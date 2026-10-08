import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import { MANUAL_INPUT_DAYS } from "../types/reject.js";
import type {
  ManualRejectInput,
  RejectRecord,
  RejectRowCheck,
  RejectType,
  RejectUploadInput,
  RejectUploadResult,
  RejectUploadRow,
  RejectValidation,
  RunningSku,
  RunningSkus,
} from "../types/reject.js";

// Reject data per machine, shift and SKU (`reject_records` + `reject_record_items`), uploaded from the
// shift reject sheet or entered by hand. Reject categories live in `reject_types`; they are registered
// on the Reject Types page, and uploads create the ones a sheet adds.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 500;

interface RejectTypeRow extends RowDataPacket {
  id: string;
  name: string;
  sort_order: number;
}

interface RecordRow extends RowDataPacket {
  id: string;
  production_date: string;
  shift_id: string;
  shift_name: string;
  machine_id: string;
  machine_no: string;
  operator: string;
  sku_master_id: string | null;
  sku_id: string;
  product_name: string;
  sku: string;
  created_at: Date;
  updated_at: Date;
}

const toType = (r: RejectTypeRow): RejectType => ({ id: r.id, name: r.name, sortOrder: r.sort_order });

/** Collapses whitespace; used for names that are stored. */
const clean = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().replace(/\s+/g, " ");
/** Comparison key: case- and space-insensitive, so "15 gr" matches "15gr". */
const key = (v: unknown) => clean(v).toLowerCase().replace(/ /g, "");

function isValidDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Empty cells count as 0. Returns null when the value is not a whole number ≥ 0. */
function parseQuantity(value: unknown): number | null {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 4_000_000_000 ? value : null;
  const s = String(value).trim();
  if (!s) return 0;
  return /^\d{1,10}$/.test(s) && Number(s) <= 4_000_000_000 ? Number(s) : null;
}

// ---------- validation ----------

interface ResolvedRow {
  machineId: string;
  machineNo: string;
  operator: string;
  sku: { id: string; skuId: string; productName: string; sku: string };
  /** Quantity per reject type name (as in the sheet header); only quantities > 0. */
  quantities: [string, number][];
}

interface Checked {
  validation: RejectValidation;
  date: string;
  shift: { id: string; name: string } | null;
  typeNames: string[];
  rows: ResolvedRow[];
}

function asInput(body: unknown): RejectUploadInput {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.rows) || !Array.isArray(b.rejectTypes)) throw new HttpError(400, "rows and rejectTypes are required");
  if (b.rows.length > MAX_ROWS) throw new HttpError(400, `Too many rows (max ${MAX_ROWS})`);
  return {
    productionDate: clean(b.productionDate),
    shiftId: clean(b.shiftId),
    rejectTypes: b.rejectTypes.map(clean),
    rows: b.rows.map((r: unknown, i): RejectUploadRow => {
      const row = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
      return {
        rowNumber: Number.isInteger(row.rowNumber) ? (row.rowNumber as number) : i + 1,
        machineNo: clean(row.machineNo),
        operator: clean(row.operator),
        sku: clean(row.sku),
        flavor: clean(row.flavor),
        quantities: Array.isArray(row.quantities) ? (row.quantities as RejectUploadRow["quantities"]) : [],
      };
    }),
  };
}

