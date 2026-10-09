import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { Report, ReportFigures, ReportGroup, ReportRow, ReportType } from "../types/report.js";
import { machineStore } from "./machine-store.js";
import { oeeHistoryStore } from "./oee-history-store.js";
import { settingsStore } from "./settings-store.js";
import { shiftDefs, shiftPeriodAt } from "./shift-store.js";
import { skuStore } from "./sku-store.js";
import { dayStartOf, figures, type Totals } from "./summary-store.js";

// Production reports over a range of production dates, built from the hourly OEE figures per machine and
// SKU (oee_hourly) plus the reject input. An hour belongs to the production date whose day (from the
// earliest shift start, as in the summary) contains it, and to the shift running at the start of the hour.
// The historical page (historical-store) reads the same figures.

export const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TYPES: ReportType[] = ["daily", "shift", "machine", "sku"];
/** Longest range one report covers. */
const MAX_DAYS = 366;
/** SKU key of hours without a SKU and of rows saved before the SKU was recorded. */
const NO_SKU = "-";

const pad = (n: number) => String(n).padStart(2, "0");
export const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const list = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const emptyTotals = (): Totals => ({ countedMs: 0, runMs: 0, idealOutput: 0, output: 0, reject: 0 });
export const addTotals = (t: Totals, o: Totals) => {
  t.countedMs += o.countedMs;
  t.runMs += o.runMs;
  t.idealOutput += o.idealOutput;
  t.output += o.output;
  t.reject += o.reject;
};
export const figuresOf = (t: Totals): ReportFigures => ({
  output: Math.round(t.output),
  reject: Math.round(t.reject),
  ...figures(t),
});

/** Totals of one production date, shift, machine and SKU. */
export interface Cell {
  date: string;
  shiftId: string | null;
  shiftName: string;
  machineId: string;
  skuKey: string;
  totals: Totals;
}

