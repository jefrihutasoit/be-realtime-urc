// Keep in sync with oee-realtime-urc/src/types/settings.ts
import type { MachineStatus } from "./oee.js";

/**
 * Global mapping from the raw value of a machine's status tag to RUN / STOP / OFF.
 * A tag that cannot be read is always OFF; a value in none of the lists gets `unmatched`.
 */
export interface StatusDefinition {
  run: number[];
  stop: number[];
  off: number[];
  unmatched: MachineStatus;
}

/**
 * "notInMaster": the product tag holds no SKU from the SKU master (empty, 0 or an unknown code).
 * "empty": the product tag is empty or 0.
 * "any": the SKU is not checked (status only).
 */
export type FinishSkuCondition = "notInMaster" | "empty" | "any";

/** Finishes the OEE run when the SKU and status conditions both hold for `holdSeconds`. */
export interface FinishRule {
  sku: FinishSkuCondition;
  /** Machine status from the status tag; "ANY" does not check it. */
  status: MachineStatus | "ANY";
  /** How long both conditions must hold before the run finishes; 0 finishes at once. */
  holdSeconds: number;
}

/** How OEE is calculated, for every machine with OEE enabled. Changing it starts a new OEE run. */
export interface OeeSettings {
  /**
   * "sku": OEE only counts while the product tag holds a SKU ID registered in the SKU master.
   * "always": OEE always counts; an unknown or empty SKU uses the default ideal rate.
   */
  startMode: "sku" | "always";
  /**
   * "cumulative": output/reject tags are ever-increasing counters; the increase is counted.
   * "direct": the tag value itself is the total for the current run (the PLC resets it).
   */
  counterMode: "cumulative" | "direct";
  /** Start a new OEE run when the running SKU changes (only checked while the machine is not Off). */
  resetOnSkuChange: boolean;
  /** Off time is paused (not counted). When false, Off counts as downtime in Availability. */
  pauseWhenOff: boolean;
  /**
   * Reject counted in Quality: the reject tag, the reject input (Reject Input upload / manual entry for
   * the machine, shift and SKU of the run), or both added together.
   */
  rejectSource: "both" | "tag" | "input";
  /**
   * Off while an OEE run is going (it has run and is not finished) is a BREAKDOWN: counted as downtime
   * even when `pauseWhenOff` is set.
   */
  breakdownWhenOff: boolean;
  /** Conditions that finish the current OEE run; the first one that holds finishes it. */
  finishRules: FinishRule[];
  /**
   * Name used for the OEE machines in the dashboards instead of "Machine" (e.g. "Bagger"), when enabled.
   * Display only: changing it does not restart OEE.
   */
  machineLabelEnabled: boolean;
  machineLabel: string;
}

export const DEFAULT_OEE_SETTINGS: OeeSettings = {
  startMode: "sku",
  counterMode: "cumulative",
  resetOnSkuChange: true,
  pauseWhenOff: true,
  rejectSource: "both",
  breakdownWhenOff: false,
  finishRules: [],
  machineLabelEnabled: false,
  machineLabel: "Bagger",
};
