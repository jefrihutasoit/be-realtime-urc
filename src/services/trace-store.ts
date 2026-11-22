import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import type { TraceDowntimeReport, TraceFigures } from "../types/trace.js";
import { addTotals, emptyTotals, loadCells } from "./report-store.js";
import type { Totals } from "./summary-store.js";

// Trace downtime: OEE per machine and production date where the downtime is the uploaded downtime of chosen
// categories (Downtime Input, "Tipe Downtime") instead of the machine status. The counted time, output, ideal output
// and reject come from the hourly OEE figures as in the other reports (filters: range, machine category, machines).
// A downtime row linked to several machines counts for each of them.

const round1 = (v: number) => Math.round(v * 10) / 10;
const list = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Downtime category as stored; rows without one are "Other" (as in the summary). */
const typeOf = (v: unknown) => (String(v ?? "").trim() || "Other").toUpperCase();

function figures(t: Totals, downtimeMs: number): TraceFigures {
  const counted = t.countedMs;
  const perf = t.idealOutput > 0 ? t.output / t.idealOutput : null;
  const quality = t.output > 0 ? Math.max(0, (t.output - t.reject) / t.output) : counted > 0 ? 1 : null;
  const availability = counted > 0 ? Math.max(0, (counted - downtimeMs) / counted) : null;
  const signalAvailability = counted > 0 ? t.runMs / counted : null;
  const oeeOf = (a: number | null) =>
    a === null || perf === null || quality === null ? null : round1(Math.min(a, 1) * Math.min(perf, 1) * Math.min(quality, 1) * 100);
  const pct = (v: number | null) => (v === null ? null : round1(v * 100));
  return {
    countedSeconds: Math.round(counted / 1000),
    downtimeSeconds: Math.round(Math.min(downtimeMs, counted) / 1000),
    signalDowntimeSeconds: Math.round(Math.max(counted - t.runMs, 0) / 1000),
    output: Math.round(t.output),
    reject: Math.round(t.reject),
    availability: pct(availability),
    performance: pct(perf),
    quality: pct(quality),
    oee: oeeOf(availability),
    signalAvailability: pct(signalAvailability),
    signalOee: oeeOf(signalAvailability),
  };
}

export const traceStore = {
  /**
   * `?from=&to=[&category=][&machines=id,…][&source=upload|signal][&types=EL,MS]`: with `source=signal` the downtime is
   * the machine status (types ignored); else the uploaded categories in `types` (no `types`: every category).
   */
  async build(query: Record<string, unknown>): Promise<TraceDowntimeReport> {
    // Shift and SKU filters do not apply: uploaded downtime is per machine and production date.
    const { ctx, cells } = await loadCells({ ...query, shift: "", skus: "" });

    // Counted figures per machine × production date.
    const perKey = new Map<string, { machineId: string; date: string; totals: Totals }>();
    for (const c of cells) {
      const key = `${c.machineId}|${c.date}`;
      const e = perKey.get(key) ?? { machineId: c.machineId, date: c.date, totals: emptyTotals() };
      addTotals(e.totals, c.totals);
      perKey.set(key, e);
    }

    // Uploaded downtime per machine × date × category, for the machines in the report's filters.
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(d.production_date, '%Y-%m-%d') AS date, x.machine_id, d.downtime_type AS type,
          SUM(COALESCE(d.duration_seconds, 0)) AS seconds, COUNT(*) AS n
        FROM downtime_records d JOIN downtime_record_machines x ON x.record_id = d.id
        WHERE d.production_date BETWEEN ? AND ?
        GROUP BY date, x.machine_id, d.downtime_type`,
      [ctx.from, ctx.to]
    );
    // Same range, machine category and machine filters as the OEE figures (shift and SKU filters are off).
    const inScope = rows.filter((r) => ctx.keep(String(r.date), null, String(r.machine_id), "-"));

    const typeTotals = new Map<string, { type: string; seconds: number; count: number }>();
    for (const r of inScope) {
      const type = typeOf(r.type);
      const t = typeTotals.get(type) ?? { type, seconds: 0, count: 0 };
      t.seconds += Number(r.seconds);
      t.count += Number(r.n);
      typeTotals.set(type, t);
    }
    // Categories without any downtime time (e.g. a row without a duration) change nothing, so they are not offered.
    const types = [...typeTotals.values()].filter((t) => t.seconds > 0).sort((a, b) => b.seconds - a.seconds);
    // Source of the downtime: the machine status (Stop / Off), or the uploaded rows of the chosen categories. The
    // two are not combined.
    const source = query.source === "signal" ? "signal" : "upload";
    const wanted = list(query.types).map((t) => t.toUpperCase());
    const selected = source === "signal" ? [] : query.types === undefined ? types.map((t) => t.type) : wanted;
    const chosen = new Set(selected);

    const downtimeMs = new Map<string, number>();
    let unmatchedMs = 0;
    if (source === "signal") {
      for (const [key, e] of perKey) downtimeMs.set(key, Math.max(e.totals.countedMs - e.totals.runMs, 0));
    } else {
      for (const r of inScope) {
        if (!chosen.has(typeOf(r.type))) continue;
        const key = `${r.machine_id}|${r.date}`;
        const ms = Number(r.seconds) * 1000;
        if (perKey.get(key)?.totals.countedMs) downtimeMs.set(key, (downtimeMs.get(key) ?? 0) + ms);
        else unmatchedMs += ms;
      }
    }

    // Totals per machine, per date and over all; downtime above the counted time of a machine-day is capped there.
    const byMachine = new Map<string, { totals: Totals; down: number }>();
    const byDate = new Map<string, { totals: Totals; down: number }>();
    const all = { totals: emptyTotals(), down: 0 };
    for (const [key, e] of perKey) {
      const down = Math.min(downtimeMs.get(key) ?? 0, e.totals.countedMs);
      for (const [map, k] of [
        [byMachine, e.machineId],
        [byDate, e.date],
      ] as const) {
        const g = map.get(k) ?? { totals: emptyTotals(), down: 0 };
        addTotals(g.totals, e.totals);
        g.down += down;
        map.set(k, g);
      }
      addTotals(all.totals, e.totals);
      all.down += down;
    }

    return {
      from: ctx.from,
      to: ctx.to,
      generatedAt: new Date().toISOString(),
      types,
      source,
      selected,
      total: figures(all.totals, all.down),
      machines: [...byMachine.entries()]
        .map(([machineId, g]) => ({ machineId, machineNo: ctx.noOf(machineId), ...figures(g.totals, g.down) }))
        .sort((a, b) => a.machineNo.localeCompare(b.machineNo, undefined, { numeric: true })),
      days: [...byDate.entries()].map(([date, g]) => ({ date, ...figures(g.totals, g.down) })).sort((a, b) => b.date.localeCompare(a.date)),
      unmatchedSeconds: Math.round(unmatchedMs / 1000),
    };
  },
};
