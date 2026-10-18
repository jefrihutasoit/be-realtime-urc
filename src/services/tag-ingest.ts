import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { dbHealth, pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { ChannelStats, GatewayStatus } from "../types/gateway.js";
import type { TagReading } from "../types/tag.js";
import { adaptiveTags } from "./adaptive-tags.js";
import { gatewaySettingsStore } from "./gateway-settings.js";
import { machineStore } from "./machine-store.js";
import { tagValueStore } from "./tag-value-store.js";
import { scaleTags } from "./yamato/fields.js";

/**
 * Entry point for gateway readings (HTTP batch, MQTT, Simulator) and the source of current tag values.
 *
 *  - Current values live in memory, so the poller reads them without querying `tag_values` every tick.
 *    A cheap tail (`id > last id`) also picks up rows a gateway inserts into `tag_values` directly.
 *  - Readings are written in one multi-row INSERT per flush. With `onChangeOnly`, a reading is stored only
 *    when the value changed; monitoring tags are stored at most every `monitoringIntervalSec`.
 *    Production tags (status, output, reject, product) are stored on every change: the timeline,
 *    output log and shift-start baselines are built from them.
 */

interface Latest {
  value: string;
  at: number;
}
interface Row {
  tag: string;
  value: string;
  at: number;
}
export interface Reading {
  tagName: string;
  value: string;
  recordedAt: Date;
}

const MAX_VALUE_LENGTH = 255;
const MAX_READINGS_PER_MESSAGE = 5000;
/** Rows kept for a retry when the database is unreachable; older ones are dropped beyond this. */
const MAX_PENDING = 200_000;
const INSERT_CHUNK = 1000;
const TAIL_LIMIT = 5000;
const REGISTRY_TTL_MS = 5000;
/** Timestamps further ahead than this are taken as gateway clock errors and replaced by server time. */
const MAX_FUTURE_MS = 5 * 60_000;

const latest = new Map<string, Latest>();
/** Tags already looked up in the database, so a tag that was never pushed is not queried every tick. */
const looked = new Set<string>();
/** Last value written (or found) in `tag_values`, per tag. */
const lastStored = new Map<string, Latest>();
let pending: Row[] = [];
/** Newest monitoring reading per tag, waiting for its interval. */
const throttled = new Map<string, Row>();
let tailId = 0;
let warm: Promise<void> | null = null;

const newStats = (): ChannelStats => ({
  messages: 0,
  readings: 0,
  ignored: 0,
  invalid: 0,
  retimed: 0,
  lastMessageAt: null,
  lastError: null,
});
export const channelStats = { http: newStats(), mqtt: newStats() };
const storage = { written: 0, skipped: 0, lastFlushAt: null as string | null, lastError: null as string | null };
const unknownTags: string[] = [];

// ---------- registered tags ----------

let registry: {
  at: number;
  all: Set<string>;
  numeric: Set<string>;
  monitoring: Set<string>;
  /** Machine No(s) using each tag. */
  owners: Map<string, string[]>;
  /** Machines by lower-cased machine No, for routing MQTT topics. */
  machines: Map<
    string,
    { id: string; machineNo: string; realtimeMode: "registered" | "adaptive"; production: Set<string> }
  >;
} | null = null;

/** Tags used by any machine; which must be numbers; which are monitoring-only (throttled). */
export async function registeredTags() {
  if (registry && Date.now() - registry.at < REGISTRY_TTL_MS) return registry;
  // Without the database, keep using the last known machines.
  if (registry && !dbHealth.ready) return registry;
  const machines = await machineStore.list();
  const all = new Set<string>();
  const numeric = new Set<string>();
  const production = new Set<string>();
  const owners = new Map<string, string[]>();
  const own = (tag: string, no: string) => owners.set(tag, [...(owners.get(tag) ?? []), no]);
  for (const m of machines) {
    const scale = scaleTags(m);
    const speed = m.tagSpeed ? [m.tagSpeed] : [];
    [m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct, ...speed, ...m.monitoringTags.map((t) => t.tagName), ...scale.map((t) => t.tagName)].forEach(
      (t) => own(t, m.machineNo)
    );
    for (const t of [m.tagStatus, m.tagOutput, m.tagReject]) all.add(t), numeric.add(t), production.add(t);
    all.add(m.tagProduct);
    production.add(m.tagProduct);
    m.monitoringTags.forEach((t) => (all.add(t.tagName), numeric.add(t.tagName)));
    // Speed is stored like a monitoring tag (by the monitoring interval).
    speed.forEach((t) => (all.add(t), numeric.add(t)));
    // Yamato scale fields; text ones (product name) are not numeric.
    scale.forEach((t) => (all.add(t.tagName), t.field.text || numeric.add(t.tagName)));
  }
  const monitoring = new Set([...all].filter((t) => !production.has(t)));
  const byNo = new Map(
    machines.map((m) => [
      m.machineNo.toLowerCase(),
      {
        id: m.id,
        machineNo: m.machineNo,
        realtimeMode: m.realtimeMode,
        production: new Set([m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct]),
      },
    ])
  );
  registry = { at: Date.now(), all, numeric, monitoring, owners, machines: byNo };
  return registry;
}

/** Makes the next check see machine changes right away. */
export const forgetRegisteredTags = () => {
  registry = null;
};

// ---------- payload ----------

function valueText(v: unknown): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") {
    const s = v.trim();
    return s && s.length <= MAX_VALUE_LENGTH ? s : null;
  }
  return null;
}

