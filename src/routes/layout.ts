import express, { Router } from "express";
import { LAYOUT_IMAGE_TYPES, layoutStore } from "../services/layout-store.js";

export const layoutRouter = Router();

layoutRouter.get("/", async (_req, res) => {
  res.json(await layoutStore.get());
});

/** Raw image body (Content-Type image/png, image/jpeg or image/webp); CAD exports can be large. */
layoutRouter.put(
  "/image",
  express.raw({ type: Object.keys(LAYOUT_IMAGE_TYPES), limit: "15mb" }),
  async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.json(await layoutStore.setImage(body, (req.headers["content-type"] ?? "").split(";")[0].trim()));
  }
);

layoutRouter.delete("/image", async (_req, res) => {
  res.json(await layoutStore.removeImage());
});

layoutRouter.put("/markers", async (req, res) => {
  res.json(await layoutStore.setMarkers(req.body));
});