export function parseDate(value: unknown, name: string) {
  const s = String(value ?? "");
  if (!DATE_PATTERN.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${name} must be YYYY-MM-DD`);
  return s;
}

/**
 * Range, filters, names and settings of a report request (`from`, `to`, `machines`, `skus`, `shift`),
 * with the hourly figures already saved for the range.
 */
export async function reportContext(query: Record<string, unknown>) {
  const from = parseDate(query.from, "from");
  const to = parseDate(query.to, "to");
  if (from > to) throw new HttpError(400, "from must not be after to");
  const rangeStart = dayStartOf(from);
  const rangeEnd = new Date(dayStartOf(to).getTime() + DAY);
  if (rangeEnd.getTime() - rangeStart.getTime() > MAX_DAYS * DAY) {
    throw new HttpError(400, `A report covers at most ${MAX_DAYS} days`);
  }
  const machineFilter = new Set(list(query.machines));
  const skuFilter = new Set(list(query.skus).map((s) => s.toLowerCase()));
  const shiftFilter = String(query.shift ?? "").trim();

  // Include what the engine counted since its last save.
  if (Date.now() < rangeEnd.getTime() + HOUR) {
    await oeeHistoryStore.flush().catch((err) => console.warn("[report] could not save hourly OEE:", err));
  }

  const [machines, skus, settings] = await Promise.all([
    machineStore.list(),
    skuStore.list(),
    settingsStore.getOeeSettings(),
  ]);

  const machineNo = new Map(machines.map((m) => [m.id, m.machineNo]));
  const skuMaster = new Map(skus.map((s) => [s.skuId.toLowerCase(), s]));
  /** Product names of SKUs outside the master, from the reject input. */
  const productNames = new Map<string, string>();
  /** Key of a product tag code or SKU ID: the SKU master's when registered, else the code itself. */
  const skuKeyOf = (code: string) => {
    const c = code.trim();
    if (!c || c === NO_SKU) return NO_SKU;
    const num = /^\d+(\.0+)?$/.test(c) ? String(Number(c)) : null;
    return (
      (skuMaster.get(c.toLowerCase()) ?? (num !== null ? skuMaster.get(num) : undefined))?.skuId.toLowerCase() ??
      c.toLowerCase()
    );
  };
  const skuLabel = (key: string) => {
    if (key === NO_SKU) return { skuCode: NO_SKU, productName: "-" };
    const m = skuMaster.get(key);
    return m
      ? { skuCode: m.skuId, productName: m.productName }
      : { skuCode: key.toUpperCase(), productName: productNames.get(key) ?? "Unknown SKU" };
  };
  const firstShiftMinute = shiftDefs().length ? Math.min(...shiftDefs().map((s) => s.start)) : 0;
  const shiftOrder = new Map(
    [...shiftDefs()]
      .sort((a, b) => ((a.start - firstShiftMinute + 1440) % 1440) - ((b.start - firstShiftMinute + 1440) % 1440))
      .map((s, i) => [s.id, i])
  );

  return {
    from,
    to,
    rangeStart,
    rangeEnd,
    useTag: settings.rejectSource !== "input",
    useInput: settings.rejectSource !== "tag",
    firstShiftMinute,
    machineNo,
    productNames,
    skuKeyOf,
    skuLabel,
    noOf: (id: string) => machineNo.get(id) ?? "?",
    /** Production date of an hour. */
    dateOfHour: (hourStart: number) => ymdOf(new Date(hourStart - firstShiftMinute * 60_000)),
    /** Shifts in production-day order; time outside every shift last. */
    shiftRank: (id: string | null) => (id === null ? shiftOrder.size : (shiftOrder.get(id) ?? shiftOrder.size)),
    keep: (date: string, shiftId: string | null, machineId: string, skuKey: string) =>
      date >= from &&
      date <= to &&
      (!shiftFilter || shiftId === shiftFilter) &&
      (!machineFilter.size || machineFilter.has(machineId)) &&
      (!skuFilter.size || skuFilter.has(skuKey) || skuFilter.has(skuLabel(skuKey).skuCode.toLowerCase())),
  };
}

export type ReportContext = Awaited<ReturnType<typeof reportContext>>;

/** Reject input of the range per production date, shift, machine and SKU. */
export async function rejectInputRows(ctx: ReportContext, machineId?: string) {
  if (!ctx.useInput) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(r.production_date, '%Y-%m-%d') AS production_date, r.shift_id, r.shift_name,
        r.machine_id, r.machine_no, r.sku_id, r.product_name, SUM(i.quantity) AS qty
      FROM reject_records r JOIN reject_record_items i ON i.record_id = r.id
      WHERE r.production_date BETWEEN ? AND ? ${machineId ? "AND r.machine_id = ?" : ""}
      GROUP BY r.production_date, r.shift_id, r.shift_name, r.machine_id, r.machine_no, r.sku_id, r.product_name`,
    machineId ? [ctx.from, ctx.to, machineId] : [ctx.from, ctx.to]
  );
  return rows.map((r) => {
    const skuKey = ctx.skuKeyOf(String(r.sku_id ?? ""));
    if (ctx.skuLabel(skuKey).productName === "Unknown SKU" && r.product_name) ctx.productNames.set(skuKey, r.product_name);
    if (!ctx.machineNo.has(r.machine_id)) ctx.machineNo.set(r.machine_id, r.machine_no);
    return {
      date: String(r.production_date),
      shiftId: String(r.shift_id),
      shiftName: String(r.shift_name),
      machineId: String(r.machine_id),
      skuKey,
      qty: Number(r.qty),
    };
  });
}

/** Totals per production date × shift × machine × SKU within the request's filters. */
export async function loadCells(query: Record<string, unknown>) {
  const ctx = await reportContext(query);
  const [hourly, rejects] = await Promise.all([
    oeeHistoryStore.between(ctx.rangeStart, ctx.rangeEnd),
    rejectInputRows(ctx),
  ]);

  const cells = new Map<string, Cell>();
  const cellFor = (date: string, shiftId: string | null, shiftName: string, machineId: string, skuKey: string) => {
    const key = `${date}|${shiftId ?? ""}|${machineId}|${skuKey}`;
    let c = cells.get(key);
    if (!c) {
      c = { date, shiftId, shiftName, machineId, skuKey, totals: emptyTotals() };
      cells.set(key, c);
    }
    return c;
  };

  for (const r of hourly) {
    if (r.countedMs <= 0 && r.output <= 0 && r.rejectTag <= 0) continue;
    const date = ctx.dateOfHour(r.hourStart);
    const period = shiftPeriodAt(new Date(r.hourStart));
    const skuKey = ctx.skuKeyOf(r.skuCode);
    if (!ctx.keep(date, period.shiftId, r.machineId, skuKey)) continue;
    addTotals(cellFor(date, period.shiftId, period.name, r.machineId, skuKey).totals, {
      countedMs: r.countedMs,
      runMs: r.runMs,
      idealOutput: r.idealOutput,
      output: r.output,
      reject: ctx.useTag ? r.rejectTag : 0,
    });
  }
  for (const r of rejects) {
    if (!ctx.keep(r.date, r.shiftId, r.machineId, r.skuKey)) continue;
    cellFor(r.date, r.shiftId, r.shiftName, r.machineId, r.skuKey).totals.reject += r.qty;
  }
  return { ctx, cells: [...cells.values()] };
}

