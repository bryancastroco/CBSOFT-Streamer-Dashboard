import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_ROLES,
  can,
  isAdmin,
  isUserRole,
  type Permission,
} from "@/lib/auth/roles";

/** Capabilities the Phase 2 specification reserves for admins. */
const ADMIN_ONLY: readonly Permission[] = [
  "streamers.manage",
  "tokens.manage",
  "sync.trigger",
  "sync.view_errors",
  "users.manage",
  "settings.manage",
  "audit.view",
];

/** Capabilities a viewer is explicitly granted. */
const VIEWER_ALLOWED: readonly Permission[] = [
  "dashboard.view",
  "reports.view",
  "posts.view",
  "videos.view",
  "analysis.view",
  "streamers.view",
];

describe("role definitions", () => {
  it("has exactly the two roles the specification defines", () => {
    expect([...USER_ROLES]).toEqual(["admin", "viewer"]);
  });

  it("recognises valid roles and rejects everything else", () => {
    expect(isUserRole("admin")).toBe(true);
    expect(isUserRole("viewer")).toBe(true);

    expect(isUserRole("manager")).toBe(false);
    expect(isUserRole("superuser")).toBe(false);
    expect(isUserRole("")).toBe(false);
    expect(isUserRole(null)).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
    expect(isUserRole({ role: "admin" })).toBe(false);
  });

  it("identifies admins", () => {
    expect(isAdmin("admin")).toBe(true);
    expect(isAdmin("viewer")).toBe(false);
  });
});

describe("permission matrix", () => {
  it("gives an admin full access", () => {
    for (const permission of PERMISSIONS) {
      expect(can("admin", permission)).toBe(true);
    }
  });

  it("gives a viewer read access to dashboards and reports", () => {
    for (const permission of VIEWER_ALLOWED) {
      expect(can("viewer", permission)).toBe(true);
    }
  });

  it("denies a viewer every administrative capability", () => {
    for (const permission of ADMIN_ONLY) {
      expect(can("viewer", permission)).toBe(false);
    }
  });

  it("keeps a viewer away from streamer and token management specifically", () => {
    // Called out separately because these are the two the specification names.
    expect(can("viewer", "streamers.manage")).toBe(false);
    expect(can("viewer", "tokens.manage")).toBe(false);
    expect(can("viewer", "sync.trigger")).toBe(false);
  });

  it("covers every declared permission, so none is silently unassigned", () => {
    const assigned = new Set([...ADMIN_ONLY, ...VIEWER_ALLOWED]);
    expect([...PERMISSIONS].sort()).toEqual([...assigned].sort());
  });

  it("grants no permission outside the declared set", () => {
    for (const role of USER_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});
