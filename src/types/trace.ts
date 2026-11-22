// Keep in sync with oee-realtime-urc/src/types/trace.ts

/**
 * OEE with the downtime taken from the uploaded downtime of chosen categories (e.g. EL, MS) instead of the machine
 * status, next to the usual OEE. Performance and Quality are the usual ones.
 *   Availability (trace) = (counted time − uploaded downtime of the chosen categories) / counted time
 *   OEE (trace)          = Availability (trace) × Performance × Quality
 */
export interface TraceFigures {
  countedSeconds: number;
  /** Uploaded downtime of the chosen categories matched to this machine / date. */
  downtimeSeconds: number;
  /** Stop / Off time from the machine status (counted − run), for comparison. */
  signalDowntimeSeconds: number;
  output: number;
  reject: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
  /** The usual figures, downtime from the machine status. */
  signalAvailability: number | null;
  signalOee: number | null;
}

/** GET /reports/trace-downtime. */
export interface TraceDowntimeReport {
  from: string;
  to: string;
  generatedAt: string;
  /** Downtime categories uploaded for the machines in the range: total time and rows, largest first. */
  types: { type: string; seconds: number; count: number }[];
  /** Where the downtime comes from: the machine status, or the uploaded rows of the `selected` categories. */
  source: "signal" | "upload";
  /** The uploaded categories counted as downtime (empty with source "signal"). */
  selected: string[];
  total: TraceFigures;
  machines: (TraceFigures & { machineId: string; machineNo: string })[];
  days: (TraceFigures & { date: string })[];
  /** Downtime of the chosen categories that matched no counted machine time (other machine, no OEE data that day). */
  unmatchedSeconds: number;
}
