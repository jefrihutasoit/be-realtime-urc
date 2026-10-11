import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { dbConfig, type DbConfig } from "../config/db-config.js";

const createPoolFor = (cfg: DbConfig) =>
  mysql.createPool({
    ...cfg,
    connectionLimit: 10,
    connectTimeout: 5000,
    // DATETIME columns are stored and read as UTC.
    timezone: "Z",
  });

let current: Pool = createPoolFor(dbConfig());

/**
 * The connection pool. A stable object that forwards to the current pool, so the connection settings
 * can be changed at runtime (System Management) without every module re-importing it.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const value = Reflect.get(current, prop);
    return typeof value === "function" ? value.bind(current) : value;
  },
});

/** Switches to a pool for the given settings; the old pool is closed in the background. */
export function replacePool(cfg: DbConfig) {
  const old = current;
  current = createPoolFor(cfg);
  old.end().catch(() => {});
}

/**
 * Whether the database is usable. Set by the system lifecycle (system-state); modules that run on a timer
 * (poller, ingest) skip their work while it is false instead of logging an error every tick.
 */
export const dbHealth = {
  ready: false,
  error: null as string | null,
  /** When `ready` last changed. */
  since: new Date().toISOString(),
};

export interface DbTestResult {
  ok: boolean;
  message: string;
  ms: number;
  serverVersion?: string;
  /** Whether the database exists yet; it is created on connect when missing. */
  databaseExists?: boolean;
}

/** Tries the settings with a single connection to the server (not the pool). */
export async function testDbConfig(cfg: DbConfig): Promise<DbTestResult> {
  const started = Date.now();
  const { database, ...server } = cfg;
  try {
    const conn = await mysql.createConnection({ ...server, connectTimeout: 5000 });
    try {
      const [[{ version }]] = await conn.query<RowDataPacket[]>("SELECT VERSION() AS version");
      const [dbs] = await conn.query<RowDataPacket[]>("SHOW DATABASES LIKE ?", [database]);
      const exists = dbs.length > 0;
      return {
        ok: true,
        message: exists
          ? `Connected to ${cfg.host}:${cfg.port}; database "${database}" found`
          : `Connected to ${cfg.host}:${cfg.port}; database "${database}" does not exist yet and will be created`,
        ms: Date.now() - started,
        serverVersion: String(version),
        databaseExists: exists,
      };
    } finally {
      await conn.end();
    }
  } catch (err) {
    return { ok: false, message: describeDbError(err, cfg), ms: Date.now() - started };
  }
}

/** A readable reason for a connection error. */
export function describeDbError(err: unknown, cfg: DbConfig = dbConfig()) {
  const e = err as { code?: string; message?: string };
  switch (e.code) {
    case "ECONNREFUSED":
      return `Nothing is listening on ${cfg.host}:${cfg.port}. Is MySQL / MariaDB (XAMPP) running?`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Host "${cfg.host}" not found`;
    case "ETIMEDOUT":
      return `No answer from ${cfg.host}:${cfg.port} (timeout); check the host, port and firewall`;
    case "ER_ACCESS_DENIED_ERROR":
      return `User "${cfg.user}" was refused: wrong password, or the user may not connect from this computer`;
    case "ER_DBACCESS_DENIED_ERROR":
      return `User "${cfg.user}" has no access to database "${cfg.database}"`;
    default:
      return e.message || String(err);
  }
}

/** Runs `fn` inside a transaction; rolls back if it throws. */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
