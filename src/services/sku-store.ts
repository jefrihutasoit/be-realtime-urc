import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import type { SkuInput, SkuMaster } from "../types/sku.js";

// SKU master in MySQL (`skus`). Photos are files in UPLOAD_DIR/skus; the table keeps only the file name.

export const SKU_PHOTO_DIR = path.join(env.uploadDir, "skus");
const SKU_PHOTO_URL = "/uploads/skus";

const SKU_ID_PATTERN = /^[A-Za-z0-9]{1,30}$/;
const MAX_PHOTO_BYTES = 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

interface SkuRow extends RowDataPacket {
  id: string;
  sku_id: string;
  product_name: string;
  sku: string;
  output_per_minute: string;
  photo_file: string | null;
  created_at: Date;
  updated_at: Date;
}

/** `undefined` keeps the current photo, `null` removes it, a Buffer replaces it. */
type PhotoChange = undefined | null | { data: Buffer; ext: string };
type ParsedSku = Partial<Omit<SkuInput, "photo">> & { photo: PhotoChange };

const toSku = (row: SkuRow): SkuMaster => ({
  id: row.id,
  skuId: row.sku_id,
  productName: row.product_name,
  sku: row.sku,
  outputPerMinute: Number(row.output_per_minute),
  photo: row.photo_file ? `${SKU_PHOTO_URL}/${row.photo_file}` : null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

// ---------- validation ----------

function parsePhoto(value: unknown, currentPath: string | null): PhotoChange {
  if (value === undefined || value === currentPath) return undefined;
  if (value === null) return null;
  const match = typeof value === "string" ? /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(value) : null;
  const ext = match && PHOTO_TYPES[match[1]];
  if (!match || !ext) throw new HttpError(400, "Photo must be a JPG, PNG or WebP image");
  const data = Buffer.from(match[2], "base64");
  if (data.length > MAX_PHOTO_BYTES) throw new HttpError(400, "Photo must be 1 MB or smaller");
  return { data, ext };
}

export function parseSkuInput(body: unknown, current?: SkuMaster): ParsedSku {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const partial = !!current;
  const has = (k: keyof SkuInput) => !partial || k in b;
  const data: ParsedSku = { photo: parsePhoto(b.photo, current?.photo ?? null) };

  for (const [key, label, max] of [
    ["skuId", "SKU ID", 30],
    ["productName", "Product name", 150],
    ["sku", "SKU", 100],
  ] as const) {
    if (!has(key)) continue;
    const v = typeof b[key] === "string" ? b[key].trim() : "";
    if (!v) throw new HttpError(400, `${label} is required`);
    if (v.length > max) throw new HttpError(400, `${label} is too long (max ${max})`);
    data[key] = v;
  }
  if (data.skuId !== undefined && !SKU_ID_PATTERN.test(data.skuId)) {
    throw new HttpError(400, "SKU ID may only contain letters and numbers");
  }

  if (has("outputPerMinute")) {
    const v = b.outputPerMinute;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 100_000) {
      throw new HttpError(400, "Output per minute must be a number greater than 0");
    }
    data.outputPerMinute = Math.round(v * 100) / 100;
  }
  return data;
}

async function assertSkuIdFree(skuId: string, excludeId = "") {
  const [rows] = await pool.query<SkuRow[]>("SELECT sku_id FROM skus WHERE sku_id = ? AND id <> ?", [skuId, excludeId]);
  if (rows.length) throw new HttpError(409, `SKU ID "${rows[0].sku_id}" already exists`);
}

function mapDbError(skuId: string | undefined) {
  return (err: unknown): never => {
    if ((err as { code?: string })?.code === "ER_DUP_ENTRY") throw new HttpError(409, `SKU ID "${skuId}" already exists`);
    throw err;
  };
}

// ---------- photo files ----------

async function savePhoto(photo: { data: Buffer; ext: string }) {
  await mkdir(SKU_PHOTO_DIR, { recursive: true });
  const file = `${randomUUID()}.${photo.ext}`;
  await writeFile(path.join(SKU_PHOTO_DIR, file), photo.data);
  return file;
}

export async function deletePhoto(file: string | null | undefined) {
  if (!file) return;
  await unlink(path.join(SKU_PHOTO_DIR, path.basename(file))).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") console.warn(`[sku] could not delete photo ${file}:`, err.message);
  });
}

// ---------- store ----------

async function getRow(id: string) {
  const [rows] = await pool.query<SkuRow[]>("SELECT * FROM skus WHERE id = ?", [id]);
  return rows[0];
}

export const skuStore = {
  async list() {
    const [rows] = await pool.query<SkuRow[]>("SELECT * FROM skus");
    return rows.map(toSku).sort((a, b) => a.skuId.localeCompare(b.skuId, undefined, { numeric: true }));
  },

  async create(body: unknown) {
    const data = parseSkuInput(body);
    await assertSkuIdFree(data.skuId!);

    const id = randomUUID();
    const now = new Date();
    const file = data.photo ? await savePhoto(data.photo) : null;
    try {
      await pool.query(
        `INSERT INTO skus (id, sku_id, product_name, sku, output_per_minute, photo_file, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, data.skuId, data.productName, data.sku, data.outputPerMinute, file, now, now]
      );
    } catch (err) {
      await deletePhoto(file);
      mapDbError(data.skuId)(err);
    }
    return toSku((await getRow(id))!);
  },

  async update(id: string, body: unknown) {
    const row = await getRow(id);
    if (!row) throw new HttpError(404, "SKU not found");
    const data = parseSkuInput(body, toSku(row));
    if (data.skuId !== undefined) await assertSkuIdFree(data.skuId, id);

    const newFile = data.photo ? await savePhoto(data.photo) : null;
    const photoFile = data.photo === undefined ? row.photo_file : newFile;
    try {
      await pool.query(
        `UPDATE skus SET sku_id = ?, product_name = ?, sku = ?, output_per_minute = ?, photo_file = ?, updated_at = ?
          WHERE id = ?`,
        [
          data.skuId ?? row.sku_id,
          data.productName ?? row.product_name,
          data.sku ?? row.sku,
          data.outputPerMinute ?? row.output_per_minute,
          photoFile,
          new Date(),
          id,
        ]
      );
    } catch (err) {
      await deletePhoto(newFile);
      mapDbError(data.skuId)(err);
    }
    if (photoFile !== row.photo_file) await deletePhoto(row.photo_file);
    return toSku((await getRow(id))!);
  },

  async remove(id: string) {
    const row = await getRow(id);
    if (!row) throw new HttpError(404, "SKU not found");
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM skus WHERE id = ?", [id]);
    if (result.affectedRows === 0) throw new HttpError(404, "SKU not found");
    await deletePhoto(row.photo_file);
  },
};
