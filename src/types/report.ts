// Keep in sync with oee-realtime-urc/src/types/report.ts

/**
 * How report rows are grouped:
 *   daily   — per production date, a row per machine and SKU
 *   shift   — per production date and shift, a row per machine and SKU
 *   machine — per machine over the whole range, a row per SKU
 *   sku     — per SKU over the whole range, a row per machine
 */
export type ReportType = "daily" | "shift" | "machine" | "sku";

/** Output and reject in pcs; OEE figures in percent, null when no time was counted. */
export interface ReportFigures {
  output: number;
  reject: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
}

export interface ReportRow extends ReportFigures {
  machineId: string;
  machineNo: string;
  /** SKU ID of the SKU master, or the raw product tag code; "-" when unknown or without a SKU. */
  skuCode: string;
  productName: string;
}

export interface ReportGroup {
  key: string;
  /** Production date "YYYY-MM-DD" (daily and shift reports). */
  date: string | null;
  /** Shift report only; shiftId null is time outside every shift. */
  shiftId: string | null;
  shiftName: string | null;
  /** Machine report only. */
  machineId: string | null;
  machineNo: string | null;
  /** SKU report only. */
  skuCode: string | null;
  productName: string | null;
  /** Figures over all rows of the group (from the summed times and counts, not an average of rows). */
  total: ReportFigures;
  rows: ReportRow[];
}

export interface Report {
  type: ReportType;
  /** Production dates, inclusive. */
  from: string;
  to: string;
  generatedAt: string;
  groups: ReportGroup[];
  total: ReportFigures;
}

/** `GET /api/reports` query: dates "YYYY-MM-DD"; machines, skus: comma-separated; empty = all. */
export interface ReportQuery {
  type: ReportType;
  from: string;
  to: string;
  machines?: string;
  skus?: string;
  shift?: string;
}
