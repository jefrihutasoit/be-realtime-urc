import { connect, createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { Aedes } from "aedes";
import mqtt, { type MqttClient } from "mqtt";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import type { GatewayPublish, GatewaySettings, GatewayStatus, MqttTestResult } from "../types/gateway.js";
import { gatewayLog, payloadText } from "./gateway-log.js";
import { adaptiveTags } from "./adaptive-tags.js";
import { gatewaySettingsStore, machineNoFromTopic, parseGatewaySettings } from "./gateway-settings.js";
import { channelStats, parsePayload, registeredTags, tagIngest } from "./tag-ingest.js";

/**
 * Runs the gateway channels from the gateway settings and restarts them when the settings change:
 *   - HTTP: an optional dedicated port that only accepts gateway ingest (POST /ingest), so gateway
 *     traffic stays off the dashboard API. POST /api/tag-values/batch on the main port always works.
 *   - MQTT: either a built-in broker (gateways publish to the backend directly) or a client of an
 *     external broker. Messages on the configured topic filter are ingested.
 */

const sameKey = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Whether a request carries the gateway API key (header x-gateway-key or Authorization: Bearer). */
export function hasGatewayKey(header: (name: string) => string | undefined) {
  const keys = [gatewaySettingsStore.cached()?.http.apiKey, process.env.GATEWAY_API_KEY].filter(Boolean) as string[];
  const sent = header("x-gateway-key") ?? /^Bearer\s+(\S+)$/i.exec(header("authorization") ?? "")?.[1];
  return !!sent && keys.some((k) => sameKey(k, sent));
}

/**
 * Ingests one message and writes it to the gateway console with its outcome.
 * Throws (after logging) when the message cannot be read, so HTTP callers can answer 400.
 */
export async function ingestAndLog(
  channel: "http" | "mqtt",
  payload: unknown,
  from: { topic?: string; client?: string; topicTag?: string } = {}
) {
  const entry = { kind: "in" as const, channel, topic: from.topic, client: from.client, payload: payloadText(payload) };
  const stats = channelStats[channel];
  try {
    const { readings, invalid } = parsePayload(payload, from.topicTag);
    // A machine in adaptive mode, named by the MQTT topic: its tags other than status / output / reject /
    // product are realtime tags, kept in memory only.
    const machine = from.topic ? await adaptiveMachineOf(from.topic) : null;
    const production = machine ? readings.filter((r) => machine.production.has(r.tagName)) : readings;
    const adaptive = machine
      ? adaptiveTags.put(machine.id, machine.machineNo, readings.filter((r) => !machine.production.has(r.tagName)))
      : 0;
    const { machines, retimed, ...counts } = await tagIngest.ingest(production, stats, invalid);
    stats.readings += adaptive;
    const result = { ...counts, accepted: counts.accepted + adaptive };
    const shown = machine ? [...new Set([machine.machineNo, ...machines])] : machines;
    const notes = [
      machine && `${adaptive} realtime tag${adaptive === 1 ? "" : "s"} (adaptive, memory only)`,
      retimed && `ts not newer than the previous reading for ${retimed} tag${retimed === 1 ? "" : "s"}: server time used`,
    ].filter(Boolean);
    gatewayLog.add({
      ...entry,
      result,
      machines: shown,
      ...(machine && { adaptive: true }),
      ...(notes.length && { message: notes.join(" · ") }),
      error: result.accepted === 0,
    });
    return { ...result, machines: shown };
  } catch (err) {
    stats.invalid += 1;
    stats.lastError = err instanceof Error ? err.message : String(err);
    gatewayLog.add({ ...entry, message: stats.lastError, error: true });
    throw err;
  }
}

/** The machine an MQTT topic names, when it is in adaptive realtime mode. */
async function adaptiveMachineOf(topic: string) {
  const filter = gatewaySettingsStore.cached()?.mqtt.topic;
  const no = filter ? machineNoFromTopic(filter, topic) : null;
  const machine = no ? (await registeredTags()).machines.get(no.toLowerCase()) : undefined;
  return machine?.realtimeMode === "adaptive" ? machine : null;
}

const event = (channel: "http" | "mqtt", message: string, extra: { client?: string; error?: boolean } = {}) =>
  gatewayLog.add({ kind: "event", channel, message, ...extra });

// ---------- HTTP ingest port ----------

let httpServer: HttpServer | null = null;
let httpPort: number | null = null;

function ingestApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const auth: RequestHandler = (req, res, next) => {
    if (!gatewaySettingsStore.cached()?.http.enabled) return void res.status(503).json({ error: "HTTP ingest is disabled" });
    if (!hasGatewayKey((n) => req.get(n))) return void res.status(401).json({ error: "Invalid gateway key" });
    next();
  };
  app.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });
  const ingest: RequestHandler = async (req, res) => {
    res.json(await ingestAndLog("http", req.body, { client: req.ip }));
  };
  app.post(["/ingest", "/api/tag-values/batch"], auth, ingest);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: "Invalid JSON body" });
    if (err?.type === "entity.too.large") return void res.status(413).json({ error: "Request body is too large" });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errors);
  return app;
}

