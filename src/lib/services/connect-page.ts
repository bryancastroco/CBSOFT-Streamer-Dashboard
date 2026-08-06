import "server-only";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLog } from "@/lib/audit/log";
import { listManagedPages, toChoice, type PageChoice } from "@/lib/meta/oauth";
import { validatePageToken } from "@/lib/meta/token-validation";
import {
  markConnected,
  readUserToken,
  recordError,
} from "@/lib/repositories/page-connections";
import { attachConnectedPageToken } from "@/lib/repositories/streamers";

/**
 * Turning an approved Facebook sign-in into a stored Page token.
 *
 * ## What this file deliberately does not do
 *
 * Encrypt, decrypt, or touch a token column. Both credentials are owned by the
 * repository that stores them — the user token by `page-connections`, the Page
 * token by `streamers` — and `tests/token-containment.test.ts` fails the build
 * if that stops being true. This is orchestration: ask Meta, check the answer,
 * hand it to the repository.
 *
 * The plaintext Page token exists here as a local for the length of one
 * validation call, which is the same exposure a manually pasted one has.
 *
 * ## Why `/me/accounts` is called twice
 *
 * The OAuth callback knows *who* signed in but not *which* of their Pages they
 * mean, so the choice is a second step. Between the two, only the user token is
 * held — encrypted, for fifteen minutes.
 *
 * The alternative would be holding the Page tokens from the first call in a
 * session, or worse handing them to the browser to be posted back. Architecture
 * rule 5 says a Page token never reaches the browser; this is how that stays
 * true while still letting the streamer choose. The selection posts back a Page
 * id and nothing else, and that id is checked against what Meta says they
 * administer, so a forged one attaches nothing.
 */

/**
 * The Pages this invitation may attach, safe to render.
 *
 * `toChoice` drops the token before the value leaves this function, so the type
 * the page renders has no field one could hide in.
 */
export async function listConnectablePages(
  connectionId: string,
): Promise<{ ok: true; pages: PageChoice[] } | { ok: false; message: string }> {
  const held = await readUserToken(connectionId);
  if (!held.ok) return held;

  const result = await listManagedPages(held.token);
  if (!result.ok) {
    await recordError(connectionId, result.message);
    return { ok: false, message: result.message };
  }

  return { ok: true, pages: result.data.map(toChoice) };
}

export type ConnectOutcome =
  | { ok: true; pageName: string; tokenStatus: string; warning: string | null }
  | { ok: false; message: string };

/**
 * Attach the chosen Page.
 *
 * The token takes the same path a manually entered one does — validated against
 * the Page it claims to belong to, then stored by the streamer repository — so
 * there is one story about how a credential got there, and one place to read it.
 */
export async function connectChosenPage(params: {
  connectionId: string;
  inviteeLabel: string;
  streamerId: string | null;
  pageId: string;
}): Promise<ConnectOutcome> {
  const held = await readUserToken(params.connectionId);
  if (!held.ok) return held;

  const listed = await listManagedPages(held.token);
  if (!listed.ok) {
    await recordError(params.connectionId, listed.message);
    return { ok: false, message: listed.message };
  }

  /*
   * The chosen id is looked up in Meta's own answer rather than trusted.
   *
   * The selection arrives from a browser on a public page, so it is attacker
   * controlled. Finding it here proves the Page is one this person actually
   * administers and that the token is the one Meta issued for it — a forged id
   * simply matches nothing.
   */
  const chosen = listed.data.find((page) => page.id === params.pageId);
  if (!chosen) {
    return { ok: false, message: "That Page is not one your Facebook account manages." };
  }

  const validation = await validatePageToken({
    token: chosen.accessToken,
    expectedPageId: chosen.id,
  });

  // `invalid` is the one status worth refusing: it means the token does not
  // belong to the Page it claims. Everything else — expiring, under-scoped — is
  // still the right token and is stored so the admin can see it needs work.
  if (validation.status === "invalid") {
    await recordError(params.connectionId, validation.message);
    return { ok: false, message: validation.message };
  }

  const attached = await attachConnectedPageToken({
    streamerId: params.streamerId,
    fallbackName: params.inviteeLabel,
    pageId: chosen.id,
    pageName: chosen.name,
    token: chosen.accessToken,
    validation,
  });

  // A refusal here means the choice conflicts with the roster — the Page
  // belongs to a different streamer, or the invitation was for another Page.
  // Recorded so an admin sees why the streamer stalled rather than being told
  // only that they did.
  if (!attached.ok) {
    await recordError(params.connectionId, attached.message);
    return { ok: false, message: attached.message };
  }

  const streamerId = attached.streamerId;

  await recordAuditLog({
    userId: null,
    action: AUDIT_ACTIONS.connectionCompleted,
    entityType: AUDIT_ENTITY_TYPES.pageConnection,
    entityId: params.connectionId,
    metadata: { pageId: chosen.id, pageName: chosen.name, streamerId },
  });

  await markConnected({
    id: params.connectionId,
    pageId: chosen.id,
    pageName: chosen.name,
    streamerId,
  });

  return {
    ok: true,
    pageName: chosen.name,
    tokenStatus: validation.status,
    /*
     * A token that works but is missing a permission is still worth storing —
     * it syncs some things — but the streamer is the only person who can grant
     * the rest, and they are on the screen right now. Saying so here is far
     * cheaper than an admin noticing an empty metric next week.
     */
    warning: validation.status === "valid" ? null : validation.message,
  };
}
