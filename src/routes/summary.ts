import { Router } from "express";
import { summaryStore } from "../services/summary-store.js";

export const summaryRouter = Router();

/**
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` (or `?date=` for one day): everything the summary dashboard shows for
 * those production days (`DailySummary`).
 */
summaryRouter.get("/", async (req, res) => {
  const date = String(req.query.date ?? "");
  res.json(await summaryStore.range(String(req.query.from ?? date), String(req.query.to ?? date)));
});
