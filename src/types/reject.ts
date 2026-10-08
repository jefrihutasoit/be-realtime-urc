// Keep in sync with oee-realtime-urc/src/types/reject.ts

/** A reject category, e.g. "Pouch Bocor". New categories are added automatically by uploads. */
export interface RejectType {
  id: string;
  name: string;
  sortOrder: number;
}

/** One machine row of an uploaded reject sheet, as read from the file. */
export interface RejectUploadRow {
  /** Row number in the spreadsheet, for messages. */
  rowNumber: number;
  /** MC column; matched to a registered machine number. */
  machineNo: string;
  operator: string;
  /** SKU column, e.g. "15 gr"; matched together with `flavor` to the SKU master. */
  sku: string;
  /** FLV column, e.g. "King stick Jagung Bakar"; matched to the SKU master's product name. */
  flavor: string;
  /** Quantity per reject type, in the same order as `RejectUploadInput.rejectTypes`. Empty cells are null. */
  quantities: (number | string | null)[];
}

/** One shift's reject sheet. */
export interface RejectUploadInput {
  /** "YYYY-MM-DD". */
  productionDate: string;
  shiftId: string;
  /** Reject type names from the sheet header (the "Data Reject" columns). */
  rejectTypes: string[];
  rows: RejectUploadRow[];
}

export interface RejectRowCheck {
  rowNumber: number;
  machineNo: string;
  /** Registered machine / SKU master this row matched; null when not found. */
  machineId: string | null;
  skuMasterId: string | null;
  skuId: string | null;
  /** Problems that block the upload. Empty when the row is valid. */
  issues: string[];
  /** Notes that do not block the upload, e.g. an empty operator or a row skipped for having no SKU. */
  warnings: string[];
  /** Rows without a SKU are not uploaded. */
  skipped: boolean;
}

export interface RejectValidation {
  valid: boolean;
  /** Problems with the sheet as a whole (date, shift, columns). */
  errors: string[];
  rows: RejectRowCheck[];
  /** Reject types in the sheet that do not exist yet; they are created on upload. */
  newRejectTypes: string[];
  /** Machines in the sheet that already have data for this date and shift; it is replaced on upload. */
  replacedMachines: string[];
}

export interface RejectUploadResult {
  saved: number;
  replaced: number;
  createdTypes: string[];
}

/** Reject data of one machine in one shift. */
export interface RejectRecord {
  id: string;
  productionDate: string;
  shiftId: string;
  shiftName: string;
  machineId: string;
  machineNo: string;
  operator: string;
  skuMasterId: string | null;
  skuId: string;
  productName: string;
  sku: string;
  /** Quantity per reject type id. */
  quantities: Record<string, number>;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface RejectTypeInput {
  name: string;
  /** Position in lists and the upload template; defaults to the end. */
  sortOrder?: number;
}

/** Manual input is allowed for today and the days before it, up to this many days in total. */
export const MANUAL_INPUT_DAYS = 3;

/** A SKU that ran on a machine during a shift, read from the machine's product tag. */
export interface RunningSku {
  skuMasterId: string;
  skuId: string;
  productName: string;
  sku: string;
}

export interface RunningSkus {
  /** ISO timestamps of the shift occurrence that was searched. */
  start: string;
  end: string;
  skus: RunningSku[];
}

/** Reject data of one machine, shift and SKU entered by hand. Saving replaces the record's quantities. */
export interface ManualRejectInput {
  productionDate: string;
  shiftId: string;
  machineId: string;
  skuMasterId: string;
  operator: string;
  items: { rejectTypeId: string; quantity: number }[];
}
