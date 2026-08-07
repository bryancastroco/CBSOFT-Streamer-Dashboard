import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invitation tokens and the state they express — a PURE module.
 *
 * No database, no framework. The interesting decisions here are about what an
 * invitation *is*, and they are worth testing without a connection.
 */

/**
 * 256 bits, base64url.
 *
 * The link is a bearer credential: whoever holds it can attach a Facebook Page
 * to this workspace. It therefore has to be unguessable in the same sense a
 * session token is — 32 random bytes, not a uuid, which carries version and
 * variant bits and is generated for uniqueness rather than secrecy.
 *
 * base64url so it survives being pasted into a chat message, an email, or a
 * URL bar without escaping.
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What gets stored.
 *
 * SHA-256 rather than a password hash, deliberately. A password hash is slow to
 * defeat dictionary attacks on low-entropy secrets; this secret has 256 bits of
 * entropy and no dictionary, so the slowness would buy nothing and cost a
 * deliberate delay on every page load.
 */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison, for anywhere two hashes are checked directly. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length. Checking first and returning false is the safe shape.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * How long a link lives.
 *
 * Long enough to survive a weekend and a streamer who reads messages on Monday;
 * short enough that a link forwarded into a group chat six months ago is no
 * longer a way in. An admin can always issue another — the cost of expiry is one
 * click, and the cost of no expiry is a credential with no end date.
 *
 * Three days was considered after the first batch went out and rejected: the
 * requirement is a floor, not a target, and a link that dies while a streamer
 * is away costs an admin a re-issue and the streamer a second explanation.
 * Fourteen clears the floor comfortably.
 *
 * Changing it affects only new invitations. `expires_at` is written per row
 * when the link is minted, so anything already sent keeps the window it was
 * issued with — there is no back-dating and no migration to write.
 */
export const INVITATION_TTL_DAYS = 14;

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The user token is held only between the callback and the Page choice.
 *
 * Fifteen minutes is far longer than choosing from a list takes, and far
 * shorter than the sixty days Meta grants a long-lived user token. The stored
 * credential should not outlive the reason it was stored.
 */
export const USER_TOKEN_HOLD_MINUTES = 15;

export function userTokenHoldExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + USER_TOKEN_HOLD_MINUTES * 60 * 1000);
}

export type InvitationStatus = "pending" | "opened" | "connected" | "revoked";

/**
 * What an invitation is *right now*, including the state nothing writes.
 *
 * `expired` is derived rather than stored: a stored value would need a job to
 * set it, and until that job ran the table would disagree with the clock. Every
 * reader asks this function instead, so there is one answer.
 */
export type EffectiveStatus = InvitationStatus | "expired";

export function effectiveStatus(params: {
  status: string;
  expiresAt: Date;
  now?: Date;
}): EffectiveStatus {
  const now = params.now ?? new Date();

  // Both terminal states outrank expiry. A connected invitation stays
  // connected — the link is spent, not stale — and a revoked one was ended
  // deliberately, which is a more useful thing to show than "expired".
  if (params.status === "connected") return "connected";
  if (params.status === "revoked") return "revoked";

  if (params.expiresAt.getTime() <= now.getTime()) return "expired";

  return params.status === "opened" ? "opened" : "pending";
}

/** Whether the link can still be used to connect a Page. */
export function isUsable(params: { status: string; expiresAt: Date; now?: Date }): boolean {
  const state = effectiveStatus(params);
  return state === "pending" || state === "opened";
}

export const INVITATION_STATUS_LABELS: Record<EffectiveStatus, string> = {
  pending: "Not opened yet",
  opened: "Opened, not finished",
  connected: "Connected",
  expired: "Expired",
  revoked: "Revoked",
};

/**
 * Why a link stopped working, in words the streamer can act on.
 *
 * Deliberately does not distinguish "no such invitation" from "wrong token":
 * telling an unauthenticated visitor which of those it was turns the page into
 * an oracle for guessing valid links.
 */
export function unusableReason(state: EffectiveStatus): string {
  switch (state) {
    case "connected":
      return "This link has already been used. Ask CBSOFT for a new one if you need to reconnect.";
    case "expired":
      return "This link has expired. Ask CBSOFT to send you a new one.";
    case "revoked":
      return "This link was cancelled. Ask CBSOFT to send you a new one.";
    default:
      return "This link is no longer valid. Ask CBSOFT to send you a new one.";
  }
}
