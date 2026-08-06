import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/config/app-origin";
import { isUsable } from "@/lib/connect/invitations";
import { buildAuthorizeUrl, connectRedirectUri } from "@/lib/meta/oauth";
import { findInvitationByToken, markOpened } from "@/lib/repositories/page-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/connect/{token}/start — begin the Facebook sign-in.
 *
 * A POST rather than a link, because starting an OAuth flow is a state change:
 * it mints a CSRF token and sets a cookie. A GET would also let any image tag
 * or link preview on the page kick the flow off.
 *
 * The redirect to Facebook is a 303, not a form target. `form-action 'self'` in
 * the CSP would refuse a form posting straight to facebook.com — correctly, since
 * that is exactly the shape of an exfiltration. A redirect is a navigation and
 * is not governed by it.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const origin = resolveAppOrigin();

  const invitation = await findInvitationByToken(token);

  // Back to the page, which explains the state properly. Deliberately does not
  // distinguish "no such invitation" from "expired" here — the page does that,
  // and only for an invitation that exists.
  if (!invitation || !isUsable(invitation)) {
    return NextResponse.redirect(`${origin}/connect/${encodeURIComponent(token)}`, 303);
  }

  await markOpened(invitation.id);

  /*
   * The CSRF defence. Meta echoes `state` back untouched, and the callback
   * compares it against this cookie — so a callback the streamer did not
   * start cannot be forged by sending them a crafted URL.
   *
   * The invitation token rides along in the cookie rather than in `state`,
   * because `state` travels through Facebook and back in a URL: it lands in
   * browser history, in any referrer, and in Meta's logs. The invitation token
   * is a bearer credential and belongs in none of those.
   */
  const nonce = randomBytes(32).toString("base64url");
  const store = await cookies();

  store.set("connect_state", `${nonce}:${token}`, {
    httpOnly: true,
    sameSite: "lax", // `strict` would drop the cookie on the return from Facebook.
    secure: origin.startsWith("https://"),
    path: "/",
    maxAge: 15 * 60,
  });

  return NextResponse.redirect(
    buildAuthorizeUrl({ state: nonce, redirectUri: connectRedirectUri(origin) }),
    303,
  );
}
