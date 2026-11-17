import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { DailySummary, OeeFigures } from "../types/summary.js";
import { MACHINE_CATEGORIES, type MachineCategory } from "../types/machine.js";
import { machineStore } from "./machine-store.js";
import { oeeHistoryStore, type HourlyRow } from "./oee-history-store.js";
import { settingsStore } from "./settings-store.js";
import { shiftDefs } from "./shift-store.js";

// Summary for the dashboard, built in one request from the hourly OEE figures, reject input and
// uploaded downtime of a range of production dates.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Longest range one summary covers. */
const MAX_DAYS = 366;

const round1 = (v: number) => Math.round(v * 10) / 10;

export interface Totals {
  countedMs: number;
  runMs: number;
  idealOutput: number;
  output: number;
  reject: number;
}

export function figures(t: Totals): OeeFigures {
  if (t.countedMs <= 0) return { oee: null, availability: null, performance: null, quality: null };
  const a = t.runMs / t.countedMs;
  const p = t.idealOutput > 0 ? t.output / t.idealOutput : 0;
  const q = t.output > 0 ? Math.max(0, (t.output - t.reject) / t.output) : 1;
  return {
    oee: round1(Math.min(a, 1) * Math.min(p, 1) * Math.min(q, 1) * 100),
    availability: round1(a * 100),
    performance: round1(p * 100),
    quality: round1(q * 100),
  };
}

/** Local start of the production day: the date at the earliest shift start (midnight without shifts). */
export function dayStartOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const first = Math.min(...shiftDefs().map((s) => s.start), 24 * 60) % (24 * 60);
  return new Date(y, m - 1, d, 0, shiftDefs().length ? first : 0);
}

function parseDate(value: string, name: string) {
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return value;
}

/** Production dates from `from` to `to`, inclusive; stops once past MAX_DAYS. */
function datesBetween(from: string, to: string) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const [y, m, d] = from.split("-").map(Number);
  const dates: string[] = [];
  for (let day = new Date(y, m - 1, d); dates.length <= MAX_DAYS; day.setDate(day.getDate() + 1)) {
    const ymd = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    if (ymd > to) break;
    dates.push(ymd);
  }
  return dates;
}

