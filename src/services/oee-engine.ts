import { shiftPeriodAt } from "./shift-store.js";
import type { MachineRegistration } from "../types/machine.js";
import type { MachineStatus, MachineOee, OeeWaitReason, Sku } from "../types/oee.js";
import type { FinishRule, OeeSettings, StatusDefinition } from "../types/settings.js";
import { resolveStatus } from "./settings-store.js";

/**
 * Turns gateway samples into OEE for one "run": a stretch of the current shift that ends at the shift
 * boundary, when the machine's OEE settings change, (with resetOnSkuChange) when the SKU changes, or
 * when one of the machine's finish rules holds. A finished run keeps its figures until production can
 * start again: the gate is open, the machine is not Off and no finish rule holds.
 * With breakdownWhenOff, Off during a run that has run and is not finished is a breakdown: downtime,
 * counted in the same Stop / Breakdown timer as STOP.
 * The states are saved regularly (oee-state-store) and restored at startup, so a backend restart keeps
 * the open runs of the current shift. A gap of more than MAX_CREDIT_GAP_MS without samples is not counted.
 * All rules are global (OeeSettings). Changing the finish rules keeps the run; any other change starts a new one.
 * Time and output only count while the run's gate is open (see `gateOf`).
 *   Availability = run time / counted time
 *   Performance  = output / ideal output, where ideal output accumulates counted minutes
 *                  (RUN and STOP, paused time excluded) × output-per-minute of the SKU at that time
 *   Quality      = (output − reject) / output, where reject is the reject tag and/or the reject input of
 *                  the run's SKU in the current shift (OeeSettings.rejectSource)
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
  /** Downtime: STOP, and Off when it is a breakdown. */
  stopMs: number;
  stopCount: number;
  /** Set when a finish rule ended the run; nothing is counted afterwards. */
  finishedAt: number | null;
  finishReason: string | null;
  /** Ideal output over all counted time since the calculation started (RUN and STOP). */
  idealOutput: number;
  output: number;
  reject: number;
}

interface MachineState {
  run: RunState;
  lastSampleAt: number;
  lastStatus: MachineStatus;
  /** Whether the machine was in breakdown since the last sample. */
  lastBreakdown: boolean;
  /** Since when each finish rule (by index) has held during the open run; null when it does not hold. */
  ruleSince: (number | null)[];
  /** The finish rules `ruleSince` belongs to; a change of the rules restarts the hold timers. */
  rulesKey: string;
  /** Whether time and output were counting since the last sample. */
  lastCounting: boolean;
  /** Ideal rate (packs/min) in effect since the last sample. */
  lastRate: number;
  /** Product tag code in effect since the last sample; the hourly bucket of the interval is booked to it. */
  lastSkuCode?: string;
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
  oee: OeeSettings;
  sku: Sku;
  /** True when the product tag matches a SKU in the SKU master. */
  skuRegistered: boolean;
  /** Ideal output rate (packs/min) of the running SKU. */
  idealRate: number;
  /** Reject input of this machine in the current shift, by lower-cased SKU ID. */
  inputRejects?: Record<string, number>;
  /**
   * Counter values at shift start, used only when this machine's state is created for a new shift period.
   * Undefined means "no history": the first sample becomes the baseline.
   */
  baseline?: { output: number; reject: number };
}

const states = new Map<string, MachineState>();

/** Longest interval between two samples that is still credited (e.g. not the time the backend was down). */
const MAX_CREDIT_GAP_MS = 5 * 60_000;

/** What was counted for one machine in one clock hour; saved by oee-history-store for the daily summary. */
export interface HourlyBucket {
  machineId: string;
  /** Local clock hour, as epoch ms. */
  hourStart: number;
  /** Product tag code ("-" without a SKU). */
  skuCode: string;
  countedMs: number;
  runMs: number;
  stopMs: number;
  idealOutput: number;
  output: number;
  rejectTag: number;
  /** Time per status of the status tag, counting or not. */
  statusMs: Record<MachineStatus, number>;
}

