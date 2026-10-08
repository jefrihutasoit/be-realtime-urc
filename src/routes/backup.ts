import { Router } from "express";
import { backupStore } from "../services/backup-store.js";

export const backupRouter = Router();

/** All settings as a `SettingsBackup` (the frontend turns it into an Excel file). */
backupRouter.get("/", async (_req, res) => {
  res.json(await backupStore.export());
});

/** Checks a `SettingsBackup` and summarises what a restore would change, without saving. */
backupRouter.post("/validate", async (req, res) => {
  res.json(await backupStore.validate(req.body));
});

/** Replaces all settings with the backup; refused with 400 unless it validates. */
backupRouter.post("/restore", async (req, res) => {
  res.json(await backupStore.restore(req.body));
});
