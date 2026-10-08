import type { RequestHandler } from "express";
import { authStore } from "../services/auth-store.js";
import type { Me, Permission } from "../types/auth.js";

// The dashboard data can be read without signing in (guest view). Everything else needs a session token
// (Authorization: Bearer <token>). Reading is open to every signed-in user; changes need the permission
// of the first matching rule below. A change without a rule is for the Engineering account only.

type Method = "WRITE" | "DELETE" | "ANY";

const RULES: [Method, RegExp, Permission][] = [
  ["ANY", /^\/backup(\/|$)/, "backup.manage"],
  ["ANY", /^\/database(\/|$)/, "database.manage"],
  ["ANY", /^\/users(\/|$)/, "users.manage"],
  ["WRITE", /^\/machines(\/|$)/, "machines.manage"],
  ["WRITE", /^\/settings\/status-definition$/, "status.manage"],
  ["WRITE", /^\/settings\/oee$/, "oee.settings"],
  ["WRITE", /^\/tag-values(\/|$)/, "simulator.use"],
  ["WRITE", /^\/skus(\/|$)/, "sku.manage"],
  ["WRITE", /^\/shifts(\/|$)/, "shift.manage"],
  ["WRITE", /^\/layout(\/|$)/, "layout.manage"],
  ["WRITE", /^\/rejects\/types(\/|$)/, "reject.types"],
  ["DELETE", /^\/rejects\/[^/]+$/, "reject.edit"],
  ["WRITE", /^\/rejects(\/|$)/, "reject.submit"],
  ["DELETE", /^\/downtime\/[^/]+$/, "downtime.edit"],
  ["WRITE", /^\/downtime(\/|$)/, "downtime.submit"],
];

const PUBLIC = [/^\/health$/, /^\/auth\/login$/];

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
];

const bearer = (header: string | undefined) => /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? null;

/** The signed-in user, set by `authenticate`. */
export const currentUser = (locals: Record<string, unknown>) => locals.user as Me;

export const authenticate: RequestHandler = async (req, res, next) => {
  if (PUBLIC.some((p) => p.test(req.path))) return next();

  // A gateway may push tag readings with a shared key instead of a user session.
  const gatewayKey = process.env.GATEWAY_API_KEY;
  if (gatewayKey && req.path.startsWith("/tag-values") && req.get("x-gateway-key") === gatewayKey) return next();

  const token = bearer(req.get("authorization"));
  const user = token ? await authStore.userOfToken(token) : null;
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
