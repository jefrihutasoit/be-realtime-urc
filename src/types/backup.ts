// Keep in sync with oee-realtime-urc/src/types/backup.ts
import type { LayoutDisplay } from "./layout.js";
import type { GatewaySettings } from "./gateway.js";
import type { AppearanceSettings } from "./system.js";
import type { RolePermissions } from "./auth.js";
import type { OeeSettings, StatusDefinition } from "./settings.js";

export const BACKUP_VERSION = 1;

/**
 * All system settings, without history (tag values, reject data) and without uploaded images
 * (machine and SKU photos, the layout image).
 * Records refer to each other by their user-facing keys (machine No, SKU ID, shift name), not by
 * database ids, so a backup can be restored on another installation.
 */
export interface SettingsBackup {
  version: number;
  exportedAt: string;
  machines: BackupMachine[];
  skus: BackupSku[];
  shifts: BackupShift[];
  statusDefinition: StatusDefinition;
  /** Global OEE calculation settings; a backup without them restores the defaults. */
  oeeSettings: OeeSettings;
  /** What each role may do; a backup without them keeps the current role permissions. */
  rolePermissions?: RolePermissions;
  /** Machine positions on the plant layout (3D layout mapping). */
  layoutMarkers: BackupLayoutMarker[];
  rejectTypes: BackupRejectType[];
  /**
   * HTTP / MQTT gateway channels and storage, incl. the API key and MQTT password (keep the file safe).
   * A backup without them keeps the current gateway settings.
   */
  gatewaySettings?: GatewaySettings;
  /** Theme; a backup without it keeps the current one. */
  appearance?: AppearanceSettings;
  /** 3D layout look: default camera, status indicator and marker size; a backup without it keeps the current one. */
  layoutDisplay?: LayoutDisplay;
}

export interface BackupMachine {
  machineNo: string;
  machineName: string;
  tagStatus: string;
  tagOutput: string;
  tagReject: string;
  tagProduct: string;
  outputUnit: string;
  rejectUnit: string;
  realtimeMode: "registered" | "adaptive";
  adaptiveTtlMinutes: number;
  isActive: boolean;
  oeeEnabled: boolean;
  /** Only photo paths (e.g. "/machines/packing-machine.svg"); uploaded photos are not in the backup. */
  photo: string | null;
  monitoringTags: { name: string; tagName: string; unit: string }[];
}

export interface BackupSku {
  skuId: string;
  productName: string;
  sku: string;
  outputPerMinute: number;
}

export interface BackupShift {
  name: string;
  /** "HH:mm". */
  start: string;
  end: string;
}

export interface BackupLayoutMarker {
  machineNo: string;
  x: number;
  y: number;
}

export interface BackupRejectType {
  name: string;
  sortOrder: number;
}

export interface BackupSectionSummary {
  section: string;
  /** Records in the backup file. */
  inBackup: number;
  add: number;
  update: number;
  /** Current records that are not in the backup and are deleted on restore. */
  remove: number;
}

export interface BackupCheck {
  valid: boolean;
  /** Problems that block the restore. */
  errors: string[];
  /** Notes that do not block it, e.g. photos that are kept. */
  warnings: string[];
  summary: BackupSectionSummary[];
}
