// Keep in sync with oee-realtime-urc/src/types/historical.ts
import type { ReportFigures } from "./report.js";

/**
 * Historical page data for a range of production dates and the report filters (machines, SKUs, shift).
 * Figures of a group come from its summed times and counts, as in the reports.
 */
export interface HistoricalData {
  from: string;
  to: string;
  generatedAt: string;
  total: ReportFigures;
  /** Machines with data, by machine number. */
  machines: (ReportFigures & { machineId: string; machineNo: string })[];
  /** Every production date of the range, oldest first; `machines` holds only machines with data that day. */
  days: { date: string; total: ReportFigures; machines: Record<string, ReportFigures> }[];
}

/** One clock hour and SKU of one machine on one production date. */
export interface HourlyDetailRow extends ReportFigures {
  /** ISO start of the clock hour. */
  hourStart: string;
  skuCode: string;
  productName: string;
  /** Uploaded downtime of the machine overlapping the hour (detail, else downtime type). */
  remarks: string;
}

/** `GET /api/historical/hourly?machine=&date=[&skus=][&shift=]`. Reject input is spread over its shift's hours by output. */
export interface HourlyDetail {
  machineId: string;
  machineNo: string;
  date: string;
  rows: HourlyDetailRow[];
  total: ReportFigures;
}
