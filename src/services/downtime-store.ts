import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type {
  DowntimeRecord,
  DowntimeRowCheck,
  DowntimeUploadRow,
  DowntimeUploadResult,
  DowntimeValidation,
} from "../types/downtime.js";

// Downtime uploaded from the downtime sheet (`downtime_records` + its machine in `downtime_record_machines`).
// One row is one machine, which must be registered exactly as written; everything else is stored as is.
// A row with the same date, machine text, bagger and start time as an earlier upload replaces it.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ROWS = 2000;

const str = (v: unknown, max: number) =>
  (typeof v === "string" ? v : v == null ? "" : String(v)).trim().replace(/\s+/g, " ").slice(0, max);

function isValidDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

interface MachineRef {
  id: string;
  no: string;
}

/** One row is one machine: the text must be a registered machine number exactly (only spaces around it are ignored). */
function resolveMachine(machineText: string, byNo: Map<string, MachineRef>): { machine: MachineRef | null; issue: string | null } {
  if (!machineText) return { machine: null, issue: "Machine is empty" };
  if (/[,;/&+]/.test(machineText)) {
    return { machine: null, issue: `"${machineText}" names more than one machine; put one machine per row` };
  }
  const machine = byNo.get(machineText) ?? null;
  return machine ? { machine, issue: null } : { machine: null, issue: `Machine "${machineText}" is not registered` };
}

interface CleanRow {
  rowNumber: number;
  productionDate: string;
  machineText: string;
  bagger: string;
  line: string;
  sku: string;
  start: string;
  end: string;
  durationSeconds: number | null;
  notificationNo: string;
  detail: string;
  operator: string;
  downtimeType: string;
  machine: MachineRef;
}

