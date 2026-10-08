import { Router } from "express";
import { rejectStore } from "../services/reject-store.js";

export const rejectsRouter = Router();

rejectsRouter.get("/types", async (_req, res) => {
  res.json(await rejectStore.listTypes());
});

rejectsRouter.post("/types", async (req, res) => {
  res.status(201).json(await rejectStore.createType(req.body));
});

rejectsRouter.patch("/types/:id", async (req, res) => {
  res.json(await rejectStore.updateType(req.params.id, req.body));
});

/** Refused with 409 while reject records use the type. */
rejectsRouter.delete("/types/:id", async (req, res) => {
  await rejectStore.removeType(req.params.id);
  res.json({ ok: true });
});

/** `?date=YYYY-MM-DD&shiftId=` (shiftId optional). */
rejectsRouter.get("/", async (req, res) => {
  const { date, shiftId } = req.query;
  res.json(await rejectStore.list(String(date ?? ""), shiftId ? String(shiftId) : undefined));
});

/** Checks a parsed reject sheet (`RejectUploadInput`) without saving it. */
rejectsRouter.post("/validate", async (req, res) => {
  res.json(await rejectStore.validate(req.body));
});

/** Saves a reject sheet; refused with 400 unless it validates. */
rejectsRouter.post("/upload", async (req, res) => {
  res.status(201).json(await rejectStore.upload(req.body));
});

/** Production dates open for manual input (server local time), newest first. */
rejectsRouter.get("/manual/dates", (_req, res) => {
  res.json(rejectStore.manualInputDates());
});

/** `?machineId=&date=YYYY-MM-DD&shiftId=`: SKUs that ran on the machine in that shift (`RunningSkus`). */
rejectsRouter.get("/manual/skus", async (req, res) => {
  const { machineId, date, shiftId } = req.query;
  res.json(await rejectStore.runningSkus(String(machineId ?? ""), String(date ?? ""), String(shiftId ?? "")));
});

/** Creates or replaces the record of one machine, shift and SKU (`ManualRejectInput`). */
rejectsRouter.post("/manual", async (req, res) => {
  res.json(await rejectStore.saveManual(req.body));
});

rejectsRouter.delete("/:id", async (req, res) => {
  await rejectStore.remove(req.params.id);
  res.json({ ok: true });
});
