import { Router } from "express";
import { reportStore } from "../services/report-store.js";
import { traceStore } from "../services/trace-store.js";

export const reportsRouter = Router();

/** `?type=daily|shift|machine|sku&from=YYYY-MM-DD&to=YYYY-MM-DD[&machines=id,…][&skus=code,…][&shift=id]` (`Report`). */
reportsRouter.get("/", async (req, res) => {
  res.json(await reportStore.build(req.query));
});

/**
 * `?from=&to=[&category=][&machines=id,…][&types=EL,MS]`: OEE with the uploaded downtime of the chosen categories
 * as downtime (`TraceDowntimeReport`). Without `types` every category counts; `types=` (empty) counts none.
 */
reportsRouter.get("/trace-downtime", async (req, res) => {
  res.json(await traceStore.build(req.query));
});
