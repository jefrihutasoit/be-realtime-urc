import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import type { GatewaySettings, GatewaySettingsView } from "../types/gateway.js";
import { readSetting, writeSetting } from "./settings-store.js";

// Gateway settings in `app_settings` ("gateway_settings"), cached in memory: the auth middleware reads the
// API key on every gateway request.

export const GATEWAY_SETTINGS_KEY = "gateway_settings";
const KEY = GATEWAY_SETTINGS_KEY;

export const newApiKey = () => randomBytes(24).toString("base64url");

/** Topic of one machine: the subscription filter's base plus the machine No ("urc/oee/#" → "urc/oee/1A"). */
export function machineTopic(filter: string, machineNo: string) {
  if (filter.includes("+")) return filter.replace("+", machineNo).replace(/\/#$/, "");
  return `${filter.replace(/\/?#$/, "")}/${machineNo}`;
}

/** The machine No a topic names: the level matched by the filter's "+" or "#" ("urc/oee/1A" → "1A"). */
export function machineNoFromTopic(filter: string, topic: string): string | null {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "+" || f[i] === "#") return t[i] || null;
    if (f[i] !== t[i]) return null;
  }
  return null;
}

function defaults(): GatewaySettings {
  return {
    http: { enabled: true, port: null, apiKey: process.env.GATEWAY_API_KEY || newApiKey() },
    mqtt: {
      enabled: false,
      mode: "builtin",
      builtinPort: 1883,
      brokerUrl: "mqtt://127.0.0.1:1883",
      username: "",
      password: "",
      clientId: `oee-backend-${randomBytes(3).toString("hex")}`,
      topic: "urc/oee/#",
      qos: 1,
    },
    storage: { onChangeOnly: true, monitoringIntervalSec: 10, flushIntervalMs: 1000, timestampSource: "server" },
  };
}

let cache: GatewaySettings | null = null;

const obj = (v: unknown, label: string) => {
  if (v === undefined) return {} as Record<string, unknown>;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, `${label} must be an object`);
  return v as Record<string, unknown>;
};

function bool(v: unknown, label: string, fallback: boolean) {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new HttpError(400, `${label} must be true or false`);
  return v;
}

function int(v: unknown, label: string, fallback: number, min: number, max: number) {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function text(v: unknown, label: string, fallback: string, max: number) {
  if (v === undefined) return fallback;
  if (typeof v !== "string") throw new HttpError(400, `${label} must be text`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${label} is too long (max ${max})`);
  return s;
}

/**
 * Validates a full or partial settings object on top of `base`. The MQTT password is kept when it is
 * left out or null, so the browser never needs to know it.
 */
export function parseGatewaySettings(body: unknown, base: GatewaySettings): GatewaySettings {
  const b = obj(body, "Gateway settings");
  const h = obj(b.http, "http");
  const m = obj(b.mqtt, "mqtt");
  const s = obj(b.storage, "storage");

  const http: GatewaySettings["http"] = {
    enabled: bool(h.enabled, "HTTP enabled", base.http.enabled),
    port: h.port === undefined ? base.http.port : h.port === null ? null : int(h.port, "HTTP ingest port", 0, 1024, 65535),
    apiKey: text(h.apiKey, "API key", base.http.apiKey, 128),
  };
  if (http.apiKey.length < 16) throw new HttpError(400, "API key must be at least 16 characters");
  if (http.port === env.port) throw new HttpError(400, `Port ${env.port} is the main API port; leave the ingest port empty to use it`);

  const mode = m.mode === undefined ? base.mqtt.mode : m.mode;
  if (mode !== "builtin" && mode !== "external") throw new HttpError(400, "MQTT mode must be builtin or external");
  const qos = m.qos === undefined ? base.mqtt.qos : m.qos;
  if (qos !== 0 && qos !== 1 && qos !== 2) throw new HttpError(400, "MQTT QoS must be 0, 1 or 2");
  const mqtt: GatewaySettings["mqtt"] = {
    enabled: bool(m.enabled, "MQTT enabled", base.mqtt.enabled),
    mode,
    builtinPort: int(m.builtinPort, "Built-in broker port", base.mqtt.builtinPort, 1024, 65535),
    brokerUrl: text(m.brokerUrl, "Broker URL", base.mqtt.brokerUrl, 300),
    username: text(m.username, "MQTT username", base.mqtt.username, 100),
    password: m.password === undefined || m.password === null ? base.mqtt.password : text(m.password, "MQTT password", "", 200),
    clientId: text(m.clientId, "Client ID", base.mqtt.clientId, 100),
    topic: text(m.topic, "Topic", base.mqtt.topic, 200),
    qos,
  };
  if (!mqtt.topic) throw new HttpError(400, "MQTT topic is required");
  if (!mqtt.clientId) throw new HttpError(400, "MQTT client ID is required");
  if (mode === "external" && !/^(mqtts?|wss?|tcp|ssl):\/\/[^\s]+$/i.test(mqtt.brokerUrl)) {
    throw new HttpError(400, "Broker URL must look like mqtt://host:1883 (or mqtts://, ws://, wss://)");
  }
  if (mqtt.enabled && mode === "builtin") {
    if (mqtt.builtinPort === env.port) throw new HttpError(400, `Port ${env.port} is the main API port`);
    if (http.enabled && mqtt.builtinPort === http.port) throw new HttpError(400, "HTTP ingest and the MQTT broker need different ports");
  }

  const storage: GatewaySettings["storage"] = {
    onChangeOnly: bool(s.onChangeOnly, "Store on change only", base.storage.onChangeOnly),
    monitoringIntervalSec: int(s.monitoringIntervalSec, "Monitoring tag interval", base.storage.monitoringIntervalSec, 0, 3600),
    flushIntervalMs: int(s.flushIntervalMs, "Write interval", base.storage.flushIntervalMs, 200, 60_000),
    timestampSource: (s.timestampSource ?? base.storage.timestampSource ?? "server") as GatewaySettings["storage"]["timestampSource"],
  };
  if (storage.timestampSource !== "server" && storage.timestampSource !== "gateway") {
    throw new HttpError(400, "Timestamp source must be server or gateway");
  }

  return { http, mqtt, storage };
}

export function toView(s: GatewaySettings): GatewaySettingsView {
  return { ...s, mqtt: { ...s.mqtt, password: "", hasPassword: s.mqtt.password !== "" } };
}

export const gatewaySettingsStore = {
  /** Loads (and on first use creates) the settings. */
  async get(): Promise<GatewaySettings> {
    if (cache) return cache;
    const stored = await readSetting(KEY);
    const d = defaults();
    try {
      cache = stored === undefined ? d : parseGatewaySettings(stored, d);
    } catch (err) {
      // E.g. a port saved before the 1024 minimum: keep what is valid, reset the rest to defaults.
      console.error("[gateway] stored settings are invalid, using defaults:", err);
      const s = stored as Partial<GatewaySettings>;
      cache = { ...d, http: { ...d.http, apiKey: s?.http?.apiKey || d.http.apiKey } };
    }
    if (stored === undefined) await writeSetting(KEY, cache);
    return cache;
  },

  /** Cached settings without a database round trip; null before the first `get`. */
  cached: () => cache,

  async update(body: unknown): Promise<GatewaySettings> {
    const next = parseGatewaySettings(body, await this.get());
    await writeSetting(KEY, next);
    cache = next;
    return next;
  },

  /** Drops the cache, e.g. after a database restore. */
  forget() {
    cache = null;
  },
};
