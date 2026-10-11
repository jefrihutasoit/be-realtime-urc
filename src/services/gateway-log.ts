import type { GatewayLogEntry } from "../types/gateway.js";

// Recent gateway activity (messages in, test publishes, connections) for the console on the Gateway page.
// In memory only; it is a debugging aid, not a history.

const MAX_ENTRIES = 300;
const MAX_PAYLOAD_CHARS = 4000;

const entries: GatewayLogEntry[] = [];
let seq = 0;

export const gatewayLog = {
  add(entry: Omit<GatewayLogEntry, "seq" | "at">) {
    const payload =
      entry.payload && entry.payload.length > MAX_PAYLOAD_CHARS
        ? `${entry.payload.slice(0, MAX_PAYLOAD_CHARS)}… (${entry.payload.length} chars)`
        : entry.payload;
    entries.push({ ...entry, payload, seq: ++seq, at: new Date().toISOString() });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  },

  /** Entries newer than `after` (a seq), oldest first. */
  since(after: number) {
    return { entries: entries.filter((e) => e.seq > after), last: seq };
  },

  clear() {
    entries.length = 0;
  },
};

/** Payload as text for the log. */
export const payloadText = (payload: unknown) =>
  Buffer.isBuffer(payload) ? payload.toString("utf8") : typeof payload === "string" ? payload : JSON.stringify(payload);
