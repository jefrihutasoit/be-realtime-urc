import { Router } from "express";
import { dbConfig, dbConfigView, parseDbConfig } from "../config/db-config.js";
import { dbHealth, testDbConfig } from "../db/pool.js";
import { currentUser } from "../middleware/auth.js";
import { systemLog } from "../services/system-log.js";
import { systemState } from "../services/system-state.js";
import type { SystemEventType, SystemInfo, SystemStatus } from "../types/system.js";

// System Management: database connection, system event log. These work while the database is down.

export const systemRouter = Router();

const status = (): SystemStatus => ({
  database: { ready: dbHealth.ready, error: dbHealth.error, since: dbHealth.since },
  startedAt: systemLog.info().startedAt,
});

/** Open to everyone: lets the app show that the database is down. */
systemRouter.get("/status", (_req, res) => {
  res.json(status());
});

systemRouter.get("/info", (_req, res) => {
  const info: SystemInfo = { ...systemLog.info(), ...status() };
  res.json(info);
});

/** `?limit=200&types=SYSTEM_START,UNEXPECTED_SHUTDOWN`; newest first. */
systemRouter.get("/log", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
  const types = typeof req.query.types === "string" && req.query.types ? (req.query.types.split(",") as SystemEventType[]) : undefined;
  res.json(systemLog.list(limit, types));
});

systemRouter.get("/database", (_req, res) => {
  res.json(dbConfigView());
});

/** Tries settings (fields or `connectionString`; password null = the saved one) without saving them. */
systemRouter.post("/database/test", async (req, res) => {
  res.json(await testDbConfig(parseDbConfig(req.body, dbConfig())));
});

/** Saves the settings and reconnects. Answers with the outcome; failing settings are kept so they can be fixed. */
systemRouter.put("/database", async (req, res) => {
  const cfg = parseDbConfig(req.body, dbConfig());
  const connected = await systemState.applyDbConfig(cfg, currentUser(res.locals).username);
  res.json({ connected, error: dbHealth.error, config: dbConfigView() });
});
