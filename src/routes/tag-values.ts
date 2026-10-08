import { Router } from "express";
import { HttpError } from "../lib/http-error.js";
import { machineStore } from "../services/machine-store.js";
import { tagValueStore } from "../services/tag-value-store.js";

// Tag readings in `tag_values`. POST is what the Simulator page uses to act as the gateway.

export const tagValuesRouter = Router();

/** Tags registered on any machine, and which of them must hold numbers. */
async function registeredTags() {
  const machines = await machineStore.list();
  const all = new Set<string>();
  const numeric = new Set<string>();
  for (const m of machines) {
    [m.tagStatus, m.tagOutput, m.tagReject].forEach((t) => (all.add(t), numeric.add(t)));
    all.add(m.tagProduct);
    m.monitoringTags.forEach((t) => (all.add(t.tagName), numeric.add(t.tagName)));
  }
  return { all, numeric };
}

tagValuesRouter.get("/latest", async (_req, res) => {
  const { all } = await registeredTags();
  res.json(await tagValueStore.latest([...all]));
});

tagValuesRouter.get("/recent", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  res.json(await tagValueStore.recent(limit));
});

tagValuesRouter.post("/", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const tagName = typeof b.tagName === "string" ? b.tagName.trim() : "";
  const value = typeof b.value === "number" ? String(b.value) : typeof b.value === "string" ? b.value.trim() : "";
  if (!tagName) throw new HttpError(400, "Tag name is required");
  if (!value) throw new HttpError(400, "Value is required");
  if (value.length > 255) throw new HttpError(400, "Value is too long (max 255)");

  const { all, numeric } = await registeredTags();
  if (!all.has(tagName)) throw new HttpError(400, `Tag ${tagName} is not registered on any machine`);
  if (numeric.has(tagName) && !Number.isFinite(Number(value))) {
    throw new HttpError(400, `Tag ${tagName} needs a numeric value`);
  }

  let recordedAt = new Date();
  if (b.timestamp !== undefined) {
    recordedAt = new Date(String(b.timestamp));
    if (Number.isNaN(recordedAt.getTime())) throw new HttpError(400, "Invalid timestamp");
  }

  res.status(201).json(await tagValueStore.insert(tagName, value, recordedAt));
});
