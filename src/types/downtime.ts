// Keep in sync with oee-realtime-urc/src/types/downtime.ts

/** One row of the downtime sheet, as read by the frontend. Only the machine is checked against the master. */
export interface DowntimeUploadRow {
  /** Row number in the spreadsheet, for messages. */
  rowNumber: number;
  /** "YYYY-MM-DD"; rows without a date take the date of the row above (`dateFromAbove`). */
  productionDate: string | null;
  dateFromAbove: boolean;
  /** "Machine Packaging": one registered machine number, exactly as in Machine Management. */
  machineText: string;
  /** Stored as written. */
  bagger: string;
  line: string;
  sku: string;
  /** "HH:mm" or null. */
  start: string | null;
  end: string | null;
  /** From "Total (Second)", else "Total (Hr)", else start → end. */
  durationSeconds: number | null;
  notificationNo: string;
  detail: string;
  operator: string;
  /** "Tipe Downtime", e.g. EL, OL. */
  downtimeType: string;
}

export interface DowntimeUploadInput {
  rows: DowntimeUploadRow[];
}

export interface DowntimeRowCheck {
  rowNumber: number;
  /** The registered machine of the row (empty when it is not registered). */
  machines: string[];
  /** Problems that block the upload. */
  issues: string[];
  warnings: string[];
}

export interface DowntimeValidation {
  valid: boolean;
  errors: string[];
  rows: DowntimeRowCheck[];
  /** Rows already uploaded (same date, machine, bagger and start); they are replaced. */
  replaced: number;
}

export interface DowntimeUploadResult {
  saved: number;
  replaced: number;
}

export interface DowntimeRecord {
  id: string;
  productionDate: string;
  machineText: string;
  bagger: string;
  line: string;
  sku: string;
  start: string;
  end: string;
  durationSeconds: number | null;
  notificationNo: string;
  detail: string;
  operator: string;
  downtimeType: string;
  /** Registered machine numbers. */
  machines: string[];
  createdAt: string;
}
