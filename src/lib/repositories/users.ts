import "server-only";

import { and, asc, desc, eq, ne, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { type UserRole } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";

/**
 * User administration data access.
 *
 * Uses the service-role database connection, so RLS does not apply here. Every
 * function in this module therefore assumes the caller has ALREADY proven it is
 * an admin via `assertAdmin()`. Do not call these from anywhere that has not.
 */

export type AdminUserListItem = {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
};

export async function listUsers(): Promise<AdminUserListItem[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .orderBy(asc(users.email));

  return rows;
}

export async function countAdmins(): Promise<number> {
  const db = getDb();

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, "admin"));

  return row?.count ?? 0;
}

export type RoleChangeOutcome =
  | { ok: true; email: string; previousRole: UserRole; newRole: UserRole }
  | { ok: false; reason: RoleChangeRejection };

export type RoleChangeRejection = "not_found" | "self_change" | "no_change" | "last_admin";

/**
 * Change a user's role and record it in the audit trail.
 *
 * Both happen in one transaction on purpose: a privilege change that is not
 * logged is worse than a privilege change that fails. If the audit insert
 * fails, the role change rolls back with it.
 *
 * Two rules are enforced here, in the database transaction, rather than in the
 * UI:
 *
 *   1. Nobody changes their own role. This blocks self-promotion and mirrors
 *      the `users_update_admin` RLS policy, so the same rule holds whether the
 *      request arrives through the server or through PostgREST.
 *   2. The last admin cannot be demoted. Otherwise a workspace can be locked
 *      out of its own administration with a single click, recoverable only by
 *      re-running the seed script against production.
 */
export async function changeUserRole(params: {
  actorId: string;
  targetUserId: string;
  newRole: UserRole;
}): Promise<RoleChangeOutcome> {
  const db = getDb();

  if (params.actorId === params.targetUserId) {
    return { ok: false, reason: "self_change" };
  }

  return db.transaction(async (tx) => {
    // Lock the row so a concurrent demotion cannot race past the last-admin
    // check and leave the workspace with zero admins.
    const [target] = await tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, params.targetUserId))
      .for("update");

    if (!target) {
      return { ok: false, reason: "not_found" } as const;
    }

    if (target.role === params.newRole) {
      return { ok: false, reason: "no_change" } as const;
    }

    if (target.role === "admin" && params.newRole !== "admin") {
      const [remaining] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, params.targetUserId)));

      if ((remaining?.count ?? 0) === 0) {
        return { ok: false, reason: "last_admin" } as const;
      }
    }

    await tx.update(users).set({ role: params.newRole }).where(eq(users.id, params.targetUserId));

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.userRoleChanged,
      entityType: AUDIT_ENTITY_TYPES.user,
      entityId: params.targetUserId,
      metadataJson: {
        targetEmail: target.email,
        previousRole: target.role,
        newRole: params.newRole,
      },
    });

    return {
      ok: true,
      email: target.email,
      previousRole: target.role,
      newRole: params.newRole,
    } as const;
  });
}

export type AuditLogListItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  createdAt: Date;
  actorEmail: string | null;
};

/** Recent audit entries, newest first. Admin-only by RLS and by guard. */
export async function listRecentAuditLogs(limit = 25): Promise<AuditLogListItem[]> {
  const db = getDb();

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadataJson,
      createdAt: auditLogs.createdAt,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  return rows;
}
