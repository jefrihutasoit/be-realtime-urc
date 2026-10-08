import { randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { pool, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import {
  BACKUP_VERSION,
  type BackupCheck,
  type BackupLayoutMarker,
  type BackupMachine,
  type BackupRejectType,
  type BackupSectionSummary,
  type BackupShift,
  type BackupSku,
  type SettingsBackup,
} from "../types/backup.js";
import type { RolePermissions } from "../types/auth.js";
import { DEFAULT_OEE_SETTINGS, type OeeSettings, type StatusDefinition } from "../types/settings.js";
import { authStore, parseRolePermissions } from "./auth-store.js";
import { layoutStore } from "./layout-store.js";
import { machineStore, parseMachineInput, PRODUCTION_TAGS } from "./machine-store.js";
import { forgetMachine } from "./oee-engine.js";
import { rejectStore } from "./reject-store.js";
import { parseOeeSettings, parseStatusDefinition, settingsStore } from "./settings-store.js";
import { durationOf, loadShifts, overlaps, parseTime, shiftStore } from "./shift-store.js";
import { deletePhoto, parseSkuInput, skuStore } from "./sku-store.js";

// Export and full restore of the system settings: machines with their tags, SKUs (without photos),
// shifts, status definition, OEE settings, role permissions, plant layout markers and reject types.
// History and user accounts are never touched.
// A restore replaces the settings with the backup: records are matched by machine No, SKU ID,
// shift name and reject type name, so matched records keep their database id (and their history).

const STATUS_KEY = "status_definition";
const OEE_KEY = "oee_settings";
const ROLES_KEY = "role_permissions";
const LAYOUT_KEY = "plant_layout";

const lower = (v: string) => v.trim().toLowerCase();
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isPhotoPath = (photo: string | null): photo is string => typeof photo === "string" && photo.startsWith("/");

interface Parsed {
  machines: BackupMachine[];
  skus: BackupSku[];
  shifts: (BackupShift & { startMinute: number; endMinute: number })[];
  statusDefinition: StatusDefinition | null;
  oeeSettings: OeeSettings;
  rolePermissions: RolePermissions | null;
  layoutMarkers: BackupLayoutMarker[];
  rejectTypes: BackupRejectType[];
}

interface Current {
  machines: { id: string; machine_no: string; photo: string | null; created_at: Date }[];
  skus: { id: string; sku_id: string; photo_file: string | null; created_at: Date }[];
  shifts: { id: string; name: string; created_at: Date }[];
  rejectTypes: { id: string; name: string; used: number }[];
  hasLayoutMarkers: boolean;
}

// ---------- validation ----------

const list = (b: Record<string, unknown>, key: string, errors: string[]) => {
  if (b[key] === undefined) return [];
  if (!Array.isArray(b[key])) {
    errors.push(`${key} must be a list`);
    return [];
  }
  return b[key] as Record<string, unknown>[];
};

async function parseBackup(body: unknown, errors: string[]): Promise<Parsed> {
  const parsed: Parsed = {
    machines: [],
    skus: [],
    shifts: [],
    statusDefinition: null,
    oeeSettings: DEFAULT_OEE_SETTINGS,
    rolePermissions: null,
    layoutMarkers: [],
    rejectTypes: [],
  };
  if (typeof body !== "object" || body === null) {
    errors.push("Invalid backup");
    return parsed;
  }
  const b = body as Record<string, unknown>;
  if (b.version !== BACKUP_VERSION) {
    errors.push(`Unsupported backup version ${String(b.version)} (expected ${BACKUP_VERSION})`);
    return parsed;
  }

  // Machines and their tags
  const tagOwner = new Map<string, string>();
  const machineNos = new Set<string>();
  for (const [i, raw] of list(b, "machines", errors).entries()) {
    const label = `Machine ${typeof raw.machineNo === "string" && raw.machineNo.trim() ? `"${raw.machineNo.trim()}"` : `#${i + 1}`}`;
    try {
      const photo = typeof raw.photo === "string" && isPhotoPath(raw.photo) ? raw.photo : null;
      const m = await parseMachineInput({
        ...raw,
        photo,
        monitoringTags: raw.monitoringTags ?? [],
      });
      const machineNo = m.machineNo!;
      if (machineNos.has(lower(machineNo))) throw new Error("Machine No is used twice");
      machineNos.add(lower(machineNo));
      const own = PRODUCTION_TAGS.map(([key]) => m[key]!);
      if (new Set(own).size !== own.length) throw new Error("Status, output, reject and product must use different tags");
      for (const tag of own) {
        const other = tagOwner.get(tag);
        if (other) throw new Error(`Tag ${tag} is also used by machine ${other}`);
        tagOwner.set(tag, machineNo);
      }
      parsed.machines.push({
        machineNo,
        machineName: m.machineName!,
        tagStatus: m.tagStatus!,
        tagOutput: m.tagOutput!,
        tagReject: m.tagReject!,
        tagProduct: m.tagProduct!,
        isActive: m.isActive!,
        oeeEnabled: m.oeeEnabled!,
        photo,
        monitoringTags: (m.monitoringTags ?? []).map((t) => ({ name: t.name, tagName: t.tagName })),
      });
    } catch (err) {
      errors.push(`${label}: ${message(err)}`);
    }
  }

  // SKUs (photos are not part of the backup)
  const skuIds = new Set<string>();
  for (const [i, raw] of list(b, "skus", errors).entries()) {
    const label = `SKU ${typeof raw.skuId === "string" && raw.skuId.trim() ? `"${raw.skuId.trim()}"` : `#${i + 1}`}`;
    try {
      const s = parseSkuInput({
        skuId: raw.skuId,
        productName: raw.productName,
        sku: raw.sku,
        outputPerMinute: raw.outputPerMinute,
      });
      if (skuIds.has(lower(s.skuId!))) throw new Error("SKU ID is used twice");
      skuIds.add(lower(s.skuId!));
      parsed.skus.push({ skuId: s.skuId!, productName: s.productName!, sku: s.sku!, outputPerMinute: s.outputPerMinute! });
    } catch (err) {
      errors.push(`${label}: ${message(err)}`);
    }
  }

  // Shifts
  for (const [i, raw] of list(b, "shifts", errors).entries()) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const label = `Shift ${name ? `"${name}"` : `#${i + 1}`}`;
    try {
      if (!name) throw new Error("Shift name is required");
      if (name.length > 50) throw new Error("Shift name is too long (max 50)");
      const startMinute = parseTime(raw.start, "Start");
      const endMinute = parseTime(raw.end, "End");
      if (startMinute === endMinute) throw new Error("Start and end must be different");
      const def = { id: name, name, start: startMinute, duration: durationOf(startMinute, endMinute) };
      for (const other of parsed.shifts) {
        if (lower(other.name) === lower(name)) throw new Error("Shift name is used twice");
        const otherDef = { id: other.name, name: other.name, start: other.startMinute, duration: durationOf(other.startMinute, other.endMinute) };
        if (overlaps(def, otherDef)) throw new Error(`Overlaps with ${other.name} (${other.start}–${other.end})`);
      }
      parsed.shifts.push({ name, start: String(raw.start).trim(), end: String(raw.end).trim(), startMinute, endMinute });
    } catch (err) {
      errors.push(`${label}: ${message(err)}`);
    }
  }

  // Status definition
  try {
    parsed.statusDefinition = parseStatusDefinition(b.statusDefinition);
  } catch (err) {
    errors.push(`Status definition: ${message(err)}`);
  }

  // OEE settings (optional: missing fields get their defaults)
  if (b.oeeSettings !== undefined) {
    try {
      parsed.oeeSettings = parseOeeSettings(b.oeeSettings);
    } catch (err) {
      errors.push(`OEE settings: ${message(err)}`);
    }
  }

  // Role permissions (optional: older backups keep the current ones)
  if (b.rolePermissions !== undefined && b.rolePermissions !== null) {
    try {
      parsed.rolePermissions = parseRolePermissions(b.rolePermissions);
    } catch (err) {
      errors.push(`Role permissions: ${message(err)}`);
    }
  }

  // Layout markers, by machine No
  const placed = new Set<string>();
  for (const [i, raw] of list(b, "layoutMarkers", errors).entries()) {
    const machineNo = typeof raw.machineNo === "string" ? raw.machineNo.trim() : "";
    const label = `Layout marker ${machineNo ? `"${machineNo}"` : `#${i + 1}`}`;
    const coord = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    if (!machineNo) errors.push(`${label}: machine No is required`);
    else if (!machineNos.has(lower(machineNo))) errors.push(`${label}: machine is not in the backup`);
    else if (placed.has(lower(machineNo))) errors.push(`${label}: machine is placed twice`);
    else if (!coord(raw.x) || !coord(raw.y)) errors.push(`${label}: X and Y must be between 0 and 1`);
    else {
      placed.add(lower(machineNo));
      const round = (v: number) => Math.round(v * 10000) / 10000;
      parsed.layoutMarkers.push({ machineNo, x: round(raw.x as number), y: round(raw.y as number) });
    }
  }

  // Reject types
  const typeNames = new Set<string>();
  for (const [i, raw] of list(b, "rejectTypes", errors).entries()) {
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    const label = `Reject type ${name ? `"${name}"` : `#${i + 1}`}`;
    const order = raw.sortOrder ?? i + 1;
    if (!name) errors.push(`${label}: name is required`);
    else if (name.length > 100) errors.push(`${label}: name is too long (max 100)`);
    else if (typeNames.has(lower(name).replace(/ /g, ""))) errors.push(`${label}: name is used twice`);
    else if (!Number.isInteger(order) || (order as number) < 0 || (order as number) > 9999) {
      errors.push(`${label}: order must be a whole number from 0 to 9999`);
    } else {
      typeNames.add(lower(name).replace(/ /g, ""));
      parsed.rejectTypes.push({ name, sortOrder: order as number });
    }
  }
  return parsed;
}

async function loadCurrent(conn: PoolConnection | typeof pool): Promise<Current> {
  const [machines] = await conn.query<RowDataPacket[]>("SELECT id, machine_no, photo, created_at FROM machines");
  const [skus] = await conn.query<RowDataPacket[]>("SELECT id, sku_id, photo_file, created_at FROM skus");
  const [shifts] = await conn.query<RowDataPacket[]>("SELECT id, name, created_at FROM shifts");
  const [rejectTypes] = await conn.query<RowDataPacket[]>(
    `SELECT t.id, t.name, (SELECT COUNT(*) FROM reject_record_items i WHERE i.reject_type_id = t.id) AS used
      FROM reject_types t`
  );
  const [layout] = await conn.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [
    LAYOUT_KEY,
  ]);
  let hasLayoutMarkers = false;
  try {
    hasLayoutMarkers = !!layout[0] && (JSON.parse(layout[0].setting_value).markers ?? []).length > 0;
  } catch {
    // An unreadable layout is replaced anyway.
  }
  return {
    machines: machines as Current["machines"],
    skus: skus as Current["skus"],
    shifts: shifts as Current["shifts"],
    rejectTypes: (rejectTypes as RowDataPacket[]).map((t) => ({ id: t.id, name: t.name, used: Number(t.used) })),
    hasLayoutMarkers,
  };
}