async function check(body: unknown, conn: PoolConnection | typeof pool = pool): Promise<Checked> {
  const input = asInput(body);
  const errors: string[] = [];

  if (!input.productionDate) errors.push("Production date is required");
  else if (!isValidDate(input.productionDate)) errors.push(`Invalid production date "${input.productionDate}"`);

  const [shiftRows] = await conn.query<RowDataPacket[]>("SELECT id, name FROM shifts WHERE id = ?", [input.shiftId]);
  const shift = shiftRows[0] ? { id: shiftRows[0].id as string, name: shiftRows[0].name as string } : null;
  if (!input.shiftId) errors.push("Shift is required");
  else if (!shift) errors.push("Shift not found");

  // Reject type columns
  const typeNames = input.rejectTypes;
  if (!typeNames.length) errors.push("The sheet has no reject type columns");
  const seenTypes = new Set<string>();
  for (const name of typeNames) {
    if (!name) errors.push("A reject type column has no name");
    else if (name.length > 100) errors.push(`Reject type "${name}" is too long (max 100)`);
    else if (seenTypes.has(key(name))) errors.push(`Reject type "${name}" appears more than once`);
    seenTypes.add(key(name));
  }
  const existingTypes = new Set((await listTypes(conn)).map((t) => key(t.name)));
  const newRejectTypes = typeNames.filter((n) => n && !existingTypes.has(key(n)));

  // Masters
  const [machineRows] = await conn.query<RowDataPacket[]>("SELECT id, machine_no FROM machines");
  const machines = new Map(machineRows.map((m) => [key(m.machine_no), { id: m.id as string, no: m.machine_no as string }]));
  const [skuRows] = await conn.query<RowDataPacket[]>("SELECT id, sku_id, product_name, sku FROM skus");
  const skus = new Map(
    skuRows.map((s) => [
      `${key(s.sku)}|${key(s.product_name)}`,
      { id: s.id as string, skuId: s.sku_id as string, productName: s.product_name as string, sku: s.sku as string },
    ])
  );

  if (!input.rows.length) errors.push("The sheet has no machine rows with data");

  const seenMachines = new Map<string, number>();
  const checks: RejectRowCheck[] = [];
  const rows: ResolvedRow[] = [];
  for (const r of input.rows) {
    const issues: string[] = [];
    const warnings: string[] = [];
    const machine = r.machineNo ? machines.get(key(r.machineNo)) : undefined;
    const base = { rowNumber: r.rowNumber, machineNo: r.machineNo, machineId: machine?.id ?? null };

    // Without a SKU there is nothing to record: the row is skipped with a warning, even when the
    // machine code is not registered (the sheet may list machines that are not in the system).
    if (!r.sku) {
      warnings.push(
        !r.machineNo
          ? "MC and SKU are empty; row skipped"
          : machine
            ? "SKU is empty; row skipped"
            : `Machine "${r.machineNo}" is not registered and SKU is empty; row skipped`
      );
      checks.push({ ...base, skuMasterId: null, skuId: null, issues, warnings, skipped: true });
      continue;
    }

    // With a SKU, the machine and the SKU must both match the master data.
    if (!r.machineNo) issues.push("Machine number (MC) is empty");
    else if (!machine) issues.push(`Machine "${r.machineNo}" is not registered`);
    else if (seenMachines.has(machine.id)) issues.push(`Machine "${r.machineNo}" also appears in row ${seenMachines.get(machine.id)}`);
    if (machine && !seenMachines.has(machine.id)) seenMachines.set(machine.id, r.rowNumber);

    const sku = skus.get(`${key(r.sku)}|${key(r.flavor)}`);
    if (!r.flavor) issues.push("FLV is empty");
    else if (!sku) {
      // Say what is registered for this product, since a size / product mix-up is the usual cause.
      const sizes = skuRows.filter((s) => key(s.product_name) === key(r.flavor)).map((s) => s.sku as string);
      issues.push(
        `SKU "${r.sku}" with product "${r.flavor}" is not in the SKU master` +
          (sizes.length ? ` (registered for ${r.flavor}: ${sizes.join(", ")})` : ` (no SKU registered for ${r.flavor})`)
      );
    }

    if (!r.operator) warnings.push("Operator is empty");
    else if (r.operator.length > 100) issues.push("Operator is too long (max 100)");

    const quantities: [string, number][] = [];
    typeNames.forEach((name, i) => {
      const q = parseQuantity(r.quantities[i]);
      if (q === null) issues.push(`${name}: "${r.quantities[i]}" is not a whole number`);
      else if (q > 0) quantities.push([name, q]);
    });

    checks.push({ ...base, skuMasterId: sku?.id ?? null, skuId: sku?.skuId ?? null, issues, warnings, skipped: false });
    if (!issues.length && machine && sku) {
      rows.push({ machineId: machine.id, machineNo: machine.no, operator: r.operator, sku, quantities });
    }
  }
  if (input.rows.length && checks.every((c) => c.skipped)) errors.push("No row has a SKU, so there is nothing to upload");

  let replacedMachines: string[] = [];
  if (shift && isValidDate(input.productionDate) && rows.length) {
    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT machine_no FROM reject_records WHERE production_date = ? AND shift_id = ? AND machine_id IN (?)",
      [input.productionDate, shift.id, rows.map((r) => r.machineId)]
    );
    replacedMachines = existing.map((e) => e.machine_no as string);
  }

  const valid = !errors.length && checks.every((c) => !c.issues.length);
  return {
    validation: { valid, errors, rows: checks, newRejectTypes, replacedMachines },
    date: input.productionDate,
    shift,
    typeNames,
    rows,
  };
}

