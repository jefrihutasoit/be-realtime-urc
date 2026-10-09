import { HttpError } from "../lib/http-error.js";
import type { HistoricalData, HourlyDetail, HourlyDetailRow } from "../types/historical.js";
import { downtimeStore } from "./downtime-store.js";
import { oeeHistoryStore } from "./oee-history-store.js";
import {
  addTotals,
  emptyTotals,
  figuresOf,
  loadCells,
  parseDate,
  rejectInputRows,
  reportContext,
  ymdOf,
} from "./report-store.js";
import { shiftPeriodAt } from "./shift-store.js";
import type { Totals } from "./summary-store.js";

// The historical page: the report figures of a range per machine and per production date, and the hours
// of one machine on one date.

/** "HH:mm" → minutes after the start of the production day, or null. */
function dayMinute(time: string, firstShiftMinute: number) {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? (Number(m[1]) * 60 + Number(m[2]) - firstShiftMinute + 1440) % 1440 : null;
}

export const historicalStore = {
  async range(query: Record<string, unknown>): Promise<HistoricalData> {
    const { ctx, cells } = await loadCells(query);

    const total = emptyTotals();
    const perMachine = new Map<string, Totals>();
    const perDay = new Map<string, { total: Totals; machines: Map<string, Totals> }>();
    for (const c of cells) {
      addTotals(total, c.totals);
      if (!perMachine.has(c.machineId)) perMachine.set(c.machineId, emptyTotals());
      addTotals(perMachine.get(c.machineId)!, c.totals);
      let day = perDay.get(c.date);
      if (!day) {
        day = { total: emptyTotals(), machines: new Map() };
        perDay.set(c.date, day);
      }
      addTotals(day.total, c.totals);
      if (!day.machines.has(c.machineId)) day.machines.set(c.machineId, emptyTotals());
      addTotals(day.machines.get(c.machineId)!, c.totals);
    }

    const days: HistoricalData["days"] = [];
    for (let d = new Date(`${ctx.from}T00:00:00`); ymdOf(d) <= ctx.to; d.setDate(d.getDate() + 1)) {
      const date = ymdOf(d);
      const day = perDay.get(date);
      days.push({
        date,
        total: figuresOf(day?.total ?? emptyTotals()),
        machines: Object.fromEntries([...(day?.machines ?? [])].map(([id, t]) => [id, figuresOf(t)])),
      });
    }

    return {
      from: ctx.from,
      to: ctx.to,
      generatedAt: new Date().toISOString(),
      total: figuresOf(total),
      machines: [...perMachine.entries()]
        .map(([machineId, t]) => ({ machineId, machineNo: ctx.noOf(machineId), ...figuresOf(t) }))
        .sort((a, b) => a.machineNo.localeCompare(b.machineNo, undefined, { numeric: true })),
      days,
    };
  },

  async hourly(query: Record<string, unknown>): Promise<HourlyDetail> {
    const machineId = String(query.machine ?? "").trim();
    if (!machineId) throw new HttpError(400, "machine is required");
    const date = parseDate(query.date, "date");
    const ctx = await reportContext({ ...query, from: date, to: date, machines: machineId });
    const dayStart = ctx.rangeStart.getTime();

    const [hourly, rejects, downtime] = await Promise.all([
      oeeHistoryStore.between(ctx.rangeStart, ctx.rangeEnd),
      rejectInputRows(ctx, machineId),
      downtimeStore.list(date),
    ]);

    interface Slot {
      hourStart: number;
      shiftId: string | null;
      skuKey: string;
      totals: Totals;
    }
    const slots = new Map<string, Slot>();
    for (const r of hourly) {
      if (r.machineId !== machineId || (r.countedMs <= 0 && r.output <= 0 && r.rejectTag <= 0)) continue;
      const shiftId = shiftPeriodAt(new Date(r.hourStart)).shiftId;
      const skuKey = ctx.skuKeyOf(r.skuCode);
      if (!ctx.keep(date, shiftId, machineId, skuKey)) continue;
      const key = `${r.hourStart}|${skuKey}`;
      const slot = slots.get(key) ?? { hourStart: r.hourStart, shiftId, skuKey, totals: emptyTotals() };
      addTotals(slot.totals, {
        countedMs: r.countedMs,
        runMs: r.runMs,
        idealOutput: r.idealOutput,
        output: r.output,
        reject: ctx.useTag ? r.rejectTag : 0,
      });
      slots.set(key, slot);
    }

    // Reject input is per shift: spread over the shift's hours of that SKU (else of any SKU) by output.
    const all = [...slots.values()];
    for (const r of rejects) {
      if (!ctx.keep(r.date, r.shiftId, machineId, r.skuKey)) continue;
      const inShift = all.filter((s) => s.shiftId === r.shiftId);
      const target = inShift.some((s) => s.skuKey === r.skuKey) ? inShift.filter((s) => s.skuKey === r.skuKey) : inShift;
      if (!target.length) continue;
      const output = target.reduce((sum, s) => sum + s.totals.output, 0);
      for (const s of target) s.totals.reject += output > 0 ? (r.qty * s.totals.output) / output : r.qty / target.length;
    }

    // Uploaded downtime of this machine, as minutes of the production day.
    const machineNo = ctx.noOf(machineId);
    const stops = downtime
      .filter((d) => d.machines.includes(machineNo))
      .flatMap((d) => {
        const start = dayMinute(d.start, ctx.firstShiftMinute);
        if (start === null) return [];
        let end = dayMinute(d.end, ctx.firstShiftMinute) ?? start;
        if (end < start) end += 1440;
        return [{ start, end: Math.max(end, start + 1), text: (d.detail || d.downtimeType || "Downtime").trim() }];
      });

    const total = emptyTotals();
    const rows: HourlyDetailRow[] = all
      .sort((a, b) => a.hourStart - b.hourStart || ctx.skuLabel(a.skuKey).skuCode.localeCompare(ctx.skuLabel(b.skuKey).skuCode))
      .map((s) => {
        addTotals(total, s.totals);
        const from = (s.hourStart - dayStart) / 60_000;
        const remarks = [...new Set(stops.filter((d) => d.start < from + 60 && d.end > from).map((d) => d.text))];
        return {
          hourStart: new Date(s.hourStart).toISOString(),
          ...ctx.skuLabel(s.skuKey),
          ...figuresOf(s.totals),
          remarks: remarks.join("; "),
        };
      });

    return { machineId, machineNo, date, rows, total: figuresOf(total) };
  },
};
