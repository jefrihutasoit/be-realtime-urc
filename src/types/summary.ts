// Keep in sync with oee-realtime-urc/src/types/summary.ts
/** OEE figures in percent; null when nothing was counted. */
export interface OeeFigures {
  oee: number | null;
  availability: number | null;
  performance: number | null;
  quality: number | null;
}

/**
 * Everything the summary page shows for one production day: from the start of the earliest shift on
 * that date for 24 hours. OEE comes from the hourly figures the engine saves (oee_hourly), reject input
 * and downtime from their uploads for that production date.
 */
export interface DailySummary {
  date: string;
  dayStart: string;
  dayEnd: string;
  generatedAt: string;
  activeMachines: number;
  /** Average of the machines' day OEE, over machines that counted time. */
  oee: OeeFigures & { machines: number };
  output: number;
  /** rejectTag + rejectInput, as selected by the OEE settings' reject source. */
  reject: number;
  rejectTag: number;
  rejectInput: number;
  /** 24 clock hours from dayStart. Reject input is spread over its shift's hours by output. */
  hourly: { hour: string; oee: number | null; output: number; reject: number }[];
  /** Reject input per reject type, largest first. */
  rejectByType: { name: string; quantity: number }[];
  /** Day OEE per OEE-enabled active machine. */
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
