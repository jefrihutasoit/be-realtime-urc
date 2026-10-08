import { Router } from "express";
import { settingsStore } from "../services/settings-store.js";

export const settingsRouter = Router();

settingsRouter.get("/status-definition", async (_req, res) => {
  res.json(await settingsStore.getStatusDefinition());
});

settingsRouter.put("/status-definition", async (req, res) => {
  res.json(await settingsStore.updateStatusDefinition(req.body));
});
