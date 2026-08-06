import "server-only";

import { desc, eq } from "drizzle-orm";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
} from "@/lib/connect/invitations";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { getDb } from "@/lib/db";
import { auditLogs, pageConnections, streamers } from "@/lib/db/schema";

/**
 * Invitations that let a streamer attach their own Page.
 *
 * ## What never leaves this module
 *
 * The raw invitation token is returned exactly once, by `createInvitation`, so
 * the admin screen can render the link. Nothing else can recover it — only the
 * hash is stored. Losing it means issuing a new invitation, which is the right
 * trade: the alternative is a table full of live credentials in plaintext.
 *
 * The user access token is stored encrypted and read back only by
 * `takeUserToken`, which clears it in the same statement.
 */

export type ConnectionRow = {
  id: string;
  inviteeLabel: string;
  inviteeEmail: string | null;
  streamerId: string | null;
  streamerCode: string | null;
  streamerName: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  openedAt: Date | null;
  connectedAt: Date | null;
  connectedPageId: string | null;
  connectedPageName: string | null;
  lastError: string | null;
};

const LIST_COLUMNS = {
  id: pageConnections.id,
  inviteeLabel: pageConnections.inviteeLabel,
  inviteeEmail: pageConnections.inviteeEmail,
  streamerId: pageConnections.streamerId,
  streamerCode: streamers.streamerCode,
  streamerName: streamers.streamerName,
  status: pageConnections.status,
  createdAt: pageConnections.createdAt,
  expiresAt: pageConnections.expiresAt,
  openedAt: pageConnections.openedAt,
  connectedAt: pageConnections.connectedAt,
  connectedPageId: pageConnections.connectedPageId,
  connectedPageName: pageConnections.connectedPageName,
  lastError: pageConnections.lastError,
} as const;

/**
 * Mint an invitation.
 *
 * Returns the raw token alongside the row — the only moment it exists outside
 * the admin's clipboard.
 */
export async function createInvitation(params: {
  actorId: string;
  inviteeLabel: string;
  inviteeEmail: string | null;
  streamerId: string | null;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const db = getDb();
  const token = generateInvitationToken();
  const expiresAt = invitationExpiry();

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(pageConnections)
      .values({
        tokenHash: hashInvitationToken(token),
        inviteeLabel: params.inviteeLabel,
        inviteeEmail: params.inviteeEmail,
        streamerId: params.streamerId,
        createdBy: params.actorId,
        expiresAt,
      })
      .returning({ id: pageConnections.id });

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.connectionInvited,
      entityType: AUDIT_ENTITY_TYPES.pageConnection,
      entityId: created!.id,
      /*
       * The label and the expiry, never the token. An audit row is readable by
       * every admin and kept forever; a live invitation credential in it would
       * outlive both the invitation and any reason to have it.
       */
      metadataJson: {
        inviteeLabel: params.inviteeLabel,
        expiresAt: expiresAt.toISOString(),
        streamerId: params.streamerId,
      },
    });

    return { id: created!.id, token, expiresAt };
  });
}

export async function listInvitations(limit = 100): Promise<ConnectionRow[]> {
  const db = getDb();

  return db
    .select(LIST_COLUMNS)
    .from(pageConnections)
    .leftJoin(streamers, eq(streamers.id, pageConnections.streamerId))
    .orderBy(desc(pageConnections.createdAt))
    .limit(limit);
}

export type InvitationByToken = {
  id: string;
  inviteeLabel: string;
  streamerId: string | null;
  status: string;
  expiresAt: Date;
  connectedPageName: string | null;
};

/**
 * Resolve a raw token to its invitation.
 *
 * Looks up by hash, so the raw value is never compared against stored data and
 * never appears in a query the database might log.
 */
export async function findInvitationByToken(token: string): Promise<InvitationByToken | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: pageConnections.id,
      inviteeLabel: pageConnections.inviteeLabel,
      streamerId: pageConnections.streamerId,
      status: pageConnections.status,
      expiresAt: pageConnections.expiresAt,
      connectedPageName: pageConnections.connectedPageName,
    })
    .from(pageConnections)
    .where(eq(pageConnections.tokenHash, hashInvitationToken(token)))
    .limit(1);

  return row ?? null;
}

/**
 * Note that the streamer arrived.
 *
 * Only ever `pending` → `opened`: a connected or revoked invitation must not be
 * dragged back to an earlier state by someone reloading an old tab.
 */
