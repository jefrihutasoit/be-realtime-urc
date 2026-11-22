import cors from "cors";
import { corsOptions } from "./config/cors.js";
import express, { type ErrorRequestHandler } from "express";
import { env } from "./config/env.js";
import { HttpError } from "./lib/http-error.js";
import { apiRouter } from "./routes/index.js";
import { license } from "./services/license.js";

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};

export function createApp() {
  const app = express();
  app.use(cors(corsOptions));
  // Machine photos are sent as data URLs, so allow a bit more than the 1.5 MB photo limit.
  app.use(express.json({ limit: "2mb" }));

  // Uploaded files get unique names, so they can be cached for a long time.
  app.use("/uploads", (_req, res, next) => {
    if (license.isLicensed()) return next();
    res.status(403).json({ error: "This system is not licensed", code: "LICENSE_REQUIRED" });
  });
  app.use("/uploads", express.static(env.uploadDir, { maxAge: "30d", immutable: true, index: false }));
  app.use("/api", apiRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);
  return app;
}
