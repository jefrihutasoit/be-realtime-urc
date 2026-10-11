// Keep in sync with oee-realtime-urc/src/types/system.ts

export type SystemEventType =
  | "SYSTEM_START"
  | "SYSTEM_STOP"
  | "UNEXPECTED_SHUTDOWN"
  | "DB_CONNECTED"
  | "DB_UNAVAILABLE"
  | "DB_SETTINGS_CHANGED"
  | "SETTINGS_RESTORED"
  | "DATABASE_RESTORED";

export interface SystemEvent {
  at: string;
  type: SystemEventType;
  message: string;
  detail?: Record<string, unknown>;
}

/** The run before this one, from its last heartbeat. */
export interface SystemRunInfo {
  startedAt: string;
  lastAliveAt: string;
  /** False when it ended without a normal shutdown. */
  clean: boolean;
}

/** GET /system/status: open to everyone, so the app can show that the database is down. */
export interface SystemStatus {
  database: { ready: boolean; error: string | null; since: string };
  startedAt: string;
}

/** GET /system/info: details for System Management. */
export interface SystemInfo extends SystemStatus {
  lastHeartbeatAt: string | null;
  heartbeatSeconds: number;
  previousRun: SystemRunInfo | null;
  host: string;
  pid: number;
  node: string;
  osUptimeSeconds: number;
  memoryFreeMb: number;
  memoryTotalMb: number;
  logFile: string;
}

/** Display theme for every user and the dashboards (stored in app_settings, part of the settings backup). */
export interface AppearanceSettings {
  mode: "light" | "dark";
  accent: "blue" | "teal" | "indigo" | "green" | "red" | "orange";
}

export const DEFAULT_APPEARANCE: AppearanceSettings = { mode: "light", accent: "blue" };
