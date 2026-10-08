import { Router } from "express";
import { databaseStore } from "../services/database-store.js";

export const databaseRouter = Router();

databaseRouter.get("/stats", async (_req, res) => {
  res.json(await databaseStore.stats());
});

/** Streams the whole database as a .jsonl.gz file. */
databaseRouter.get("/backup", async (_req, res) => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="oee-db-backup-${stamp}.jsonl.gz"`);
  try {
    await databaseStore.backup(res);
  } catch (err) {
    // Headers are already sent; cut the download so the file is visibly incomplete (no end marker).
    console.error("[database] backup failed:", err);
    res.destroy();
  }
});

/** Body: the backup file as sent (Content-Type application/gzip). Replaces the whole database. */
databaseRouter.post("/restore", async (req, res) => {
  res.json(await databaseStore.restore(req));
});

/** `{ from, to }`: how much a clear would delete. */
databaseRouter.post("/clear/preview", async (req, res) => {
  res.json(await databaseStore.previewClear(req.body));
});

/** `{ from, to, confirm: "DELETE" }`. */
databaseRouter.post("/clear", async (req, res) => {
  res.json(await databaseStore.clear(req.body));
});

/** `{ confirm: "INITIALIZE", keepUsers }`. */
databaseRouter.post("/initialize", async (req, res) => {
  res.json(await databaseStore.initialize(req.body));
});
