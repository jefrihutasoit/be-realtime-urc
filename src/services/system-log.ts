import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { freemem, hostname, totalmem, uptime } from "node:os";
import { dirname, resolve } from "node:path";
import type { SystemEvent, SystemEventType, SystemRunInfo } from "../types/system.js";

/**
 * System event log in local files (not the database, which may be the thing that is down):
 *   logs/system-events.jsonl  one event per line (start, stop, unexpected shutdown, database up/down, …)
 *   logs/heartbeat.json       rewritten every HEARTBEAT_MS while running; `clean` is set on a normal stop
 * At start, a heartbeat without `clean` means the previous run ended without a stop (power loss, crash,
 * hardware failure, killed process): an UNEXPECTED_SHUTDOWN event records when it was last alive.
 */

const DIR = resolve(process.env.LOG_DIR ?? "logs");
const EVENTS = resolve(DIR, "system-events.jsonl");
const HEARTBEAT = resolve(DIR, "heartbeat.json");
const HEARTBEAT_MS = 30_000;
/** The events file is rotated (to .1) beyond this size. */
const MAX_BYTES = 5 * 1024 * 1024;

interface Heartbeat {
  at: string;
  startedAt: string;
  pid: number;
  clean: boolean;
}

const startedAt = new Date().toISOString();
let previousRun: SystemRunInfo | null = null;
let lastBeat: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

const ensureDir = () => mkdirSync(DIR, { recursive: true });

function readHeartbeat(): Heartbeat | null {
  try {
    return JSON.parse(readFileSync(HEARTBEAT, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

function writeHeartbeat(clean: boolean) {
  try {
    ensureDir();
    lastBeat = new Date().toISOString();
    writeFileSync(HEARTBEAT, JSON.stringify({ at: lastBeat, startedAt, pid: process.pid, clean } satisfies Heartbeat));
  } catch (err) {
    console.error("[system] cannot write heartbeat:", (err as Error).message);
  }
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  const parts = [[Math.floor(s / 86400), "d"], [Math.floor((s % 86400) / 3600), "h"], [Math.floor((s % 3600) / 60), "m"]] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, u]) => `${n}${u}`).join(" ");
  return text || `${s}s`;
};

export const systemLog = {
  add(type: SystemEventType, message: string, detail?: Record<string, unknown>) {
    const event: SystemEvent = { at: new Date().toISOString(), type, message, ...(detail && { detail }) };
    try {
      ensureDir();
      if (existsSync(EVENTS) && statSync(EVENTS).size > MAX_BYTES) renameSync(EVENTS, `${EVENTS}.1`);
      appendFileSync(EVENTS, `${JSON.stringify(event)}\n`);
    } catch (err) {
      console.error("[system] cannot write event log:", (err as Error).message);
    }
    const tag = type === "UNEXPECTED_SHUTDOWN" || type === "DB_UNAVAILABLE" ? "warn" : "log";
    console[tag](`[system] ${type}: ${message}`);
  },

  /** Records the start, and an unexpected shutdown of the previous run when its heartbeat was not clean. */
  start() {
    const prev = readHeartbeat();
    if (prev) {
      previousRun = { startedAt: prev.startedAt, lastAliveAt: prev.at, clean: prev.clean };
      if (!prev.clean) {
        const down = Date.now() - Date.parse(prev.at);
        this.add(
          "UNEXPECTED_SHUTDOWN",
          `Previous run stopped without a normal shutdown (power loss, crash, hardware failure or killed process). ` +
            `Last alive ${new Date(prev.at).toLocaleString("en-GB")}, down for about ${duration(down)}.`,
          { lastAliveAt: prev.at, previousStartedAt: prev.startedAt, downSeconds: Math.round(down / 1000) }
        );
      }
    }
    this.add("SYSTEM_START", `Backend started on ${hostname()} (pid ${process.pid})`, {
      host: hostname(),
      pid: process.pid,
      node: process.version,
      osUptimeSeconds: Math.round(uptime()),
      memoryFreeMb: mb(freemem()),
      memoryTotalMb: mb(totalmem()),
    });
    writeHeartbeat(false);
    timer = setInterval(() => writeHeartbeat(false), HEARTBEAT_MS);
  },

  /** Normal shutdown: the next start will not report an unexpected one. */
  stop(reason: string) {
    clearInterval(timer);
    this.add("SYSTEM_STOP", `Backend stopped normally (${reason})`);
    writeHeartbeat(true);
  },

  /** Newest events first; optionally only some types. */
  list(limit = 200, types?: SystemEventType[]): SystemEvent[] {
    const read = (file: string) => {
      try {
        return readFileSync(file, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    };
    const lines = [...read(`${EVENTS}.1`), ...read(EVENTS)];
    const out: SystemEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const e = JSON.parse(lines[i]) as SystemEvent;
        if (!types || types.includes(e.type)) out.push(e);
      } catch {
        // A line cut off by a power loss.
      }
    }
    return out;
  },

  info() {
    return {
      startedAt,
      lastHeartbeatAt: lastBeat,
      heartbeatSeconds: HEARTBEAT_MS / 1000,
      previousRun,
      host: hostname(),
      pid: process.pid,
      node: process.version,
      osUptimeSeconds: Math.round(uptime()),
      memoryFreeMb: mb(freemem()),
      memoryTotalMb: mb(totalmem()),
      logFile: EVENTS,
    };
  },
};

export const systemLogDir = () => dirname(EVENTS);
