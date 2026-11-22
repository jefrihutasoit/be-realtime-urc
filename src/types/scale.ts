// Keep in sync with oee-realtime-urc/src/types/scale.ts
import type { TimelineSegment } from "./oee.js";
import type { TrendSignal } from "./trend.js";

/**
 * Weight specification over a stretch of time: the target weight of the SKU running, and the low / high limit
 * from their tags as they were then. A value is null when not set.
 */
export interface SpecBand {
  from: number;
  to: number;
  target: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Readings of the weight signal while one SKU ran. Counts are readings (a value is stored when it changes);
 * below / above compare each reading with the limit in effect at its time.
 */
export interface ScaleSkuSegment {
  start: string;
  end: string;
  /** Product tag code; "-" when no SKU was set. */
  skuCode: string;
  productName: string;
  /** Target weight of the SKU (SKU Management); null when not set or the SKU is not in the master. */
  target: number | null;
  /** Limits in effect at the end of the run; null when there is no limit tag or reading. */
  low: number | null;
  high: number | null;
  /** True when a limit changed during the run. */
  limitsChanged: boolean;
  count: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  stdDev: number | null;
  below: number;
  above: number;
}

/** GET /machines/:id/scale-monitor: one weight signal, its limit tags and the SKUs run over the range. */
export interface ScaleMonitor {
  machineId: string;
  machineNo: string;
  from: string;
  to: string;
  bucketSeconds: number;
  /** Numeric signals of the machine that can be monitored or used as a limit (scale fields first). */
  signals: { key: string; name: string; unit: string; scale: boolean }[];
  /** The chosen weight signal with its readings; null when the machine has no numeric signal. */
  signal: TrendSignal | null;
  /** Keys of the signals used as low / high limit; null = no limit. */
  lowKey: string | null;
  highKey: string | null;
  bands: SpecBand[];
  skus: ScaleSkuSegment[];
  status: TimelineSegment[];
  /** True when the range had more readings than are checked; the counts cover the newest ones. */
  truncated: boolean;
}
