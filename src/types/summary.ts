// Keep in sync with oee-realtime-urc/src/types/summary.ts
/** OEE figures in percent; null when nothing was counted. */
export interface OeeFigures {
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
}

/**
 * Everything the summary page shows for a range of production days (`from` to `to`, one day when they
 * are equal). A production day runs from the start of the earliest shift on that date for 24 hours.
 * OEE comes from the hourly figures the engine saves (oee_hourly), reject input and downtime from their
 * uploads for those production dates.
 */
export interface DailySummary {
  from: string;
  to: string;
  /** Production days in the range. */
  days: number;
  /** Start of the first production day. */
  dayStart: string;
  /** End of the last production day. */
  dayEnd: string;
  generatedAt: string;
  activeMachines: number;
  /** Average of the machines' OEE over the range, over machines that counted time. */
  oee: OeeFigures & { machines: number };
  output: number;
  /** rejectTag + rejectInput, as selected by the OEE settings' reject source. */
  reject: number;
  rejectTag: number;
  rejectInput: number;
  /** Size of a trend point: an hour for one day, a production day for longer ranges. */
  bucket: "hour" | "day";
  /**
   * From dayStart, per bucket: 24 clock hours for one day, else one point per production day. Reject
   * input is spread over its shift's points by output.
   */
  trend: { start: string; oee: number | null; output: number; reject: number }[];
  /** Reject input per reject type, largest first. */
  rejectByType: { name: string; quantity: number }[];
  /** OEE over the range per OEE-enabled active machine. */
  machines: { machineId: string; machineNo: string; oee: number | null; output: number; reject: number }[];
  /** Stop / Breakdown time counted by the OEE engine, all machines. */
  machineDowntimeSeconds: number;
  /** Time per status of the status tag, all OEE machines. */
  statusSeconds: { RUN: number; STOP: number; OFF: number };
  downtime: {
    totalSeconds: number;
    byType: { type: string; seconds: number; count: number }[];
  };
}
