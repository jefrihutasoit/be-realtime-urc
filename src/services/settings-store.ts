import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { MachineStatus } from "../types/oee.js";
import type { StatusDefinition } from "../types/settings.js";

// Global settings in `app_settings` (JSON values). Cached in memory because the poller reads them every tick.

const STATUS_KEY = "status_definition";
const STATUSES: MachineStatus[] = ["RUN", "STOP", "OFF"];
const MAX_VALUES = 50;

export const DEFAULT_STATUS_DEFINITION: StatusDefinition = { run: [1], stop: [0], off: [], unmatched: "OFF" };

let statusCache: StatusDefinition | null = null;

function parseValues(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} values must be a list`);
  if (value.length > MAX_VALUES) throw new HttpError(400, `${label}: at most ${MAX_VALUES} values`);
  for (const v of value) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${label} values must be numbers`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function parseStatusDefinition(body: unknown): StatusDefinition {
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
};

/** Maps a raw status tag value to RUN / STOP / OFF. Unreadable (null) is always OFF. */
export function resolveStatus(value: number | null, def: StatusDefinition): MachineStatus {
  if (value === null) return "OFF";
  if (def.run.includes(value)) return "RUN";
  if (def.stop.includes(value)) return "STOP";
  if (def.off.includes(value)) return "OFF";
  return def.unmatched;
}
