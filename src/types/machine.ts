// Keep in sync with oee-realtime-urc/src/types/machine.ts

/** A gateway tag shown on the machine's realtime monitoring view, e.g. seal temperature. */
export interface MonitoringTag {
  id: string;
  name: string;
  tagName: string;
}

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
  createdAt: string;
  updatedAt: string;
}

export type ProductionTagKey = "tagStatus" | "tagOutput" | "tagReject" | "tagProduct";

export type MonitoringTagInput = Omit<MonitoringTag, "id"> & { id?: string };

export type MachineInput = Pick<
  MachineRegistration,
  "machineNo" | "machineName" | ProductionTagKey | "photo" | "isActive" | "oeeEnabled"
> & { monitoringTags: MonitoringTagInput[] };

export interface GatewayTag {
  tag: string;
  description: string;
}
