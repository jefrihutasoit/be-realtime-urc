import { env } from "../config/env.js";
import type { MachineMonitoring, MachineOee, Sku } from "../types/oee.js";
import type { SkuMaster } from "../types/sku.js";
import { gateway } from "./gateway.js";
import { machineStore } from "./machine-store.js";
import { forgetMachine, needsBaseline, statusOnly, updateOee } from "./oee-engine.js";
import { resolveStatus, settingsStore } from "./settings-store.js";
import { shiftPeriodAt } from "./shift-store.js";
import { skuStore } from "./sku-store.js";

export interface PollResult {
  oee: MachineOee[];
  monitoring: MachineMonitoring[];
}

let latest: PollResult = { oee: [], monitoring: [] };

export const getLatest = () => latest;

const NO_SKU: Sku = { code: "-", name: "No active SKU", image: null };

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Index of SKUs by lower-cased SKU ID, for matching the product tag value. */
function indexSkus(skus: SkuMaster[]) {
  return new Map(skus.map((s) => [s.skuId.toLowerCase(), s]));
}

/** Maps the product tag value to a SKU. Numeric codes also match after normalising ("10.0" → "10"). */
function resolveSku(raw: string | null, skus: Map<string, SkuMaster>): { sku: Sku; rate: number; registered: boolean } {
  const code = raw?.trim();
  if (!code) return { sku: NO_SKU, rate: env.idealRatePpm, registered: false };
  const num = toNumber(code);
  const match = skus.get(code.toLowerCase()) ?? (num !== null ? skus.get(String(num)) : undefined);
  if (!match) return { sku: { code, name: "Unknown SKU", image: null }, rate: env.idealRatePpm, registered: false };
  return {
    sku: { code: match.skuId, name: match.productName, image: match.photo },
    rate: match.outputPerMinute,
    registered: true,
  };
}

async function pollOnce(): Promise<PollResult> {
  const [all, statusDefinition, skuList] = await Promise.all([
    machineStore.list(),
    settingsStore.getStatusDefinition(),
    skuStore.list(),
  ]);
  const machines = all.filter((m) => m.isActive);
  all.filter((m) => !m.isActive).forEach((m) => forgetMachine(m.id));
  const oeeMachines = machines.filter((m) => m.oeeEnabled);
  const skus = indexSkus(skuList);

  // Every active machine reports status; only OEE-enabled ones need the counters and product.
  const tags = new Set<string>();
  for (const m of machines) {
    tags.add(m.tagStatus);
    m.monitoringTags.forEach((t) => tags.add(t.tagName));
  }
  for (const m of oeeMachines) [m.tagOutput, m.tagReject, m.tagProduct].forEach((t) => tags.add(t));

  const now = Date.now();
  const values = await gateway.read([...tags]);

  // Counter values at shift start for machines whose shift state is about to be (re)created.
  let baselines: Record<string, string | null> | null = null;
  const fresh = oeeMachines.filter((m) => needsBaseline(m.id, now));
  const freshIds = new Set(fresh.map((m) => m.id));
  if (fresh.length && gateway.readBefore) {
    baselines = await gateway.readBefore(
      fresh.flatMap((m) => [m.tagOutput, m.tagReject]),
      new Date(shiftPeriodAt(new Date(now)).start)
    );
  }

  const updatedAt = new Date(now).toISOString();

  return {
    oee: machines.map((m) => {
      if (!m.oeeEnabled) {
        // Drop any shift state so re-enabling OEE starts clean instead of crediting the gap.
        forgetMachine(m.id);
        return statusOnly(m, resolveStatus(toNumber(values[m.tagStatus]), statusDefinition), now);
      }
      const { sku, rate, registered } = resolveSku(values[m.tagProduct], skus);
      return updateOee(
        m,
        { status: toNumber(values[m.tagStatus]), output: toNumber(values[m.tagOutput]), reject: toNumber(values[m.tagReject]) },
        {
          statusDefinition,
          sku,
          skuRegistered: registered,
          idealRate: rate,
          // A counter with no reading before the shift started is counted from 0.
          baseline: baselines && freshIds.has(m.id)
            ? { output: toNumber(baselines[m.tagOutput]) ?? 0, reject: toNumber(baselines[m.tagReject]) ?? 0 }
            : undefined,
        },
        now
      );
    }),
    monitoring: machines.map((m) => ({
      machineId: m.id,
      values: m.monitoringTags.map((t) => ({ ...t, value: toNumber(values[t.tagName]) })),
      updatedAt,
    })),
  };
}

/** Polls the gateway on a fixed interval and hands each result to `onResult`. */
export function startPoller(onResult: (result: PollResult) => void) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // skip a tick rather than pile up slow reads
    busy = true;
    try {
      latest = await pollOnce();
      onResult(latest);
    } catch (err) {
      console.error("[poller] poll failed:", err);
    } finally {
      busy = false;
    }
  }, env.pollIntervalMs);
  return () => clearInterval(timer);
}
