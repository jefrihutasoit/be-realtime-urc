import { once } from "node:events";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import type { Connection as CallbackConnection } from "mysql2";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import { authStore } from "./auth-store.js";
import { resetEngine } from "./oee-engine.js";
import { oeeHistoryStore } from "./oee-history-store.js";
import { oeeStateStore } from "./oee-state-store.js";
import { withPollerPaused } from "./poller.js";
import { settingsStore } from "./settings-store.js";
import { loadShifts } from "./shift-store.js";

// Whole-database maintenance: backup and restore of every table, initialize (empty like a new
// install) and clearing the history of a date range.
//
// Backup file: gzip of JSON lines.
//   {"type":"header","format":"oee-urc-database","version":1,"exportedAt":…,"migrations":[…],"tables":[…]}
//   {"type":"rows","table":"machines","rows":[{…},…]}      (up to BATCH rows per line)
//   {"type":"end","counts":{"machines":40,…}}
// Dates are written as {"$d":"<ISO>"} and binary values as {"$b":"<base64>"}.

const FORMAT = "oee-urc-database";

interface BackupHeader {
  format?: string;
  migrations?: string[];
  tables?: string[];
  exportedAt?: string;
}
const VERSION = 1;
const BATCH = 500;
/** Not in a backup: the schema version itself, and login sessions (restoring would sign people in or out). */
const SKIP_TABLES = ["schema_migrations", "user_sessions"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The shifts a new install starts with (as in migration 005). */
const DEFAULT_SHIFTS = [
  ["shift-1", "Shift 1", 360, 840],
  ["shift-2", "Shift 2", 840, 1320],
  ["shift-3", "Shift 3", 1320, 360],
] as const;

async function tableNames(conn: PoolConnection | typeof pool = pool) {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
  );
  return rows.map((r) => String(r.name));
}

async function migrationIds(conn: PoolConnection | typeof pool = pool) {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id FROM schema_migrations ORDER BY id");
  return rows.map((r) => String(r.id));
}

const encode = (row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? { $d: v.toISOString() } : Buffer.isBuffer(v) ? { $b: v.toString("base64") } : v;
  }
  return out;
};

const decode = (row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const o = v as { $d?: string; $b?: string } | null;
    out[k] = o && typeof o === "object" && typeof o.$d === "string" ? new Date(o.$d)
      : o && typeof o === "object" && typeof o.$b === "string" ? Buffer.from(o.$b, "base64")
      : v;
  }
  return out;
};

/** Local midnight of a "YYYY-MM-DD" date, `addDays` later. */
function localDay(date: string, addDays = 0) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d + addDays);
}

function parseRange(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const from = typeof b.from === "string" ? b.from : "";
  const to = typeof b.to === "string" ? b.to : "";
  if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) throw new HttpError(400, "From and to must be dates (YYYY-MM-DD)");
  if (from > to) throw new HttpError(400, "From must not be after to");
  return { from, to, start: localDay(from), end: localDay(to, 1) };
}

/** What a date range covers: [table, label, WHERE clause, params]. Child rows go with their record (FK cascade). */
function rangeTargets(r: ReturnType<typeof parseRange>): [string, string, string, unknown[]][] {
  return [
    ["tag_values", "Tag values (status, output, reject, product readings)", "recorded_at >= ? AND recorded_at < ?", [r.start, r.end]],
    ["oee_hourly", "Hourly OEE figures", "hour_start >= ? AND hour_start < ?", [r.start, r.end]],
    ["reject_records", "Reject data", "production_date BETWEEN ? AND ?", [r.from, r.to]],
    ["downtime_records", "Downtime data", "production_date BETWEEN ? AND ?", [r.from, r.to]],
  ];
}

/** Brings the in-memory state back in line with the database after it was changed underneath. */
async function reloadState() {
  resetEngine();
  await loadShifts();
  settingsStore.clearCache();
  authStore.clearCache();
  await authStore.ensureDefaults();
  await oeeStateStore.restore();
}

async function clearUploads() {
  for (const dir of ["skus", "layout"]) {
    const full = path.join(env.uploadDir, dir);
    const files = await readdir(full).catch(() => [] as string[]);
    await Promise.all(files.map((f) => unlink(path.join(full, f)).catch(() => {})));
  }
}