/** Add / update / remove counts of one section, matching on a case-insensitive key. */
function diff(section: string, incoming: string[], current: string[]): BackupSectionSummary & { removed: string[] } {
  const now = new Set(current.map(lower));
  const next = new Set(incoming.map(lower));
  const removed = current.filter((k) => !next.has(lower(k)));
  return {
    section,
    inBackup: incoming.length,
    add: incoming.filter((k) => !now.has(lower(k))).length,
    update: incoming.filter((k) => now.has(lower(k))).length,
    remove: removed.length,
    removed,
  };
}

async function check(body: unknown, conn: PoolConnection | typeof pool = pool) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = await parseBackup(body, errors);
  const current = await loadCurrent(conn);

  const machines = diff("Machines", parsed.machines.map((m) => m.machineNo), current.machines.map((m) => m.machine_no));
  const skus = diff("SKUs", parsed.skus.map((s) => s.skuId), current.skus.map((s) => s.sku_id));
  const shifts = diff("Shifts", parsed.shifts.map((s) => s.name), current.shifts.map((s) => s.name));
  const types = diff("Reject Types", parsed.rejectTypes.map((t) => t.name), current.rejectTypes.map((t) => t.name));
  const keptTypes = current.rejectTypes.filter((t) => t.used > 0 && types.removed.includes(t.name)).map((t) => t.name);
  types.remove -= keptTypes.length;

  if (!parsed.machines.length) warnings.push("The backup has no machines");
  if (!parsed.shifts.length) warnings.push("The backup has no shifts; OEE will not reset per shift");
  if (machines.removed.length) warnings.push(`Machines deleted (not in the backup): ${machines.removed.join(", ")}`);
  if (skus.removed.length) warnings.push(`SKUs deleted (not in the backup): ${skus.removed.join(", ")}`);
  if (shifts.removed.length) warnings.push(`Shifts deleted (not in the backup): ${shifts.removed.join(", ")}`);
  if (keptTypes.length) warnings.push(`Reject types kept because reject data uses them: ${keptTypes.join(", ")}`);
  const backupNos = new Set(parsed.machines.map((m) => lower(m.machineNo)));
  const backupSkus = new Set(parsed.skus.map((s) => lower(s.skuId)));
  const keptPhotos =
    current.machines.filter((m) => m.photo && !isPhotoPath(m.photo) && backupNos.has(lower(m.machine_no))).length +
    current.skus.filter((s) => s.photo_file && backupSkus.has(lower(s.sku_id))).length;
  if (keptPhotos) warnings.push(`Photos are not in the backup; ${keptPhotos} current photos of matching machines / SKUs are kept`);

  // Monitoring tags, status definition and layout markers are replaced as a whole.
  const tagCount = parsed.machines.reduce((n, m) => n + m.monitoringTags.length, 0);
  const summary: BackupSectionSummary[] = [
    machines,
    { section: "Monitoring Tags", inBackup: tagCount, add: 0, update: tagCount, remove: 0 },
    skus,
    shifts,
    { section: "Status Definition", inBackup: parsed.statusDefinition ? 1 : 0, add: 0, update: 1, remove: 0 },
    { section: "OEE Settings", inBackup: 1, add: 0, update: 1, remove: 0 },
    {
      section: "Role Permissions",
      inBackup: parsed.rolePermissions ? 3 : 0,
      add: 0,
      update: parsed.rolePermissions ? 3 : 0,
      remove: 0,
    },
    {
      section: "Layout Markers",
      inBackup: parsed.layoutMarkers.length,
      add: 0,
      update: parsed.layoutMarkers.length,
      remove: 0,
    },
    types,
  ].map(({ section, inBackup, add, update, remove }) => ({ section, inBackup, add, update, remove }));
  if (current.hasLayoutMarkers && !parsed.layoutMarkers.length) warnings.push("All machine positions on the layout are cleared");
  if (!parsed.rolePermissions) warnings.push("The backup has no role permissions; the current ones are kept");

  return { result: { valid: errors.length === 0, errors, warnings, summary } as BackupCheck, parsed, current };
}

