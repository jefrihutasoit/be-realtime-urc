import { Router } from "express";
import { downtimeStore } from "../services/downtime-store.js";

export const downtimeRouter = Router();

/** `?date=YYYY-MM-DD`: uploaded downtime of that production date. */
downtimeRouter.get("/", async (req, res) => {
  res.json(await downtimeStore.list(String(req.query.date ?? "")));
});

/** Checks a parsed downtime sheet (`DowntimeUploadInput`): only the machines are verified. */
downtimeRouter.post("/validate", async (req, res) => {
  res.json(await downtimeStore.validate(req.body));
});

/** Saves the sheet; refused with 400 unless it validates. Rows already uploaded are replaced. */
downtimeRouter.post("/upload", async (req, res) => {
  res.status(201).json(await downtimeStore.upload(req.body));
});

downtimeRouter.delete("/:id", async (req, res) => {
  await downtimeStore.remove(req.params.id);
  res.json({ ok: true });
});