export const summaryStore = {
  /**
   * Summary of the production dates `from` to `to` for one machine category (Bagger and Machine Packaging
   * are evaluated separately): per hour for one day, per day for longer ranges.
   */
  async range(fromValue: string, toValue: string, categoryValue: unknown = "BAGGER"): Promise<DailySummary> {
    const from = parseDate(fromValue, "from");
    const to = parseDate(toValue, "to");
    const category = (categoryValue || "BAGGER") as MachineCategory;
    if (!MACHINE_CATEGORIES.includes(category)) throw new HttpError(400, "category must be BAGGER or PACKAGING");
    if (from > to) throw new HttpError(400, "from must not be after to");
    const dates = datesBetween(from, to);
    if (dates.length > MAX_DAYS) throw new HttpError(400, `A summary covers at most ${MAX_DAYS} days`);
    const dayStart = dayStartOf(from);
    const dayEnd = new Date(dayStartOf(to).getTime() + DAY);
    const bucketMs = dates.length === 1 ? HOUR : DAY;

    // Include what the engine counted since its last save.
    if (Date.now() >= dayStart.getTime() && Date.now() < dayEnd.getTime() + HOUR) {
      await oeeHistoryStore.flush().catch((err) => console.warn("[summary] could not save hourly OEE:", err));
    }

    const [allMachines, settings, hourly, rejectRows, typeRows, downtimeRows] = await Promise.all([
      machineStore.list(),
      settingsStore.getOeeSettings(),
      oeeHistoryStore.between(dayStart, dayEnd),
      pool.query<RowDataPacket[]>(
        `SELECT DATE_FORMAT(r.production_date, '%Y-%m-%d') AS production_date, r.machine_id, r.shift_id,
            SUM(i.quantity) AS qty FROM reject_records r
          JOIN reject_record_items i ON i.record_id = r.id WHERE r.production_date BETWEEN ? AND ?
          GROUP BY r.production_date, r.machine_id, r.shift_id`,
        [from, to]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT t.name, SUM(i.quantity) AS qty FROM reject_records r
          JOIN reject_record_items i ON i.record_id = r.id JOIN reject_types t ON t.id = i.reject_type_id
          LEFT JOIN machines m ON m.id = r.machine_id
          WHERE r.production_date BETWEEN ? AND ? AND COALESCE(m.oee_enabled, 1) = 1
            AND COALESCE(m.category, 'BAGGER') = ?
          GROUP BY t.id, t.name ORDER BY qty DESC`,
        [from, to, category]
      ),
      pool.query<RowDataPacket[]>(
        // A row with a notification number is unplanned downtime; without one it is planned. A row belongs to
        // the category of its (first) machine; rows without a known machine count as Bagger.
        `SELECT COALESCE(NULLIF(d.downtime_type, ''), 'Other') AS type, (TRIM(d.notification_no) <> '') AS unplanned,
            SUM(COALESCE(d.duration_seconds, 0)) AS seconds, COUNT(*) AS count
          FROM downtime_records d
          WHERE d.production_date BETWEEN ? AND ?
            AND COALESCE((SELECT m.category FROM downtime_record_machines x JOIN machines m ON m.id = x.machine_id
              WHERE x.record_id = d.id ORDER BY x.machine_no LIMIT 1), 'BAGGER') = ?
          GROUP BY type, unplanned`,
        [from, to, category]
      ),
    ]);
    const machines = allMachines.filter((m) => m.isActive);
    // Only machines of this category count. OEE is captured for every machine, but machines with OEE
    // disabled are left out of the summary.
    const byId = new Map(allMachines.map((m) => [m.id, m]));
    /** Whether a machine counts here; history of deleted machines counts as Bagger. */
    const inCategory = (id: string) => {
      const m = byId.get(id);
      return m ? m.oeeEnabled && m.category === category : category === "BAGGER";
    };
    /** Machine status is shown for both categories together (still without OEE-disabled machines). */
    const inStatus = (id: string) => byId.get(id)?.oeeEnabled ?? true;
    const useTag = settings.rejectSource !== "input";
    const useInput = settings.rejectSource !== "tag";
    const inputRows = useInput ? rejectRows[0].filter((r) => inCategory(r.machine_id)) : [];

    // ---- per trend point (all machines)
    const buckets = Array.from(
      { length: Math.round((dayEnd.getTime() - dayStart.getTime()) / bucketMs) },
      (_, i) => dayStart.getTime() + i * bucketMs
    );
    const empty = (): Totals => ({ countedMs: 0, runMs: 0, idealOutput: 0, output: 0, reject: 0 });
    const perBucket = buckets.map(empty);
    const perMachine = new Map<string, Totals>();
    const statusMs = { RUN: 0, STOP: 0, OFF: 0 };
    let stopMs = 0;
    const add = (t: Totals, r: HourlyRow) => {
      t.countedMs += r.countedMs;
      t.runMs += r.runMs;
      t.idealOutput += r.idealOutput;
      t.output += r.output;
      if (useTag) t.reject += r.rejectTag;
    };
    for (const r of hourly) {
      const i = Math.floor((r.hourStart - dayStart.getTime()) / bucketMs);
      if (i < 0 || i >= buckets.length) continue;
      if (inStatus(r.machineId)) for (const st of ["RUN", "STOP", "OFF"] as const) statusMs[st] += r.statusMs[st];
      if (!inCategory(r.machineId)) continue;
      add(perBucket[i], r);
      if (!perMachine.has(r.machineId)) perMachine.set(r.machineId, empty());
      add(perMachine.get(r.machineId)!, r);
      stopMs += r.stopMs;
    }

    // ---- reject input: per machine, and spread over the points of its shift by output
    let rejectInput = 0;
    const inputByShift = new Map<string, { date: string; shiftId: string; qty: number }>();
    for (const r of inputRows) {
      const qty = Number(r.qty);
      rejectInput += qty;
      if (!perMachine.has(r.machine_id)) perMachine.set(r.machine_id, empty());
      perMachine.get(r.machine_id)!.reject += qty;
      const key = `${r.production_date}|${r.shift_id}`;
      const e = inputByShift.get(key) ?? { date: r.production_date, shiftId: r.shift_id, qty: 0 };
      e.qty += qty;
      inputByShift.set(key, e);
    }
    for (const { date, shiftId, qty } of inputByShift.values()) {
      const def = shiftDefs().find((s) => s.id === shiftId);
      const [y, m, d] = date.split("-").map(Number);
      const start = def ? new Date(y, m - 1, d, 0, def.start).getTime() : dayStartOf(date).getTime();
      const end = def ? start + def.duration * 60_000 : start + DAY;
      const idx = buckets.map((b, i) => (b + bucketMs > start && b < end ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      const output = idx.reduce((sum, i) => sum + perBucket[i].output, 0);
      for (const i of idx) perBucket[i].reject += output > 0 ? (qty * perBucket[i].output) / output : qty / idx.length;
    }

    // ---- per machine
    const machineRows = machines
      .filter((m) => inCategory(m.id))
      .map((m) => {
        const t = perMachine.get(m.id) ?? empty();
        return {
          machineId: m.id,
          machineNo: m.machineNo,
          oee: figures(t).oee,
          output: Math.round(t.output),
          reject: Math.round(t.reject),
        };
      })
      .sort((a, b) => a.machineNo.localeCompare(b.machineNo, undefined, { numeric: true }));
    const counted = [...perMachine.entries()].filter(([, t]) => t.countedMs > 0).map(([, t]) => figures(t));
    const avg = (key: keyof OeeFigures) =>
      counted.length ? round1(counted.reduce((s, f) => s + (f[key] ?? 0), 0) / counted.length) : null;

    const output = perBucket.reduce((s, t) => s + t.output, 0);
    const rejectTag = useTag ? hourly.reduce((s, r) => s + r.rejectTag, 0) : 0;

    // ---- uploaded downtime
    const typeMap = new Map<string, { type: string; seconds: number; count: number }>();
    const planned = { seconds: 0, count: 0 };
    const unplanned = { seconds: 0, count: 0 };
    for (const r of downtimeRows[0]) {
      const seconds = Number(r.seconds);
      const count = Number(r.count);
      const t = typeMap.get(String(r.type)) ?? { type: String(r.type), seconds: 0, count: 0 };
      t.seconds += seconds;
      t.count += count;
      typeMap.set(t.type, t);
      const category = Number(r.unplanned) ? unplanned : planned;
      category.seconds += seconds;
      category.count += count;
    }
    const byType = [...typeMap.values()].sort((a, b) => b.seconds - a.seconds);

    return {
      from,
      to,
      days: dates.length,
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      category,
      // Machines of this category with OEE enabled.
      activeMachines: machines.filter((m) => inCategory(m.id)).length,
      statusMachines: machines.filter((m) => inStatus(m.id)).length,
      oee: {
        oee: avg("oee"),
        availability: avg("availability"),
        performance: avg("performance"),
        quality: avg("quality"),
        machines: counted.length,
      },
      output: Math.round(output),
      reject: Math.round(rejectTag + rejectInput),
      rejectTag: Math.round(rejectTag),
      rejectInput,
      bucket: bucketMs === HOUR ? "hour" : "day",
      trend: perBucket.map((t, i) => ({
        start: new Date(buckets[i]).toISOString(),
        oee: figures(t).oee,
        output: Math.round(t.output),
        reject: Math.round(t.reject),
      })),
      rejectByType: typeRows[0].map((r) => ({ name: r.name, quantity: Number(r.qty) })),
      machines: machineRows,
      machineDowntimeSeconds: Math.round(stopMs / 1000),
      statusSeconds: {
        RUN: Math.round(statusMs.RUN / 1000),
        STOP: Math.round(statusMs.STOP / 1000),
        OFF: Math.round(statusMs.OFF / 1000),
      },
      downtime: {
        totalSeconds: byType.reduce((s, t) => s + t.seconds, 0),
        byType,
        planned,
        unplanned,
      },
    };
  },
};