// ---------- store ----------

async function listTypes(conn: PoolConnection | typeof pool = pool) {
  const [rows] = await conn.query<RejectTypeRow[]>("SELECT * FROM reject_types ORDER BY sort_order, name");
  return rows.map(toType);
}

/** Ids of the named reject types, creating the missing ones at the end of the list. */
async function ensureTypes(conn: PoolConnection, names: string[]) {
  const types = await listTypes(conn);
  const ids = new Map(types.map((t) => [key(t.name), t.id]));
  let order = types.reduce((max, t) => Math.max(max, t.sortOrder), 0);
  const created: string[] = [];
  for (const name of names) {
    if (ids.has(key(name))) continue;
    const id = randomUUID();
    await conn.query("INSERT INTO reject_types (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)", [
      id,
      name,
      ++order,
      new Date(),
    ]);
    ids.set(key(name), id);
    created.push(name);
  }
  return { idOf: (name: string) => ids.get(key(name))!, created };
}

// ---------- reject types ----------

function parseTypeInput(body: unknown, current?: RejectType): { name: string; sortOrder?: number } {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const name = "name" in b || !current ? clean(b.name) : current.name;
  if (!name) throw new HttpError(400, "Reject type name is required");
  if (name.length > 100) throw new HttpError(400, "Reject type name is too long (max 100)");
  if (b.sortOrder === undefined || b.sortOrder === null) return { name };
  if (!Number.isInteger(b.sortOrder) || (b.sortOrder as number) < 0 || (b.sortOrder as number) > 9999) {
    throw new HttpError(400, "Order must be a whole number from 0 to 9999");
  }
  return { name, sortOrder: b.sortOrder as number };
}

async function assertTypeNameFree(name: string, excludeId = "") {
  const clash = (await listTypes()).find((t) => t.id !== excludeId && key(t.name) === key(name));
  if (clash) throw new HttpError(409, `Reject type "${clash.name}" already exists`);
}

async function getType(id: string) {
  const [rows] = await pool.query<RejectTypeRow[]>("SELECT * FROM reject_types WHERE id = ?", [id]);
  return rows[0] ? toType(rows[0]) : undefined;
}

// ---------- manual input ----------

const pad = (n: number) => String(n).padStart(2, "0");
const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Production dates open for manual input (server local time), newest first. */
export function manualInputDates(now = new Date()) {
  return Array.from({ length: MANUAL_INPUT_DAYS }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    return localYmd(d);
  });
}

/** The occurrence of a shift that starts on `date` (a shift over midnight ends the next day). */
async function shiftOn(date: string, shiftId: string, conn: PoolConnection | typeof pool) {
  if (!isValidDate(date)) throw new HttpError(400, "Date must be YYYY-MM-DD");
  const [rows] = await conn.query<RowDataPacket[]>("SELECT * FROM shifts WHERE id = ?", [shiftId]);
  const s = rows[0];
  if (!s) throw new HttpError(404, "Shift not found");
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, s.start_minute);
  const minutes = (s.end_minute - s.start_minute + 1440) % 1440 || 1440;
  return { id: s.id as string, name: s.name as string, start, end: new Date(start.getTime() + minutes * 60_000) };
}