export const reportStore = {
  async build(query: Record<string, unknown>): Promise<Report> {
    const type = String(query.type ?? "daily") as ReportType;
    if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(", ")}`);
    const { ctx, cells } = await loadCells(query);
    const { noOf, skuLabel, shiftRank } = ctx;

    const groupKeyOf = (c: Cell) =>
      type === "daily" ? c.date : type === "shift" ? `${c.date}|${c.shiftId ?? ""}` : type === "machine" ? c.machineId : c.skuKey;
    const rowKeyOf = (c: Cell) => (type === "machine" ? c.skuKey : type === "sku" ? c.machineId : `${c.machineId}|${c.skuKey}`);

    const byGroup = new Map<string, { first: Cell; total: Totals; rows: Map<string, { first: Cell; totals: Totals }> }>();
    const grand = emptyTotals();
    for (const c of cells) {
      const gk = groupKeyOf(c);
      let g = byGroup.get(gk);
      if (!g) {
        g = { first: c, total: emptyTotals(), rows: new Map() };
        byGroup.set(gk, g);
      }
      addTotals(g.total, c.totals);
      addTotals(grand, c.totals);
      const rk = rowKeyOf(c);
      const row = g.rows.get(rk) ?? { first: c, totals: emptyTotals() };
      addTotals(row.totals, c.totals);
      g.rows.set(rk, row);
    }

    const byMachineNo = (a: string, b: string) => noOf(a).localeCompare(noOf(b), undefined, { numeric: true });
    const bySku = (a: string, b: string) => skuLabel(a).skuCode.localeCompare(skuLabel(b).skuCode, undefined, { numeric: true });

    const groups: ReportGroup[] = [...byGroup.entries()].map(([key, g]) => {
      const c = g.first;
      const rows: ReportRow[] = [...g.rows.values()]
        .sort((a, b) => byMachineNo(a.first.machineId, b.first.machineId) || bySku(a.first.skuKey, b.first.skuKey))
        .map(({ first, totals }) => ({
          machineId: first.machineId,
          machineNo: noOf(first.machineId),
          ...skuLabel(first.skuKey),
          ...figuresOf(totals),
        }));
      const sku = type === "sku" ? skuLabel(c.skuKey) : null;
      return {
        key,
        date: type === "daily" || type === "shift" ? c.date : null,
        shiftId: type === "shift" ? c.shiftId : null,
        shiftName: type === "shift" ? c.shiftName : null,
        machineId: type === "machine" ? c.machineId : null,
        machineNo: type === "machine" ? noOf(c.machineId) : null,
        skuCode: sku?.skuCode ?? null,
        productName: sku?.productName ?? null,
        total: figuresOf(g.total),
        rows,
      };
    });

    // Newest date first; shifts in production-day order; machines and SKUs by number.
    groups.sort((a, b) => {
      if (type === "daily" || type === "shift") {
        return b.date!.localeCompare(a.date!) || shiftRank(a.shiftId) - shiftRank(b.shiftId);
      }
      if (type === "machine") return byMachineNo(a.machineId!, b.machineId!);
      return a.skuCode!.localeCompare(b.skuCode!, undefined, { numeric: true });
    });

    return { type, from: ctx.from, to: ctx.to, generatedAt: new Date().toISOString(), groups, total: figuresOf(grand) };
  },
};
