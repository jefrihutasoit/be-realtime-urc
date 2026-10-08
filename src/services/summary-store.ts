import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { DailySummary, OeeFigures } from "../types/summary.js";
import { downtimeStore } from "./downtime-store.js";
import { machineStore } from "./machine-store.js";
import { oeeHistoryStore, type HourlyRow } from "./oee-history-store.js";
import { settingsStore } from "./settings-store.js";
import { shiftDefs } from "./shift-store.js";

// Daily summary for the dashboard, built in one request from the hourly OEE figures, reject input
// and uploaded downtime of one production date.

const HOUR = 3_600_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const round1 = (v: number) => Math.round(v * 10) / 10;

interface Totals {
  countedMs: number;
  runMs: number;
  idealOutput: number;
  output: number;
  reject: number;
}

function figures(t: Totals): OeeFigures {
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
function dayStartOf(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const first = Math.min(...shiftDefs().map((s) => s.start), 24 * 60) % (24 * 60);
  return new Date(y, m - 1, d, 0, shiftDefs().length ? first : 0);
}

export const summaryStore = {
  async daily(date: string): Promise<DailySummary> {
    if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(400, "date must be YYYY-MM-DD");
    const dayStart = dayStartOf(date);
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR);

    // Include what the engine counted since its last save.
    if (Date.now() >= dayStart.getTime() && Date.now() < dayEnd.getTime() + HOUR) {
      await oeeHistoryStore.flush().catch((err) => console.warn("[summary] could not save hourly OEE:", err));
    }

    const [allMachines, settings, hourly, rejectRows, typeRows, downtime] = await Promise.all([
      machineStore.list(),
      settingsStore.getOeeSettings(),
      oeeHistoryStore.between(dayStart, dayEnd),
      pool.query<RowDataPacket[]>(
        `SELECT r.machine_id, r.shift_id, SUM(i.quantity) AS qty FROM reject_records r
          JOIN reject_record_items i ON i.record_id = r.id WHERE r.production_date = ?
          GROUP BY r.machine_id, r.shift_id`,
        [date]
      ),
      pool.query<RowDataPacket[]>(
        `SELECT t.name, SUM(i.quantity) AS qty FROM reject_records r
          JOIN reject_record_items i ON i.record_id = r.id JOIN reject_types t ON t.id = i.reject_type_id
          WHERE r.production_date = ? GROUP BY t.id, t.name ORDER BY qty DESC`,
        [date]
      ),
      downtimeStore.list(date),
    ]);
    const machines = allMachines.filter((m) => m.isActive);
    const useTag = settings.rejectSource !== "input";
    const useInput = settings.rejectSource !== "tag";
    const inputRows = useInput ? rejectRows[0] : [];

    // ---- per hour (all machines)
    const hours = Array.from({ length: 24 }, (_, i) => dayStart.getTime() + i * HOUR);
    const empty = (): Totals => ({ countedMs: 0, runMs: 0, idealOutput: 0, output: 0, reject: 0 });
    const perHour = hours.map(empty);
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
      const i = Math.floor((r.hourStart - dayStart.getTime()) / HOUR);
      if (i < 0 || i > 23) continue;
      add(perHour[i], r);
      if (!perMachine.has(r.machineId)) perMachine.set(r.machineId, empty());
      add(perMachine.get(r.machineId)!, r);
      stopMs += r.stopMs;
      for (const st of ["RUN", "STOP", "OFF"] as const) statusMs[st] += r.statusMs[st];
    }

    // ---- reject input: per machine, and spread over the hours of its shift by output
    let rejectInput = 0;
    const inputByShift = new Map<string, number>();
    for (const r of inputRows) {
      const qty = Number(r.qty);
      rejectInput += qty;
      if (!perMachine.has(r.machine_id)) perMachine.set(r.machine_id, empty());
      perMachine.get(r.machine_id)!.reject += qty;
      inputByShift.set(r.shift_id, (inputByShift.get(r.shift_id) ?? 0) + qty);
    }
    for (const [shiftId, qty] of inputByShift) {
      const def = shiftDefs().find((s) => s.id === shiftId);
      const [y, m, d] = date.split("-").map(Number);
      const from = def ? new Date(y, m - 1, d, 0, def.start).getTime() : dayStart.getTime();
      const to = def ? from + def.duration * 60_000 : dayEnd.getTime();
      const idx = hours.map((h, i) => (h + HOUR > from && h < to ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      const output = idx.reduce((sum, i) => sum + perHour[i].output, 0);
      for (const i of idx) perHour[i].reject += output > 0 ? (qty * perHour[i].output) / output : qty / idx.length;
    }

    // ---- per machine
    const machineRows = machines
      .filter((m) => m.oeeEnabled)
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

    const output = perHour.reduce((s, t) => s + t.output, 0);
    const rejectTag = useTag ? hourly.reduce((s, r) => s + r.rejectTag, 0) : 0;

    // ---- uploaded downtime
    const byType = new Map<string, { type: string; seconds: number; count: number }>();
    for (const r of downtime) {
      const type = r.downtimeType || "Other";
      const t = byType.get(type) ?? { type, seconds: 0, count: 0 };
      t.seconds += r.durationSeconds ?? 0;
      t.count += 1;
      byType.set(type, t);
    }

    return {
      date,
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      activeMachines: machines.length,
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
      hourly: perHour.map((t, i) => ({
        hour: new Date(hours[i]).toISOString(),
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
        totalSeconds: [...byType.values()].reduce((s, t) => s + t.seconds, 0),
        byType: [...byType.values()].sort((a, b) => b.seconds - a.seconds),
      },
    };
  },
};
