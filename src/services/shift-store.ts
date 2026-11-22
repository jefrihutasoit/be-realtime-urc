import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { Shift, ShiftPeriod } from "../types/shift.js";

// Shift definitions in `shifts`. The OEE engine needs the current shift synchronously on every poll,
// so the definitions are cached in memory: loaded at startup and refreshed after every change.

const DAY = 1440;
const WEEK = 7 * DAY;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface ShiftRow extends RowDataPacket {
  id: string;
  name: string;
  start_minute: number;
  end_minute: number;
  days: string;
  day_times: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ShiftDef {
  id: string;
  name: string;
  start: number;
  /** Length in minutes, 1..1440. */
  duration: number;
  /** Weekdays the shift starts on (0 = Sunday ... 6 = Saturday). */
  days: number[];
  /** Other start / length on some of those weekdays. */
  dayTimes: Record<number, { start: number; duration: number }>;
}

/** Start and length of a shift on a weekday; null when it does not run that day. */
export function timesOn(def: Pick<ShiftDef, "start" | "duration" | "days" | "dayTimes">, weekday: number) {
  if (!def.days.includes(weekday)) return null;
  return def.dayTimes[weekday] ?? { start: def.start, duration: def.duration };
}

/** Stored JSON {"6": [start, end]} -> per weekday start / length, only for days the shift runs. */
function dayTimesOf(text: string | null | undefined, days: number[]) {
  const out: Record<number, { start: number; duration: number }> = {};
  try {
    const raw = JSON.parse(text || "{}") as Record<string, [number, number]>;
    for (const [d, v] of Object.entries(raw)) {
      const day = Number(d);
      if (days.includes(day) && Array.isArray(v) && v[0] !== v[1]) out[day] = { start: v[0], duration: durationOf(v[0], v[1]) };
    }
  } catch {
    // Unreadable: the default times apply.
  }
  return out;
}

const endOf = (t: { start: number; duration: number }) => (t.start + t.duration) % DAY;

/** Validates other times per day: `[{ day, start: "HH:mm", end: "HH:mm" }]`, only for days the shift runs. */
export function parseDayTimes(value: unknown, days: number[], label = "Day times") {
  const out: Record<number, { start: number; duration: number }> = {};
  if (value === undefined || value === null) return out;
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list`);
  for (const item of value) {
    const r = (item ?? {}) as Record<string, unknown>;
    const day = r.day;
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) throw new HttpError(400, `${label}: day must be 0 to 6`);
    const name = DAY_NAMES[day as number];
    if (day as number in out) throw new HttpError(400, `${label}: ${name} is set twice`);
    if (!days.includes(day as number)) throw new HttpError(400, `${label}: the shift does not run on ${name}`);
    const start = parseTime(r.start, `${name} start`);
    const end = parseTime(r.end, `${name} end`);
    if (start === end) throw new HttpError(400, `${name}: start and end must be different`);
    out[day as number] = { start, duration: durationOf(start, end) };
  }
  return out;
}

const dayTimesJson = (t: Record<number, { start: number; duration: number }>) =>
  Object.keys(t).length ? JSON.stringify(Object.fromEntries(Object.entries(t).map(([d, v]) => [d, [v.start, endOf(v)]]))) : null;

/** "0,1,2" -> [0, 1, 2]; an empty or unreadable value means every day. */
export function daysOf(text: string | null | undefined) {
  const list = [...new Set(String(text ?? "").split(",").filter(Boolean).map(Number))].filter(
    (d) => Number.isInteger(d) && d >= 0 && d <= 6
  );
  return list.length ? list.sort() : [...ALL_DAYS];
}

/** Validates a days list; missing = every day. */
export function parseDays(value: unknown, label = "Days"): number[] {
  if (value === undefined || value === null) return [...ALL_DAYS];
  if (!Array.isArray(value) || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new HttpError(400, `${label} must be weekdays 0 (Sunday) to 6 (Saturday)`);
  }
  const days = [...new Set(value as number[])].sort();
  if (!days.length) throw new HttpError(400, "Choose at least one day");
  return days;
}

const pad = (n: number) => String(n).padStart(2, "0");
const toLabel = (minute: number) => `${pad(Math.floor((minute % DAY) / 60))}:${pad(minute % 60)}`;
export const durationOf = (start: number, end: number) => (end - start + DAY) % DAY || DAY;

const toShift = (r: ShiftRow): Shift => ({
  id: r.id,
  name: r.name,
  start: toLabel(r.start_minute),
  end: toLabel(r.end_minute),
  durationMinutes: durationOf(r.start_minute, r.end_minute),
  days: daysOf(r.days),
  dayTimes: Object.entries(dayTimesOf(r.day_times, daysOf(r.days))).map(([d, t]) => ({
    day: Number(d),
    start: toLabel(t.start),
    end: toLabel(t.start + t.duration),
    durationMinutes: t.duration,
  })),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

let cache: ShiftDef[] = [];

/** Current shift definitions (start in minutes after midnight, duration in minutes). */
export const shiftDefs = (): readonly ShiftDef[] => cache;

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
    days: daysOf(r.days),
    dayTimes: dayTimesOf(r.day_times, daysOf(r.days)),
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
  // Occurrences around `at`, each only on the weekdays its shift runs (by the day it starts).
  const occurrences = [-1, 0, 1, 2].flatMap((offset) => {
    const day = midnight(at, offset);
    return cache.flatMap((s) => {
      const t = timesOn(s, day.getDay());
      if (!t) return [];
      const start = addMinutes(day, t.start);
      return [{ def: s, times: t, start, end: addMinutes(start, t.duration) }];
    });
  });

  const current = occurrences.find((o) => o.start <= at && at < o.end);
  if (current) {
    return {
      shiftId: current.def.id,
      name: current.def.name,
      start: current.start.toISOString(),
      end: current.end.toISOString(),
      startLabel: toLabel(current.times.start),
      endLabel: toLabel(current.times.start + current.times.duration),
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

export function parseTime(value: unknown, label: string) {
  const m = typeof value === "string" ? TIME_PATTERN.exec(value.trim()) : null;
  if (!m) throw new HttpError(400, `${label} must be a time in HH:mm format`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True when two shifts share any minute on a day both run, including across midnight and the week end. */
export function overlaps(a: ShiftDef, b: ShiftDef) {
  for (const da of a.days) {
    const ta = timesOn(a, da)!;
    const aStart = da * DAY + ta.start;
    for (const db of b.days) {
      const tb = timesOn(b, db)!;
      const bStart = db * DAY + tb.start;
      if ([-WEEK, 0, WEEK].some((k) => aStart < bStart + k + tb.duration && bStart + k < aStart + ta.duration)) return true;
    }
  }
  return false;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export { dayTimesJson };
/** "every day" or "Mon, Tue, Sat". */
export const daysLabel = (days: number[]) => (days.length === 7 ? "every day" : days.map((d) => DAY_NAMES[d]).join(", "));

async function parseAndCheck(body: unknown, current?: ShiftRow) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;

  const name = "name" in b || !current ? (typeof b.name === "string" ? b.name.trim() : "") : current.name;
  if (!name) throw new HttpError(400, "Shift name is required");
  if (name.length > 50) throw new HttpError(400, "Shift name is too long (max 50)");
  const start = "start" in b || !current ? parseTime(b.start, "Start") : current.start_minute;
  const end = "end" in b || !current ? parseTime(b.end, "End") : current.end_minute;
  if (start === end) throw new HttpError(400, "Start and end must be different");
  const days = "days" in b || !current ? parseDays(b.days) : daysOf(current.days);
  const dayTimes = "dayTimes" in b || !current ? parseDayTimes(b.dayTimes, days) : dayTimesOf(current.day_times, days);

  const candidate: ShiftDef = { id: current?.id ?? "", name, start, duration: durationOf(start, end), days, dayTimes };
  for (const r of await selectAll()) {
    if (r.id === current?.id) continue;
    if (r.name.toLowerCase() === name.toLowerCase()) throw new HttpError(409, `Shift "${r.name}" already exists`);
    const other = {
      id: r.id,
      name: r.name,
      start: r.start_minute,
      duration: durationOf(r.start_minute, r.end_minute),
      days: daysOf(r.days),
      dayTimes: dayTimesOf(r.day_times, daysOf(r.days)),
    };
    if (overlaps(candidate, other)) {
      throw new HttpError(
        409,
        `Overlaps with ${r.name} (${toLabel(r.start_minute)}–${toLabel(r.end_minute)}, ${daysLabel(other.days)})`
      );
    }
  }
  return { name, start, end, days, dayTimes };
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
      "INSERT INTO shifts (id, name, start_minute, end_minute, days, day_times, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, s.name, s.start, s.end, s.days.join(","), dayTimesJson(s.dayTimes), now, now]
    );
    await loadShifts();
    return toShift((await getRow(id))!);
  },

  async update(id: string, body: unknown) {
    const row = await getRow(id);
    if (!row) throw new HttpError(404, "Shift not found");
    const s = await parseAndCheck(body, row);
    await pool.query(
      "UPDATE shifts SET name = ?, start_minute = ?, end_minute = ?, days = ?, day_times = ?, updated_at = ? WHERE id = ?",
      [s.name, s.start, s.end, s.days.join(","), dayTimesJson(s.dayTimes), new Date(), id]
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
