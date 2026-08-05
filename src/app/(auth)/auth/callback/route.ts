import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit/actions";
import { recordAuditLogSafe } from "@/lib/audit/log";
import { sanitiseNextPath } from "@/lib/auth/route-policy";
import { childLogger } from "@/lib/observability/logger";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/callback
 *
 * Where an emailed link lands: an invitation, a password reset, a magic link.
 *
 * ## Why this exists
 *
 * It did not, and invitations were therefore broken end to end. `inviteUserByEmail`
 * was called with no `redirectTo`, so Supabase fell back to the project's Site
 * URL — still `http://localhost:3000` — and the first invitation sent in
 * production produced `ERR_CONNECTION_REFUSED` on the invitee's machine.
 *
 * Worse, the click still *consumed* the one-time token on Supabase's side. The
 * second click then reported `otp_expired`, which reads like the link sat
 * unopened for a day rather than like it was spent on a redirect to nowhere.
 * Both symptoms, one cause.
 *
 * ## The exchange
 *
 * `@supabase/ssr` uses the PKCE flow, so Supabase sends the browser here with
 * `?code=`. Exchanging it sets the session cookies; without that step the
 * invitee has a verified email and no way to be recognised.
 *
 * ## Errors arrive here too
 *
 * An expired or already-used link redirects here with `?error=` instead of a
 * code, and the honest thing is to say which — "ask for a new invitation" and
 * "check your password" are different instructions. Nothing from the query is
 * echoed into the response; only a fixed message keyed off `error_code`.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const log = childLogger({ component: "auth.callback" });

  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");
  const next = sanitiseNextPath(url.searchParams.get("next")) ?? "/auth/set-password";

  if (errorCode || !code) {
    /*
     * `otp_expired` covers both "expired" and "already used", because Supabase
     * does not distinguish them — and for an invitee the remedy is the same.
     */
    const reason = errorCode === "otp_expired" ? "link_expired" : "link_invalid";

    log.warn("auth.callback.rejected", { reason, hadCode: code !== null });

    redirect(`/login?reason=${reason}`);
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    // Never the provider's message: it can carry the token back onto the page.
    log.warn("auth.callback.exchange_failed", { hasSession: Boolean(data?.session) });

    redirect("/login?reason=link_invalid");
  }

  await recordAuditLogSafe({
    userId: data.session.user.id,
    action: AUDIT_ACTIONS.userSignedIn,
    entityType: AUDIT_ENTITY_TYPES.user,
    entityId: data.session.user.id,
    metadata: { method: "email_link" },
  });

  log.info("auth.callback.exchanged", { next });

  redirect(next);
}
