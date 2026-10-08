// Keep in sync with oee-realtime-urc/src/types/oee.ts
import type { ShiftPeriod } from "./shift.js";

export type MachineStatus = "RUN" | "STOP" | "OFF";

/**
 * Status shown live: the status tag's status, or BREAKDOWN when the machine is Off during an OEE run
 * that has run and is not finished (when the machine's "breakdown when Off" setting is on).
 */
export type LiveStatus = MachineStatus | "BREAKDOWN";

/** WAITING: not counting yet (see `waitingFor`); RUNNING: counting; FINISHED: a finish rule ended the run. */
export type OeeRunState = "WAITING" | "RUNNING" | "FINISHED";

export interface Sku {
  code: string;
  name: string;
  /** Backend path of the SKU photo (e.g. "/uploads/skus/x.jpg"); null when there is none. */
  image: string | null;
}

/**
 * Why OEE is not counting: no SKU on the product tag, a SKU that is not in the SKU master,
 * the machine is Off while "pause when Off" is set, or a finish rule finished the run.
 */
export type OeeWaitReason = "NO_SKU" | "UNREGISTERED_SKU" | "MACHINE_OFF" | "RUN_FINISHED";

export interface MachineOee {
  machineId: string;
  machineName: string;
  line: string;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  status: LiveStatus;
  /** False for machines that only report status; all OEE figures below are then 0 and must not be shown. */
  oeeEnabled: boolean;
  /** Whether OEE is accumulating right now; when false `waitingFor` says why. */
  counting: boolean;
  waitingFor: OeeWaitReason | null;
  runState: OeeRunState;
  /** When a finish rule ended the run, and which rule; null while the run is open. */
  finishedAt: string | null;
  finishReason: string | null;
  /** Start of the current OEE calculation (shift start, SKU change or settings change); null when OEE is off. */
  runStart: string | null;
  /** SKU the current calculation counts for; null until one has been counted. */
  runSku: string | null;
  /** Time counted in the current calculation (paused time excluded). */
  countedSeconds: number;
  output: number;
  /**
   * Output expected since the current calculation started: counted minutes (RUN and STOP; paused time
   * excluded) × the SKU's output per minute. Performance = output / idealOutput.
   */
  idealOutput: number;
  /** Reject counted in Quality: rejectTag + rejectInput, as selected by the OEE settings' rejectSource. */
  reject: number;
  /** From the machine's reject tag during the run (0 when the tag is not counted). */
  rejectTag: number;
  /** From Reject Input for this machine, the current shift and the run's SKU (0 when input is not counted). */
  rejectInput: number;
  /** Time in RUN during the current shift. */
  uptimeSeconds: number;
  /** Downtime of the current run (STOP and breakdown), and how many times the machine went down. */
  stopSeconds: number;
  stopCount: number;
  sku: Sku;
  updatedAt: string;
}

/** Live values of one machine's monitoring tags, keyed by MonitoringTag.id. */
export interface MachineMonitoring {
  machineId: string;
  values: { id: string; name: string; tagName: string; value: number | null }[];
  updatedAt: string;
}

/** One output or reject counter reading; `quantity` is the increase since the previous reading. */
export interface ProductionLogEntry {
  id: number;
  timestamp: string;
  type: "OUTPUT" | "REJECT";
  counter: number;
  quantity: number;
}

/** A change of the status tag value. */
export interface StatusEvent {
  id: number;
  timestamp: string;
  value: string;
  status: MachineStatus;
}

/** Status on the timeline; NO_DATA before the status tag's first reading. */
export type TimelineStatus = MachineStatus | "NO_DATA";

/** A period with one status. `end` is exclusive. */
export interface TimelineSegment {
  status: TimelineStatus;
  start: string;
  end: string;
}

/** Status over the current shift, from shift start until now. */
export interface MachineTimeline {
  shift: ShiftPeriod;
  shiftStart: string;
  shiftEnd: string;
  now: string;
  segments: TimelineSegment[];
  /** Seconds per status within the shift so far. */
  totals: Record<TimelineStatus, number>;
}

export interface MachineHistory {
  production: ProductionLogEntry[];
  events: StatusEvent[];
}
