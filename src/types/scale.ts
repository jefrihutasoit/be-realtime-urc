// Keep in sync with oee-realtime-urc/src/types/scale.ts
import type { TimelineSegment } from "./oee.js";
import type { TrendSignal } from "./trend.js";

/** One SKU run on the machine, from the product tag. */
export interface ScaleSkuRun {
  start: string;
  end: string;
  /** Product tag code; "-" when no SKU was set. */
  skuCode: string;
  productName: string;
  /** Weight of the SKU (SKU Management); null when not set or the SKU is not in the master. */
  target: number | null;
}

/** GET /machines/:id/scale-monitor: the recorded fields of a machine's weight scale and the SKUs run. */
export interface ScaleMonitor {
  machineId: string;
  machineNo: string;
  from: string;
  to: string;
  bucketSeconds: number;
  /** Numeric fields of the scale that are recorded (chosen in the machine's scale settings). */
  signals: TrendSignal[];
  skus: ScaleSkuRun[];
  status: TimelineSegment[];
}
