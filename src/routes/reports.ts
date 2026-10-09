import { Router } from "express";
import { reportStore } from "../services/report-store.js";

export const reportsRouter = Router();

/** `?type=daily|shift|machine|sku&from=YYYY-MM-DD&to=YYYY-MM-DD[&machines=id,…][&skus=code,…][&shift=id]` (`Report`). */
reportsRouter.get("/", async (req, res) => {
  res.json(await reportStore.build(req.query));
});
