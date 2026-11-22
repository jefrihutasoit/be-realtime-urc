import { HttpError } from "../lib/http-error.js";
import type { MachineRegistration } from "../types/machine.js";
import type { ScaleMonitor, ScaleSkuRun } from "../types/scale.js";
import type { SkuMaster } from "../types/sku.js";
import { skuStore } from "./sku-store.js";
import { tagValueStore } from "./tag-value-store.js";
import { trendStore } from "./trend-store.js";
import { SCALE_TAG_PREFIX } from "./yamato/fields.js";

// Scale monitoring: the recorded fields of a machine's weight scale over a range (bucketed like the trend) and the
// SKUs run on the machine (from the product tag) with their weight from SKU Management.

/** At most this many SKU runs are returned (the newest). */
const MAX_RUNS = 300;

/** SKU master entry of a product tag code (numeric codes also match after normalising, as in the poller). */
function skuOf(code: string, byId: Map<string, SkuMaster>) {
  const c = code.trim();
  if (!c) return undefined;
  const num = Number(c);
  return byId.get(c.toLowerCase()) ?? (Number.isFinite(num) ? byId.get(String(num)) : undefined);
}

export async function scaleMonitor(machine: MachineRegistration, from: unknown, to: unknown): Promise<ScaleMonitor> {
  if (!machine.scale?.enabled) throw new HttpError(400, `Machine ${machine.machineNo} has no active weight scale`);
  const [trend, skus] = await Promise.all([trendStore.trend(machine, from, to), skuStore.list()]);
  const signals = trend.signals.filter((s) => s.key.startsWith(SCALE_TAG_PREFIX));

  // SKU runs from the product tag readings.
  const fromDate = new Date(trend.from);
  const toDate = new Date(trend.to);
  const runs: { start: number; end: number; code: string }[] = [];
  if (machine.tagProduct) {
    const [before, readings] = await Promise.all([
      tagValueStore.latestBefore([machine.tagProduct], fromDate),
      tagValueStore.between(machine.tagProduct, fromDate, toDate),
    ]);
    let current = { code: before[0]?.value.trim() ?? "", start: fromDate.getTime() };
    for (const r of readings) {
      const code = r.value.trim();
      if (code === current.code) continue;
      const at = Date.parse(r.timestamp);
      if (at > current.start) runs.push({ ...current, end: at });
      current = { code, start: at };
    }
    runs.push({ ...current, end: toDate.getTime() });
  }
  const byId = new Map(skus.map((s) => [s.skuId.toLowerCase(), s]));
  const skuRuns: ScaleSkuRun[] = runs.slice(-MAX_RUNS).map((r) => {
    const master = skuOf(r.code, byId);
    return {
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      skuCode: r.code || "-",
      productName: master?.productName ?? (r.code ? "Unknown SKU" : "No SKU"),
      target: master?.targetWeight ?? null,
    };
  });

  return {
    machineId: machine.id,
    machineNo: machine.machineNo,
    from: trend.from,
    to: trend.to,
    bucketSeconds: trend.bucketSeconds,
    signals,
    skus: skuRuns,
    status: trend.status,
  };
}
