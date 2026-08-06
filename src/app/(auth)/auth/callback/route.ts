import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";

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
 * ## Two arrival shapes, and why both are handled
 *
 * `?token_hash=…&type=…` — what an **email template** sends when it is written
 * with `{{ .TokenHash }}`. Verified here with `verifyOtp`, which mints the
 * session. This is the shape that matters: every link this product sends is
 * generated server-side by an admin action, so there is no browser to have
 * started a PKCE exchange.
 *
 * `?code=…` — the PKCE shape, produced when a flow was begun in the browser.
 * Kept because a future OAuth provider would use it, and because it costs four
 * lines.
 *
 * ## The failure this was written to end
 *
 * Supabase's default `{{ .ConfirmationURL }}` verifies the token and then
 * redirects with the session in a **URL fragment** — `#access_token=…`. A
 * fragment is never sent to the server. So this route saw no `code`, no
 * `error_code`, and did the only thing it could: bounce to /login.
 *
 * From the invitee's side that is indistinguishable from a broken invitation.
 * They click, they land on a sign-in form, and they are asked for a password
 * they were never given the chance to create. Meanwhile the one-time token has
 * been spent, so the link is dead and the second click reports `otp_expired` —
 * which reads like they were slow rather than like the flow never worked.
 *
 * It leaves almost no trace: the audit trail gets no `user.signed_in`, because
 * this route returned before writing one. Diagnosing it means noticing an entry
 * that is *absent*.
 *
 * The email templates must therefore point here with `{{ .TokenHash }}`:
 *
 *   {{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=invite&next=/auth/set-password
 *
 * ## Errors arrive here too
 *
 * An expired or already-used link redirects here with `?error=` instead of a
 * token, and the honest thing is to say which — "ask for a new invitation" and
 * "check your password" are different instructions. Nothing from the query is
 * echoed into the response; only a fixed message keyed off `error_code`.
 */

/**
 * The OTP types this route will verify.
 *
 * An allow-list, not a cast. `type` arrives from a URL, and passing it straight
 * to `verifyOtp` would let a caller choose which kind of token to redeem —
 * `email_change` in particular is not something an invitation link should be
 * able to reach.
 */
const ALLOWED_OTP_TYPES = new Set<EmailOtpType>([
  "invite",
  "recovery",
  "magiclink",
  "signup",
  "email",
]);

function otpTypeFrom(value: string | null): EmailOtpType | null {
  if (!value) return null;
  return ALLOWED_OTP_TYPES.has(value as EmailOtpType) ? (value as EmailOtpType) : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const log = childLogger({ component: "auth.callback" });

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const otpType = otpTypeFrom(url.searchParams.get("type"));
  const errorCode = url.searchParams.get("error_code");
  const next = sanitiseNextPath(url.searchParams.get("next")) ?? "/auth/set-password";

  if (errorCode || (!code && !(tokenHash && otpType))) {
    /*
     * `otp_expired` covers both "expired" and "already used", because Supabase
     * does not distinguish them — and for an invitee the remedy is the same.
     */
    const reason = errorCode === "otp_expired" ? "link_expired" : "link_invalid";

    log.warn("auth.callback.rejected", {
      reason,
      hadCode: code !== null,
      hadTokenHash: tokenHash !== null,
      // Logged because an unrecognised type is the signature of an email
      // template pointing here with something this route will not redeem.
      hadUsableType: otpType !== null,
    });

    redirect(`/login?reason=${reason}`);
  }

  const supabase = await createSupabaseServerClient();

  const { data, error } =
    tokenHash && otpType
      ? await supabase.auth.verifyOtp({ type: otpType, token_hash: tokenHash })
      : await supabase.auth.exchangeCodeForSession(code!);

  if (error || !data.session) {
    // Never the provider's message: it can carry the token back onto the page.
    log.warn("auth.callback.exchange_failed", {
      hasSession: Boolean(data?.session),
      method: tokenHash ? "token_hash" : "code",
    });

    redirect("/login?reason=link_invalid");
  }

  await recordAuditLogSafe({
    userId: data.session.user.id,
    action: AUDIT_ACTIONS.userSignedIn,
    entityType: AUDIT_ENTITY_TYPES.user,
    entityId: data.session.user.id,
    metadata: { method: tokenHash ? `email_${otpType}` : "email_link" },
  });

  log.info("auth.callback.exchanged", { next, method: tokenHash ? "token_hash" : "code" });

  redirect(next);
}
