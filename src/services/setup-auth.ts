import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Me } from "../types/auth.js";

/**
 * Login while the database is unavailable ("setup mode"), so the connection can be fixed from the UI.
 * Only Engineering accounts can log in: their password hashes are copied to a local file whenever the
 * database is up. Before that has ever happened, ENGINEERING_USERNAME / ENGINEERING_PASSWORD from .env
 * (default engineering / engineering) are accepted.
 * Setup sessions live in memory and end when the backend restarts.
 */

const FILE = resolve(process.env.RECOVERY_FILE ?? "config/recovery.json");

export interface RecoveryLogin {
  username: string;
  name: string;
  passwordHash: string;
}

const sessions = new Map<string, Me>();
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function saveRecoveryLogins(logins: RecoveryLogin[]) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(logins, null, 2));
  } catch (err) {
    console.error("[auth] cannot write recovery logins:", (err as Error).message);
  }
}

export function recoveryLogins(): RecoveryLogin[] | null {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as RecoveryLogin[];
  } catch {
    return null;
  }
}

export const setupSessions = {
  create(username: string, name: string): { token: string; user: Me } {
    const token = randomBytes(32).toString("hex");
    const user: Me = { id: `setup:${username}`, username, name: `${name} (setup mode)`, role: "ENGINEERING", permissions: [] };
    sessions.set(tokenHash(token), user);
    return { token, user };
  },
  get: (token: string) => sessions.get(tokenHash(token)) ?? null,
  remove: (token: string) => sessions.delete(tokenHash(token)),
};
