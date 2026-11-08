import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type {
  MachineInput,
  MachineRegistration,
  MonitoringTag,
  ProductionTagKey,
  ProductionUnitKey,
  RealtimeMode,
  ScaleConfig,
} from "../types/machine.js";
import { YAMATO_FIELD_BY_KEY } from "./yamato/fields.js";

// Machine registry backed by MySQL (tables `machines` and `machine_monitoring_tags`; the Yamato scale
// settings are a JSON text in `machines.scale_config`).

export const PRODUCTION_TAGS: [ProductionTagKey, string][] = [
  ["tagStatus", "Tag status"],
  ["tagOutput", "Tag output"],
  ["tagReject", "Tag reject"],
  ["tagProduct", "Tag product"],
];

const PRODUCTION_UNITS: [ProductionUnitKey, string, string][] = [
  ["outputUnit", "output_unit", "Output unit"],
  ["rejectUnit", "reject_unit", "Reject unit"],
];
const DEFAULT_UNIT = "pcs";
const REALTIME_MODES: RealtimeMode[] = ["registered", "adaptive"];
/** Default and limits of the adaptive tag expiry: one 8-hour shift, 1 minute to 7 days. */
const DEFAULT_TTL_MIN = 480;
const MAX_TTL_MIN = 7 * 24 * 60;

function parseRealtimeMode(value: unknown): RealtimeMode {
  if (!REALTIME_MODES.includes(value as RealtimeMode)) throw new HttpError(400, "Realtime mode must be registered or adaptive");
  return value as RealtimeMode;
}

function parseTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TTL_MIN) {
    throw new HttpError(400, `Adaptive tag expiry must be 1 to ${MAX_TTL_MIN} minutes`);
  }
  return value;
}

/** Fields that can be set on many machines at once: key, column, parser. */
const BULK_FIELDS: [keyof MachineRegistration, string, (v: unknown) => string | number][] = [
  ["outputUnit", "output_unit", (v) => parseUnit(v, "Output unit")],
  ["rejectUnit", "reject_unit", (v) => parseUnit(v, "Reject unit")],
  ["realtimeMode", "realtime_mode", parseRealtimeMode],
  ["adaptiveTtlMinutes", "adaptive_ttl_min", parseTtl],
];

// Kept under MySQL's default 1 MB max_allowed_packet (XAMPP). The frontend sends ~50 KB JPEGs.
const MAX_PHOTO_LENGTH = 700_000;
const MAX_MONITORING_TAGS = 100;

type ParsedInput = Omit<Partial<MachineInput>, "monitoringTags"> & {
  monitoringTags?: MonitoringTag[];
};

interface MachineRow extends RowDataPacket {
  id: string;
  machine_no: string;
  machine_name: string;
  tag_status: string;
  tag_output: string;
  tag_reject: string;
  tag_product: string;
  tag_speed: string;
  output_unit: string;
  reject_unit: string;
  realtime_mode: RealtimeMode;
  adaptive_ttl_min: number;
  scale_config: string | null;
  photo: string | null;
  is_active: number;
  oee_enabled: number;
  created_at: Date;
  updated_at: Date;
}

interface MonitoringTagRow extends RowDataPacket {
  id: string;
  machine_id: string;
  name: string;
  tag_name: string;
  unit: string;
}

// ---------- validation ----------

// Tag names are free text: the gateway tag list is only a suggestion, so any address can be registered.
const MAX_TAG_LENGTH = 200;
const MAX_UNIT_LENGTH = 20;

