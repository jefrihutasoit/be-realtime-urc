import mysql, { type PoolConnection } from "mysql2/promise";
import { env } from "../config/env.js";

export const pool = mysql.createPool({
  ...env.db,
  connectionLimit: 10,
  // DATETIME columns are stored and read as UTC.
  timezone: "Z",
});

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
