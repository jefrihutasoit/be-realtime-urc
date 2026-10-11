import { Router } from "express";
import { gateway } from "../services/gateway.js";
import { gatewayLog } from "../services/gateway-log.js";
import { gatewayManager } from "../services/gateway-manager.js";
import { gatewaySettingsStore, newApiKey, toView } from "../services/gateway-settings.js";

export const gatewayRouter = Router();

/** Tag catalog offered when registering machines. */
gatewayRouter.get("/tags", async (_req, res) => {
  res.json(await gateway.listTags());
});

gatewayRouter.get("/settings", async (_req, res) => {
  res.json(toView(await gatewaySettingsStore.get()));
});

/** Saves the settings and restarts the channels; a port that cannot be opened is reported as 409. */
gatewayRouter.put("/settings", async (req, res) => {
  const saved = await gatewaySettingsStore.update(req.body);
  await gatewayManager.apply(saved);
  res.json(toView(saved));
});

/** Replaces the HTTP API key; gateways using the old key are refused from now on. */
gatewayRouter.post("/settings/api-key", async (_req, res) => {
  res.json(toView(await gatewaySettingsStore.update({ http: { apiKey: newApiKey() } })));
});

gatewayRouter.get("/status", (_req, res) => {
  res.json(gatewayManager.status());
});

/** Console entries newer than `?after=<seq>`. */
gatewayRouter.get("/messages", (req, res) => {
  res.json(gatewayLog.since(Number(req.query.after) || 0));
});

gatewayRouter.delete("/messages", (_req, res) => {
  gatewayLog.clear();
  res.json({ ok: true });
});

/** One connect + subscribe attempt with the MQTT settings in the body (not saved). */
gatewayRouter.post("/mqtt/test", async (req, res) => {
  res.json(await gatewayManager.testExternal(req.body));
});

/** Test publish through the running MQTT connection. */
gatewayRouter.post("/publish", async (req, res) => {
  res.json(await gatewayManager.publish(req.body));
});
