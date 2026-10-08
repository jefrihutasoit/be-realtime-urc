import mysql, { type RowDataPacket } from "mysql2/promise";
import { env } from "../config/env.js";
import { migrations } from "./migrations.js";
import { pool } from "./pool.js";

/** Creates the database if needed, then applies pending migrations. Safe to run on every start. */
export async function migrate() {
  const { database, ...server } = env.db;
  const admin = await mysql.createConnection(server);
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
    );
  } finally {
    await admin.end();
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(100) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.id as string));

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    // MySQL DDL auto-commits, so a migration is not atomic; keep each one small.
    for (const statement of m.sql) await pool.query(statement);
    await pool.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [m.id, new Date()]);
    console.log(`[db] applied migration ${m.id}`);
  }
}
