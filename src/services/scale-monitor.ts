import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import type { MachineRegistration } from "../types/machine.js";
import type { ScaleMonitor, ScaleSkuSegment, SpecBand } from "../types/scale.js";
import type { SkuMaster } from "../types/sku.js";
import { skuStore } from "./sku-store.js";
import { tagValueStore } from "./tag-value-store.js";
import { trendStore } from "./trend-store.js";
import { SCALE_TAG_PREFIX } from "./yamato/fields.js";

// Scale monitoring: one weight signal of a machine (a scale field or any numeric signal), its low / high limit
// read from tags (by default the scale's own Low limit / High limit), and the SKUs run on the machine (from the
// product tag) with their target weight from SKU Management. Every weight reading is checked against the limits
// in effect at its time; per SKU run the readings are summarised to find deviating scales.

/** At most this many SKU runs are summarised (the newest). */
const MAX_SEGMENTS = 300;
/** At most this many weight readings are checked (the newest); the chart itself uses the bucketed trend. */
const MAX_READINGS = 300_000;
const DEFAULT_SIGNAL = `${SCALE_TAG_PREFIX}AVERAGE_WEIGHT`;
const DEFAULT_LOW = `${SCALE_TAG_PREFIX}LOW_LIMIT`;
const DEFAULT_HIGH = `${SCALE_TAG_PREFIX}HIGH_LIMIT`;

/** SKU master entry of a product tag code (numeric codes also match after normalising, as in the poller). */
function skuOf(code: string, byId: Map<string, SkuMaster>) {
  const c = code.trim();
  if (!c) return undefined;
  const num = Number(c);
  return byId.get(c.toLowerCase()) ?? (Number.isFinite(num) ? byId.get(String(num)) : undefined);
}

/** A tag's value over time: [time, value] steps from `from`, the first holding the value from before it. */
async function steps(tagName: string, from: Date, to: Date) {
  const [before, readings] = await Promise.all([tagValueStore.latestBefore([tagName], from), tagValueStore.between(tagName, from, to)]);
  const out: [number, number | null][] = [];
  const first = before[0] ? Number(before[0].value) : NaN;
  out.push([from.getTime(), Number.isFinite(first) ? first : null]);
  for (const r of readings) {
    const v = Number(r.value);
    if (!Number.isFinite(v) || v === out.at(-1)![1]) continue;
    out.push([Date.parse(r.timestamp), v]);
  }
  return out;
}

/** Value of a step list at time t (steps sorted by time). */
function stepAt(list: [number, number | null][] | null, t: number) {
  if (!list) return null;
  let v: number | null = null;
  for (const [at, value] of list) {
    if (at > t) break;
    v = value;
  }
  return v;
}

