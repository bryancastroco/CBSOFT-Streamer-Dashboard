import "server-only";

import { auditLogs } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import type { AuditAction, AuditEntityType } from "@/lib/audit/actions";

/**
 * Append to the audit trail.
 *
 * Written with the service-role database connection, because `audit_logs` has
 * no INSERT policy for any client role — the trail must not be writable from
 * the browser, and it is enforced append-only by trigger, so nothing here can
 * later be rewritten.
 *
 * Never put a token, a secret, a password or a raw request body in `metadata`.
 */
export type AuditEntry = {
  /** The acting user, or null for machine actors (cron, n8n). */
  userId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordAuditLog(entry: AuditEntry): Promise<void> {
  const db = getDb();

  await db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadataJson: entry.metadata ?? {},
  });
}

/**
 * Audit writes must never take down the operation they describe.
 *
 * Used for advisory events such as sign-in. For security-critical events —
 * a role change — call `recordAuditLog` directly inside the transaction so a
 * failed write fails the whole operation. An unlogged privilege change is
 * worse than a failed privilege change.
 */
export async function recordAuditLogSafe(entry: AuditEntry): Promise<void> {
  try {
    await recordAuditLog(entry);
  } catch (error) {
    console.error("[audit] failed to record entry", {
      action: entry.action,
      entityType: entry.entityType,
      // The error message only — never the entry metadata, which may be large.
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}
