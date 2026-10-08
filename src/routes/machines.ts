import { Router } from "express";
import { HttpError } from "../lib/http-error.js";
import { machineStore } from "../services/machine-store.js";
import { forgetMachine } from "../services/oee-engine.js";
import { resolveStatus, settingsStore } from "../services/settings-store.js";
import { tagValueStore } from "../services/tag-value-store.js";
import { shiftPeriodAt } from "../services/shift-store.js";
import type {
  MachineHistory,
  MachineStatus,
  MachineTimeline,
  ProductionLogEntry,
  StatusEvent,
  TimelineSegment,
  TimelineStatus,
} from "../types/oee.js";
import type { TagReading } from "../types/tag.js";

export const machinesRouter = Router();

async function getMachine(id: string) {
  const machine = await machineStore.get(id);
  if (!machine) throw new HttpError(404, "Machine not found");
  return machine;
}

/** Counter readings (newest first) with the increase since the previous reading; a drop means a reset. */
function counterLog(readings: TagReading[], type: ProductionLogEntry["type"], limit: number): ProductionLogEntry[] {
  const entries: ProductionLogEntry[] = [];
  for (let i = 0; i < Math.min(readings.length, limit); i++) {
    const counter = Number(readings[i].value);
    if (!Number.isFinite(counter)) continue;
    const previous = readings[i + 1] ? Number(readings[i + 1].value) : 0;
    const quantity = Number.isFinite(previous) && counter >= previous ? counter - previous : counter;
    entries.push({ id: readings[i].id, timestamp: readings[i].timestamp, type, counter, quantity });
  }
  return entries;
}

machinesRouter.get("/", async (_req, res) => {
  res.json(await machineStore.list());
});

machinesRouter.get("/:id", async (req, res) => {
  res.json(await getMachine(req.params.id));
});

/** Output/reject log and status change events of one machine, newest first. */
machinesRouter.get("/:id/history", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
  const machine = await getMachine(req.params.id);
  const [outputs, rejects, statuses, statusDefinition] = await Promise.all([
    tagValueStore.history(machine.tagOutput, limit + 1),
    tagValueStore.history(machine.tagReject, limit + 1),
    // Repeated identical values are not events, so read more rows than we return.
    tagValueStore.history(machine.tagStatus, limit * 5),
    settingsStore.getStatusDefinition(),
  ]);

  const production = [...counterLog(outputs, "OUTPUT", limit), ...counterLog(rejects, "REJECT", limit)]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id - a.id)
    .slice(0, limit);

  const events: StatusEvent[] = [];
  for (let i = 0; i < statuses.length && events.length < limit; i++) {
    const r = statuses[i];
    if (statuses[i + 1]?.value === r.value) continue; // same value as the reading before it
    const n = Number(r.value);
    events.push({
      id: r.id,
      timestamp: r.timestamp,
      value: r.value,
      status: resolveStatus(Number.isFinite(n) ? n : null, statusDefinition),
    });
  }

  const history: MachineHistory = { production, events };
  res.json(history);
});

/**
 * Status timeline of the current shift, built from the status tag's recorded timestamps.
 * Before the first reading the status is the last value recorded before the shift, or NO_DATA when there is none.
 */
machinesRouter.get("/:id/timeline", async (req, res) => {
  const machine = await getMachine(req.params.id);
  const now = new Date();
  const shift = shiftPeriodAt(now);
  const shiftStart = new Date(shift.start);
  const [before, readings, statusDefinition] = await Promise.all([
    tagValueStore.latestBefore([machine.tagStatus], shiftStart),
    tagValueStore.between(machine.tagStatus, shiftStart, now),
    settingsStore.getStatusDefinition(),
  ]);
  const toStatus = (value: string | undefined): MachineStatus => {
    const n = value === undefined ? NaN : Number(value);
    return resolveStatus(Number.isFinite(n) ? n : null, statusDefinition);
  };

  const segments: TimelineSegment[] = [];
  let current: { status: TimelineStatus; start: number } = {
    status: before[0] ? toStatus(before[0].value) : "NO_DATA",
    start: shiftStart.getTime(),
  };
  for (const r of readings) {
    const status = toStatus(r.value);
    if (status === current.status) continue;
    const at = new Date(r.timestamp).getTime();
    if (at > current.start) {
      segments.push({ status: current.status, start: new Date(current.start).toISOString(), end: r.timestamp });
    }
    current = { status, start: at };
  }
  segments.push({ status: current.status, start: new Date(current.start).toISOString(), end: now.toISOString() });

  const totals: Record<TimelineStatus, number> = { RUN: 0, STOP: 0, OFF: 0, NO_DATA: 0 };
  for (const s of segments) totals[s.status] += Math.round((Date.parse(s.end) - Date.parse(s.start)) / 1000);

  const timeline: MachineTimeline = {
    shift,
    shiftStart: shift.start,
    shiftEnd: shift.end,
    now: now.toISOString(),
    segments,
    totals,
  };
  res.json(timeline);
});

machinesRouter.post("/", async (req, res) => {
  res.status(201).json(await machineStore.create(req.body));
});

machinesRouter.patch("/:id", async (req, res) => {
  res.json(await machineStore.update(req.params.id, req.body));
});

machinesRouter.delete("/:id", async (req, res) => {
  await machineStore.remove(req.params.id);
  forgetMachine(req.params.id);
  res.json({ ok: true });
});
