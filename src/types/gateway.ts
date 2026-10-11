// Keep in sync with oee-realtime-urc/src/types/gateway.ts

/**
 * How gateways deliver tag readings to the backend, and how readings are stored.
 * Both channels accept the same payload (see `IngestPayload`).
 */
export interface GatewaySettings {
  http: {
    /** POST /api/tag-values/batch on the main API port (always), plus the dedicated port below. */
    enabled: boolean;
    /** Extra port that serves only gateway ingest (POST /ingest); null = main API port only. */
    port: number | null;
    /** Sent by the gateway as header `x-gateway-key` (or `Authorization: Bearer <key>`). */
    apiKey: string;
  };
  mqtt: {
    enabled: boolean;
    /** "builtin": the backend runs its own MQTT broker; "external": it connects to one (Mosquitto, EMQX, …). */
    mode: "builtin" | "external";
    /** Port of the built-in broker. */
    builtinPort: number;
    /** External broker, e.g. "mqtt://192.168.1.10:1883" or "mqtts://broker:8883". */
    brokerUrl: string;
    /** Broker login; for the built-in broker, what gateways must log in with (empty = no login). */
    username: string;
    /** Never sent to the browser; see `hasPassword`. */
    password: string;
    clientId: string;
    /**
     * Subscription filter, e.g. "urc/oee/#". One topic per machine: a gateway publishes each machine's
     * values to the filter's base plus the machine No, e.g. "urc/oee/1A".
     */
    topic: string;
    qos: 0 | 1 | 2;
  };
  storage: {
    /** Store a reading only when the tag's value changed (report by exception). */
    onChangeOnly: boolean;
    /** Monitoring tags (speed, temperature, …) are stored at most this often; 0 = every change. */
    monitoringIntervalSec: number;
    /** Readings are written to the database in one batch this often. */
    flushIntervalMs: number;
    /**
     * Time a reading is recorded at: "server" = when the backend receives it (default; gateway clocks are
     * often off), "gateway" = the message's `ts`, for gateways that buffer readings while offline. With
     * "gateway", a `ts` not newer than the tag's previous reading is replaced by the server time.
     */
    timestampSource: "server" | "gateway";
  };
}

/** Settings as sent to the browser: the MQTT password is replaced by `hasPassword`. */
export type GatewaySettingsView = Omit<GatewaySettings, "mqtt"> & {
  mqtt: Omit<GatewaySettings["mqtt"], "password"> & { password: ""; hasPassword: boolean };
};

/**
 * One gateway message. Any of:
 *   { "ts": "2026-10-11T08:00:00Z", "values": { "GW01.LINE1.M1A.OUTPUT": 1520, ... } }
 *   { "readings": [ { "tagName": "...", "value": 1, "timestamp": "..." }, ... ] }
 *   [ { "tagName": "...", "value": 1 }, ... ]
 * `ts` / `timestamp` are ISO text or epoch milliseconds; missing means "now".
 */
export type IngestPayload = unknown;

export interface ChannelStats {
  messages: number;
  readings: number;
  /** Readings for tags no machine uses. */
  ignored: number;
  /** Messages or readings that could not be read. */
  invalid: number;
  /** Readings whose gateway `ts` was not newer than the previous one; recorded at server time instead. */
  retimed: number;
  lastMessageAt: string | null;
  lastError: string | null;
}

/** One line of the gateway console. */
export interface GatewayLogEntry {
  seq: number;
  at: string;
  /** "in": a message received; "out": a test publish from the Gateway page; "event": connect, disconnect, error. */
  kind: "in" | "out" | "event";
  channel: "mqtt" | "http";
  topic?: string;
  /** MQTT client ID, or the HTTP client address. */
  client?: string;
  payload?: string;
  /** Outcome of an incoming message. */
  result?: { accepted: number; ignored: number; invalid: number };
  /** Machine Nos whose tags the message carried. */
  machines?: string[];
  /** The message carried adaptive realtime tags ("name,unit,value"). */
  adaptive?: boolean;
  message?: string;
  error?: boolean;
}

/** Body of POST /gateway/publish: a test message sent through the MQTT connection. */
export interface GatewayPublish {
  topic: string;
  payload: string;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

/** Result of POST /gateway/mqtt/test: one connect + subscribe attempt to an external broker. */
export interface MqttTestResult {
  ok: boolean;
  /** What happened, e.g. "Connected and subscribed to urc/oee/#" or the broker's refusal. */
  message: string;
  /** Time until the broker answered. */
  ms: number;
}

export interface GatewayStatus {
  now: string;
  /** Port of the main API (POST /api/tag-values/batch). */
  apiPort: number;
  http: ChannelStats & {
    enabled: boolean;
    /** Dedicated ingest port, when configured. */
    port: number | null;
    listening: boolean;
  };
  mqtt: ChannelStats & {
    enabled: boolean;
    mode: "builtin" | "external";
    connected: boolean;
    /** Gateways connected to the built-in broker. */
    clients: number;
  };
  storage: {
    /** Readings waiting to be written. */
    pending: number;
    written: number;
    /** Readings not stored because the value did not change (or the monitoring interval had not passed). */
    skipped: number;
    /** Adaptive realtime tags held in memory (never stored). */
    adaptiveTags: number;
    adaptiveMachines: number;
    lastFlushAt: string | null;
    lastError: string | null;
    /** Tags held in the in-memory latest-value cache. */
    cachedTags: number;
  };
  /** Recent tag names that were sent but are not registered on any machine (newest first). */
  unknownTags: string[];
}
