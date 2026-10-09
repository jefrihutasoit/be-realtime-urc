import { Router } from "express";
import { historicalStore } from "../services/historical-store.js";

export const historicalRouter = Router();

/** `?from=&to=[&machines=][&skus=][&shift=]` (`HistoricalData`). */
historicalRouter.get("/", async (req, res) => {
  res.json(await historicalStore.range(req.query));
});

/** `?machine=&date=[&skus=][&shift=]` (`HourlyDetail`). */
historicalRouter.get("/hourly", async (req, res) => {
  res.json(await historicalStore.hourly(req.query));
});
