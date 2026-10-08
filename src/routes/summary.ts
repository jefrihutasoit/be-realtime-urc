import { Router } from "express";
import { summaryStore } from "../services/summary-store.js";

export const summaryRouter = Router();

/** `?date=YYYY-MM-DD`: everything the summary dashboard shows for that production day (`DailySummary`). */
summaryRouter.get("/", async (req, res) => {
  res.json(await summaryStore.daily(String(req.query.date ?? "")));
});
