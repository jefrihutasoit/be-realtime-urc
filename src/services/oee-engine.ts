import { shiftPeriodAt } from "./shift-store.js";
import type { MachineRegistration, OeeConfig } from "../types/machine.js";
import type { MachineStatus, MachineOee, OeeWaitReason, Sku } from "../types/oee.js";
import type { StatusDefinition } from "../types/settings.js";
import { resolveStatus } from "./settings-store.js";

/**
 * Turns gateway samples into OEE for one "run": a stretch of the current shift that ends at the shift
 * boundary, when the machine's OEE settings change, or (with resetOnSkuChange) when the SKU changes.
 * Time and output only count while the run's gate is open (see `gateOf`).
 *   Availability = run time / counted time
 *   Performance  = output / ideal output, where ideal output accumulates counted minutes
 *                  (RUN and STOP, paused time excluded) × output-per-minute of the SKU at that time
 *   Quality      = (output − reject) / output
 */

interface RunState {
  /** Start of the shift period this run belongs to. */
  periodStart: number;
  /** OEE settings the run was started with; any change starts a new run. */
  configKey: string;
  since: number;
  /** SKU the run is counting for; null until a SKU has been counted. */
  skuCode: string | null;
  countedMs: number;
  runMs: number;
  stopMs: number;
  stopCount: number;
  /** Ideal output over all counted time since the calculation started (RUN and STOP). */
  idealOutput: number;
  output: number;
  reject: number;
}

interface MachineState {
  run: RunState;
  lastSampleAt: number;
  lastStatus: MachineStatus;
  /** Whether time and output were counting since the last sample. */
  lastCounting: boolean;
  /** Ideal rate (packs/min) in effect since the last sample. */
  lastRate: number;
  /** Last raw counter values, tracked across runs so a new run starts from the current counter. */
  lastOutputCounter: number | null;
  lastRejectCounter: number | null;
}

export interface Sample {
  status: number | null;
  output: number | null;
  reject: number | null;
}

export interface SampleContext {
  statusDefinition: StatusDefinition;
  sku: Sku;
  /** True when the product tag matches a SKU in the SKU master. */
  skuRegistered: boolean;
  /** Ideal output rate (packs/min) of the running SKU. */
  idealRate: number;
  /**
   * Counter values at shift start, used only when this machine's state is created for a new shift period.
   * Undefined means "no history": the first sample becomes the baseline.
   */
  baseline?: { output: number; reject: number };
}

const states = new Map<string, MachineState>();

const pct = (n: number) => Math.round(Math.min(Math.max(n, 0), 1) * 1000) / 10;
const configKeyOf = (c: OeeConfig) => `${c.startMode}|${c.resetOnSkuChange}|${c.pauseWhenOff}|${c.counterMode}`;

/** Increase of a counter since the last read; a drop means the PLC counter was reset. */
function counterDelta(current: number | null, last: number | null) {
  if (current === null || last === null) return 0;
  return current >= last ? current - last : current;
}

/** Whether OEE counts right now, and if not, why. */
function gateOf(config: OeeConfig, status: MachineStatus, ctx: SampleContext): OeeWaitReason | null {
  if (config.startMode === "sku") {
    if (ctx.sku.code === "-") return "NO_SKU";
    if (!ctx.skuRegistered) return "UNREGISTERED_SKU";
  }
  if (status === "OFF" && config.pauseWhenOff) return "MACHINE_OFF";
  return null;
}

function newRun(periodStart: number, configKey: string, now: number): RunState {
  return {
    periodStart,
    configKey,
    since: now,
    skuCode: null,
    countedMs: 0,
    runMs: 0,
    stopMs: 0,
    stopCount: 0,
    idealOutput: 0,
    output: 0,
    reject: 0,
  };
}

/** True when the next sample for this machine starts a new shift period (so a counter baseline is needed). */
export function needsBaseline(machineId: string, now = Date.now()) {
  return states.get(machineId)?.run.periodStart !== Date.parse(shiftPeriodAt(new Date(now)).start);
}

