import "server-only";

import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { type UserRole } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
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
  /** Null when the account is active. */
  deactivatedAt: Date | null;
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
      deactivatedAt: users.deactivatedAt,
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
    .where(and(eq(users.role, "admin"), isNull(users.deactivatedAt)));

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
        .where(
          and(
            eq(users.role, "admin"),
            ne(users.id, params.targetUserId),
            // A deactivated admin cannot administer anything, so it must not
            // count as the one keeping the workspace reachable.
            isNull(users.deactivatedAt),
          ),
        );

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

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export type ActivationRejection = "not_found" | "self_change" | "no_change" | "last_admin";

export type ActivationOutcome =
  | { ok: true; email: string; active: boolean }
  | { ok: false; reason: ActivationRejection };

/**
 * Switch an account off, or back on.
 *
 * Deliberately not a delete. `audit_logs.user_id` references this table, and
 * the trail has to outlive the person — "who promoted this account to admin"
 * must stay answerable after they leave. Destroying the row would either take
 * the history with it or leave dangling references.
 *
 * The same two rules as a role change, for the same reasons, plus the fact
 * that deactivating is a *stronger* action than demoting: it removes every
 * capability rather than some.
 *
 *   1. Nobody deactivates themselves. Locking yourself out with one click is
 *      not a thing an interface should offer.
 *   2. The last active admin cannot be switched off — that is the same
 *      workspace lockout as demoting them, reachable only by re-running the
 *      seed script against production.
 *
 * Reactivation needs no such guard: restoring access can never lock anyone out.
 */
export async function setUserActive(params: {
  actorId: string;
  targetUserId: string;
  active: boolean;
}): Promise<ActivationOutcome> {
  const db = getDb();

  if (params.actorId === params.targetUserId) {
    return { ok: false, reason: "self_change" };
  }

  return db.transaction(async (tx) => {
    // Locked, so a concurrent deactivation cannot race past the last-admin
    // check and leave the workspace with nobody who can administer it.
    const [target] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        deactivatedAt: users.deactivatedAt,
      })
      .from(users)
      .where(eq(users.id, params.targetUserId))
      .for("update");

    if (!target) return { ok: false, reason: "not_found" } as const;

    const currentlyActive = target.deactivatedAt === null;
    if (currentlyActive === params.active) {
      return { ok: false, reason: "no_change" } as const;
    }

    if (!params.active && target.role === "admin") {
      const [remaining] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            eq(users.role, "admin"),
            ne(users.id, params.targetUserId),
            isNull(users.deactivatedAt),
          ),
        );

      if ((remaining?.count ?? 0) === 0) {
        return { ok: false, reason: "last_admin" } as const;
      }
    }

    await tx
      .update(users)
      .set({ deactivatedAt: params.active ? null : new Date() })
      .where(eq(users.id, params.targetUserId));

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: params.active ? AUDIT_ACTIONS.userReactivated : AUDIT_ACTIONS.userDeactivated,
      entityType: AUDIT_ENTITY_TYPES.user,
      entityId: params.targetUserId,
      metadataJson: { targetEmail: target.email, role: target.role },
    });

    return { ok: true, email: target.email, active: params.active } as const;
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type InviteRejection = "already_exists" | "invite_failed";

export type InviteOutcome =
  | { ok: true; email: string; role: UserRole; userId: string }
  | { ok: false; reason: InviteRejection; message: string };

/**
 * Invite someone by email.
 *
 * Supabase sends the email and owns the credential entirely — the invitee sets
 * their own password through a link, and this application never sees, stores or
 * transmits one. That is the whole reason invitation is the right primitive
 * here rather than "create a user with a password".
 *
 * A profile row appears by database trigger the moment the auth user is
 * created, always with role `viewer`. So an admin invite is two steps, and the
 * order matters: the account exists as a viewer first and is promoted second,
 * which means a failure between them leaves the weaker account rather than a
 * stronger one.
 */
export async function inviteUser(params: {
  actorId: string;
  email: string;
  fullName: string | null;
  role: UserRole;
}): Promise<InviteOutcome> {
  const db = getDb();
  const email = params.email.trim().toLowerCase();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (existing) {
    return {
      ok: false,
      reason: "already_exists",
      message: "Someone with that email address is already in this workspace.",
    };
  }

  const admin = createSupabaseAdminClient();

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    ...(params.fullName ? { data: { full_name: params.fullName } } : {}),
  });

  if (error || !data?.user) {
    /*
     * Meaningful to an operator without leaking anything. The common causes
     * are a mail provider that is not configured and Supabase's own hourly
     * limit on invitations, and both need saying rather than "failed".
     */
    return {
      ok: false,
      reason: "invite_failed",
      message: error?.message ?? "Supabase did not return a user for that invitation.",
    };
  }

  const userId = data.user.id;

  /*
   * The trigger provisions the profile, but this does not assume it ran — a
   * missing row here would mean an invited person who cannot sign in, and the
   * insert costs nothing when it is already there.
   */
  await db
    .insert(users)
    .values({
      id: userId,
      email,
      fullName: params.fullName,
      role: "viewer",
    })
    .onConflictDoNothing();

  if (params.role === "admin") {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
  }

  await db.insert(auditLogs).values({
    userId: params.actorId,
    action: AUDIT_ACTIONS.userInvited,
    entityType: AUDIT_ENTITY_TYPES.user,
    entityId: userId,
    metadataJson: { targetEmail: email, role: params.role },
  });

  return { ok: true, email, role: params.role, userId };
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