// ---------- store ----------

export const backupStore = {
  async export(): Promise<SettingsBackup> {
    const [machines, skus, shifts, statusDefinition, oeeSettings, rolePermissions, layout, rejectTypes] = await Promise.all([
      machineStore.list(),
      skuStore.list(),
      shiftStore.list(),
      settingsStore.getStatusDefinition(),
      settingsStore.getOeeSettings(),
      authStore.rolePermissions(),
      layoutStore.get(),
      rejectStore.listTypes(),
    ]);
    const machineNo = new Map(machines.map((m) => [m.id, m.machineNo]));
    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      machines: machines.map((m) => ({
        machineNo: m.machineNo,
        machineName: m.machineName,
        tagStatus: m.tagStatus,
        tagOutput: m.tagOutput,
        tagReject: m.tagReject,
        tagProduct: m.tagProduct,
        isActive: m.isActive,
        oeeEnabled: m.oeeEnabled,
        photo: isPhotoPath(m.photo) ? m.photo : null,
        monitoringTags: m.monitoringTags.map((t) => ({ name: t.name, tagName: t.tagName })),
      })),
      skus: skus.map((s) => ({ skuId: s.skuId, productName: s.productName, sku: s.sku, outputPerMinute: s.outputPerMinute })),
      shifts: shifts.map((s) => ({ name: s.name, start: s.start, end: s.end })),
      statusDefinition,
      oeeSettings,
      rolePermissions,
      layoutMarkers: layout.markers.flatMap((mk) =>
        machineNo.has(mk.machineId) ? [{ machineNo: machineNo.get(mk.machineId)!, x: mk.x, y: mk.y }] : []
      ),
      rejectTypes: rejectTypes.map((t) => ({ name: t.name, sortOrder: t.sortOrder })),
    };
  },

  async validate(body: unknown): Promise<BackupCheck> {
    return (await check(body)).result;
  },

  /** Replaces all settings with the backup, in one transaction. Refused unless the backup validates. */
  async restore(body: unknown): Promise<BackupCheck> {
    const removedMachineIds: string[] = [];
    const removedPhotos: (string | null)[] = [];

    const result = await withTransaction(async (conn) => {
      const { result, parsed, current } = await check(body, conn);
      if (!result.valid) throw new HttpError(400, "The backup has errors. Check it and fix the problems before restoring");
      const now = new Date();

      // Machines: rewritten as a whole so tags can move between machines without unique-key clashes.
      // Matched machines keep their id, creation time and uploaded photo.
      const machineByNo = new Map(current.machines.map((m) => [lower(m.machine_no), m]));
      const machineIds = new Map<string, string>();
      await conn.query("DELETE FROM machines");
      for (const m of parsed.machines) {
        const old = machineByNo.get(lower(m.machineNo));
        const id = old?.id ?? randomUUID();
        machineIds.set(lower(m.machineNo), id);
        const photo = m.photo ?? old?.photo ?? null;
        await conn.query(
          `INSERT INTO machines (id, machine_no, machine_name, tag_status, tag_output, tag_reject, tag_product,
            photo, is_active, oee_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, m.machineNo, m.machineName, m.tagStatus, m.tagOutput, m.tagReject, m.tagProduct, photo, m.isActive,
            m.oeeEnabled, old?.created_at ?? now, now]
        );
        if (m.monitoringTags.length) {
          await conn.query("INSERT INTO machine_monitoring_tags (id, machine_id, name, tag_name, sort_order) VALUES ?", [
            m.monitoringTags.map((t, i) => [randomUUID(), id, t.name, t.tagName, i]),
          ]);
        }
      }
      for (const m of current.machines) if (!machineIds.has(lower(m.machine_no))) removedMachineIds.push(m.id);

      // SKUs: matched SKUs keep their id and photo file.
      const skuById = new Map(current.skus.map((s) => [lower(s.sku_id), s]));
      await conn.query("DELETE FROM skus");
      for (const s of parsed.skus) {
        const old = skuById.get(lower(s.skuId));
        await conn.query(
          `INSERT INTO skus (id, sku_id, product_name, sku, output_per_minute, photo_file, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [old?.id ?? randomUUID(), s.skuId, s.productName, s.sku, s.outputPerMinute, old?.photo_file ?? null,
            old?.created_at ?? now, now]
        );
      }
      const backupSkus = new Set(parsed.skus.map((s) => lower(s.skuId)));
      for (const s of current.skus) if (!backupSkus.has(lower(s.sku_id))) removedPhotos.push(s.photo_file);

      // Shifts: matched shifts keep their id, which reject data refers to.
      const shiftByName = new Map(current.shifts.map((s) => [lower(s.name), s]));
      await conn.query("DELETE FROM shifts");
      for (const s of parsed.shifts) {
        const old = shiftByName.get(lower(s.name));
        await conn.query(
          "INSERT INTO shifts (id, name, start_minute, end_minute, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [old?.id ?? randomUUID(), s.name, s.startMinute, s.endMinute, old?.created_at ?? now, now]
        );
      }

      // Reject types are referenced by reject data, so they are updated in place; used ones are never deleted.
      const typeByName = new Map(current.rejectTypes.map((t) => [lower(t.name).replace(/ /g, ""), t]));
      const keepTypes = new Set<string>();
      for (const t of parsed.rejectTypes) {
        const old = typeByName.get(lower(t.name).replace(/ /g, ""));
        if (old) {
          keepTypes.add(old.id);
          await conn.query("UPDATE reject_types SET name = ?, sort_order = ? WHERE id = ?", [t.name, t.sortOrder, old.id]);
        } else {
          await conn.query("INSERT INTO reject_types (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)", [
            randomUUID(),
            t.name,
            t.sortOrder,
            now,
          ]);
        }
      }
      for (const t of current.rejectTypes) {
        if (!keepTypes.has(t.id) && t.used === 0) await conn.query("DELETE FROM reject_types WHERE id = ?", [t.id]);
      }

      // Status definition and layout markers (the layout image stays as it is).
      const upsert = (key: string, value: unknown) =>
        conn.query(
          `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
          [key, JSON.stringify(value), now]
        );
      await upsert(STATUS_KEY, parsed.statusDefinition);
      await upsert(OEE_KEY, parsed.oeeSettings);
      if (parsed.rolePermissions) await upsert(ROLES_KEY, parsed.rolePermissions);
      const [layoutRows] = await conn.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [
        LAYOUT_KEY,
      ]);
      let imageFile: string | null = null;
      try {
        imageFile = layoutRows[0] ? (JSON.parse(layoutRows[0].setting_value).imageFile ?? null) : null;
      } catch {
        // Unreadable layout: start over without an image.
      }
      await upsert(LAYOUT_KEY, {
        imageFile,
        markers: parsed.layoutMarkers.map((mk) => ({ machineId: machineIds.get(lower(mk.machineNo))!, x: mk.x, y: mk.y })),
        updatedAt: now.toISOString(),
      });
      return result;
    });

    // In-memory state that follows the database.
    await loadShifts();
    settingsStore.clearCache();
    authStore.clearCache();
    removedMachineIds.forEach(forgetMachine);
    await Promise.all(removedPhotos.map(deletePhoto));
    return result;
  },
};
