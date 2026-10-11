import { dbConfig, saveDbConfig, type DbConfig } from "../config/db-config.js";
import { migrate } from "../db/migrate.js";
import { dbHealth, describeDbError, pool, replacePool } from "../db/pool.js";
import { authStore } from "./auth-store.js";
import { gatewayManager } from "./gateway-manager.js";
import { gatewaySettingsStore } from "./gateway-settings.js";
import { resetEngine } from "./oee-engine.js";
import { oeeStateStore } from "./oee-state-store.js";
import { startPoller, type PollResult } from "./poller.js";
import { settingsStore } from "./settings-store.js";
import { loadShifts } from "./shift-store.js";
import { systemLog } from "./system-log.js";
import { startIngest, tagIngest } from "./tag-ingest.js";

/**
 * Startup and database lifecycle. The HTTP server runs even when the database cannot be reached, so the
 * connection can be fixed from System Management: until then only login (Engineering) and the database
 * settings work. The connection is retried on its own, and checked regularly once it is up.
 */

const RETRY_MS = 15_000;
const HEALTH_MS = 10_000;

let onPoll: (r: PollResult) => void = () => {};
let servicesStarted = false;
let connecting: Promise<boolean> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let stopPoller: (() => void) | null = null;
/** Last failure written to the system log, so retries with the same reason do not repeat it. */
let loggedFailure: string | null = null;

function logFailure(message: string) {
  if (message === loggedFailure) return;
  loggedFailure = message;
  systemLog.add("DB_UNAVAILABLE", message);
}

function setReady(ready: boolean, error: string | null) {
  const changed = dbHealth.ready !== ready;
  dbHealth.ready = ready;
  dbHealth.error = error;
  if (changed) dbHealth.since = new Date().toISOString();
  return changed;
}

/** Everything that needs the database before the system can run. */
async function prepare(restoreStates: boolean) {
  await migrate();
  await loadShifts();
  await authStore.ensureDefaults();
  await authStore.saveRecoveryLogins();
  await gatewaySettingsStore.get();
  if (restoreStates) {
    const restored = await oeeStateStore.restore();
    if (restored) console.log(`[oee] restored ${restored} OEE run state(s)`);
  }
}

function startServices() {
  if (servicesStarted) return;
  servicesStarted = true;
  startIngest();
  gatewayManager.start();
  stopPoller = startPoller(onPoll);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void systemState.connect(), RETRY_MS);
}

/** Notices a database that went away while running, and starts reconnecting. */
async function checkHealth() {
  if (!dbHealth.ready || connecting) return;
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    const reason = describeDbError(err);
    setReady(false, reason);
    logFailure(`Database connection lost: ${reason}`);
    scheduleRetry();
  }
}

export const systemState = {
  /** Called once at startup, after the HTTP server listens. */
  async boot(broadcast: (r: PollResult) => void) {
    onPoll = broadcast;
    systemLog.start();
    await this.connect(true);
    healthTimer = setInterval(() => void checkHealth(), HEALTH_MS);
  },

  /** Connects and prepares the database; on failure keeps the system in setup mode and retries. */
  connect(restoreStates = false): Promise<boolean> {
    connecting ??= (async () => {
      clearTimeout(retryTimer);
      const { host, port, database } = dbConfig();
      try {
        await prepare(restoreStates || !servicesStarted);
        if (setReady(true, null) || !servicesStarted || loggedFailure) {
          systemLog.add("DB_CONNECTED", `Database "${database}" on ${host}:${port} connected`);
        }
        loggedFailure = null;
        startServices();
        return true;
      } catch (err) {
        const reason = describeDbError(err);
        setReady(false, reason);
        logFailure(`Cannot use database "${database}" on ${host}:${port}: ${reason}`);
        scheduleRetry();
        return false;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  },

  /**
   * Saves new connection settings and switches to them. In-memory state of the old database (OEE runs,
   * cached settings, current tag values) is dropped and loaded again from the new one.
   */
  async applyDbConfig(cfg: DbConfig, actor: string) {
    const before = dbConfig();
    saveDbConfig(cfg);
    replacePool(cfg);
    systemLog.add(
      "DB_SETTINGS_CHANGED",
      `Database settings changed by ${actor}: ${before.user}@${before.host}:${before.port}/${before.database} → ` +
        `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`
    );
    setReady(false, "Connecting with the new settings…");
    resetEngine();
    tagIngest.reset();
    settingsStore.clearCache();
    authStore.clearCache();
    gatewaySettingsStore.forget();
    const ok = await this.connect(true);
    if (ok) await gatewayManager.apply(await gatewaySettingsStore.get()).catch((err) => console.error("[gateway]", err));
    return ok;
  },

  /** Normal shutdown. */
  stop(reason: string) {
    clearTimeout(retryTimer);
    clearInterval(healthTimer);
    stopPoller?.();
    systemLog.stop(reason);
  },

  servicesStarted: () => servicesStarted,
};
