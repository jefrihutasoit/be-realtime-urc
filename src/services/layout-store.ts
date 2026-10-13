import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import {
  LAYOUT_INDICATORS,
  MARKER_SIZE_RANGE,
  type LayoutDisplay,
  type LayoutIndicator,
  type LayoutMarker,
  type LayoutView,
  type PlantLayout,
} from "../types/layout.js";
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
  view: LayoutView | null;
  indicator: LayoutIndicator;
  markerSize: number;
  updatedAt: string | null;
}

const EMPTY: StoredLayout = { imageFile: null, markers: [], view: null, indicator: "ring", markerSize: 1, updatedAt: null };

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
    view: stored.view,
    indicator: LAYOUT_INDICATORS.includes(stored.indicator) ? stored.indicator : "ring",
    markerSize: validMarkerSize(stored.markerSize) ? stored.markerSize : 1,
    updatedAt: stored.updatedAt,
  };
}

const validMarkerSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= MARKER_SIZE_RANGE.min && v <= MARKER_SIZE_RANGE.max;

/** `{ position, target }` of three numbers each, or null / undefined for the automatic view. */
export function parseView(raw: unknown): LayoutView | null {
  if (raw == null) return null;
  const v = raw as Record<string, unknown>;
  const vec = (value: unknown, label: string): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1000)) {
      throw new HttpError(400, `view.${label} must be three numbers`);
    }
    return value.map((n: number) => Math.round(n * 100) / 100) as [number, number, number];
  };
  return { position: vec(v.position, "position"), target: vec(v.target, "target") };
}

export function parseIndicator(raw: unknown): LayoutIndicator {
  if (!LAYOUT_INDICATORS.includes(raw as LayoutIndicator)) {
    throw new HttpError(400, `indicator must be one of: ${LAYOUT_INDICATORS.join(", ")}`);
  }
  return raw as LayoutIndicator;
}

export function parseMarkerSize(raw: unknown): number {
  if (!validMarkerSize(raw)) {
    throw new HttpError(400, `markerSize must be a number from ${MARKER_SIZE_RANGE.min} to ${MARKER_SIZE_RANGE.max}`);
  }
  return Math.round(raw * 100) / 100;
}

/** The whole display block of a backup; each part is checked. */
export function parseLayoutDisplay(raw: unknown): LayoutDisplay {
  if (typeof raw !== "object" || raw === null) throw new HttpError(400, "must be an object");
  const d = raw as Record<string, unknown>;
  return { view: parseView(d.view), indicator: parseIndicator(d.indicator ?? "ring"), markerSize: parseMarkerSize(d.markerSize ?? 1) };
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

  /** Body `{ view: { position, target } }`, or `{ view: null }` to go back to the automatic view. */
  async setView(body: unknown) {
    const view = parseView((body as { view?: unknown } | null)?.view);
    return toLayout(await write({ ...(await read()), view }));
  },

  /** Body `{ indicator: "ring" | "led" }`. */
  async setIndicator(body: unknown) {
    const indicator = parseIndicator((body as { indicator?: unknown } | null)?.indicator);
    return toLayout(await write({ ...(await read()), indicator }));
  },

  /** Body `{ markerSize: number }` within MARKER_SIZE_RANGE. */
  async setMarkerSize(body: unknown) {
    const markerSize = parseMarkerSize((body as { markerSize?: unknown } | null)?.markerSize);
    return toLayout(await write({ ...(await read()), markerSize }));
  },

  /** View, indicator and marker size, for the settings backup. */
  async display(): Promise<LayoutDisplay> {
    const { view, indicator, markerSize } = await this.get();
    return { view, indicator, markerSize };
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
