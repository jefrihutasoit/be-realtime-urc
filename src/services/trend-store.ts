import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { MachineRegistration } from "../types/machine.js";
import type { MachineStatus, TimelineSegment, TimelineStatus } from "../types/oee.js";
import type { MachineTrend, TrendSignal } from "../types/trend.js";
import { resolveStatus, settingsStore } from "./settings-store.js";
import { tagValueStore } from "./tag-value-store.js";
import { scaleTags } from "./yamato/fields.js";

// Trend of one machine's signals (output / reject counters and monitoring tags) and status over a time
// range, read from `tag_values`. Readings are reduced to about TARGET_POINTS buckets per signal, each with
// its last, min and max value, so a long range stays small and short spikes still show.

const DAY = 86_400_000;
/** Longest range one trend covers. */
const MAX_RANGE_MS = 31 * DAY;
const TARGET_POINTS = 600;
/** Bucket widths in seconds; the smallest giving at most TARGET_POINTS buckets is used. */
const BUCKETS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600];

/**
 * Status segments from `from` to `to`, built from the status tag's recorded timestamps. Before the first
 * reading the status is the last value recorded before `from`, or NO_DATA when there is none.
 */
export async function statusSegments(tagStatus: string, from: Date, to: Date): Promise<TimelineSegment[]> {
  const [before, readings, statusDefinition] = await Promise.all([
    tagValueStore.latestBefore([tagStatus], from),
    tagValueStore.between(tagStatus, from, to),
    settingsStore.getStatusDefinition(),
  ]);
  const toStatus = (value: string | undefined): MachineStatus => {
    const n = value === undefined ? NaN : Number(value);
    return resolveStatus(Number.isFinite(n) ? n : null, statusDefinition);
  };

  const segments: TimelineSegment[] = [];
  /** Adds a segment, joining it to the previous one when the status is the same (e.g. a zero-length flip). */
  const push = (seg: TimelineSegment) => {
    const last = segments.at(-1);
    if (last && last.status === seg.status && last.end === seg.start) last.end = seg.end;
    else segments.push(seg);
  };
  let current: { status: TimelineStatus; start: number } = {
    status: before[0] ? toStatus(before[0].value) : "NO_DATA",
    start: from.getTime(),
  };
  for (const r of readings) {
    const status = toStatus(r.value);
    if (status === current.status) continue;
    const at = new Date(r.timestamp).getTime();
    if (at > current.start) push({ status: current.status, start: new Date(current.start).toISOString(), end: r.timestamp });
    current = { status, start: at };
  }
  push({ status: current.status, start: new Date(current.start).toISOString(), end: to.toISOString() });
  return segments;
}

function parseTime(value: unknown, name: string) {
  const t = Date.parse(String(value ?? ""));
  if (!Number.isFinite(t)) throw new HttpError(400, `${name} must be a date and time`);
  return t;
}

export const trendStore = {
  /** Signals and status of `machine` from `fromValue` to `toValue` (ISO times; `to` is capped at now). */
  async trend(machine: MachineRegistration, fromValue: unknown, toValue: unknown): Promise<MachineTrend> {
    const fromMs = parseTime(fromValue, "from");
    const toMs = Math.min(parseTime(toValue, "to"), Date.now());
    if (fromMs >= toMs) throw new HttpError(400, "from must be before to (and before now)");
    if (toMs - fromMs > MAX_RANGE_MS) throw new HttpError(400, "A trend covers at most 31 days");
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const bucketSeconds = BUCKETS.find((b) => (toMs - fromMs) / (b * 1000) <= TARGET_POINTS) ?? BUCKETS.at(-1)!;

    const signals: TrendSignal[] = [
      { key: "output", name: "Output", tagName: machine.tagOutput, unit: machine.outputUnit, kind: "counter" as const },
      { key: "reject", name: "Reject", tagName: machine.tagReject, unit: machine.rejectUnit, kind: "counter" as const },
      // No speed tag: dropped by the tagName filter below.
      { key: "speed", name: "Speed", tagName: machine.tagSpeed, unit: machine.outputUnit ? `${machine.outputUnit}/min` : "/min", kind: "value" as const },
      ...machine.monitoringTags.map((t) => ({ key: t.id, name: t.name, tagName: t.tagName, unit: t.unit, kind: "value" as const })),
      ...scaleTags(machine)
        .filter((t) => !t.field.text)
        .map((t) => ({ key: t.id, name: t.name, tagName: t.tagName, unit: t.unit, kind: "value" as const })),
    ]
      .filter((s) => s.tagName)
      .map((s) => ({ ...s, start: null, points: [] }));
    const tags = [...new Set(signals.map((s) => s.tagName))];

    const [before, [rows], status] = await Promise.all([
      tagValueStore.latestBefore(tags, from),
      tags.length
        ? pool.query<RowDataPacket[]>(
            // The newest row of a bucket (by insert order, as for current values) gives its last value.
            `SELECT g.tag_name, g.b, g.mn, g.mx, t.tag_value AS last FROM (
                SELECT tag_name, FLOOR(TIMESTAMPDIFF(MICROSECOND, ?, recorded_at) / ?) AS b,
                  MIN(tag_value + 0) AS mn, MAX(tag_value + 0) AS mx, MAX(id) AS last_id
                FROM tag_values WHERE tag_name IN (?) AND recorded_at >= ? AND recorded_at < ?
                GROUP BY tag_name, b
              ) g JOIN tag_values t ON t.id = g.last_id
              ORDER BY g.tag_name, g.b`,
            [from, bucketSeconds * 1_000_000, tags, from, to]
          )
        : Promise.resolve([[] as RowDataPacket[]] as const),
      statusSegments(machine.tagStatus, from, to),
    ]);

    const startOf = new Map(before.map((r) => [r.tagName, Number(r.value)]));
    const pointsOf = new Map<string, TrendSignal["points"]>();
    for (const r of rows) {
      const last = Number(r.last);
      if (!Number.isFinite(last)) continue;
      const list = pointsOf.get(r.tag_name) ?? [];
      list.push([fromMs + Number(r.b) * bucketSeconds * 1000, last, Number(r.mn), Number(r.mx)]);
      pointsOf.set(r.tag_name, list);
    }
    for (const s of signals) {
      const start = startOf.get(s.tagName);
      s.start = start !== undefined && Number.isFinite(start) ? start : null;
      s.points = pointsOf.get(s.tagName) ?? [];
    }

    return {
      machineId: machine.id,
      machineNo: machine.machineNo,
      from: from.toISOString(),
      to: to.toISOString(),
      bucketSeconds,
      signals,
      status,
    };
  },
};
