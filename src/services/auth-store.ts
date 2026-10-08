import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../db/pool.js";
import { HttpError } from "../lib/http-error.js";
import {
  DEFAULT_ROLE_PERMISSIONS,
  ENGINEERING_PERMISSIONS,
  FIXED_PERMISSIONS,
  ASSIGNABLE_ROLES,
  MANAGED_ROLES,
  PERMISSIONS,
  type ManagedRole,
  type Me,
  type Permission,
  type Role,
  type RolePermissions,
  type User,
} from "../types/auth.js";

// Users (`users`), login sessions (`user_sessions`, only a hash of the token is stored) and the
// permissions per role (app_settings "role_permissions"). Engineering accounts are only visible to and
// managed by Engineering accounts; one is created from ENGINEERING_USERNAME / ENGINEERING_PASSWORD.

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_DAYS = 7;
const ROLES_KEY = "role_permissions";
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,50}$/;
const MIN_PASSWORD = 6;
const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS.map((p) => p.key), ...ENGINEERING_PERMISSIONS];

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  name: string;
  role: Role;
  password_hash: string;
  is_active: number;
  last_login_at: Date | null;
  created_at: Date;
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = await scrypt(password, Buffer.from(salt, "hex"), 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  name: r.name,
  role: r.role,
  isActive: !!r.is_active,
  lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
});

// ---------- role permissions ----------

let rolesCache: RolePermissions | null = null;

export function parseRolePermissions(body: unknown): RolePermissions {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const allowed = new Set<string>(PERMISSIONS.map((p) => p.key));
  const out = {} as RolePermissions;
  for (const role of MANAGED_ROLES) {
    const list = b[role] ?? [];
    if (!Array.isArray(list)) throw new HttpError(400, `${role} permissions must be a list`);
    for (const p of list) if (!allowed.has(p)) throw new HttpError(400, `Unknown permission "${p}"`);
    out[role] = [...new Set([...(list as Permission[]), ...(FIXED_PERMISSIONS[role] ?? [])])];
  }
  return out;
}

async function rolePermissions(): Promise<RolePermissions> {
  if (rolesCache) return rolesCache;
  const [rows] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = ?", [
    ROLES_KEY,
  ]);
  let roles = DEFAULT_ROLE_PERMISSIONS;
  try {
    if (rows[0]) roles = parseRolePermissions(JSON.parse(rows[0].setting_value));
  } catch (err) {
    console.warn("[auth] stored role permissions are invalid, using defaults:", (err as Error).message);
  }
  rolesCache = roles;
  return roles;
}

async function permissionsOf(role: Role): Promise<Permission[]> {
  if (role === "ENGINEERING") return ALL_PERMISSIONS;
  return (await rolePermissions())[role] ?? [];
}

// ---------- validation ----------

function parseUserInput(body: unknown, partial: boolean, actor: Me) {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Invalid request body");
  const b = body as Record<string, unknown>;
  const has = (k: string) => !partial || k in b;
  const out: { username?: string; name?: string; role?: Role; isActive?: boolean; password?: string } = {};
  if (has("username")) {
    const v = typeof b.username === "string" ? b.username.trim() : "";
    if (!USERNAME_PATTERN.test(v)) {
      throw new HttpError(400, "Username must be 3–50 letters, numbers, dots, dashes or underscores");
    }
    out.username = v;
  }
  if (has("name")) {
    const v = typeof b.name === "string" ? b.name.trim() : "";
    if (!v) throw new HttpError(400, "Name is required");
    if (v.length > 100) throw new HttpError(400, "Name is too long (max 100)");
    out.name = v;
  }
  if (has("role")) {
    const engineering = actor.role === "ENGINEERING";
    if (!ASSIGNABLE_ROLES.includes(b.role as Role) || (b.role === "ENGINEERING" && !engineering)) {
      throw new HttpError(400, `Role must be ${engineering ? "Engineering, " : ""}Admin, Engineer or Operator`);
    }
    out.role = b.role as Role;
  }
  if (has("isActive")) out.isActive = b.isActive !== false;
  if (b.password !== undefined && b.password !== "") {
    if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
    }
    out.password = b.password;
  } else if (!partial) {
    throw new HttpError(400, "Password is required");
  }
  return out;
}

