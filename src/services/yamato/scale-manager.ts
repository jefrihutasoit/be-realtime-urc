import type { ChannelStats } from "../../types/gateway.js";
import { HttpError } from "../../lib/http-error.js";
import type { MachineRegistration } from "../../types/machine.js";
import { tagIngest } from "../tag-ingest.js";
import { YAMATO_FIELDS, readField, scaleTags } from "./fields.js";
import { YamatoClient } from "./yamato-client.js";

/**
 * Keeps one Yamato connection per machine with an enabled scale and reads its DS data every second. The
 * chosen fields go through tag-ingest like gateway readings (current value + storage by the monitoring
 * interval). Each connection runs on its own async loop with timeouts, so a slow or missing scale never
 * holds up the poller, the gateway or another scale. Sessions follow the machine list given to `sync`.
 */

export interface ScaleStatus {
  machineId: string;
  machineNo: string;
  address: string;
  state: "connecting" | "connected" | "error";
  lastReadAt: string | null;
  lastError: string | null;
}

const INTERVAL_MS = 1000;
const RECONNECT_DELAY_MS = 3000;
/** One full DS read (with retries) taking longer than this drops the connection. */
const TRANSACTION_TIMEOUT_MS = 8000;
/** Values older than this are shown as no value (scale unreachable). */
const STALE_MS = 5000;
/** A connection test gives up after this. */
const TEST_TIMEOUT_MS = 10_000;

/** Result of a connection test: the raw DS payload and every field read from it. */
export interface ScaleTestResult {
  /** "live" when the machine's running connection to the same scale answered (no second connection). */
  source: "test" | "live";
  ms: number;
  payload: string;
  fields: { key: string; label: string; group: string; unit: string; offset: number; length: number; raw: string; value: string | null }[];
}

interface Session {
  signature: string;
  machineNo: string;
  client: YamatoClient;
  tags: ReturnType<typeof scaleTags>;
  running: boolean;
  wake: (() => void) | null;
  state: ScaleStatus["state"];
  lastReadAt: number | null;
  lastError: string | null;
  /** Latest values by field key. */
  values: Record<string, string | null>;
  /** Raw DS payload of the last read. */
  payload: string | null;
}

const sessions = new Map<string, Session>();

const stats: ChannelStats = {
  messages: 0,
  readings: 0,
  ignored: 0,
  invalid: 0,
  retimed: 0,
  lastMessageAt: null,
  lastError: null,
};

const signatureOf = (m: MachineRegistration) =>
  JSON.stringify([m.machineNo, m.scale!.host, m.scale!.port, m.scale!.mcSide, m.scale!.fields]);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Waits `ms`, or less when the session is stopped. */
function pause(s: Session, ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      s.wake = null;
      resolve();
    }
    s.wake = done;
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error("Transaction timeout"));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function run(s: Session) {
  while (s.running) {
    if (!s.client.connected) {
      s.state = s.lastError ? "error" : "connecting";
      try {
        await s.client.connect();
        if (!s.running) break;
        s.state = "connected";
        s.lastError = null;
      } catch (err) {
        s.state = "error";
        s.lastError = `Connect failed: ${message(err)}`;
        await pause(s, RECONNECT_DELAY_MS);
        continue;
      }
    }

    const started = Date.now();
    try {
      const payload = await withTimeout(s.client.readDs(), TRANSACTION_TIMEOUT_MS, () => s.client.close());
      if (!s.running) break;
      const at = new Date();
      s.payload = payload;
      const readings: { tagName: string; value: string; recordedAt: Date }[] = [];
      for (const t of s.tags) {
        const value = readField(payload, t.field);
        s.values[t.field.key] = value;
        if (value !== null) readings.push({ tagName: t.tagName, value, recordedAt: at });
      }
      s.lastReadAt = at.getTime();
      s.state = "connected";
      s.lastError = null;
      // Storage problems are tag-ingest's; they must not stop the scale loop.
      if (readings.length) await tagIngest.ingest(readings, stats).catch((err) => (stats.lastError = message(err)));
    } catch (err) {
      s.state = "error";
      s.lastError = message(err);
      s.client.close();
    }
    if (s.running) await pause(s, Math.max(0, INTERVAL_MS - (Date.now() - started)));
  }
  s.client.close();
}