const buckets = new Map<string, HourlyBucket>();

function bucketFor(machineId: string, at: number, skuCode: string) {
  const hour = new Date(at);
  hour.setMinutes(0, 0, 0);
  const key = `${machineId}|${hour.getTime()}|${skuCode}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      machineId,
      hourStart: hour.getTime(),
      skuCode,
      countedMs: 0,
      runMs: 0,
      stopMs: 0,
      idealOutput: 0,
      output: 0,
      rejectTag: 0,
      statusMs: { RUN: 0, STOP: 0, OFF: 0 },
    };
    buckets.set(key, b);
  }
  return b;
}

/** Hands over the buckets collected since the last call. */
export function takeHourlyBuckets() {
  const list = [...buckets.values()];
  buckets.clear();
  return list;
}

/** Puts buckets back after they could not be saved, so the next save includes them. */
export function returnHourlyBuckets(list: HourlyBucket[]) {
  for (const old of list) {
    const b = bucketFor(old.machineId, old.hourStart, old.skuCode);
    b.countedMs += old.countedMs;
    b.runMs += old.runMs;
    b.stopMs += old.stopMs;
    b.idealOutput += old.idealOutput;
    b.output += old.output;
    b.rejectTag += old.rejectTag;
    for (const st of ["RUN", "STOP", "OFF"] as const) b.statusMs[st] += old.statusMs[st];
  }
}

const pct = (n: number) => Math.round(Math.min(Math.max(n, 0), 1) * 1000) / 10;
/** The settings a run is calculated with; finish rules, reject source and machine name do not restart it. */
const configKeyOf = ({
  finishRules: _rules,
  rejectSource: _source,
  machineLabelEnabled: _labelOn,
  machineLabel: _label,
  ...c
}: OeeSettings) => JSON.stringify(c);

/** Product tag empty or 0. */
const isEmptySku = (code: string) => code.trim() === "" || code === "-" || (/^[\d.]+$/.test(code) && Number(code) === 0);

function ruleHolds(rule: FinishRule, status: MachineStatus, ctx: SampleContext) {
  const sku =
    rule.sku === "any" || (rule.sku === "empty" ? isEmptySku(ctx.sku.code) : !ctx.skuRegistered || isEmptySku(ctx.sku.code));
  return sku && (rule.status === "ANY" || rule.status === status);
}

const SKU_TEXT: Record<FinishRule["sku"], string> = {
  notInMaster: "SKU not in master",
  empty: "SKU empty",
  any: "",
};

/** E.g. "SKU not in master + Off for 60 s". */
export function describeFinishRule(rule: FinishRule) {
  const parts = [SKU_TEXT[rule.sku], rule.status === "ANY" ? "" : rule.status[0] + rule.status.slice(1).toLowerCase()];
  const text = parts.filter(Boolean).join(" + ");
  return rule.holdSeconds ? `${text} for ${rule.holdSeconds} s` : text;
}

/** Increase of a counter since the last read; a drop means the PLC counter was reset. */
function counterDelta(current: number | null, last: number | null) {
  if (current === null || last === null) return 0;
  return current >= last ? current - last : current;
}

/** Whether OEE counts right now, and if not, why. */
function gateOf(config: OeeSettings, status: MachineStatus, ctx: SampleContext): OeeWaitReason | null {
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
    finishedAt: null,
    finishReason: null,
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
  const config = ctx.oee;
  const configKey = configKeyOf(config);
  const status = resolveStatus(sample.status, ctx.statusDefinition);
  // Gate from SKU and Off settings alone; a finished run and breakdowns are applied below.
  const gateWait = gateOf(config, status, ctx);
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
      lastBreakdown: false,
      ruleSince: [],
      rulesKey: "",
      lastCounting: gateWait === null,
      lastRate: ctx.idealRate,
      lastSkuCode: ctx.sku.code,
      lastOutputCounter: base ? base.output : sample.output,
      lastRejectCounter: base ? base.reject : sample.reject,
    };
    // Production between the baseline and now is credited when the gate is open.
    s.lastCounting = gateWait === null && !!base;
    states.set(machine.id, s);
  } else if (s.run.periodStart !== periodStart || s.run.configKey !== configKey) {
    // New shift or changed settings: close the run. The interval since the last sample is not credited.
    s.run = newRun(periodStart, configKey, now);
    s.lastSampleAt = now;
    s.lastCounting = false;
    s.ruleSince = [];
  }
  const run = s.run;

  // Credit the interval since the last sample, using the status, rate and gate seen at its start.
  // The same amounts go to the bucket of the hour and SKU for the daily summary and reports.
  const gap = now - s.lastSampleAt;
  const bucket = bucketFor(machine.id, now, s.lastSkuCode ?? ctx.sku.code);
  if (gap > 0 && gap <= MAX_CREDIT_GAP_MS) bucket.statusMs[s.lastStatus] += gap;
  if (s.lastCounting && gap <= MAX_CREDIT_GAP_MS) {
    const ms = gap;
    const ideal = (ms / 60_000) * s.lastRate;
    run.countedMs += ms;
    run.idealOutput += ideal;
    bucket.countedMs += ms;
    bucket.idealOutput += ideal;
    if (s.lastStatus === "RUN") {
      run.runMs += ms;
      bucket.runMs += ms;
    } else if (s.lastStatus === "STOP" || s.lastBreakdown) {
      run.stopMs += ms;
      bucket.stopMs += ms;
    }
    if (!direct) {
      const output = counterDelta(sample.output, s.lastOutputCounter);
      const reject = counterDelta(sample.reject, s.lastRejectCounter);
      run.output += output;
      run.reject += reject;
      bucket.output += output;
      bucket.rejectTag += reject;
    }
  }
  s.lastOutputCounter = sample.output ?? s.lastOutputCounter;
  s.lastRejectCounter = sample.reject ?? s.lastRejectCounter;

  // Finish rules apply to a run that has run (has RUN time) and is not finished yet.
  const rules = config.finishRules;
  const rulesKey = JSON.stringify(rules);
  if (s.rulesKey !== rulesKey) {
    s.ruleSince = [];
    s.rulesKey = rulesKey;
  }
  const holds = rules.map((r) => ruleHolds(r, status, ctx));
  const open = run.finishedAt === null && run.runMs > 0;
  s.ruleSince = rules.map((_, i) => (open && holds[i] ? (s.ruleSince[i] ?? now) : null));
  if (open) {
    const hit = rules.findIndex((r, i) => holds[i] && now - s.ruleSince[i]! >= r.holdSeconds * 1000);
    if (hit >= 0) {
      run.finishedAt = now;
      run.finishReason = describeFinishRule(rules[hit]);
      s.ruleSince = [];
    }
  }

  // A new run starts after a finish once production can start again, or (with resetOnSkuChange)
  // when the SKU changes. Neither happens while the machine is Off.
  const canStart = gateWait === null && status !== "OFF";
  if (run.finishedAt !== null) {
    if (canStart && !holds.some(Boolean)) s.run = newRun(periodStart, configKey, now);
  } else if (canStart && config.resetOnSkuChange && run.skuCode !== null && run.skuCode !== ctx.sku.code) {
    s.run = newRun(periodStart, configKey, now);
  }
  const current = s.run;
  const finished = current.finishedAt !== null;
  const breakdown = !finished && config.breakdownWhenOff && status === "OFF" && current.runMs > 0;
  let waitingFor: OeeWaitReason | null = finished ? "RUN_FINISHED" : gateWait;
  // A breakdown is downtime, so it counts even when Off is otherwise paused.
  if (breakdown && waitingFor === "MACHINE_OFF") waitingFor = null;
  const counting = waitingFor === null;

  if (counting) {
    // A stop or breakdown starts when the machine goes down; STOP turning into a breakdown is the same one.
    const wasDown = s.lastCounting && (s.lastStatus === "STOP" || s.lastBreakdown);
    if ((status === "STOP" || breakdown) && (!wasDown || current.countedMs === 0)) current.stopCount += 1;
    current.skuCode = ctx.sku.code;
    if (direct) {
      // The tag value is the total itself; the bucket gets the increase.
      const before = { output: current.output, reject: current.reject };
      current.output = sample.output ?? current.output;
      current.reject = sample.reject ?? current.reject;
      bucket.output += Math.max(0, current.output - before.output);
      bucket.rejectTag += Math.max(0, current.reject - before.reject);
    }
  }

  s.lastStatus = status;
  s.lastBreakdown = breakdown && counting;
  s.lastRate = ctx.idealRate;
  s.lastSkuCode = ctx.sku.code;
  s.lastCounting = counting;
  s.lastSampleAt = now;

  const availability = current.countedMs > 0 ? current.runMs / current.countedMs : 0;
  const performance = current.idealOutput > 0 ? current.output / current.idealOutput : 0;
  const rejectTag = config.rejectSource === "input" ? 0 : current.reject;
  const rejectInput =
    config.rejectSource === "tag" || current.skuCode === null ? 0 : (ctx.inputRejects?.[current.skuCode.toLowerCase()] ?? 0);
  const reject = rejectTag + rejectInput;
  const quality = current.output > 0 ? (current.output - reject) / current.output : 1;

  return {
    machineId: machine.id,
    machineName: machine.machineNo,
    line: `Line ${machine.machineNo[0]}`,
    availability: pct(availability),
    performance: pct(performance),
    quality: pct(quality),
    oee: pct(Math.min(availability, 1) * Math.min(performance, 1) * Math.min(quality, 1)),
    status: breakdown ? "BREAKDOWN" : status,
    oeeEnabled: true,
    counting,
    waitingFor,
    runState: finished ? "FINISHED" : counting ? "RUNNING" : "WAITING",
    finishedAt: finished ? new Date(current.finishedAt!).toISOString() : null,
    finishReason: current.finishReason,
    runStart: new Date(current.since).toISOString(),
    runSku: current.skuCode,
    countedSeconds: Math.floor(current.countedMs / 1000),
    output: current.output,
    idealOutput: Math.floor(current.idealOutput),
    reject,
    rejectTag,
    rejectInput,
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
    runState: "WAITING",
    finishedAt: null,
    finishReason: null,
    runStart: null,
    runSku: null,
    countedSeconds: 0,
    output: 0,
    idealOutput: 0,
    reject: 0,
    rejectTag: 0,
    rejectInput: 0,
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

/** Drops every run state and the unsaved hourly figures (after the database was restored or cleared). */
export function resetEngine() {
  states.clear();
  buckets.clear();
}

/** The per-machine states as plain data, to be saved across restarts. */
export function snapshotStates(): [string, unknown][] {
  return [...states].map(([id, s]) => [id, structuredClone(s)]);
}

const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/**
 * Restores saved states at startup. Each one is used only while it fits: a state from an earlier shift
 * or with other OEE settings is replaced by a new run on the first sample, as after any shift change.
 */
export function restoreStates(entries: [string, unknown][]) {
  let restored = 0;
  for (const [id, value] of entries) {
    const s = value as MachineState;
    const r = s?.run as RunState | undefined;
    const valid =
      r &&
      isNumber(r.periodStart) &&
      isNumber(r.since) &&
      typeof r.configKey === "string" &&
      [r.countedMs, r.runMs, r.stopMs, r.stopCount, r.idealOutput, r.output, r.reject].every(isNumber) &&
      isNumber(s.lastSampleAt) &&
      Array.isArray(s.ruleSince);
    if (!valid) continue;
    states.set(id, s);
    restored += 1;
  }
  return restored;
}