function timeOf(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t) || t > Date.now() + MAX_FUTURE_MS) return fallback;
  return t;
}

/**
 * Reads one gateway message into readings (see IngestPayload in types/gateway.ts). `topicTag` is used for a
 * plain MQTT value (e.g. payload "1520" on topic "urc/oee/GW01.LINE1.M1A.OUTPUT").
 * Returns the readings and how many entries could not be read.
 */
export function parsePayload(payload: unknown, topicTag?: string): { readings: Reading[]; invalid: number } {
  const now = Date.now();
  const readings: Reading[] = [];
  let invalid = 0;
  const add = (tag: unknown, value: unknown, ts: number) => {
    const tagName = typeof tag === "string" ? tag.trim() : "";
    const text = valueText(value);
    if (!tagName || tagName.length > 200 || text === null) invalid += 1;
    else readings.push({ tagName, value: text, recordedAt: new Date(ts) });
  };
  const fromList = (list: unknown[], ts: number) => {
    for (const item of list) {
      const r = (item ?? {}) as Record<string, unknown>;
      add(r.tagName ?? r.tag ?? r.name, r.value ?? r.v, timeOf(r.timestamp ?? r.ts ?? r.t, ts));
    }
  };

  if (Array.isArray(payload)) fromList(payload, now);
  else if (typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    const ts = timeOf(p.ts ?? p.timestamp, now);
    if (p.values && typeof p.values === "object" && !Array.isArray(p.values)) {
      for (const [tag, value] of Object.entries(p.values)) add(tag, value, ts);
    }
    if (Array.isArray(p.readings)) fromList(p.readings, ts);
    if (p.tagName !== undefined || p.tag !== undefined) add(p.tagName ?? p.tag, p.value, ts);
    const known = p.values !== undefined || p.readings !== undefined || p.tagName !== undefined || p.tag !== undefined;
    if (!known) throw new HttpError(400, 'Expected "values", "readings" or "tagName"');
  } else if (topicTag && (typeof payload === "number" || typeof payload === "string" || typeof payload === "boolean")) {
    add(topicTag, payload, now);
  } else {
    throw new HttpError(400, "Unreadable payload");
  }
  if (readings.length + invalid > MAX_READINGS_PER_MESSAGE) {
    throw new HttpError(413, `At most ${MAX_READINGS_PER_MESSAGE} readings per message`);
  }
  return { readings, invalid };
}

// ---------- cache and storage ----------

/** Loads the newest stored value of every registered tag once, and where the tail starts. */
function ensureWarm() {
  warm ??= (async () => {
    const [[{ maxId }]] = await pool.query<RowDataPacket[]>("SELECT COALESCE(MAX(id), 0) AS maxId FROM tag_values");
    tailId = Number(maxId);
    const { all } = await registeredTags();
    for (const r of await tagValueStore.latest([...all])) remember(r.tagName, r.value, Date.parse(r.timestamp), true);
    all.forEach((t) => looked.add(t));
  })().catch((err) => {
    warm = null;
    throw err;
  });
  return warm;
}

