import { Router } from "express";
import { databaseStore } from "../services/database-store.js";

export const databaseRouter = Router();

databaseRouter.get("/stats", async (_req, res) => {
  res.json(await databaseStore.stats());
});

/** Streams the whole database as a .jsonl.gz file; `?full=1` adds the uploaded files (full system backup). */
databaseRouter.get("/backup", async (req, res) => {
  const full = req.query.full === "1" || req.query.full === "true";
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="oee-${full ? "full" : "db"}-backup-${stamp}.jsonl.gz"`);
  try {
    await databaseStore.backup(res, full);
  } catch (err) {
    // Headers are already sent; cut the download so the file is visibly incomplete (no end marker).
    console.error("[database] backup failed:", err);
    res.destroy();
  }
});

/** Body: the backup file as sent (Content-Type application/gzip). Replaces the whole database (and, for a full backup, the uploaded files). */
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
