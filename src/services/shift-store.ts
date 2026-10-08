import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { Shift, ShiftPeriod } from "../types/shift.js";

// Shift definitions in `shifts`. The OEE engine needs the current shift synchronously on every poll,
// so the definitions are cached in memory: loaded at startup and refreshed after every change.

const DAY = 1440;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface ShiftRow extends RowDataPacket {
  id: string;
  name: string;
  start_minute: number;
  end_minute: number;
  created_at: Date;
  updated_at: Date;
}

interface ShiftDef {
  id: string;
  name: string;
  start: number;
  /** Length in minutes, 1..1440. */
  duration: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLabel = (minute: number) => `${pad(Math.floor((minute % DAY) / 60))}:${pad(minute % 60)}`;
const durationOf = (start: number, end: number) => (end - start + DAY) % DAY || DAY;

const toShift = (r: ShiftRow): Shift => ({
  id: r.id,
  name: r.name,
  start: toLabel(r.start_minute),
  end: toLabel(r.end_minute),
  durationMinutes: durationOf(r.start_minute, r.end_minute),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

let cache: ShiftDef[] = [];

async function selectAll() {
  const [rows] = await pool.query<ShiftRow[]>("SELECT * FROM shifts ORDER BY start_minute");
  return rows;
}

/** Reloads the in-memory shift definitions from the database. */
export async function loadShifts() {
  cache = (await selectAll()).map((r) => ({
    id: r.id,
    name: r.name,
    start: r.start_minute,
    duration: durationOf(r.start_minute, r.end_minute),
  }));
}

// ---------- current period ----------

/** Local midnight of the day `offset` days from `at`. */
function midnight(at: Date, offset: number) {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

function addMinutes(d: Date, minutes: number) {
  const r = new Date(d);
  r.setMinutes(r.getMinutes() + minutes);
  return r;
}

/**
 * The shift occurrence containing `at`. Time outside every shift belongs to a "No shift" gap that
 * runs from the end of the previous shift to the start of the next one.
 */
export function shiftPeriodAt(at: Date): ShiftPeriod {
  const occurrences = [-1, 0, 1, 2].flatMap((offset) =>
    cache.map((s) => {
      const start = addMinutes(midnight(at, offset), s.start);
      return { def: s, start, end: addMinutes(start, s.duration) };
    })
  );

  const current = occurrences.find((o) => o.start <= at && at < o.end);
  if (current) {
    return {
      shiftId: current.def.id,
      name: current.def.name,
      start: current.start.toISOString(),
      end: current.end.toISOString(),
      startLabel: toLabel(current.def.start),
      endLabel: toLabel(current.def.start + current.def.duration),
    };
  }

  const previousEnd = occurrences
    .map((o) => o.end)
    .filter((e) => e <= at)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const nextStart = occurrences
    .map((o) => o.start)
    .filter((s) => s > at)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const start = previousEnd ?? midnight(at, 0);
  const end = nextStart ?? midnight(at, 1);
  const label = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    shiftId: null,
    name: "No shift",
    start: start.toISOString(),
    end: end.toISOString(),
    startLabel: label(start),
    endLabel: label(end),
  };
}

// ---------- validation ----------

function parseTime(value: unknown, label: string) {
  const m = typeof value === "string" ? TIME_PATTERN.exec(value.trim()) : null;
  if (!m) throw new HttpError(400, `${label} must be a time in HH:mm format`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True when two shifts share any minute, including across midnight. */
function overlaps(a: ShiftDef, b: ShiftDef) {
  return [-DAY, 0, DAY].some((k) => a.start < b.start + k + b.duration && b.start + k < a.start + a.duration);
}

async function parseAndCheck(body: unknown, current?: ShiftRow) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;

  const name = "name" in b || !current ? (typeof b.name === "string" ? b.name.trim() : "") : current.name;
  if (!name) throw new HttpError(400, "Shift name is required");
  if (name.length > 50) throw new HttpError(400, "Shift name is too long (max 50)");
  const start = "start" in b || !current ? parseTime(b.start, "Start") : current.start_minute;
  const end = "end" in b || !current ? parseTime(b.end, "End") : current.end_minute;
  if (start === end) throw new HttpError(400, "Start and end must be different");

  const candidate: ShiftDef = { id: current?.id ?? "", name, start, duration: durationOf(start, end) };
  for (const r of await selectAll()) {
    if (r.id === current?.id) continue;
    if (r.name.toLowerCase() === name.toLowerCase()) throw new HttpError(409, `Shift "${r.name}" already exists`);
    const other = { id: r.id, name: r.name, start: r.start_minute, duration: durationOf(r.start_minute, r.end_minute) };
    if (overlaps(candidate, other)) {
      throw new HttpError(
        409,
        `Overlaps with ${r.name} (${toLabel(r.start_minute)}–${toLabel(r.end_minute)})`
      );
    }
  }
  return { name, start, end };
}

// ---------- store ----------

async function getRow(id: string) {
  const [rows] = await pool.query<ShiftRow[]>("SELECT * FROM shifts WHERE id = ?", [id]);
  return rows[0];
}

export const shiftStore = {
  async list() {
    return (await selectAll()).map(toShift);
  },

  async create(body: unknown) {
    const s = await parseAndCheck(body);
    const id = randomUUID();
    const now = new Date();
    await pool.query(
      "INSERT INTO shifts (id, name, start_minute, end_minute, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, s.name, s.start, s.end, now, now]
    );
    await loadShifts();
    return toShift((await getRow(id))!);
  },

  async update(id: string, body: unknown) {
    const row = await getRow(id);
    if (!row) throw new HttpError(404, "Shift not found");
    const s = await parseAndCheck(body, row);
    await pool.query(
      "UPDATE shifts SET name = ?, start_minute = ?, end_minute = ?, updated_at = ? WHERE id = ?",
      [s.name, s.start, s.end, new Date(), id]
    );
    await loadShifts();
    return toShift((await getRow(id))!);
  },

  async remove(id: string) {
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM shifts WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "Shift not found");
    await loadShifts();
  },
};