/** Updates the current value unless a newer one is already known; `stored` also marks it as in the database. */
function remember(tag: string, value: string, at: number, stored: boolean) {
  const cur = latest.get(tag);
  if (!cur || at >= cur.at) latest.set(tag, { value, at });
  if (stored) {
    const last = lastStored.get(tag);
    if (!last || at >= last.at) lastStored.set(tag, { value, at });
  }
}

/** Queues a reading for the database according to the storage settings. */
function queue(row: Row, monitoring: boolean) {
  const { onChangeOnly, monitoringIntervalSec } = gatewaySettingsStore.cached()?.storage ?? {
    onChangeOnly: true,
    monitoringIntervalSec: 0,
  };
  if (monitoring && monitoringIntervalSec > 0) {
    if (throttled.has(row.tag)) storage.skipped += 1; // replaced by a newer reading before it was due
    throttled.set(row.tag, row);
    return;
  }
  const last = lastStored.get(row.tag);
  if (onChangeOnly && last && last.value === row.value) {
    storage.skipped += 1;
    return;
  }
  pending.push(row);
  lastStored.set(row.tag, { value: row.value, at: row.at });
}

/** Monitoring readings whose interval has passed. */
function dueThrottled(now: number) {
  const { onChangeOnly, monitoringIntervalSec } = gatewaySettingsStore.cached()!.storage;
  const due: Row[] = [];
  for (const [tag, row] of throttled) {
    const last = lastStored.get(tag);
    if (last && now - last.at < monitoringIntervalSec * 1000 && monitoringIntervalSec > 0) continue;
    throttled.delete(tag);
    if (onChangeOnly && last && last.value === row.value) {
      storage.skipped += 1;
      continue;
    }
    due.push(row);
    lastStored.set(tag, { value: row.value, at: row.at });
  }
  return due;
}