export function updateOee(machine: MachineRegistration, sample: Sample, ctx: SampleContext, now = Date.now()): MachineOee {
  const config = machine.oeeConfig;
  const configKey = configKeyOf(config);
  const status = resolveStatus(sample.status, ctx.statusDefinition);
  const waitingFor = gateOf(config, status, ctx);
  const counting = waitingFor === null;
  const periodStart = Date.parse(shiftPeriodAt(new Date(now)).start);
  const direct = config.counterMode === "direct";

  let s = states.get(machine.id);
  if (!s) {
    // First sample for this machine: counters start at the shift-start baseline when there is one.
    const base = ctx.baseline;
    s = {
      run: newRun(periodStart, configKey, now),
      lastSampleAt: now,
      lastStatus: status,
      lastCounting: counting,
      lastRate: ctx.idealRate,
      lastOutputCounter: base ? base.output : sample.output,
      lastRejectCounter: base ? base.reject : sample.reject,
    };
    // Production between the baseline and now is credited when the gate is open.
    s.lastCounting = counting && !!base;
    states.set(machine.id, s);
  } else if (s.run.periodStart !== periodStart || s.run.configKey !== configKey) {
    // New shift or changed settings: close the run. The interval since the last sample is not credited.
    s.run = newRun(periodStart, configKey, now);
    s.lastSampleAt = now;
    s.lastCounting = false;
  }
  const run = s.run;

  // Credit the interval since the last sample, using the status, rate and gate seen at its start.
  if (s.lastCounting) {
    const ms = now - s.lastSampleAt;
    run.countedMs += ms;
    run.idealOutput += (ms / 60_000) * s.lastRate;
    if (s.lastStatus === "RUN") {
      run.runMs += ms;
    } else if (s.lastStatus === "STOP") {
      run.stopMs += ms;
    }
    if (!direct) {
      run.output += counterDelta(sample.output, s.lastOutputCounter);
      run.reject += counterDelta(sample.reject, s.lastRejectCounter);
    }
  }
  s.lastOutputCounter = sample.output ?? s.lastOutputCounter;
  s.lastRejectCounter = sample.reject ?? s.lastRejectCounter;

  // A SKU change starts a new calculation. Checked only while counting and not Off.
  if (counting && status !== "OFF" && config.resetOnSkuChange && run.skuCode !== null && run.skuCode !== ctx.sku.code) {
    s.run = newRun(periodStart, configKey, now);
  }
  const current = s.run;
  if (counting) {
    if (status === "STOP" && (s.lastStatus !== "STOP" || !s.lastCounting || current.countedMs === 0)) current.stopCount += 1;
    current.skuCode = ctx.sku.code;
    if (direct) {
      // The tag value is the total itself.
      current.output = sample.output ?? current.output;
      current.reject = sample.reject ?? current.reject;
    }
  }

  s.lastStatus = status;
  s.lastRate = ctx.idealRate;
  s.lastCounting = counting;
  s.lastSampleAt = now;

  const availability = current.countedMs > 0 ? current.runMs / current.countedMs : 0;
  const performance = current.idealOutput > 0 ? current.output / current.idealOutput : 0;
  const quality = current.output > 0 ? (current.output - current.reject) / current.output : 1;

  return {
    machineId: machine.id,
    machineName: machine.machineNo,
    line: `Line ${machine.machineNo[0]}`,
    availability: pct(availability),
    performance: pct(performance),
    quality: pct(quality),
    oee: pct(Math.min(availability, 1) * Math.min(performance, 1) * Math.min(quality, 1)),
    status,
    oeeEnabled: true,
    counting,
    waitingFor,
    runStart: new Date(current.since).toISOString(),
    runSku: current.skuCode,
    countedSeconds: Math.floor(current.countedMs / 1000),
    output: current.output,
    idealOutput: Math.floor(current.idealOutput),
    reject: current.reject,
    uptimeSeconds: Math.floor(current.runMs / 1000),
    stopSeconds: Math.floor(current.stopMs / 1000),
    stopCount: current.stopCount,
    sku: ctx.sku,
    updatedAt: new Date(now).toISOString(),
  };
}

/** Live entry for an active machine with OEE disabled: status only, every OEE figure is 0. */
export function statusOnly(machine: MachineRegistration, status: MachineStatus, now = Date.now()): MachineOee {
  return {
    machineId: machine.id,
    machineName: machine.machineNo,
    line: `Line ${machine.machineNo[0]}`,
    availability: 0,
    performance: 0,
    quality: 0,
    oee: 0,
    status,
    oeeEnabled: false,
    counting: false,
    waitingFor: null,
    runStart: null,
    runSku: null,
    countedSeconds: 0,
    output: 0,
    idealOutput: 0,
    reject: 0,
    uptimeSeconds: 0,
    stopSeconds: 0,
    stopCount: 0,
    sku: { code: "-", name: "No active SKU", image: null },
    updatedAt: new Date(now).toISOString(),
  };
}

export function forgetMachine(id: string) {
  states.delete(id);
}
