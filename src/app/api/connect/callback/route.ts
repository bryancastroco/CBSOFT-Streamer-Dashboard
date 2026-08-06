import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/config/app-origin";
import { isUsable, userTokenHoldExpiry } from "@/lib/connect/invitations";
import { secureCompare } from "@/lib/crypto/tokens";
import { connectRedirectUri, exchangeCodeForUserToken, exchangeForLongLivedUserToken } from "@/lib/meta/oauth";
import { findInvitationByToken, recordError, storeUserToken } from "@/lib/repositories/page-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connect/callback — where Facebook returns the streamer.
 *
 * The one URL that must be listed under "Valid OAuth Redirect URIs" in the Meta
 * app dashboard, and it is built by `connectRedirectUri` so the value sent to
 * the dialog and the value sent to the token exchange cannot drift.
 *
 * Everything credential-shaped happens here, server-side: the browser carries a
 * one-time `code` that is worthless without the app secret, and leaves with a
 * redirect. No token is ever written to the response.
 */

const COOKIE = "connect_state";

/** Back to the invitation page, which knows how to explain itself. */
function backToInvitation(origin: string, token: string, error?: string): NextResponse {
  const url = new URL(`${origin}/connect/${encodeURIComponent(token)}`);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: Request) {
  const origin = resolveAppOrigin();
  const url = new URL(request.url);

  const store = await cookies();
  const cookieValue = store.get(COOKIE)?.value ?? "";
  // Cleared on every path through this handler. It is single-use by design, and
  // leaving it set would let a stale nonce satisfy a later callback.
  store.delete(COOKIE);

  const separator = cookieValue.indexOf(":");
  const nonce = separator > 0 ? cookieValue.slice(0, separator) : "";
  const invitationToken = separator > 0 ? cookieValue.slice(separator + 1) : "";

  if (!nonce || !invitationToken) {
    // No cookie means this callback was not started here — a forged link, or a
    // browser that dropped it. There is no invitation to send them back to, so
    // the generic page is all that can honestly be offered.
    return NextResponse.redirect(`${origin}/connect/invalid`, 303);
  }

  /*
   * Constant-time, and before anything is spent. `state` is the only thing
   * standing between this endpoint and a login-CSRF: without the check, an
   * attacker who completes their own Facebook dialog can send the resulting
   * callback URL to a streamer and attach their own Page to the invitation.
   */
  const returnedState = url.searchParams.get("state") ?? "";
  if (!secureCompare(nonce, returnedState)) {
    return backToInvitation(origin, invitationToken, "state");
  }

  const invitation = await findInvitationByToken(invitationToken);
  if (!invitation || !isUsable(invitation)) {
    return backToInvitation(origin, invitationToken);
  }

  // The streamer pressed Cancel, or Facebook refused. Not an error worth
  // recording against the invitation — they can simply try again.
  const denied = url.searchParams.get("error");
  if (denied) return backToInvitation(origin, invitationToken, "denied");

  const code = url.searchParams.get("code");
  if (!code) return backToInvitation(origin, invitationToken, "denied");

  const shortLived = await exchangeCodeForUserToken({
    code,
    redirectUri: connectRedirectUri(origin),
  });

  if (!shortLived.ok) {
    await recordError(invitation.id, shortLived.message);
    return backToInvitation(origin, invitationToken, "exchange");
  }

  /*
   * Extended before it is stored. A Page token derived from a short-lived user
   * token lasts about an hour, so a connection made in the afternoon would be
   * dead before the nightly sweep — the streamer would have "connected"
   * successfully and nothing would ever sync.
   */
  const longLived = await exchangeForLongLivedUserToken(shortLived.data.accessToken);

  if (!longLived.ok) {
    await recordError(invitation.id, longLived.message);
    return backToInvitation(origin, invitationToken, "exchange");
  }

  await storeUserToken({
    id: invitation.id,
    userToken: longLived.data.accessToken,
    expiresAt: userTokenHoldExpiry(),
  });

  return NextResponse.redirect(
    `${origin}/connect/${encodeURIComponent(invitationToken)}?step=choose`,
    303,
  );
}
