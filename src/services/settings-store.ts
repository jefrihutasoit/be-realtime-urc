import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { MachineStatus } from "../types/oee.js";
import { DEFAULT_OEE_SETTINGS, type FinishRule, type OeeSettings, type StatusDefinition } from "../types/settings.js";

// Global settings in `app_settings` (JSON values). Cached in memory because the poller reads them every tick.

const STATUS_KEY = "status_definition";
const OEE_KEY = "oee_settings";
const FINISH_SKU = ["notInMaster", "empty", "any"];
const FINISH_STATUS = ["RUN", "STOP", "OFF", "ANY"];
const MAX_FINISH_RULES = 10;
const STATUSES: MachineStatus[] = ["RUN", "STOP", "OFF"];
const MAX_VALUES = 50;

export const DEFAULT_STATUS_DEFINITION: StatusDefinition = { run: [1], stop: [0], off: [], unmatched: "OFF" };

let statusCache: StatusDefinition | null = null;
let oeeCache: OeeSettings | null = null;

function parseValues(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} values must be a list`);
  if (value.length > MAX_VALUES) throw new HttpError(400, `${label}: at most ${MAX_VALUES} values`);
  for (const v of value) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${label} values must be numbers`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

export function parseStatusDefinition(body: unknown): StatusDefinition {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const def: StatusDefinition = {
    run: parseValues(b.run, "RUN"),
    stop: parseValues(b.stop, "STOP"),
    off: parseValues(b.off ?? [], "OFF"),
    unmatched: b.unmatched as MachineStatus,
  };
  if (def.run.length === 0) throw new HttpError(400, "RUN needs at least one value");
  if (def.stop.length === 0) throw new HttpError(400, "STOP needs at least one value");
  if (!STATUSES.includes(def.unmatched)) throw new HttpError(400, "Unmatched status must be RUN, STOP or OFF");

  const owner = new Map<number, string>();
  for (const [label, values] of [["RUN", def.run], ["STOP", def.stop], ["OFF", def.off]] as const) {
    for (const v of values) {
      const other = owner.get(v);
      if (other) throw new HttpError(400, `Value ${v} is used by both ${other} and ${label}`);
      owner.set(v, label);
    }
  }
  return def;
}

/** Accepts 0/1 as well, as written by the migration that made these settings global. */
function bool(value: unknown, label: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new HttpError(400, `${label} must be true or false`);
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!options.includes(value as T)) throw new HttpError(400, `${label} must be ${options.map((o) => `"${o}"`).join(" or ")}`);
  return value as T;
}

function parseLabel(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!label) throw new HttpError(400, "Machine name is required");
  if (label.length > 30) throw new HttpError(400, "Machine name is too long (max 30)");
  return label;
}

/** Missing fields get their defaults. */
export function parseOeeSettings(body: unknown): OeeSettings {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const d = DEFAULT_OEE_SETTINGS;
  const list = b.finishRules ?? [];
  if (!Array.isArray(list)) throw new HttpError(400, "Finish rules must be a list");
  if (list.length > MAX_FINISH_RULES) throw new HttpError(400, `At most ${MAX_FINISH_RULES} finish rules`);
  const finishRules = list.map((item, i): FinishRule => {
    const r = (item ?? {}) as Record<string, unknown>;
    const label = `Finish rule #${i + 1}`;
    if (!FINISH_SKU.includes(r.sku as string)) throw new HttpError(400, `${label}: SKU condition is not valid`);
    if (!FINISH_STATUS.includes(r.status as string)) throw new HttpError(400, `${label}: machine status is not valid`);
    const hold = r.holdSeconds ?? 0;
    if (!Number.isInteger(hold) || (hold as number) < 0 || (hold as number) > 86_400) {
      throw new HttpError(400, `${label}: hold time must be 0 to 86400 seconds`);
    }
    if (r.sku === "any" && r.status === "ANY") throw new HttpError(400, `${label}: set a SKU or a status condition`);
    return { sku: r.sku, status: r.status, holdSeconds: hold } as FinishRule;
  });
  return {
    startMode: choice(b.startMode, ["sku", "always"] as const, "Start mode", d.startMode),
    counterMode: choice(b.counterMode, ["cumulative", "direct"] as const, "Counter mode", d.counterMode),
    resetOnSkuChange: bool(b.resetOnSkuChange, "resetOnSkuChange", d.resetOnSkuChange),
    pauseWhenOff: bool(b.pauseWhenOff, "pauseWhenOff", d.pauseWhenOff),
    rejectSource: choice(b.rejectSource, ["both", "tag", "input"] as const, "Reject source", d.rejectSource),
    breakdownWhenOff: bool(b.breakdownWhenOff, "breakdownWhenOff", d.breakdownWhenOff),
    finishRules,
    machineLabelEnabled: bool(b.machineLabelEnabled, "machineLabelEnabled", d.machineLabelEnabled),
    machineLabel: parseLabel(b.machineLabel, d.machineLabel),
  };
}

async function readSetting(key: string) {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [key]);
  return rows[0] ? JSON.parse(rows[0].setting_value) : undefined;
}

async function writeSetting(key: string, value: unknown) {
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
    [key, JSON.stringify(value), new Date()]
  );
}

export const settingsStore = {
  async getStatusDefinition(): Promise<StatusDefinition> {
    if (statusCache) return statusCache;
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT setting_value FROM app_settings WHERE setting_key = ?",
      [STATUS_KEY]
    );
    let def = DEFAULT_STATUS_DEFINITION;
    if (rows[0]) {
      try {
        def = parseStatusDefinition(JSON.parse(rows[0].setting_value));
      } catch (err) {
        console.warn("[settings] stored status definition is invalid, using default:", (err as Error).message);
      }
    }
    statusCache = def;
    return def;
  },

  async updateStatusDefinition(body: unknown): Promise<StatusDefinition> {
    const def = parseStatusDefinition(body);
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
      [STATUS_KEY, JSON.stringify(def), new Date()]
    );
    statusCache = def;
    return def;
  },

  async getOeeSettings(): Promise<OeeSettings> {
    if (oeeCache) return oeeCache;
    let settings = DEFAULT_OEE_SETTINGS;
    try {
      const stored = await readSetting(OEE_KEY);
      if (stored !== undefined) settings = parseOeeSettings(stored);
    } catch (err) {
      console.warn("[settings] stored OEE settings are invalid, using default:", (err as Error).message);
    }
    oeeCache = settings;
    return settings;
  },

  async updateOeeSettings(body: unknown): Promise<OeeSettings> {
    const settings = parseOeeSettings(body);
    await writeSetting(OEE_KEY, settings);
    oeeCache = settings;
    return settings;
  },

  /** Drops the cached settings after they were written elsewhere (settings restore). */
  clearCache() {
    statusCache = null;
    oeeCache = null;
  },
};

/** Maps a raw status tag value to RUN / STOP / OFF. Unreadable (null) is always OFF. */
export function resolveStatus(value: number | null, def: StatusDefinition): MachineStatus {
  if (value === null) return "OFF";
  if (def.run.includes(value)) return "RUN";
  if (def.stop.includes(value)) return "STOP";
  if (def.off.includes(value)) return "OFF";
  return def.unmatched;
}
