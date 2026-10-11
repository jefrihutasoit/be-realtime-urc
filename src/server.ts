import { createServer } from "node:http";
import { createApp } from "./app.js";
import { dbConfig } from "./config/db-config.js";
import { env } from "./config/env.js";
import { dbHealth, pool } from "./db/pool.js";
import { gatewayManager } from "./services/gateway-manager.js";
import { saveOeeStates } from "./services/poller.js";
import { systemState } from "./services/system-state.js";
import { stopIngest } from "./services/tag-ingest.js";
import { createSocketServer } from "./socket/index.js";

// The HTTP server starts first and keeps running when the database cannot be reached ("setup mode"):
// the connection can then be fixed from System Management, and is also retried on its own.

const httpServer = createServer(createApp());
const { io, broadcast } = createSocketServer(httpServer);

await new Promise<void>((resolve) => httpServer.listen(env.port, resolve));
const { database, host, port } = dbConfig();
console.log(
  `OEE backend on http://localhost:${env.port} (db: ${database} on ${host}:${port}, gateway: ${env.gatewayMode}, poll: ${env.pollIntervalMs}ms)`
);
await systemState.boot(broadcast);
if (!dbHealth.ready) {
  console.warn("[db] running in setup mode: log in as Engineering and fix the database in System Management");
}

let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  // Do not hang on a stuck connection.
  setTimeout(() => process.exit(0), 8000).unref();
  systemState.stop(signal);
  await gatewayManager.stop();
  if (dbHealth.ready) {
    // Write the readings still queued, then keep the open OEE runs for the next start.
    await stopIngest();
    await saveOeeStates();
  }
  io.close();
  httpServer.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