export const databaseStore = {
  async stats() {
    const names = await tableNames();
    const [sizes] = await pool.query<RowDataPacket[]>(
      `SELECT table_name AS name, data_length + index_length AS bytes FROM information_schema.tables
        WHERE table_schema = DATABASE()`
    );
    const bytes = new Map(sizes.map((s) => [String(s.name), Number(s.bytes)]));
    const tables = [];
    for (const name of names) {
      const [[{ n }]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${pool.escapeId(name)}`);
      tables.push({ name, rows: Number(n), bytes: bytes.get(name) ?? 0 });
    }
    const [[range]] = await pool.query<RowDataPacket[]>("SELECT MIN(recorded_at) AS oldest, MAX(recorded_at) AS newest FROM tag_values");
    const migrations = await migrationIds();
    return {
      database: env.db.database,
      schemaVersion: migrations.at(-1) ?? null,
      tables,
      tagValues: {
        oldest: range.oldest ? (range.oldest as Date).toISOString() : null,
        newest: range.newest ? (range.newest as Date).toISOString() : null,
      },
    };
  },

  /** Streams the backup into `out` (gzip of JSON lines). Tables are read one by one, row by row. */
  async backup(out: Writable) {
    // Save the live OEE figures first so the backup has them.
    await oeeStateStore.save().catch(() => {});
    await oeeHistoryStore.flush().catch(() => {});
    const gzip = createGzip();
    gzip.pipe(out);
    const write = async (obj: unknown) => {
      if (!gzip.write(`${JSON.stringify(obj)}\n`)) await once(gzip, "drain");
    };
    const conn = await pool.getConnection();
    try {
      const tables = (await tableNames(conn)).filter((t) => !SKIP_TABLES.includes(t));
      await write({
        type: "header",
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        database: env.db.database,
        migrations: await migrationIds(conn),
        tables,
      });
      const counts: Record<string, number> = {};
      for (const table of tables) {
        counts[table] = 0;
        let batch: Record<string, unknown>[] = [];
        // The callback connection under the promise wrapper can stream rows.
        const raw = conn.connection as unknown as CallbackConnection;
        const stream = raw.query(`SELECT * FROM ${pool.escapeId(table)}`).stream();
        for await (const row of stream) {
          batch.push(encode(row as Record<string, unknown>));
          counts[table] += 1;
          if (batch.length >= BATCH) {
            await write({ type: "rows", table, rows: batch });
            batch = [];
          }
        }
        if (batch.length) await write({ type: "rows", table, rows: batch });
      }
      await write({ type: "end", counts });
    } finally {
      conn.release();
      gzip.end();
    }
    await once(gzip, "end").catch(() => {});
  },

  /**
   * Replaces every table with the backup in `input` (gzip of JSON lines), in one transaction.
   * The backup must come from the same schema version (same migrations).
   */
  async restore(input: Readable) {
    return withPollerPaused(async () => {
      const conn = await pool.getConnection();
      const counts: Record<string, number> = {};
      let header: BackupHeader | null = null;
      let ended = false;
      try {
        await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        await conn.beginTransaction();
        try {
          const current = new Set(await tableNames(conn));
          // Created right before reading: readline drops lines emitted before the loop listens.
          const gunzip = createGunzip();
          const lines = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
          // A gzip error does not reach readline by itself; stop reading and report it.
          let unreadable = false;
          gunzip.on("error", () => {
            unreadable = true;
            lines.close();
          });
          for await (const line of lines) {
            if (!line.trim()) continue;
            let item: { type?: string; table?: string; rows?: Record<string, unknown>[] } & Record<string, unknown>;
            try {
              item = JSON.parse(line);
            } catch {
              throw new HttpError(400, "The file is not a database backup (unreadable line)");
            }
            if (!header) {
              if (item.type !== "header" || item.format !== FORMAT) throw new HttpError(400, "The file is not an OEE database backup");
              header = item as unknown as BackupHeader;
              const mine = await migrationIds(conn);
              const theirs = header.migrations ?? [];
              if (mine.join("|") !== theirs.join("|")) {
                throw new HttpError(
                  400,
                  `The backup is from schema version ${theirs.at(-1) ?? "?"}, this database is ${mine.at(-1) ?? "?"}. ` +
                    "Restore it on a backend of the same version."
                );
              }
              for (const t of current) {
                if (!SKIP_TABLES.includes(t)) await conn.query(`DELETE FROM ${pool.escapeId(t)}`);
              }
              continue;
            }
            if (item.type === "end") {
              ended = true;
              break;
            }
            if (item.type !== "rows" || !item.table || !Array.isArray(item.rows) || !item.rows.length) continue;
            if (!current.has(item.table) || SKIP_TABLES.includes(item.table)) continue;
            const rows = item.rows.map(decode);
            const columns = Object.keys(rows[0]);
            await conn.query(
              `INSERT INTO ${pool.escapeId(item.table)} (${columns.map((c) => pool.escapeId(c)).join(", ")}) VALUES ?`,
              [rows.map((r) => columns.map((c) => r[c]))]
            );
            counts[item.table] = (counts[item.table] ?? 0) + rows.length;
          }
          if (unreadable) throw new HttpError(400, "The file is not a gzip database backup");
          if (!header) throw new HttpError(400, "The file is empty");
          if (!ended) throw new HttpError(400, "The backup file is incomplete (no end marker); nothing was changed");
          // Sessions of users that are not in the backup end here.
          await conn.query(
            "DELETE s FROM user_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.id IS NULL OR u.is_active = 0"
          );
          await conn.commit();
        } catch (err) {
          await conn.rollback();
          throw err;
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if ((err as { code?: string }).code === "Z_DATA_ERROR") throw new HttpError(400, "The file is not a gzip database backup");
        throw err;
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
        conn.release();
        input.resume();
      }
      await reloadState();
      return { exportedAt: (header as BackupHeader | null)?.exportedAt ?? null, tables: counts };
    });
  },

  async previewClear(body: unknown) {
    const range = parseRange(body);
    const items = [];
    for (const [table, label, where, params] of rangeTargets(range)) {
      const [[{ n }]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
      items.push({ table, label, rows: Number(n) });
    }
    return { from: range.from, to: range.to, items };
  },

  /** Deletes the history of the date range (inclusive). Settings and master data stay. */
  async clear(body: unknown) {
    const range = parseRange(body);
    if ((body as { confirm?: unknown })?.confirm !== "DELETE") throw new HttpError(400, 'Type "DELETE" to confirm');
    return withPollerPaused(async () => {
      await oeeHistoryStore.flush().catch(() => {});
      const deleted: Record<string, number> = {};
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const [table, , where, params] of rangeTargets(range)) {
          const [result] = await conn.query(`DELETE FROM ${table} WHERE ${where}`, params);
          deleted[table] = (result as { affectedRows: number }).affectedRows;
        }
        // A range up to today also ends the running OEE calculations.
        const coversNow = range.end.getTime() > Date.now() && range.start.getTime() <= Date.now();
        if (coversNow) await conn.query("DELETE FROM oee_run_states");
        await conn.commit();
        if (coversNow) resetEngine();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      return { from: range.from, to: range.to, deleted };
    });
  },

  /**
   * Empties the database like a new install: default shifts, default settings and the default accounts.
   * With `keepUsers` the user accounts, their sessions and the role permissions stay.
   */
  async initialize(body: unknown) {
    const b = (body ?? {}) as { confirm?: unknown; keepUsers?: unknown };
    if (b.confirm !== "INITIALIZE") throw new HttpError(400, 'Type "INITIALIZE" to confirm');
    const keepUsers = b.keepUsers !== false;
    return withPollerPaused(async () => {
      const conn = await pool.getConnection();
      try {
        await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        await conn.beginTransaction();
        const keep = new Set(["schema_migrations", ...(keepUsers ? ["users", "user_sessions"] : [])]);
        for (const t of await tableNames(conn)) {
          if (keep.has(t)) continue;
          if (t === "app_settings" && keepUsers) {
            await conn.query("DELETE FROM app_settings WHERE setting_key <> 'role_permissions'");
          } else {
            await conn.query(`DELETE FROM ${pool.escapeId(t)}`);
          }
        }
        const now = new Date();
        await conn.query("INSERT INTO shifts (id, name, start_minute, end_minute, created_at, updated_at) VALUES ?", [
          DEFAULT_SHIFTS.map((s) => [...s, now, now]),
        ]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS = 1").catch(() => {});
        conn.release();
      }
      await clearUploads();
      await reloadState();
      return { keepUsers };
    });
  },
};
