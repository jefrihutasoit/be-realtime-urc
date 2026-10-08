import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { MachineInput, MachineRegistration, MonitoringTag, ProductionTagKey } from "../types/machine.js";

// Machine registry backed by MySQL (tables `machines` and `machine_monitoring_tags`).

export const PRODUCTION_TAGS: [ProductionTagKey, string][] = [
  ["tagStatus", "Tag status"],
  ["tagOutput", "Tag output"],
  ["tagReject", "Tag reject"],
  ["tagProduct", "Tag product"],
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
}

// ---------- validation ----------

// Tag names are free text: the gateway tag list is only a suggestion, so any address can be registered.
const MAX_TAG_LENGTH = 200;

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
    if (!name || !tagName) throw new HttpError(400, `Monitoring tag #${i + 1}: name and tag name are required`);
    if (name.length > 100) throw new HttpError(400, `Monitoring tag "${name.slice(0, 20)}…": name is too long`);
    if (tagName.length > MAX_TAG_LENGTH) throw new HttpError(400, `Monitoring tag "${name}": tag name is too long`);
    if (names.has(name.toLowerCase())) throw new HttpError(400, `Monitoring tag name "${name}" is used twice`);
    if (tagNames.has(tagName)) throw new HttpError(400, `Tag ${tagName} is used twice in monitoring tags`);
    names.add(name.toLowerCase());
    tagNames.add(tagName);
    tags.push({ id: typeof row.id === "string" ? row.id : "", name, tagName });
  }
  return tags;
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

  if (has("monitoringTags")) data.monitoringTags = parseMonitoringTags(b.monitoringTags ?? []);

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
    monitoringTags: tags,
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
    "SELECT id, machine_id, name, tag_name FROM machine_monitoring_tags WHERE machine_id IN (?) ORDER BY sort_order",
    [rows.map((r) => r.id)]
  );
  const tagsByMachine = new Map<string, MonitoringTag[]>();
  for (const t of tagRows) {
    const list = tagsByMachine.get(t.machine_id) ?? [];
    list.push({ id: t.id, name: t.name, tagName: t.tag_name });
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
  await conn.query("INSERT INTO machine_monitoring_tags (id, machine_id, name, tag_name, sort_order) VALUES ?", [
    saved.map((t, i) => [t.id, machineId, t.name, t.tagName, i]),
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
        `INSERT INTO machines (id, machine_no, machine_name, tag_status, tag_output, tag_reject, tag_product,
          photo, is_active, oee_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, m.machineNo, m.machineName, m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct,
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
          tag_product = ?, photo = ?, is_active = ?, oee_enabled = ?, updated_at = ? WHERE id = ?`,
        [m.machineNo, m.machineName, m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct,
          m.photo, m.isActive, m.oeeEnabled, new Date(), id]
      );
      if (data.monitoringTags) {
        const ownIds = new Set(current.monitoringTags.map((t) => t.id));
        await saveMonitoringTags(conn, id, data.monitoringTags, ownIds);
      }
      return (await loadMachines(conn, id))[0];
    }).catch(mapDbError);
  },

  async remove(id: string) {
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM machines WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "Machine not found");
  },
};