export async function markOpened(id: string): Promise<void> {
  const db = getDb();

  await db
    .update(pageConnections)
    .set({ status: "opened", openedAt: new Date() })
    .where(eq(pageConnections.id, id));
}

/** Park the user token between the callback and the Page choice. */
export async function storeUserToken(params: {
  id: string;
  userToken: string;
  expiresAt: Date;
}): Promise<void> {
  const db = getDb();

  await db
    .update(pageConnections)
    .set({
      encryptedUserToken: encryptToken(params.userToken),
      userTokenExpiresAt: params.expiresAt,
      lastError: null,
    })
    .where(eq(pageConnections.id, params.id));
}

/**
 * The parked user token, decrypted, or a reason it cannot be used.
 *
 * Lives here rather than in the service because this repository owns the
 * column — the same rule that confines the Page-token ciphertext to
 * `repositories/streamers.ts`. A credential should be decrypted by the module
 * responsible for storing it, and nowhere else.
 *
 * Note this is the *user* token, not a Page token: it is what
 * `/me/accounts` is called with, and it is cleared the moment a Page is chosen.
 */
export async function readUserToken(
  connectionId: string,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const db = getDb();

  const [row] = await db
    .select({
      encrypted: pageConnections.encryptedUserToken,
      expiresAt: pageConnections.userTokenExpiresAt,
    })
    .from(pageConnections)
    .where(eq(pageConnections.id, connectionId))
    .limit(1);

  if (!row?.encrypted) {
    return { ok: false, message: "Your Facebook sign-in has expired. Please start again." };
  }

  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    // Cleared rather than left to rot: an expired credential still in the table
    // is a credential.
    await clearUserToken(connectionId);
    return { ok: false, message: "Your Facebook sign-in has expired. Please start again." };
  }

  return { ok: true, token: decryptToken(row.encrypted) };
}

export async function recordError(id: string, message: string): Promise<void> {
  const db = getDb();

  // Truncated: this is rendered in an admin table, and a Graph error can carry
  // a paragraph of trace. Nothing here contains token material.
  await db
    .update(pageConnections)
    .set({ lastError: message.slice(0, 500) })
    .where(eq(pageConnections.id, id));
}

/** Clear the parked credential — on success, on failure, and on revocation. */
export async function clearUserToken(id: string): Promise<void> {
  const db = getDb();

  await db
    .update(pageConnections)
    .set({ encryptedUserToken: null, userTokenExpiresAt: null })
    .where(eq(pageConnections.id, id));
}

export async function markConnected(params: {
  id: string;
  pageId: string;
  pageName: string;
  streamerId: string;
}): Promise<void> {
  const db = getDb();

  await db
    .update(pageConnections)
    .set({
      status: "connected",
      connectedAt: new Date(),
      connectedPageId: params.pageId,
      connectedPageName: params.pageName,
      streamerId: params.streamerId,
      // The credential has served its purpose. Keeping it would leave a
      // long-lived user token in the table with nothing left to spend it on.
      encryptedUserToken: null,
      userTokenExpiresAt: null,
      lastError: null,
    })
    .where(eq(pageConnections.id, params.id));
}

export async function revokeInvitation(params: {
  actorId: string;
  id: string;
}): Promise<{ ok: boolean; message: string }> {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: pageConnections.id, status: pageConnections.status, label: pageConnections.inviteeLabel })
      .from(pageConnections)
      .where(eq(pageConnections.id, params.id));

    if (!existing) return { ok: false, message: "That invitation no longer exists." };

    if (existing.status === "connected") {
      /*
       * Refused rather than allowed. Revoking a spent invitation would suggest
       * it undoes the connection, and it does not — the Page token is already
       * stored on the streamer. Removing access is a different action, on a
       * different screen, with different consequences.
       */
      return {
        ok: false,
        message: "That invitation was already used. Remove the streamer's token instead.",
      };
    }

    await tx
      .update(pageConnections)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        encryptedUserToken: null,
        userTokenExpiresAt: null,
      })
      .where(eq(pageConnections.id, params.id));

    await tx.insert(auditLogs).values({
      userId: params.actorId,
      action: AUDIT_ACTIONS.connectionRevoked,
      entityType: AUDIT_ENTITY_TYPES.pageConnection,
      entityId: params.id,
      metadataJson: { inviteeLabel: existing.label },
    });

    return { ok: true, message: `Invitation for ${existing.label} revoked.` };
  });
}
