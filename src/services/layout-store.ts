import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { LayoutMarker, PlantLayout } from "../types/layout.js";
import { machineStore } from "./machine-store.js";

// The plant layout (one image plus a marker per machine), stored as JSON in `app_settings`.
// The image file lives in UPLOAD_DIR/layout and is served at /uploads/layout.

const LAYOUT_KEY = "plant_layout";
const LAYOUT_DIR = path.join(env.uploadDir, "layout");
const LAYOUT_URL = "/uploads/layout";

/** Accepted image types. SVG is left out because it can carry scripts. */
export const LAYOUT_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

interface StoredLayout {
  imageFile: string | null;
  markers: LayoutMarker[];
  updatedAt: string | null;
}

const EMPTY: StoredLayout = { imageFile: null, markers: [], updatedAt: null };

async function read(): Promise<StoredLayout> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [
    LAYOUT_KEY,
  ]);
  if (!rows[0]) return EMPTY;
  try {
    return { ...EMPTY, ...JSON.parse(rows[0].setting_value) };
  } catch {
    console.warn("[layout] stored layout is invalid, using an empty layout");
    return EMPTY;
  }
}

async function write(layout: StoredLayout) {
  const value: StoredLayout = { ...layout, updatedAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
    [LAYOUT_KEY, JSON.stringify(value), new Date()]
  );
  return value;
}

/** Public shape. Markers of machines that no longer exist are dropped. */
async function toLayout(stored: StoredLayout): Promise<PlantLayout> {
  const ids = new Set((await machineStore.list()).map((m) => m.id));
  return {
    image: stored.imageFile ? `${LAYOUT_URL}/${stored.imageFile}` : null,
    markers: stored.markers.filter((m) => ids.has(m.machineId)),
    updatedAt: stored.updatedAt,
  };
}

async function deleteFile(file: string | null) {
  if (!file) return;
  await unlink(path.join(LAYOUT_DIR, path.basename(file))).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") console.warn(`[layout] could not delete ${file}:`, err.message);
  });
}

export const layoutStore = {
  async get() {
    return toLayout(await read());
  },

  async setImage(data: Buffer, contentType: string) {
    const ext = LAYOUT_IMAGE_TYPES[contentType];
    if (!ext) throw new HttpError(415, "Layout must be a PNG, JPG or WebP image");
    if (data.length === 0) throw new HttpError(400, "Image is empty");
    await mkdir(LAYOUT_DIR, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    await writeFile(path.join(LAYOUT_DIR, file), data);
    const current = await read();
    // Markers are kept: they are relative, so they still fit an updated drawing of the same plant.
    const saved = await write({ ...current, imageFile: file });
    await deleteFile(current.imageFile);
    return toLayout(saved);
  },

  async removeImage() {
    const current = await read();
    const saved = await write({ ...current, imageFile: null });
    await deleteFile(current.imageFile);
    return toLayout(saved);
  },

  async setMarkers(body: unknown) {
    const list = (body as { markers?: unknown } | null)?.markers;
    if (!Array.isArray(list)) throw new HttpError(400, "markers must be a list");
    const ids = new Set((await machineStore.list()).map((m) => m.id));
    const seen = new Set<string>();
    const markers: LayoutMarker[] = list.map((item, i) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const machineId = typeof m.machineId === "string" ? m.machineId : "";
      if (!ids.has(machineId)) throw new HttpError(400, `Marker #${i + 1}: unknown machine`);
      if (seen.has(machineId)) throw new HttpError(400, `Marker #${i + 1}: machine is placed twice`);
      seen.add(machineId);
      const coord = (v: unknown, label: string) => {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
          throw new HttpError(400, `Marker #${i + 1}: ${label} must be between 0 and 1`);
        }
        return Math.round(v * 10000) / 10000;
      };
      return { machineId, x: coord(m.x, "x"), y: coord(m.y, "y") };
    });
    return toLayout(await write({ ...(await read()), markers }));
  },
};
