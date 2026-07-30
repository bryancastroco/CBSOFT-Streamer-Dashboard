/**
 * Roles and the permission matrix.
 *
 * Pure module — no imports, no I/O, safe on both the client and the server.
 * The client may use it to hide controls; the server uses it to decide. Hiding
 * a button is a courtesy, never a control.
 */

export const USER_ROLES = ["admin", "viewer"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * Every capability in the system. Adding one here without adding it to
 * `ROLE_PERMISSIONS` makes it deny-by-default for every role, which is the
 * behaviour we want from a half-finished feature.
 */
export const PERMISSIONS = [
  "dashboard.view",
  "reports.view",
  "posts.view",
  "videos.view",
  "analysis.view",
  "streamers.view",
  "streamers.manage",
  "tokens.manage",
  "sync.trigger",
  "sync.view_errors",
  "users.manage",
  "settings.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ADMIN_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * Viewers read dashboards and reports. They may see the streamer roster, but
 * nothing about tokens, and they may not trigger or inspect administrative
 * operations.
 */
const VIEWER_PERMISSIONS: readonly Permission[] = [
  "dashboard.view",
  "reports.view",
  "posts.view",
  "videos.view",
  "analysis.view",
  "streamers.view",
];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  admin: ADMIN_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

/** Does this role hold this permission? The single source of truth for RBAC. */
export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isAdmin(role: UserRole): boolean {
  return role === "admin";
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin:
    "Full access: manage streamers and Page tokens, trigger synchronisation, view sync errors, manage users and settings.",
  viewer: "Read-only access to dashboards and reports. Cannot manage or trigger anything.",
};