function parseMonitoringTags(value: unknown): MonitoringTag[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Monitoring tags must be a list");
  if (value.length > MAX_MONITORING_TAGS) throw new HttpError(400, `At most ${MAX_MONITORING_TAGS} monitoring tags`);

  const tags: MonitoringTag[] = [];
  const names = new Set<string>();
  const tagNames = new Set<string>();

  for (const [i, item] of value.entries()) {
    const row = (item ?? {}) as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const tagName = typeof row.tagName === "string" ? row.tagName.trim() : "";
    const unit = typeof row.unit === "string" ? row.unit.trim() : "";
    if (!name || !tagName) throw new HttpError(400, `Monitoring tag #${i + 1}: name and tag name are required`);
    if (name.length > 100) throw new HttpError(400, `Monitoring tag "${name.slice(0, 20)}…": name is too long`);
    if (tagName.length > MAX_TAG_LENGTH) throw new HttpError(400, `Monitoring tag "${name}": tag name is too long`);
    if (unit.length > MAX_UNIT_LENGTH) {
      throw new HttpError(400, `Monitoring tag "${name}": unit is too long (max ${MAX_UNIT_LENGTH})`);
    }
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Monitoring tag name "${name}" is used twice`);
    if (tagNames.has(tagName)) throw new HttpError(400, `Tag ${tagName} is used twice in monitoring tags`);
    names.add(name.toLowerCase());
    tagNames.add(tagName);
    tags.push({ id: typeof row.id === "string" ? row.id : "", name, tagName, unit });
  }
  return tags;
}

const MC_SIDES = ["1", "2"];

/** Yamato scale settings; null removes the scale. Host and port are only required while it is enabled. */
function parseScale(value: unknown): ScaleConfig | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new HttpError(400, "Scale settings are invalid");
  const v = value as Record<string, unknown>;
  const enabled = v.enabled === true;
  const host = typeof v.host === "string" ? v.host.trim() : "";
  const port = Number(v.port);
  const mcSide = typeof v.mcSide === "string" && v.mcSide ? v.mcSide : "1";
  const fields = Array.isArray(v.fields) ? [...new Set(v.fields.filter((f): f is string => typeof f === "string"))] : [];
  if (host.length > 100 || /\s/.test(host)) throw new HttpError(400, "Scale host is invalid");
  if (!MC_SIDES.includes(mcSide)) throw new HttpError(400, "Scale machine side must be 1 or 2");
  const unknown = fields.find((f) => !YAMATO_FIELD_BY_KEY.has(f));
  if (unknown) throw new HttpError(400, `Unknown scale field ${unknown}`);
  if (enabled) {
    if (!host) throw new HttpError(400, "Scale host is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Scale port must be 1 to 65535");
    if (!fields.length) throw new HttpError(400, "Choose at least one scale field");
  }
  return { enabled, host, port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 10001, mcSide, fields };
}

function scaleFromRow(text: string | null): ScaleConfig | null {
  if (!text) return null;
  try {
    return parseScale(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A display unit: free text, may be empty (no unit). */
function parseUnit(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be text`);
  const unit = value.trim();
  if (unit.length > MAX_UNIT_LENGTH) throw new HttpError(400, `${label} is too long (max ${MAX_UNIT_LENGTH})`);
  return unit;
}

