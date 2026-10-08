import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import type { MachineMonitoring, MachineOee, Sku } from "../types/oee.js";
import type { SkuMaster } from "../types/sku.js";
import { gateway } from "./gateway.js";
import { machineStore } from "./machine-store.js";
import { oeeHistoryStore } from "./oee-history-store.js";
import { oeeStateStore } from "./oee-state-store.js";
import { rejectStore } from "./reject-store.js";
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

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DD" in server local time. */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
  const [all, statusDefinition, oee, skuList] = await Promise.all([
    machineStore.list(),
    settingsStore.getStatusDefinition(),
    settingsStore.getOeeSettings(),
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
  const period = shiftPeriodAt(new Date(now));
  const [values, inputRejects] = await Promise.all([
    gateway.read([...tags]),
    // Reject input is recorded per production date (the day the shift starts) and shift.
    period.shiftId && oee.rejectSource !== "tag"
      ? rejectStore.shiftTotals(localDate(new Date(period.start)), period.shiftId)
      : new Map<string, Record<string, number>>(),
  ]);

  // Counter values at shift start for machines whose shift state is about to be (re)created.
  let baselines: Record<string, string | null> | null = null;
  const fresh = oeeMachines.filter((m) => needsBaseline(m.id, now));
  const freshIds = new Set(fresh.map((m) => m.id));
  if (fresh.length && gateway.readBefore) {
    baselines = await gateway.readBefore(
      fresh.flatMap((m) => [m.tagOutput, m.tagReject]),
      new Date(period.start)
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
          oee,
          sku,
          skuRegistered: registered,
          idealRate: rate,
          inputRejects: inputRejects.get(m.id),
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

/** How often the OEE run states are saved, so a restart loses at most this much. */
const SAVE_INTERVAL_MS = 10_000;

/** Saves the OEE run states and the hourly figures now (also called on shutdown). */
export async function saveOeeStates() {
  try {
    await oeeStateStore.save();
  } catch (err) {
    console.error("[poller] could not save OEE run states:", err);
  }
  try {
    await oeeHistoryStore.flush();
  } catch (err) {
    console.error("[poller] could not save hourly OEE:", err);
  }
}

let busy = false;
let paused = false;

/**
 * Runs `fn` while polling is stopped (database restore, initialize, clear), so the poller does not
 * write run states or hourly figures in between.
 */
export async function withPollerPaused<T>(fn: () => Promise<T>): Promise<T> {
  if (paused) throw new HttpError(409, "Another database operation is running");
  paused = true;
  try {
    while (busy) await new Promise((r) => setTimeout(r, 100));
    return await fn();
  } finally {
    paused = false;
  }
}

/** Polls the gateway on a fixed interval and hands each result to `onResult`. */
export function startPoller(onResult: (result: PollResult) => void) {
  let lastSaved = Date.now();
  const timer = setInterval(async () => {
    if (busy || paused) return; // skip a tick rather than pile up slow reads
    busy = true;
    try {
      latest = await pollOnce();
      onResult(latest);
      if (Date.now() - lastSaved >= SAVE_INTERVAL_MS) {
        lastSaved = Date.now();
        await saveOeeStates();
      }
    } catch (err) {
      console.error("[poller] poll failed:", err);
    } finally {
      busy = false;
    }
  }, env.pollIntervalMs);
  return () => clearInterval(timer);
}
