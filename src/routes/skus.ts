import { Router } from "express";
import { skuStore } from "../services/sku-store.js";

export const skusRouter = Router();

skusRouter.get("/", async (_req, res) => {
  res.json(await skuStore.list());
});

skusRouter.post("/", async (req, res) => {
  res.status(201).json(await skuStore.create(req.body));
});

skusRouter.patch("/:id", async (req, res) => {
  res.json(await skuStore.update(req.params.id, req.body));
});

skusRouter.delete("/:id", async (req, res) => {
  await skuStore.remove(req.params.id);
  res.json({ ok: true });
});