/**
 * SKUs in the SKU master whose ID was in the machine's product tag during the shift:
 * the value at shift start plus every value recorded during the shift.
 */
async function findRunningSkus(
  machineId: string,
  date: string,
  shiftId: string,
  conn: PoolConnection | typeof pool = pool
) {
  const [machines] = await conn.query<RowDataPacket[]>("SELECT id, machine_no, tag_product FROM machines WHERE id = ?", [
    machineId,
  ]);
  const machine = machines[0];
  if (!machine) throw new HttpError(404, "Machine not found");
  const shift = await shiftOn(date, shiftId, conn);

  const [during] = await conn.query<RowDataPacket[]>(
    "SELECT DISTINCT tag_value FROM tag_values WHERE tag_name = ? AND recorded_at >= ? AND recorded_at < ?",
    [machine.tag_product, shift.start, shift.end]
  );
  const [before] = await conn.query<RowDataPacket[]>(
    "SELECT tag_value FROM tag_values WHERE tag_name = ? AND recorded_at < ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
    [machine.tag_product, shift.start]
  );
  const codes = new Set(
    [...before, ...during].map((r) => {
      const code = String(r.tag_value).trim().toLowerCase();
      // Numeric codes also match after normalising ("10.0" → "10"), as in the OEE poller.
      return code && Number.isFinite(Number(code)) ? String(Number(code)) : code;
    })
  );

  const [skuRows] = await conn.query<RowDataPacket[]>("SELECT id, sku_id, product_name, sku FROM skus");
  const skus: RunningSku[] = skuRows
    .filter((s) => codes.has(String(s.sku_id).toLowerCase()))
    .map((s) => ({ skuMasterId: s.id, skuId: s.sku_id, productName: s.product_name, sku: s.sku }))
    .sort((a, b) => a.skuId.localeCompare(b.skuId, undefined, { numeric: true }));
  const result: RunningSkus = { start: shift.start.toISOString(), end: shift.end.toISOString(), skus };
  return { machine, shift, result };
}

function parseManualInput(body: unknown): ManualRejectInput {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const input: ManualRejectInput = {
    productionDate: clean(b.productionDate),
    shiftId: clean(b.shiftId),
    machineId: clean(b.machineId),
    skuMasterId: clean(b.skuMasterId),
    operator: clean(b.operator),
    items: [],
  };
  const dates = manualInputDates();
  if (!dates.includes(input.productionDate)) {
    throw new HttpError(
      400,
      `Manual input is only allowed for the last ${MANUAL_INPUT_DAYS} days (${dates.at(-1)} to ${dates[0]})`
    );
  }
  if (!input.shiftId) throw new HttpError(400, "Shift is required");
  if (!input.machineId) throw new HttpError(400, "Machine is required");
  if (!input.skuMasterId) throw new HttpError(400, "SKU is required");
  if (!input.operator) throw new HttpError(400, "Operator is required");
  if (input.operator.length > 100) throw new HttpError(400, "Operator is too long (max 100)");

  if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "Add at least one reject type");
  const seen = new Set<string>();
  for (const raw of b.items as unknown[]) {
    const item = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const rejectTypeId = clean(item.rejectTypeId);
    if (!rejectTypeId) throw new HttpError(400, "Select a reject type on every line");
    if (seen.has(rejectTypeId)) throw new HttpError(400, "Each reject type can only be entered once");
    seen.add(rejectTypeId);
    const quantity = parseQuantity(item.quantity);
    if (quantity === null) throw new HttpError(400, "Quantity must be a whole number of 0 or more");
    input.items.push({ rejectTypeId, quantity });
  }
  if (!input.items.some((i) => i.quantity > 0)) throw new HttpError(400, "Enter a quantity greater than 0");
  return input;
}

// ---------- records ----------

