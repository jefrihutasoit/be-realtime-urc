import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the real environment.
}

const num = (key: string, fallback: number) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const env = {
  port: num("PORT", 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(",").map((s) => s.trim()),
  pollIntervalMs: num("POLL_INTERVAL_MS", 2000),
  gatewayMode: process.env.GATEWAY_MODE ?? "database",
  idealRatePpm: num("IDEAL_RATE_PPM", 60),
  /** Folder for uploaded files (SKU photos), served at /uploads. Relative to the working directory. */
  uploadDir: resolve(process.env.UPLOAD_DIR ?? "uploads"),
  db: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: num("DB_PORT", 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "OEE-URC-Cibitung",
  },
};