export const tagIngest = {
  /**
   * Validates readings against the registered tags, updates the current values and queues them for storage.
   * Unregistered tags are counted and listed, not stored.
   */
  async ingest(readings: Reading[], stats: ChannelStats, invalid = 0) {
    // Current values still update in memory while the database is down.
    await ensureWarm().catch((err) => {
      if (dbHealth.ready) throw err;
    });
    const { all, numeric, monitoring, owners } = await registeredTags();
    let accepted = 0;
    let retimed = 0;
    const machines = new Set<string>();
    const now = Date.now();
    const gatewayTime = gatewaySettingsStore.cached()?.storage.timestampSource === "gateway";
    stats.messages += 1;
    stats.invalid += invalid;
    stats.lastMessageAt = new Date().toISOString();
    for (const r of readings) {
      if (!all.has(r.tagName)) {
        stats.ignored += 1;
        if (!unknownTags.includes(r.tagName)) {
          unknownTags.unshift(r.tagName);
          unknownTags.length = Math.min(unknownTags.length, 20);
        }
        continue;
      }
      if (numeric.has(r.tagName) && !Number.isFinite(Number(r.value))) {
        stats.invalid += 1;
        continue;
      }
      // Server receive time by default. A gateway `ts` must move forward per tag: a stale or repeated one
      // would put the reading back in time and repaint the status timeline from there.
      let at = gatewayTime ? r.recordedAt.getTime() : now;
      const previous = Math.max(latest.get(r.tagName)?.at ?? 0, lastStored.get(r.tagName)?.at ?? 0);
      if (gatewayTime && at <= previous) {
        at = Math.max(now, previous + 1);
        retimed += 1;
      }
      remember(r.tagName, r.value, at, false);
      queue({ tag: r.tagName, value: r.value, at }, monitoring.has(r.tagName));
      owners.get(r.tagName)?.forEach((no) => machines.add(no));
      accepted += 1;
    }
    stats.readings += accepted;
    stats.retimed += retimed;
    const ignored = readings.filter((r) => !all.has(r.tagName)).length;
    return { accepted, ignored, invalid: readings.length - accepted - ignored + invalid, retimed, machines: [...machines] };
  },

  /** Parses and ingests one message; errors are recorded on the channel and re-thrown. */
  async ingestPayload(payload: unknown, stats: ChannelStats, topicTag?: string) {
    try {
      const { readings, invalid } = parsePayload(payload, topicTag);
      return await this.ingest(readings, stats, invalid);
    } catch (err) {
      stats.invalid += 1;
      stats.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  },

  /** Stores one reading right away (Simulator), returning the stored row. */
  async recordNow(tagName: string, value: string, recordedAt: Date): Promise<TagReading> {
    await ensureWarm();
    const saved = await tagValueStore.insert(tagName, value, recordedAt);
    remember(tagName, value, recordedAt.getTime(), true);
    return saved;
  },

  /** Current value of each tag, or null when it was never received. */
  async read(tags: string[]): Promise<Record<string, string | null>> {
    await ensureWarm();
    await this.tail();
    const missing = tags.filter((t) => !latest.has(t) && !looked.has(t));
    if (missing.length) {
      for (const r of await tagValueStore.latest(missing)) remember(r.tagName, r.value, Date.parse(r.timestamp), true);
      missing.forEach((t) => looked.add(t));
    }
    return Object.fromEntries(tags.map((t) => [t, latest.get(t)?.value ?? null]));
  },

  /** Picks up rows written to `tag_values` by anything else (e.g. a gateway inserting directly). */
  async tail() {
    for (let i = 0; i < 5; i++) {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT id, tag_name, tag_value, recorded_at FROM tag_values WHERE id > ? ORDER BY id LIMIT ?",
        [tailId, TAIL_LIMIT]
      );
      for (const r of rows) remember(r.tag_name, r.tag_value, (r.recorded_at as Date).getTime(), true);
      if (rows.length) tailId = Number(rows[rows.length - 1].id);
      if (rows.length < TAIL_LIMIT) return;
    }
  },

  /** Writes the queued readings in multi-row INSERTs. On failure they are kept for the next flush. */
  async flush() {
    // While the database is down the readings stay queued (up to MAX_PENDING).
    if (!gatewaySettingsStore.cached() || !dbHealth.ready) return;
    const rows = [...pending, ...dueThrottled(Date.now())];
    pending = [];
    if (!rows.length) return;
    let done = 0; // rows written so far; the rest go back to the queue on failure
    try {
      for (; done < rows.length; done += INSERT_CHUNK) {
        const chunk = rows.slice(done, done + INSERT_CHUNK);
        await pool.query<ResultSetHeader>("INSERT INTO tag_values (tag_name, tag_value, recorded_at) VALUES ?", [
          chunk.map((r) => [r.tag, r.value, new Date(r.at)]),
        ]);
        storage.written += chunk.length;
      }
      storage.lastFlushAt = new Date().toISOString();
      storage.lastError = null;
    } catch (err) {
      storage.lastError = err instanceof Error ? err.message : String(err);
      pending = [...rows.slice(done), ...pending].slice(-MAX_PENDING);
      console.error("[ingest] could not write tag values:", err);
    }
  },

  status(): Pick<GatewayStatus, "storage" | "unknownTags"> {
    return {
      storage: {
        pending: pending.length + throttled.size,
        cachedTags: latest.size,
        adaptiveTags: adaptiveTags.stats().tags,
        adaptiveMachines: adaptiveTags.stats().machines,
        ...storage,
      },
      unknownTags: [...unknownTags],
    };
  },

  /** Forgets everything in memory (after the database was restored, initialized or cleared). */
  reset() {
    latest.clear();
    looked.clear();
    lastStored.clear();
    throttled.clear();
    pending = [];
    tailId = 0;
    warm = null;
    registry = null;
  },
};

let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Writes queued readings on the configured interval until `stopIngest`. */
export function startIngest() {
  const loop = async () => {
    await tagIngest.flush();
    flushTimer = setTimeout(loop, gatewaySettingsStore.cached()?.storage.flushIntervalMs ?? 1000);
  };
  flushTimer = setTimeout(loop, 1000);
}

/** Stops the flush loop and writes what is still queued (also the monitoring readings not yet due). */
export async function stopIngest() {
  clearTimeout(flushTimer);
  for (const [, row] of throttled) pending.push(row);
  throttled.clear();
  await tagIngest.flush();
}
