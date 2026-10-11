import type { RequestHandler } from "express";
import { dbHealth } from "../db/pool.js";
import { authStore } from "../services/auth-store.js";
import { hasGatewayKey } from "../services/gateway-manager.js";
import type { Me, Permission } from "../types/auth.js";

// The dashboard data can be read without signing in (guest view). Everything else needs a session token
// (Authorization: Bearer <token>). Reading is open to every signed-in user; changes need the permission
// of the first matching rule below. A change without a rule is for the Engineering account only.

type Method = "WRITE" | "DELETE" | "ANY";

const RULES: [Method, RegExp, Permission][] = [
  ["ANY", /^\/backup(\/|$)/, "backup.manage"],
  ["ANY", /^\/database(\/|$)/, "database.manage"],
  ["ANY", /^\/system\/(database|info|log)(\/|$)/, "database.manage"],
  ["WRITE", /^\/settings\/appearance$/, "appearance.manage"],
  ["ANY", /^\/users(\/|$)/, "users.manage"],
  ["WRITE", /^\/machines(\/|$)/, "machines.manage"],
  ["WRITE", /^\/settings\/status-definition$/, "status.manage"],
  ["WRITE", /^\/settings\/oee$/, "oee.settings"],
  ["WRITE", /^\/tag-values(\/|$)/, "simulator.use"],
  ["ANY", /^\/gateway\/(settings|status|messages|publish|mqtt)(\/|$)/, "gateway.manage"],
  ["WRITE", /^\/skus(\/|$)/, "sku.manage"],
  ["WRITE", /^\/shifts(\/|$)/, "shift.manage"],
  ["WRITE", /^\/layout(\/|$)/, "layout.manage"],
  ["WRITE", /^\/rejects\/types(\/|$)/, "reject.types"],
  ["DELETE", /^\/rejects\/[^/]+$/, "reject.edit"],
  ["WRITE", /^\/rejects(\/|$)/, "reject.submit"],
  ["DELETE", /^\/downtime\/[^/]+$/, "downtime.edit"],
  ["WRITE", /^\/downtime(\/|$)/, "downtime.submit"],
];

const PUBLIC = [/^\/health$/, /^\/auth\/login$/, /^\/system\/status$/];

/** What works while the database is down (setup mode): own session, and fixing the connection. */
const SETUP_PATHS = [/^\/auth\/(me|logout)$/, /^\/system\/(database|info|log)(\/|$)/];

/** Users of recently checked session tokens, so an Engineering user stays signed in while the database is down. */
const knownTokens = new Map<string, Me>();
const MAX_KNOWN_TOKENS = 500;

/** What the dashboards read; open to guests. */
const PUBLIC_READ = [
  /^\/machines(\/|$)/,
  /^\/oee(\/|$)/,
  /^\/shifts(\/|$)/,
  /^\/skus$/,
  /^\/layout$/,
  /^\/summary$/,
  // OEE settings carry the machine name shown on the dashboards.
  /^\/settings\/oee$/,
  // The theme applies to the dashboards too.
  /^\/settings\/appearance$/,
];

const bearer = (header: string | undefined) => /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? null;

/** The signed-in user, set by `authenticate`. */
export const currentUser = (locals: Record<string, unknown>) => locals.user as Me;

export const authenticate: RequestHandler = async (req, res, next) => {
  if (PUBLIC.some((p) => p.test(req.path))) return next();

  // A gateway may push tag readings with its API key (Gateway settings) instead of a user session.
  if (req.method === "POST" && req.path.startsWith("/tag-values") && hasGatewayKey((n) => req.get(n))) return next();

  const token = bearer(req.get("authorization"));

  if (!dbHealth.ready) {
    // Setup mode: only an Engineering session may fix the connection; everything else waits for the database.
    const known = token ? (authStore.setupUser(token) ?? knownTokens.get(token) ?? null) : null;
    const user = known?.role === "ENGINEERING" ? known : null;
    if (user && SETUP_PATHS.some((p) => p.test(req.path))) {
      res.locals.user = user;
      res.locals.token = token;
      return next();
    }
    res.status(503).json({
      error: `The database is not connected${dbHealth.error ? `: ${dbHealth.error}` : ""}`,
      code: "DB_UNAVAILABLE",
    });
    return;
  }

  let user = token ? authStore.setupUser(token) : null;
  if (token && !user) {
    user = await authStore.userOfToken(token);
    if (user) {
      if (knownTokens.size >= MAX_KNOWN_TOKENS) knownTokens.delete(knownTokens.keys().next().value!);
      knownTokens.set(token, user);
    } else knownTokens.delete(token);
  }
  if (!user && req.method === "GET" && PUBLIC_READ.some((p) => p.test(req.path))) return next();
  if (!user) {
    res.status(401).json({ error: "Please sign in" });
    return;
  }
  res.locals.user = user;
  res.locals.token = token;

  // Own account actions (logout, password) need no permission.
  if (req.path.startsWith("/auth/")) return next();

  const write = req.method !== "GET" && req.method !== "HEAD";
  const rule = RULES.find(
    ([method, path]) =>
      path.test(req.path) && (method === "ANY" || (method === "DELETE" ? req.method === "DELETE" : write))
  );
  if (!rule) {
    if (write && user.role !== "ENGINEERING") {
      res.status(403).json({ error: "This action is for the Engineering account only" });
      return;
    }
    return next();
  }
  if (!user.permissions.includes(rule[2])) {
    res.status(403).json({ error: "You do not have permission for this action" });
    return;
  }
  next();
};