async function getRow(id: string) {
  const [rows] = await pool.query<UserRow[]>("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0];
}

/** A user the actor may manage: Engineering accounts only for Engineering accounts. */
async function managedRow(id: string, actor: Me) {
  const row = await getRow(id);
  if (!row || (row.role === "ENGINEERING" && actor.role !== "ENGINEERING")) throw new HttpError(404, "User not found");
  return row;
}

async function assertUsernameFree(username: string, excludeId = "") {
  const [rows] = await pool.query<UserRow[]>("SELECT id FROM users WHERE username = ? AND id <> ?", [username, excludeId]);
  if (rows.length) throw new HttpError(409, `Username "${username}" is already used`);
}

async function createUser(username: string, name: string, role: Role, password: string) {
  const now = new Date();
  await pool.query(
    `INSERT INTO users (id, username, name, role, password_hash, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [randomUUID(), username, name, role, await hashPassword(password), now, now]
  );
}

export const authStore = {
  /**
   * Creates the hidden Engineering account when there is none, and a first Admin on an empty user
   * table. Called at startup.
   */
  async ensureDefaults() {
    const [[{ total, engineering }]] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS total, SUM(role = 'ENGINEERING') AS engineering FROM users"
    );
    if (!Number(engineering)) {
      const username = process.env.ENGINEERING_USERNAME || "engineering";
      const password = process.env.ENGINEERING_PASSWORD || "engineering";
      await createUser(username, "Engineering", "ENGINEERING", password);
      console.log(`[auth] created Engineering account "${username}"${process.env.ENGINEERING_PASSWORD ? "" : " (default password, set ENGINEERING_PASSWORD)"}`);
    }
    if (!Number(total)) {
      await createUser("admin", "Administrator", "ADMIN", "admin123");
      console.log('[auth] created first Admin "admin" with password "admin123"; change it after logging in');
    }
  },

  async login(body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const username = typeof b.username === "string" ? b.username.trim() : "";
    const password = typeof b.password === "string" ? b.password : "";
    const [rows] = await pool.query<UserRow[]>("SELECT * FROM users WHERE username = ?", [username]);
    const row = rows[0];
    if (!row || !row.is_active || !(await verifyPassword(password, row.password_hash))) {
      throw new HttpError(401, "Wrong username or password");
    }
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    await pool.query("INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
      tokenHash(token),
      row.id,
      now,
      new Date(now.getTime() + SESSION_DAYS * 86_400_000),
    ]);
    await pool.query("UPDATE users SET last_login_at = ? WHERE id = ?", [now, row.id]);
    await pool.query("DELETE FROM user_sessions WHERE expires_at < ?", [now]);
    return { token, user: await this.me(row) };
  },

  async logout(token: string) {
    await pool.query("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash(token)]);
  },

  /** The user of a session token, or null when the token is unknown, expired or the user is inactive. */
  async userOfToken(token: string): Promise<Me | null> {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1`,
      [tokenHash(token), new Date()]
    );
    return rows[0] ? this.me(rows[0]) : null;
  },

  async me(row: UserRow): Promise<Me> {
    return { id: row.id, username: row.username, name: row.name, role: row.role, permissions: await permissionsOf(row.role) };
  },

  async changeOwnPassword(userId: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const row = await getRow(userId);
    if (!row || typeof b.currentPassword !== "string" || !(await verifyPassword(b.currentPassword, row.password_hash))) {
      throw new HttpError(400, "Current password is wrong");
    }
    if (typeof b.newPassword !== "string" || b.newPassword.length < MIN_PASSWORD) {
      throw new HttpError(400, `New password must be at least ${MIN_PASSWORD} characters`);
    }
    await pool.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
      await hashPassword(b.newPassword),
      new Date(),
      userId,
    ]);
  },

  // ---------- user management (Engineering accounts are hidden from everyone else) ----------

  async list(actor: Me): Promise<User[]> {
    const [rows] = await pool.query<UserRow[]>(
      `SELECT * FROM users ${actor.role === "ENGINEERING" ? "" : "WHERE role <> 'ENGINEERING'"} ORDER BY name`
    );
    return rows.map(toUser);
  },

  async create(body: unknown, actor: Me) {
    const d = parseUserInput(body, false, actor);
    await assertUsernameFree(d.username!);
    const id = randomUUID();
    const now = new Date();
    await pool.query(
      `INSERT INTO users (id, username, name, role, password_hash, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.username, d.name, d.role, await hashPassword(d.password!), d.isActive ?? true, now, now]
    );
    return toUser((await getRow(id))!);
  },

  async update(id: string, body: unknown, actor: Me) {
    const row = await managedRow(id, actor);
    const d = parseUserInput(body, true, actor);
    if (id === actor.id && ((d.role && d.role !== row.role) || d.isActive === false)) {
      throw new HttpError(400, "You cannot change your own role or deactivate yourself");
    }
    if (d.username) await assertUsernameFree(d.username, id);
    await pool.query(
      `UPDATE users SET username = ?, name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ? WHERE id = ?`,
      [
        d.username ?? row.username,
        d.name ?? row.name,
        d.role ?? row.role,
        d.isActive ?? !!row.is_active,
        d.password ? await hashPassword(d.password) : row.password_hash,
        new Date(),
        id,
      ]
    );
    // A deactivated user or a new password signs out everywhere.
    if (d.isActive === false || d.password) await pool.query("DELETE FROM user_sessions WHERE user_id = ?", [id]);
    return toUser((await getRow(id))!);
  },

  async remove(id: string, actor: Me) {
    await managedRow(id, actor);
    if (id === actor.id) throw new HttpError(400, "You cannot delete yourself");
    const [result] = await pool.query<ResultSetHeader>("DELETE FROM users WHERE id = ?", [id]);
    if (!result.affectedRows) throw new HttpError(404, "User not found");
  },

  rolePermissions,

  /** Drops cached role permissions after they were written elsewhere (restore). */
  clearCache() {
    rolesCache = null;
  },

  async updateRolePermissions(body: unknown) {
    const roles = parseRolePermissions(body);
    await pool.query(
      `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)`,
      [ROLES_KEY, JSON.stringify(roles), new Date()]
    );
    rolesCache = roles;
    return roles;
  },
};