/** Validates field shapes. With `partial`, only the fields present are checked (PATCH). */
export async function parseMachineInput(body: unknown, partial = false): Promise<ParsedInput> {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const data: ParsedInput = {};
  const has = (k: keyof MachineInput) => !partial || k in b;

  for (const [key, label] of [["machineNo", "Machine No"], ["machineName", "Machine name"], ...PRODUCTION_TAGS] as const) {
    if (!has(key)) continue;
    const v = b[key];
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${label} is required`);
    data[key] = v.trim();
  }
  if (data.machineNo && data.machineNo.length > 20) throw new HttpError(400, "Machine No is too long (max 20)");
  if (data.machineName && data.machineName.length > 100) throw new HttpError(400, "Machine name is too long (max 100)");

  for (const [key, label] of PRODUCTION_TAGS) {
    if (data[key] && data[key].length > MAX_TAG_LENGTH) throw new HttpError(400, `${label} is too long (max ${MAX_TAG_LENGTH})`);
  }

  for (const [key, , label] of PRODUCTION_UNITS) {
    // Optional on create (and in older backups): defaults to "pcs".
    if (key in b) data[key] = parseUnit(b[key], label);
    else if (!partial) data[key] = DEFAULT_UNIT;
  }

  // Optional: a machine without a speed tag shows no speed.
  if ("tagSpeed" in b) {
    if (typeof b.tagSpeed !== "string") throw new HttpError(400, "Tag speed must be text");
    data.tagSpeed = b.tagSpeed.trim();
    if (data.tagSpeed.length > MAX_TAG_LENGTH) throw new HttpError(400, `Tag speed is too long (max ${MAX_TAG_LENGTH})`);
  } else if (!partial) data.tagSpeed = "";

  // Optional on create (and in older backups).
  if ("realtimeMode" in b) data.realtimeMode = parseRealtimeMode(b.realtimeMode);
  else if (!partial) data.realtimeMode = "registered";
  if ("adaptiveTtlMinutes" in b) data.adaptiveTtlMinutes = parseTtl(b.adaptiveTtlMinutes);
  else if (!partial) data.adaptiveTtlMinutes = DEFAULT_TTL_MIN;

  if (has("monitoringTags")) data.monitoringTags = parseMonitoringTags(b.monitoringTags ?? []);
  // Optional everywhere: older clients and backups do not send it.
  if ("scale" in b) data.scale = parseScale(b.scale);
  else if (!partial) data.scale = null;

  if (has("photo")) {
    const v = b.photo ?? null;
    if (v !== null && (typeof v !== "string" || !/^(data:image\/|\/)/.test(v))) {
      throw new HttpError(400, "Photo must be an image");
    }
    if (typeof v === "string" && v.length > MAX_PHOTO_LENGTH) throw new HttpError(400, "Photo is too large");
    data.photo = v;
  }

  for (const key of ["isActive", "oeeEnabled"] as const) {
    if (!(key in b)) {
      if (!partial) data[key] = true;
      continue;
    }
    if (typeof b[key] !== "boolean") throw new HttpError(400, `${key} must be true or false`);
    data[key] = b[key];
  }


  return data;
}

/**
 * Cross-record rules on the final machine state: machine No is unique, and each production tag
 * is used once within the machine and by no other machine. Monitoring tags may be shared.
 * The unique keys in the schema back this up against concurrent writes.
 */
async function assertNoConflict(
  conn: PoolConnection,
  machine: Pick<MachineRegistration, "machineNo" | ProductionTagKey>,
  excludeId = ""
) {
  const own = PRODUCTION_TAGS.map(([key]) => machine[key]);
  if (new Set(own).size !== own.length) {
    throw new HttpError(409, "Status, output, reject and product must use different tags");
  }

  const [others] = await conn.query<MachineRow[]>(
    "SELECT machine_no, tag_status, tag_output, tag_reject, tag_product FROM machines WHERE id <> ?",
    [excludeId]
  );
  for (const m of others) {
    if (m.machine_no.toLowerCase() === machine.machineNo.toLowerCase()) {
      throw new HttpError(409, `Machine No "${machine.machineNo}" is already registered`);
    }
    const theirs = new Set([m.tag_status, m.tag_output, m.tag_reject, m.tag_product]);
    const shared = own.find((t) => theirs.has(t));
    if (shared) throw new HttpError(409, `Tag ${shared} is already used by machine ${m.machine_no}`);
  }
}

// ---------- persistence ----------

function toMachine(row: MachineRow, tags: MonitoringTag[]): MachineRegistration {
  return {
    id: row.id,
    machineNo: row.machine_no,
    machineName: row.machine_name,
    tagStatus: row.tag_status,
    tagOutput: row.tag_output,
    tagReject: row.tag_reject,
    tagProduct: row.tag_product,
    tagSpeed: row.tag_speed ?? "",
    outputUnit: row.output_unit,
    rejectUnit: row.reject_unit,
    realtimeMode: row.realtime_mode,
    adaptiveTtlMinutes: Number(row.adaptive_ttl_min),
    monitoringTags: tags,
    scale: scaleFromRow(row.scale_config),
    photo: row.photo,
    isActive: !!row.is_active,
    oeeEnabled: !!row.oee_enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadMachines(conn: PoolConnection | typeof pool, id?: string) {
  const [rows] = await conn.query<MachineRow[]>(
    id ? "SELECT * FROM machines WHERE id = ?" : "SELECT * FROM machines",
    id ? [id] : []
  );
  if (rows.length === 0) return [];

  const [tagRows] = await conn.query<MonitoringTagRow[]>(
    "SELECT id, machine_id, name, tag_name, unit FROM machine_monitoring_tags WHERE machine_id IN (?) ORDER BY sort_order",
    [rows.map((r) => r.id)]
  );
  const tagsByMachine = new Map<string, MonitoringTag[]>();
  for (const t of tagRows) {
    const list = tagsByMachine.get(t.machine_id) ?? [];
    list.push({ id: t.id, name: t.name, tagName: t.tag_name, unit: t.unit });
    tagsByMachine.set(t.machine_id, list);
  }

  return rows
    .map((r) => toMachine(r, tagsByMachine.get(r.id) ?? []))
    .sort((a, b) => a.machineNo.localeCompare(b.machineNo, undefined, { numeric: true }));
}

/** Replaces a machine's monitoring tags. Ids are kept only for rows that already belonged to it. */
async function saveMonitoringTags(conn: PoolConnection, machineId: string, tags: MonitoringTag[], ownIds: Set<string>) {
  await conn.query("DELETE FROM machine_monitoring_tags WHERE machine_id = ?", [machineId]);
  if (tags.length === 0) return [];
  const saved = tags.map((t) => ({ ...t, id: ownIds.has(t.id) ? t.id : randomUUID() }));
  await conn.query("INSERT INTO machine_monitoring_tags (id, machine_id, name, tag_name, unit, sort_order) VALUES ?", [
    saved.map((t, i) => [t.id, machineId, t.name, t.tagName, t.unit, i]),
  ]);
  return saved;
}

/** Turns a unique-key violation that slipped past assertNoConflict (concurrent write) into a 409. */
function mapDbError(err: unknown): never {
  if ((err as { code?: string })?.code === "ER_DUP_ENTRY") {
    throw new HttpError(409, "Machine No or a production tag is already in use");
  }
  throw err;
}

export const machineStore = {
  list() {
    return loadMachines(pool);
  },

  async get(id: string) {
    return (await loadMachines(pool, id))[0];
  },

  async create(body: unknown) {
    const data = await parseMachineInput(body);
    const now = new Date();
    const id = randomUUID();
    const m = data as Required<ParsedInput>;

    return withTransaction(async (conn) => {
      await assertNoConflict(conn, m);
      await conn.query<ResultSetHeader>(
        `INSERT INTO machines (id, machine_no, machine_name, tag_status, tag_output, tag_reject, tag_product, tag_speed,
          output_unit, reject_unit, realtime_mode, adaptive_ttl_min, scale_config, photo, is_active, oee_enabled,
          created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, m.machineNo, m.machineName, m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct, m.tagSpeed,
          m.outputUnit, m.rejectUnit, m.realtimeMode, m.adaptiveTtlMinutes, m.scale ? JSON.stringify(m.scale) : null,
          m.photo, m.isActive, m.oeeEnabled, now, now]
      );
      await saveMonitoringTags(conn, id, m.monitoringTags, new Set());
      return (await loadMachines(conn, id))[0];
    }).catch(mapDbError);
  },

  async update(id: string, body: unknown) {
    const data = await parseMachineInput(body, true);

    return withTransaction(async (conn) => {
      const [current] = await loadMachines(conn, id);
      if (!current) throw new HttpError(404, "Machine not found");

      const m = { ...current, ...data };
      await assertNoConflict(conn, m, id);
      await conn.query(
        `UPDATE machines SET machine_no = ?, machine_name = ?, tag_status = ?, tag_output = ?, tag_reject = ?,
          tag_product = ?, tag_speed = ?, output_unit = ?, reject_unit = ?, realtime_mode = ?, adaptive_ttl_min = ?, scale_config = ?,
          photo = ?, is_active = ?, oee_enabled = ?, updated_at = ? WHERE id = ?`,
        [m.machineNo, m.machineName, m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct, m.tagSpeed,
          m.outputUnit, m.rejectUnit, m.realtimeMode, m.adaptiveTtlMinutes, m.scale ? JSON.stringify(m.scale) : null,
          m.photo, m.isActive, m.oeeEnabled, new Date(), id]
      );
      if (data.monitoringTags) {
        const ownIds = new Set(current.monitoringTags.map((t) => t.id));
        await saveMonitoringTags(conn, id, data.monitoringTags, ownIds);
      }
      return (await loadMachines(conn, id))[0];
    }).catch(mapDbError);
  },

  /**
   * Sets some fields on several machines at once (units, realtime mode, adaptive expiry).
   * Body: `{ machineIds: string[] | "all", outputUnit?, rejectUnit?, realtimeMode?, adaptiveTtlMinutes? }`.
   */
  async bulkUpdate(body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const fields = BULK_FIELDS.filter(([key]) => key in b);
    if (!fields.length) throw new HttpError(400, "Choose a setting to apply");
    const values = fields.map(([key, , parse]) => parse(b[key]));

    const all = b.machineIds === "all";
    const ids = Array.isArray(b.machineIds) ? b.machineIds.filter((v): v is string => typeof v === "string") : [];
    if (!all && ids.length === 0) throw new HttpError(400, "Choose at least one machine");

    const sets = fields.map(([, column]) => `${column} = ?`).join(", ");
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE machines SET ${sets}, updated_at = ?${all ? "" : " WHERE id IN (?)"}`,
      all ? [...values, new Date()] : [...values, new Date(), ids]
    );
    return { updated: result.affectedRows };
  },

  async remove(id: string) {
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM machines WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "Machine not found");
  },
};