async function selectRecords(where: string, params: unknown[]): Promise<RejectRecord[]> {
  const [rows] = await pool.query<RecordRow[]>(
    `SELECT r.*, DATE_FORMAT(r.production_date, '%Y-%m-%d') AS production_date FROM reject_records r WHERE ${where}`,
    params
  );
  if (!rows.length) return [];
  const [items] = await pool.query<RowDataPacket[]>(
    "SELECT record_id, reject_type_id, quantity FROM reject_record_items WHERE record_id IN (?)",
    [rows.map((r) => r.id)]
  );
  const byRecord = new Map<string, Record<string, number>>();
  for (const it of items) {
    const q = byRecord.get(it.record_id) ?? {};
    q[it.reject_type_id] = it.quantity;
    byRecord.set(it.record_id, q);
  }
  return rows
    .map((r): RejectRecord => {
      const quantities = byRecord.get(r.id) ?? {};
      return {
        id: r.id,
        productionDate: r.production_date,
        shiftId: r.shift_id,
        shiftName: r.shift_name,
        machineId: r.machine_id,
        machineNo: r.machine_no,
        operator: r.operator,
        skuMasterId: r.sku_master_id,
        skuId: r.sku_id,
        productName: r.product_name,
        sku: r.sku,
        quantities,
        total: Object.values(quantities).reduce((a, b) => a + b, 0),
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      };
    })
    .sort(
      (a, b) =>
        a.shiftName.localeCompare(b.shiftName, undefined, { numeric: true }) ||
        a.machineNo.localeCompare(b.machineNo, undefined, { numeric: true }) ||
        a.skuId.localeCompare(b.skuId, undefined, { numeric: true })
    );
}

