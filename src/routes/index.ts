import { Router } from "express";
import { gateway } from "../services/gateway.js";
import { getLatest } from "../services/poller.js";
import { machinesRouter } from "./machines.js";
import { layoutRouter } from "./layout.js";
import { settingsRouter } from "./settings.js";
import { shiftsRouter } from "./shifts.js";
import { skusRouter } from "./skus.js";
import { tagValuesRouter } from "./tag-values.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

apiRouter.use("/machines", machinesRouter);
apiRouter.use("/skus", skusRouter);
apiRouter.use("/layout", layoutRouter);
apiRouter.use("/settings", settingsRouter);
apiRouter.use("/shifts", shiftsRouter);
apiRouter.use("/tag-values", tagValuesRouter);

apiRouter.get("/gateway/tags", async (_req, res) => {
  res.json(await gateway.listTags());
});

/** Latest OEE snapshot, for the dashboard's first render before the socket delivers. */
apiRouter.get("/oee", (_req, res) => {
  res.json(getLatest().oee);
});

apiRouter.get("/oee/:machineId/monitoring", (req, res) => {
  const found = getLatest().monitoring.find((m) => m.machineId === req.params.machineId);
  if (!found) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  res.json(found);
});
