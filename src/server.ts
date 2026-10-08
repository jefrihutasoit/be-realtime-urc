import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { authStore } from "./services/auth-store.js";
import { oeeStateStore } from "./services/oee-state-store.js";
import { saveOeeStates, startPoller } from "./services/poller.js";
import { loadShifts } from "./services/shift-store.js";
import { createSocketServer } from "./socket/index.js";

try {
  await migrate();
  await loadShifts();
  await authStore.ensureDefaults();
  const restored = await oeeStateStore.restore();
  if (restored) console.log(`[oee] restored ${restored} OEE run state(s)`);
} catch (err) {
  console.error(`[db] cannot prepare database "${env.db.database}" on ${env.db.host}:${env.db.port}:`, err);
  process.exit(1);
}

const httpServer = createServer(createApp());
const { io, broadcast } = createSocketServer(httpServer);
const stopPoller = startPoller(broadcast);

httpServer.listen(env.port, () => {
  console.log(
    `OEE backend on http://localhost:${env.port} (db: ${env.db.database}, gateway: ${env.gatewayMode}, poll: ${env.pollIntervalMs}ms)`
  );
});

async function shutdown() {
  stopPoller();
  // Keep the open OEE runs for the next start.
  await saveOeeStates();
  io.close();
  httpServer.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
