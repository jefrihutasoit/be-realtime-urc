// Keep in sync with oee-realtime-urc/src/types/machine.ts

/** A gateway tag shown on the machine's realtime monitoring view, e.g. seal temperature. */
export interface MonitoringTag {
  id: string;
  name: string;
  tagName: string;
}

/**
 * How OEE is calculated for one machine. Stored per machine so the rules can change from the
 * machine settings without code changes.
 */
export interface OeeConfig {
  /**
   * "sku": OEE only counts while the product tag holds a SKU ID registered in the SKU master.
   * "always": OEE always counts; an unknown or empty SKU uses the default ideal rate.
   */
  startMode: "sku" | "always";
  /** Start a new OEE calculation when the running SKU changes (only checked while the machine is not Off). */
  resetOnSkuChange: boolean;
  /** Off time is paused (not counted). When false, Off counts as downtime in Availability. */
  pauseWhenOff: boolean;
  /**
   * "cumulative": output/reject tags are ever-increasing counters; the increase is counted.
   * "direct": the tag value itself is the total for the current calculation (the PLC resets it).
   */
  counterMode: "cumulative" | "direct";
}

export const DEFAULT_OEE_CONFIG: OeeConfig = {
  startMode: "sku",
  resetOnSkuChange: true,
  pauseWhenOff: true,
  counterMode: "cumulative",
};

export interface MachineRegistration {
  id: string;
  machineNo: string;
  machineName: string;
  /** Gateway tag addresses, e.g. "GW01.LINE1.M1A.STATUS". */
  tagStatus: string;
  tagOutput: string;
  tagReject: string;
  /** Tag holding the product / SKU code currently running on the machine. */
  tagProduct: string;
  monitoringTags: MonitoringTag[];
  /** Image URL or data URL; null when no photo has been uploaded. */
  photo: string | null;
  isActive: boolean;
  oeeEnabled: boolean;
  oeeConfig: OeeConfig;
  createdAt: string;
  updatedAt: string;
}

export type ProductionTagKey = "tagStatus" | "tagOutput" | "tagReject" | "tagProduct";

export type MonitoringTagInput = Omit<MonitoringTag, "id"> & { id?: string };

export type MachineInput = Pick<
  MachineRegistration,
  "machineNo" | "machineName" | ProductionTagKey | "photo" | "isActive" | "oeeEnabled" | "oeeConfig"
> & { monitoringTags: MonitoringTagInput[] };

export interface GatewayTag {
  tag: string;
  description: string;
}