export const rejectStore = {
  listTypes: () => listTypes(),

  async createType(body: unknown) {
    const data = parseTypeInput(body);
    await assertTypeNameFree(data.name);
    const order = data.sortOrder ?? (await listTypes()).reduce((max, t) => Math.max(max, t.sortOrder), 0) + 1;
    const id = randomUUID();
    await pool.query("INSERT INTO reject_types (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)", [
      id,
      data.name,
      order,
      new Date(),
    ]);
    return (await getType(id))!;
  },

  async updateType(id: string, body: unknown) {
    const current = await getType(id);
    if (!current) throw new HttpError(404, "Reject type not found");
    const data = parseTypeInput(body, current);
    await assertTypeNameFree(data.name, id);
    await pool.query("UPDATE reject_types SET name = ?, sort_order = ? WHERE id = ?", [
      data.name,
      data.sortOrder ?? current.sortOrder,
      id,
    ]);
    return (await getType(id))!;
  },

  /** Refused while reject records use the type. */
  async removeType(id: string) {
    const current = await getType(id);
    if (!current) throw new HttpError(404, "Reject type not found");
    const [[{ used }]] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS used FROM reject_record_items WHERE reject_type_id = ?",
      [id]
    );
    if (used > 0) {
      throw new HttpError(409, `"${current.name}" is used in ${used} reject record(s) and cannot be deleted`);
    }
    await pool.query("DELETE FROM reject_types WHERE id = ?", [id]);
  },

  async validate(body: unknown) {
    return (await check(body)).validation;
  },

  /** Saves the sheet only when every row is valid; machines already uploaded for the date and shift are replaced. */
  async upload(body: unknown): Promise<RejectUploadResult> {
    return withTransaction(async (conn) => {
      const { validation, date, shift, typeNames, rows } = await check(body, conn);
      if (!validation.valid || !shift) {
        throw new HttpError(400, "The sheet has errors. Validate it and fix the problems before uploading");
      }
      const { idOf, created } = await ensureTypes(conn, typeNames);
      const now = new Date();

      await conn.query("DELETE FROM reject_records WHERE production_date = ? AND shift_id = ? AND machine_id IN (?)", [
        date,
        shift.id,
        rows.map((r) => r.machineId),
      ]);
      for (const r of rows) {
        const id = randomUUID();
        await conn.query(
          `INSERT INTO reject_records (id, production_date, shift_id, shift_name, machine_id, machine_no, operator,
            sku_master_id, sku_id, product_name, sku, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, date, shift.id, shift.name, r.machineId, r.machineNo, r.operator, r.sku.id, r.sku.skuId,
            r.sku.productName, r.sku.sku, now, now]
        );
        if (r.quantities.length) {
          await conn.query("INSERT INTO reject_record_items (record_id, reject_type_id, quantity) VALUES ?", [
            r.quantities.map(([name, q]) => [id, idOf(name), q]),
          ]);
        }
      }
      return { saved: rows.length, replaced: validation.replacedMachines.length, createdTypes: created };
    });
  },

  /** Records of one production date, optionally one shift. */
  async list(date: string, shiftId?: string): Promise<RejectRecord[]> {
    if (!isValidDate(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    return shiftId
      ? selectRecords("r.production_date = ? AND r.shift_id = ?", [date, shiftId])
      : selectRecords("r.production_date = ?", [date]);
  },

  manualInputDates: () => manualInputDates(),

  /** Reject input per machine and lower-cased SKU ID for one shift occurrence, for the OEE calculation. */
  async shiftTotals(date: string, shiftId: string) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.machine_id, r.sku_id, SUM(i.quantity) AS qty FROM reject_records r
        JOIN reject_record_items i ON i.record_id = r.id
        WHERE r.production_date = ? AND r.shift_id = ? GROUP BY r.machine_id, r.sku_id`,
      [date, shiftId]
    );
    const totals = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const bySku = totals.get(r.machine_id) ?? {};
      const sku = String(r.sku_id).toLowerCase();
      bySku[sku] = (bySku[sku] ?? 0) + Number(r.qty);
      totals.set(r.machine_id, bySku);
    }
    return totals;
  },

  async runningSkus(machineId: string, date: string, shiftId: string): Promise<RunningSkus> {
    return (await findRunningSkus(machineId, date, shiftId)).result;
  },

  /** Creates or replaces the record of one machine, shift and SKU. */
  async saveManual(body: unknown): Promise<RejectRecord> {
    const input = parseManualInput(body);
    const id = await withTransaction(async (conn) => {
      const { machine, shift, result } = await findRunningSkus(
        input.machineId,
        input.productionDate,
        input.shiftId,
        conn
      );
      const sku = result.skus.find((s) => s.skuMasterId === input.skuMasterId);
      if (!sku) {
        throw new HttpError(
          400,
          `The selected SKU did not run on machine ${machine.machine_no} in ${shift.name} on ${input.productionDate}`
        );
      }
      const typeIds = new Set((await listTypes(conn)).map((t) => t.id));
      if (input.items.some((i) => !typeIds.has(i.rejectTypeId))) {
        throw new HttpError(400, "A reject type is not registered. Register it in Reject Types first");
      }

      const now = new Date();
      const [existing] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM reject_records WHERE production_date = ? AND shift_id = ? AND machine_id = ? AND sku_id = ?",
        [input.productionDate, shift.id, machine.id, sku.skuId]
      );
      let recordId = existing[0]?.id as string | undefined;
      if (recordId) {
        await conn.query(
          `UPDATE reject_records SET shift_name = ?, machine_no = ?, operator = ?, sku_master_id = ?, product_name = ?,
            sku = ?, updated_at = ? WHERE id = ?`,
          [shift.name, machine.machine_no, input.operator, sku.skuMasterId, sku.productName, sku.sku, now, recordId]
        );
        await conn.query("DELETE FROM reject_record_items WHERE record_id = ?", [recordId]);
      } else {
        recordId = randomUUID();
        await conn.query(
          `INSERT INTO reject_records (id, production_date, shift_id, shift_name, machine_id, machine_no, operator,
            sku_master_id, sku_id, product_name, sku, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [recordId, input.productionDate, shift.id, shift.name, machine.id, machine.machine_no, input.operator,
            sku.skuMasterId, sku.skuId, sku.productName, sku.sku, now, now]
        );
      }
      const items = input.items.filter((i) => i.quantity > 0);
      await conn.query("INSERT INTO reject_record_items (record_id, reject_type_id, quantity) VALUES ?", [
        items.map((i) => [recordId, i.rejectTypeId, i.quantity]),
      ]);
      return recordId;
    });
    return (await selectRecords("r.id = ?", [id]))[0];
  },

  async remove(id: string) {
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM reject_records WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "Reject record not found");
  },
};