export async function scaleMonitor(
  machine: MachineRegistration,
  from: unknown,
  to: unknown,
  choice: { signal?: unknown; low?: unknown; high?: unknown }
): Promise<ScaleMonitor> {
  const [trend, skus] = await Promise.all([trendStore.trend(machine, from, to), skuStore.list()]);
  const numeric = trend.signals;
  const isScale = (key: string) => key.startsWith(SCALE_TAG_PREFIX);
  const signals = [...numeric]
    .sort((a, b) => Number(isScale(b.key)) - Number(isScale(a.key)))
    .map((s) => ({ key: s.key, name: s.name, unit: s.unit, scale: isScale(s.key) }));
  const byKey = (key: unknown) => (typeof key === "string" && key ? numeric.find((s) => s.key === key) : undefined);
  const signal =
    byKey(choice.signal) ??
    byKey(DEFAULT_SIGNAL) ??
    numeric.find((s) => isScale(s.key)) ??
    numeric.find((s) => s.kind === "value") ??
    numeric[0] ??
    null;
  // A limit: the chosen tag, "none" for no limit, or by default the scale's own limit field.
  const limitOf = (wanted: unknown, fallback: string) => (wanted === "none" ? null : (byKey(wanted) ?? byKey(fallback) ?? null));
  const lowSignal = limitOf(choice.low, DEFAULT_LOW);
  const highSignal = limitOf(choice.high, DEFAULT_HIGH);

  const fromDate = new Date(trend.from);
  const toDate = new Date(trend.to);
  const fromMs = fromDate.getTime();
  const toMs = toDate.getTime();

  // SKU runs from the product tag readings.
  const runs: { start: number; end: number; code: string }[] = [];
  if (machine.tagProduct) {
    const product = await Promise.all([
      tagValueStore.latestBefore([machine.tagProduct], fromDate),
      tagValueStore.between(machine.tagProduct, fromDate, toDate),
    ]);
    let current = { code: product[0][0]?.value.trim() ?? "", start: fromMs };
    for (const r of product[1]) {
      const code = r.value.trim();
      if (code === current.code) continue;
      const at = Date.parse(r.timestamp);
      if (at > current.start) runs.push({ ...current, end: at });
      current = { code, start: at };
    }
    runs.push({ ...current, end: toMs });
  } else {
    runs.push({ code: "", start: fromMs, end: toMs });
  }
  const shown = runs.slice(-MAX_SEGMENTS);
  const byId = new Map(skus.map((s) => [s.skuId.toLowerCase(), s]));
  const masters = shown.map((r) => skuOf(r.code, byId));

  const [lowSteps, highSteps, readings] = await Promise.all([
    lowSignal ? steps(lowSignal.tagName, fromDate, toDate) : Promise.resolve(null),
    highSignal ? steps(highSignal.tagName, fromDate, toDate) : Promise.resolve(null),
    signal
      ? pool
          .query<RowDataPacket[]>(
            `SELECT recorded_at AS t, tag_value + 0 AS v FROM tag_values
              WHERE tag_name = ? AND recorded_at >= ? AND recorded_at < ? AND tag_value REGEXP '^-?[0-9.]+$'
              ORDER BY recorded_at DESC, id DESC LIMIT ?`,
            [signal.tagName, fromDate, toDate, MAX_READINGS + 1]
          )
          .then(([rows]) => rows)
      : Promise.resolve([] as RowDataPacket[]),
  ]);
  const truncated = readings.length > MAX_READINGS;
  const points = readings
    .slice(0, MAX_READINGS)
    .map((r) => ({ t: (r.t as Date).getTime(), v: Number(r.v) }))
    .reverse();

  // Spec bands: change points of the SKU and of both limits.
  const cuts = new Set<number>([fromMs, toMs, ...shown.map((r) => r.start)]);
  for (const list of [lowSteps, highSteps]) for (const [t] of list ?? []) if (t > fromMs && t < toMs) cuts.add(t);
  const edges = [...cuts].filter((t) => t >= (shown[0]?.start ?? fromMs)).sort((a, b) => a - b);
  const runAt = (t: number) => shown.findIndex((r) => r.start <= t && t < r.end);
  const bands: SpecBand[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const t = edges[i];
    const idx = runAt(t);
    const band = {
      from: t,
      to: edges[i + 1],
      target: idx >= 0 ? (masters[idx]?.targetWeight ?? null) : null,
      low: stepAt(lowSteps, t),
      high: stepAt(highSteps, t),
    };
    if (band.target === null && band.low === null && band.high === null) continue;
    const last = bands.at(-1);
    if (last && last.to === band.from && last.target === band.target && last.low === band.low && last.high === band.high) last.to = band.to;
    else bands.push(band);
  }

  // Per SKU run: summary of the readings, each checked against the limits of its time.
  const stats = shown.map(() => ({ n: 0, sum: 0, sq: 0, min: Infinity, max: -Infinity, below: 0, above: 0 }));
  let run = 0;
  for (const p of points) {
    while (run < shown.length && p.t >= shown[run].end) run++;
    if (run >= shown.length) break;
    if (p.t < shown[run].start) continue;
    const s = stats[run];
    s.n++;
    s.sum += p.v;
    s.sq += p.v * p.v;
    s.min = Math.min(s.min, p.v);
    s.max = Math.max(s.max, p.v);
    const low = stepAt(lowSteps, p.t);
    const high = stepAt(highSteps, p.t);
    if (low !== null && p.v < low) s.below++;
    if (high !== null && p.v > high) s.above++;
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const changed = (list: [number, number | null][] | null, a: number, b: number) =>
    !!list && list.some(([t], i) => i > 0 && t > a && t < b);

  const segments: ScaleSkuSegment[] = shown.map((r, i) => {
    const s = stats[i];
    const avg = s.n ? s.sum / s.n : null;
    const variance = s.n > 1 ? (s.sq - (s.sum * s.sum) / s.n) / (s.n - 1) : null;
    return {
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      skuCode: r.code || "-",
      productName: masters[i]?.productName ?? (r.code ? "Unknown SKU" : "No SKU"),
      target: masters[i]?.targetWeight ?? null,
      low: stepAt(lowSteps, r.end - 1),
      high: stepAt(highSteps, r.end - 1),
      limitsChanged: changed(lowSteps, r.start, r.end) || changed(highSteps, r.start, r.end),
      count: s.n,
      avg: avg === null ? null : round(avg),
      min: s.n ? round(s.min) : null,
      max: s.n ? round(s.max) : null,
      stdDev: variance === null ? null : round(Math.sqrt(Math.max(variance, 0))),
      below: s.below,
      above: s.above,
    };
  });

  return {
    machineId: machine.id,
    machineNo: machine.machineNo,
    from: trend.from,
    to: trend.to,
    bucketSeconds: trend.bucketSeconds,
    signals,
    signal,
    lowKey: lowSignal?.key ?? null,
    highKey: highSignal?.key ?? null,
    bands,
    skus: segments,
    status: trend.status,
    truncated,
  };
}
