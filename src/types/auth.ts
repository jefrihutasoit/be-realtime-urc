// Keep in sync with oee-realtime-urc/src/types/auth.ts

/** ENGINEERING is the hidden maintenance account: never listed, created from the backend environment. */
export type Role = "ENGINEERING" | "ADMIN" | "ENGINEER" | "OPERATOR";

/** Roles that can be given to users and configured in User Management. */
export const MANAGED_ROLES = ["ADMIN", "ENGINEER", "OPERATOR"] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ENGINEERING: "Engineering",
  ADMIN: "Admin",
  ENGINEER: "Engineer",
  OPERATOR: "Operator",
};

/** Permissions that can be given to the managed roles. The dashboard is open to every user. */
export const PERMISSIONS = [
  { key: "reject.submit", group: "Reject", label: "Submit reject (upload, manual input)" },
  { key: "reject.edit", group: "Reject", label: "Edit / delete reject data" },
  { key: "reject.types", group: "Reject", label: "Manage reject types" },
  { key: "downtime.submit", group: "Downtime", label: "Upload downtime" },
  { key: "downtime.edit", group: "Downtime", label: "Edit / delete downtime" },
  { key: "sku.manage", group: "Master data", label: "Manage SKU" },
  { key: "shift.manage", group: "Settings", label: "Shift management" },
  { key: "layout.manage", group: "Settings", label: "Layout mapping" },
  { key: "oee.settings", group: "Settings", label: "OEE calculation" },
  { key: "users.manage", group: "Users", label: "User management & roles" },
] as const;

/**
 * Only the Engineering account has these: machine settings, status definition, settings backup & restore,
 * simulator, and database backup / restore / initialize / clear.
 */
export const ENGINEERING_PERMISSIONS = [
  "machines.manage",
  "status.manage",
  "backup.manage",
  "simulator.use",
  "database.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"] | (typeof ENGINEERING_PERMISSIONS)[number];
export type RolePermissions = Record<ManagedRole, Permission[]>;

/** Admin always keeps user management, so the roles can always be fixed again. */
export const FIXED_PERMISSIONS: Partial<Record<ManagedRole, Permission[]>> = { ADMIN: ["users.manage"] };

export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  ADMIN: PERMISSIONS.map((p) => p.key),
  ENGINEER: ["reject.submit", "reject.edit", "downtime.submit", "downtime.edit", "shift.manage"],
  OPERATOR: ["reject.submit", "downtime.submit"],
};

/** Roles a user can be given: the managed roles, and Engineering only by an Engineering account. */
export const ASSIGNABLE_ROLES: Role[] = ["ENGINEERING", ...MANAGED_ROLES];

export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserInput {
  username: string;
  name: string;
  role: Role;
  isActive: boolean;
  /** Required for a new user; leave out to keep the password. */
  password?: string;
}

/** The signed-in user. */
export interface Me {
  id: string;
  username: string;
  name: string;
  role: Role;
  permissions: Permission[];
}

export interface LoginResult {
  token: string;
  user: Me;
}