function stopSession(machineId: string) {
  const s = sessions.get(machineId);
  if (!s) return;
  s.running = false;
  s.client.close();
  s.wake?.();
  sessions.delete(machineId);
}

export const scaleManager = {
  /** Starts, restarts or stops sessions to match the machines (active, with an enabled scale). */
  sync(machines: MachineRegistration[]) {
    const wanted = new Map(machines.filter((m) => m.isActive && m.scale?.enabled && m.scale.host).map((m) => [m.id, m]));
    for (const id of [...sessions.keys()]) {
      const m = wanted.get(id);
      if (!m || sessions.get(id)!.signature !== signatureOf(m)) stopSession(id);
    }
    for (const [id, m] of wanted) {
      if (sessions.has(id)) continue;
      const s: Session = {
        signature: signatureOf(m),
        machineNo: m.machineNo,
        client: new YamatoClient(m.scale!.host, m.scale!.port, m.scale!.mcSide),
        tags: scaleTags(m),
        running: true,
        wake: null,
        state: "connecting",
        lastReadAt: null,
        lastError: null,
        values: {},
        payload: null,
      };
      sessions.set(id, s);
      void run(s).catch((err) => {
        s.state = "error";
        s.lastError = message(err);
      });
    }
  },

  /** Current values of a machine's scale by field key; null for every field while the scale is unreachable. */
  value(machineId: string, key: string): string | null {
    const s = sessions.get(machineId);
    if (!s || s.lastReadAt === null || Date.now() - s.lastReadAt > STALE_MS) return null;
    return s.values[key] ?? null;
  },

  status(): ScaleStatus[] {
    return [...sessions.entries()].map(([machineId, s]) => ({
      machineId,
      machineNo: s.machineNo,
      address: `${s.client.host}:${s.client.port}`,
      state: s.state,
      lastReadAt: s.lastReadAt ? new Date(s.lastReadAt).toISOString() : null,
      lastError: s.lastError,
    }));
  },

  /**
   * Reads DS once from a scale. When a running session already polls the same scale and side, its last
   * payload is used: many scales accept only one TCP connection.
   */
  async test(body: unknown): Promise<ScaleTestResult> {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const host = typeof b.host === "string" ? b.host.trim() : "";
    const port = Number(b.port);
    const mcSide = b.mcSide === "2" ? "2" : "1";
    if (!host || host.length > 100 || /\s/.test(host)) throw new HttpError(400, "Scale host is required");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Scale port must be 1 to 65535");

    const started = Date.now();
    let payload: string;
    let source: ScaleTestResult["source"] = "test";
    const live = [...sessions.values()].find(
      (s) => s.client.host === host && s.client.port === port && s.client.mcSide === mcSide
    );
    if (live?.payload && live.lastReadAt && Date.now() - live.lastReadAt <= STALE_MS) {
      payload = live.payload;
      source = "live";
    } else {
      const client = new YamatoClient(host, port, mcSide);
      try {
        payload = await withTimeout(
          client.connect().then(() => client.readDs()),
          TEST_TIMEOUT_MS,
          () => client.close()
        );
      } catch (err) {
        throw new HttpError(502, `${host}:${port} — ${message(err)}`);
      } finally {
        client.close();
      }
    }
    return {
      source,
      ms: Date.now() - started,
      payload,
      fields: YAMATO_FIELDS.map((f) => ({
        key: f.key,
        label: f.label,
        group: f.group,
        unit: f.unit,
        offset: f.offset,
        length: f.length,
        raw: payload.substring(f.offset, f.offset + f.length),
        value: readField(payload, f),
      })),
    };
  },

  stop() {
    for (const id of [...sessions.keys()]) stopSession(id);
  },
};
