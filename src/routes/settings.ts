import { Router } from "express";
import { settingsStore } from "../services/settings-store.js";

export const settingsRouter = Router();

settingsRouter.get("/status-definition", async (_req, res) => {
  res.json(await settingsStore.getStatusDefinition());
});

settingsRouter.put("/status-definition", async (req, res) => {
  res.json(await settingsStore.updateStatusDefinition(req.body));
});

/** Global OEE calculation settings, incl. breakdown and finish rules (`OeeSettings`). */
settingsRouter.get("/oee", async (_req, res) => {
  res.json(await settingsStore.getOeeSettings());
});

settingsRouter.put("/oee", async (req, res) => {
  res.json(await settingsStore.updateOeeSettings(req.body));
});
