import { Router } from "express";
import { shiftPeriodAt, shiftStore } from "../services/shift-store.js";

export const shiftsRouter = Router();

shiftsRouter.get("/", async (_req, res) => {
  res.json(await shiftStore.list());
});

/** The shift running now (or the "No shift" gap), as used by OEE and the operation timeline. */
shiftsRouter.get("/current", (_req, res) => {
  res.json(shiftPeriodAt(new Date()));
});

shiftsRouter.post("/", async (req, res) => {
  res.status(201).json(await shiftStore.create(req.body));
});

shiftsRouter.patch("/:id", async (req, res) => {
  res.json(await shiftStore.update(req.params.id, req.body));
});

shiftsRouter.delete("/:id", async (req, res) => {
  await shiftStore.remove(req.params.id);
  res.json({ ok: true });
});