const closeServer = (s: { close: (cb: () => void) => unknown } | null) =>
  new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));

async function applyHttp(s: GatewaySettings["http"]) {
  const port = s.enabled ? s.port : null;
  if (port === httpPort && (port === null || httpServer)) return;
  await closeServer(httpServer);
  httpServer = null;
  httpPort = port;
  if (port === null) return;
  const server = createHttpServer(ingestApp());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  }).catch((err) => {
    channelStats.http.lastError = `Cannot listen on port ${port}: ${(err as Error).message}`;
    throw new HttpError(409, channelStats.http.lastError);
  });
  server.on("error", (err) => (channelStats.http.lastError = err.message));
  httpServer = server;
  channelStats.http.lastError = null;
  console.log(`[gateway] HTTP ingest on port ${port}`);
}

// ---------- MQTT ----------

let broker: Aedes | null = null;
let brokerServer: Server | null = null;
/** Open client sockets of the built-in broker, closed by force on stop so the port is really released. */
const brokerSockets = new Set<Socket>();
let client: MqttClient | null = null;
let mqttKey = "";
let mqttConnected = false;

/** Topic filter match, MQTT style ("+" one level, "#" the rest). */
function topicMatches(filter: string, topic: string) {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length || (f[i] !== "+" && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/** JSON when the payload is JSON, else the plain text (a single value for the tag named by the topic). */
function decode(payload: Buffer): unknown {
  const text = payload.toString("utf8").trim();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function onMessage(topic: string, payload: Buffer, client?: string) {
  // A plain value names its tag with the last topic level, e.g. urc/oee/GW01.LINE1.M1A.OUTPUT.
  ingestAndLog("mqtt", decode(payload), { topic, client, topicTag: topic.split("/").at(-1) }).catch(() => {});
}

async function stopMqtt() {
  mqttConnected = false;
  if (client) {
    const c = client;
    client = null;
    await new Promise<void>((resolve) => c.end(true, {}, () => resolve()));
  }
  if (broker) {
    const b = broker;
    broker = null;
    await new Promise<void>((resolve) => b.close(() => resolve()));
  }
  // server.close() only stops new connections; drop the ones still open (e.g. a client that did not disconnect).
  const closing = closeServer(brokerServer);
  for (const socket of brokerSockets) socket.destroy();
  brokerSockets.clear();
  await closing;
  brokerServer = null;
}

/** Whether something already accepts connections on the port (Windows lets two programs bind it). */
function portInUse(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function startBuiltin(s: GatewaySettings["mqtt"]) {
  if (await portInUse(s.builtinPort)) {
    channelStats.mqtt.lastError =
      `Port ${s.builtinPort} is already used by another program (e.g. Mosquitto). ` +
      `Use External broker mode to connect to it, or choose another port.`;
    throw new HttpError(409, channelStats.mqtt.lastError);
  }
  const b = await Aedes.createBroker({
    authenticate: (_client, username, password, done) => {
      if (!s.username) return done(null, true);
      const ok = username === s.username && (password?.toString() ?? "") === s.password;
      done(null, ok);
    },
  });
  b.on("publish", (packet, from) => {
    // `from` is null for the broker's own messages: $SYS, and test publishes from the Gateway page.
    if (packet.topic.startsWith("$SYS") || !topicMatches(s.topic, packet.topic)) return;
    onMessage(packet.topic, packet.payload as Buffer, from?.id ?? "(Gateway page)");
  });
  b.on("client", (c) => event("mqtt", "Client connected", { client: c.id }));
  b.on("clientDisconnect", (c) => event("mqtt", "Client disconnected", { client: c.id }));
  b.on("clientError", (c, err) => event("mqtt", `Client error: ${err.message}`, { client: c.id, error: true }));
  b.on("closed", () => event("mqtt", "Built-in broker stopped"));
  b.on("connectionError", (c, err) => {
    // The built-in broker speaks MQTT 3.1.1; MQTTX and some gateways default to MQTT 5.0.
    const message = /protocol version/i.test(err.message)
      ? "Connection refused: the client uses MQTT 5.0, the built-in broker supports MQTT 3.1.1 only. " +
        "Set the client to MQTT 3.1.1 (MQTTX: Advanced → MQTT Version), or use External broker (Mosquitto)."
      : `Connection refused: ${err.message}`;
    event("mqtt", message, { client: c?.id, error: true });
  });
  b.on("subscribe", (subs, c) => {
    if (c) event("mqtt", `Subscribed to ${subs.map((x) => x.topic).join(", ")}`, { client: c.id });
  });
  const server = createServer(b.handle);
  server.on("connection", (socket) => {
    brokerSockets.add(socket);
    socket.once("close", () => brokerSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(s.builtinPort, () => resolve());
  }).catch(async (err) => {
    await new Promise<void>((r) => b.close(() => r()));
    channelStats.mqtt.lastError = `Cannot start the MQTT broker on port ${s.builtinPort}: ${(err as Error).message}`;
    throw new HttpError(409, channelStats.mqtt.lastError);
  });
  broker = b;
  brokerServer = server;
  mqttConnected = true;
  channelStats.mqtt.lastError = null;
  console.log(`[gateway] MQTT broker on port ${s.builtinPort}, topic ${s.topic}`);
  event("mqtt", `Built-in broker started on port ${s.builtinPort}, listening to ${s.topic}`);
}

function startExternal(s: GatewaySettings["mqtt"]) {
  const c = mqtt.connect(s.brokerUrl, {
    clientId: s.clientId,
    username: s.username || undefined,
    password: s.password || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    // Keep the subscription across reconnects so QoS 1/2 messages sent while away are delivered.
    clean: false,
  });
  c.on("connect", () => {
    mqttConnected = true;
    channelStats.mqtt.lastError = null;
    c.subscribe(s.topic, { qos: s.qos }, (err) => {
      if (err) channelStats.mqtt.lastError = `Subscribe failed: ${err.message}`;
      event("mqtt", err ? `Subscribe to ${s.topic} failed: ${err.message}` : `Subscribed to ${s.topic}`, { error: !!err });
    });
    console.log(`[gateway] MQTT connected to ${s.brokerUrl}, topic ${s.topic}`);
    event("mqtt", `Connected to ${s.brokerUrl} as ${s.clientId}`);
  });
  c.on("close", () => {
    if (mqttConnected) event("mqtt", "Connection to the broker closed", { error: true });
    mqttConnected = false;
  });
  c.on("error", (err) => {
    channelStats.mqtt.lastError = err.message;
    event("mqtt", `Error: ${err.message}`, { error: true });
  });
  c.on("message", (topic, payload) => onMessage(topic, payload, `via ${s.brokerUrl}`));
  client = c;
}

async function applyMqtt(s: GatewaySettings["mqtt"]) {
  const key = s.enabled ? JSON.stringify(s) : "";
  if (key === mqttKey) return;
  await stopMqtt();
  mqttKey = key;
  if (!s.enabled) {
    event("mqtt", "MQTT disabled: broker / connection stopped");
    return;
  }
  if (s.mode === "builtin") await startBuiltin(s);
  else startExternal(s);
}

// ---------- public ----------

export const gatewayManager = {
  /** Starts or restarts the channels to match the settings. Throws when a port cannot be opened. */
  async apply(s: GatewaySettings) {
    const results = await Promise.allSettled([applyHttp(s.http), applyMqtt(s.mqtt)]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      // Retry on the next apply instead of assuming the failed channel is running.
      if (results[0].status === "rejected") httpPort = null;
      if (results[1].status === "rejected") mqttKey = "";
      throw failed.reason;
    }
  },

  /** Sends a test message through the running MQTT connection (built-in broker or external client). */
  async publish(body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Partial<GatewayPublish>;
    const topic = typeof b.topic === "string" ? b.topic.trim() : "";
    const payload = typeof b.payload === "string" ? b.payload : "";
    const qos = b.qos === 0 || b.qos === 1 || b.qos === 2 ? b.qos : 1;
    if (!topic || /[+#]/.test(topic)) throw new HttpError(400, "Topic is required and cannot contain + or #");
    if (payload.length > 100_000) throw new HttpError(400, "Payload is too large");
    const retain = b.retain === true;
    const message = `Published (QoS ${qos}${retain ? ", retained" : ""})`;
    if (broker) {
      // Logged first: the broker hands the message to the ingest synchronously.
      gatewayLog.add({ kind: "out", channel: "mqtt", topic, payload, message });
      const b2 = broker;
      await new Promise<void>((resolve, reject) =>
        b2.publish({ cmd: "publish", topic, payload: Buffer.from(payload), qos, retain, dup: false }, (err) =>
          err ? reject(err) : resolve()
        )
      );
    } else if (client && mqttConnected) {
      gatewayLog.add({ kind: "out", channel: "mqtt", topic, payload, message });
      await client.publishAsync(topic, payload, { qos, retain });
    } else {
      throw new HttpError(409, "MQTT is not running. Enable it and save the settings first.");
    }
    return { ok: true };
  },

  /**
   * Tries to connect to an external broker with the given (unsaved) MQTT settings and subscribe to the
   * topic, without touching the running connection. A null password uses the stored one.
   */
  async testExternal(body: unknown): Promise<MqttTestResult> {
    const base = await gatewaySettingsStore.get();
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const s = parseGatewaySettings({ mqtt: { ...b, mode: "external" } }, base).mqtt;
    const started = Date.now();
    const result = await new Promise<MqttTestResult>((resolve) => {
      const c = mqtt.connect(s.brokerUrl, {
        // A separate ID, so the test does not kick the backend's own connection off the broker.
        clientId: `${s.clientId}-test-${Date.now().toString(36)}`,
        username: s.username || undefined,
        password: s.password || undefined,
        reconnectPeriod: 0,
        connectTimeout: 5000,
        clean: true,
      });
      let done = false;
      const finish = (ok: boolean, message: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        c.end(true);
        resolve({ ok, message, ms: Date.now() - started });
      };
      const timer = setTimeout(() => finish(false, `No answer from ${s.brokerUrl} within 6 s`), 6000);
      c.on("connect", () => {
        c.subscribe(s.topic, { qos: s.qos }, (err, granted) => {
          if (err) return finish(false, `Connected, but subscribing to ${s.topic} failed: ${err.message}`);
          // 128 = the broker refused the subscription (e.g. an ACL).
          if (granted?.some((g) => g.qos === 128)) return finish(false, `Connected, but the broker refused topic ${s.topic}`);
          finish(true, `Connected to ${s.brokerUrl} and subscribed to ${s.topic}`);
        });
      });
      c.on("error", (err) => {
        const code = (err as { code?: string | number }).code;
        const reason =
          code === "ECONNREFUSED"
            ? "nothing is listening there (is the broker running? right host and port?)"
            : code === "ENOTFOUND"
              ? "host not found"
              : /not authorized|bad user ?name or password/i.test(err.message)
                ? "username or password rejected"
                : err.message;
        finish(false, `Cannot connect to ${s.brokerUrl}: ${reason}`);
      });
      c.on("close", () => finish(false, `Connection to ${s.brokerUrl} closed before it was ready`));
    });
    gatewayLog.add({ kind: "event", channel: "mqtt", message: `Connection test: ${result.message} (${result.ms} ms)`, error: !result.ok });
    return result;
  },

  async start() {
    try {
      await this.apply(await gatewaySettingsStore.get());
    } catch (err) {
      console.error("[gateway]", err instanceof Error ? err.message : err);
    }
  },

  async stop() {
    await Promise.all([closeServer(httpServer), stopMqtt()]);
    httpServer = null;
  },

  status(): GatewayStatus {
    const s = gatewaySettingsStore.cached();
    return {
      now: new Date().toISOString(),
      apiPort: env.port,
      http: { ...channelStats.http, enabled: !!s?.http.enabled, port: httpPort, listening: !!httpServer?.listening },
      mqtt: {
        ...channelStats.mqtt,
        enabled: !!s?.mqtt.enabled,
        mode: s?.mqtt.mode ?? "builtin",
        connected: mqttConnected,
        clients: broker?.connectedClients ?? 0,
      },
      ...tagIngest.status(),
    };
  },
};
