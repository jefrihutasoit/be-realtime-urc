// Keep in sync with oee-realtime-urc/src/types/trend.ts
import type { TimelineSegment } from "./oee.js";

/** "counter" = output / reject counters, "value" = monitoring tags. */
export type TrendSignalKind = "counter" | "value";

/**
 * One signal of a machine over the trend range. Readings are stored only when the value changes, so a
 * value holds until the next point.
 */
export interface TrendSignal {
  /** "output", "reject", or the monitoring tag id. */
  key: string;
  name: string;
  tagName: string;
  unit: string;
  kind: TrendSignalKind;
  /** Value held from before `from`; null when nothing was recorded before. */
  start: number | null;
  /** Buckets with readings, oldest first: [bucket start (ms), last value, min, max]. */
  points: [number, number, number, number][];
}

/** Signals and status of one machine from `from` to `to` (`to` is never after the server time). */
export interface MachineTrend {
  machineId: string;
  machineNo: string;
  from: string;
  to: string;
  /** Width of one point; readings inside a bucket are reduced to last / min / max. */
  bucketSeconds: number;
  signals: TrendSignal[];
  /** Status timeline over the range. */
  status: TimelineSegment[];
}