async function check(body: unknown, conn: PoolConnection | typeof pool = pool) {
  const raw = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(raw)) throw new HttpError(400, "rows must be a list");
  if (raw.length > MAX_ROWS) throw new HttpError(400, `At most ${MAX_ROWS} rows per upload`);

  const [machineRows] = await conn.query<RowDataPacket[]>("SELECT id, machine_no FROM machines");
  const byNo = new Map(machineRows.map((m) => [String(m.machine_no), { id: m.id, no: m.machine_no as string }]));

  const errors: string[] = [];
  if (!raw.length) errors.push("The sheet has no downtime rows");
  const checks: DowntimeRowCheck[] = [];
  const rows: CleanRow[] = [];
  for (const item of raw as Partial<DowntimeUploadRow>[]) {
    const r = item ?? {};
    const rowNumber = Number(r.rowNumber) || 0;
    const issues: string[] = [];
    const warnings: string[] = [];
    const productionDate = str(r.productionDate, 10);
    const machineText = str(r.machineText, 100);
    const bagger = str(r.bagger, 20);
    const start = str(r.start, 5);
    const end = str(r.end, 5);
    const duration = r.durationSeconds;

    if (!productionDate) issues.push("Date is empty");
    else if (!isValidDate(productionDate)) issues.push(`Date "${productionDate}" is not valid`);
    else if (r.dateFromAbove) warnings.push(`Date ${productionDate} taken from the row above`);

    const { machine, issue } = resolveMachine(machineText, byNo);
    if (issue) issues.push(issue);

    if (start && !TIME_PATTERN.test(start)) warnings.push(`Start "${start}" is not a time; not saved`);
    if (end && !TIME_PATTERN.test(end)) warnings.push(`End "${end}" is not a time; not saved`);
    const durationSeconds =
      typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= 7 * 86_400
        ? Math.round(duration)
        : null;
    if (durationSeconds === null) warnings.push("Duration is empty; counted as 0");

    checks.push({ rowNumber, machines: machine ? [machine.no] : [], issues, warnings });
    if (!issues.length && machine) {
      rows.push({
        rowNumber,
        productionDate,
        machineText,
        bagger,
        line: str(r.line, 50),
        sku: str(r.sku, 100),
        start: TIME_PATTERN.test(start) ? start : "",
        end: TIME_PATTERN.test(end) ? end : "",
        durationSeconds,
        notificationNo: str(r.notificationNo, 50),
        detail: str(r.detail, 2000),
        operator: str(r.operator, 100),
        downtimeType: str(r.downtimeType, 50).toUpperCase(),
        machine,
      });
    }
  }

  // The same row twice in one sheet would hit the unique key.
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = rowKey(r);
    const other = seen.get(k);
    if (other !== undefined) {
      checks.find((c) => c.rowNumber === r.rowNumber)?.issues.push(`Same date, machine and start as row ${other}`);
    } else seen.set(k, r.rowNumber);
  }

  let replaced = 0;
  if (rows.length) {
    const [existing] = await conn.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(production_date, '%Y-%m-%d') AS production_date, machine_text, bagger, start_time
        FROM downtime_records WHERE production_date IN (?)`,
      [[...new Set(rows.map((r) => r.productionDate))]]
    );
    const keys = new Set(
      existing.map((e) =>
        rowKey({
          productionDate: e.production_date,
          machineText: e.machine_text,
          bagger: e.bagger,
          start: e.start_time,
        })
      )
    );
    replaced = rows.filter((r) => keys.has(rowKey(r))).length;
  }

  const valid = !errors.length && checks.every((c) => !c.issues.length);
  const validation: DowntimeValidation = { valid, errors, rows: checks, replaced };
  return { validation, rows };
}

const rowKey = (r: { productionDate: string; machineText: string; bagger: string; start: string }) =>
  [r.productionDate, r.machineText.toLowerCase(), r.bagger.toLowerCase(), r.start].join("|");


export const downtimeStore = {
  async validate(body: unknown) {
    return (await check(body)).validation;
  },

  async upload(body: unknown): Promise<DowntimeUploadResult> {
    return withTransaction(async (conn) => {
      const { validation, rows } = await check(body, conn);
      if (!validation.valid) {
        throw new HttpError(400, "The sheet has errors. Check it and fix or ignore the rows before uploading");
      }
      const now = new Date();
      for (const r of rows) {
        await conn.query(
          `DELETE FROM downtime_records WHERE production_date = ? AND machine_text = ? AND bagger = ? AND start_time = ?`,
          [r.productionDate, r.machineText, r.bagger, r.start]
        );
        const id = randomUUID();
        await conn.query(
          `INSERT INTO downtime_records (id, production_date, machine_text, bagger, line, sku, start_time, end_time,
            duration_seconds, notification_no, detail, operator, downtime_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, r.productionDate, r.machineText, r.bagger, r.line, r.sku, r.start, r.end, r.durationSeconds,
            r.notificationNo, r.detail, r.operator, r.downtimeType, now, now]
        );
        await conn.query("INSERT INTO downtime_record_machines (record_id, machine_id, machine_no) VALUES (?, ?, ?)", [
          id,
          r.machine.id,
          r.machine.no,
        ]);
      }
      return { saved: rows.length, replaced: validation.replaced };
    });
  },

  async list(date: string): Promise<DowntimeRecord[]> {
    if (!isValidDate(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.*, DATE_FORMAT(r.production_date, '%Y-%m-%d') AS production_date FROM downtime_records r
        WHERE r.production_date = ? ORDER BY r.start_time, r.machine_text`,
      [date]
    );
    if (!rows.length) return [];
    const [machines] = await pool.query<RowDataPacket[]>(
      "SELECT record_id, machine_no FROM downtime_record_machines WHERE record_id IN (?)",
      [rows.map((r) => r.id)]
    );
    const byRecord = new Map<string, string[]>();
    for (const m of machines) byRecord.set(m.record_id, [...(byRecord.get(m.record_id) ?? []), m.machine_no]);
    return rows.map((r) => ({
      id: r.id,
      productionDate: r.production_date,
      machineText: r.machine_text,
      bagger: r.bagger,
      line: r.line,
      sku: r.sku,
      start: r.start_time,
      end: r.end_time,
      durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      notificationNo: r.notification_no,
      detail: r.detail,
      operator: r.operator,
      downtimeType: r.downtime_type,
      machines: (byRecord.get(r.id) ?? []).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      createdAt: (r.created_at as Date).toISOString(),
    }));
  },

  async remove(id: string) {
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM downtime_records WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "Downtime record not found");
  },
};
