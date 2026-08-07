import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRouteAccess } from "@/lib/auth/route-policy";
import { setPasswordSchema } from "@/lib/auth/validation";

/**
 * The invitation round trip, and the two ways it was broken end to end.
 *
 * ## What actually happened
 *
 * `inviteUserByEmail` was called with no `redirectTo`. Supabase therefore fell
 * back to the project's Site URL — still `http://localhost:3000` — so the first
 * invitation sent from production opened `ERR_CONNECTION_REFUSED` on the
 * invitee's machine.
 *
 * The click had already spent the one-time token, so the second attempt came
 * back `otp_expired`. That reads like a link left unopened for a day, which is
 * a different problem with a different fix, and it hid the real cause.
 *
 * Underneath that sat a second gap: nothing at the other end. There was no
 * route to exchange the code for a session and no page to set a password, so
 * even a correctly addressed link had nowhere to land. An invited account would
 * have had a verified email and no credential to sign in with — an account
 * nobody could ever use.
 */

const SOURCE = (file: string) => path.join(process.cwd(), "src", file);

/**
 * Source with comments stripped.
 *
 * These assertions are about what the code *does*, and the prose beside it
 * names the things being avoided — `inviteUserByEmail`, `action_link` — because
 * explaining why they are absent is most of the value. Matching the whole file
 * would fail on the explanation rather than the behaviour.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the invitation names where to come back to", () => {
  it("passes redirectTo rather than relying on the Site URL", async () => {
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    expect(source).toContain("redirectTo");
    expect(source).toContain("/auth/callback");
  });

  it("builds the link from the resolved origin, never a request header", async () => {
    /*
     * An emailed link is the classic host-header poisoning target: the victim
     * receives a genuine token pointed at the attacker's domain.
     * `resolveAppOrigin()` reads only platform and operator configuration.
     */
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    expect(source).toContain("resolveAppOrigin()");
    expect(source).not.toMatch(/inviteUserByEmail[\s\S]{0,400}headers\(\)/);
  });
});

describe("the link has somewhere to land", () => {
  it("has a callback route", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8");

    // Without the exchange the invitee has a verified email and no session.
    expect(source).toContain("exchangeCodeForSession");
  });

  it("has a page to set the first password", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/set-password/actions.ts"), "utf8");

    expect(source).toContain("updateUser");
  });

  it.each(["/auth/callback", "/auth/set-password"])("%s is reachable without a session", (route) => {
    // Both are reached by someone who cannot possibly be signed in yet.
    expect(resolveRouteAccess(route)).toBe("public");
  });

  it("verifies the user against Supabase rather than trusting the cookie", async () => {
    /*
     * `getUser()` revalidates with the auth server; `getSession()` reads the
     * cookie. Handing someone a password is the operation where that
     * distinction is worth the round trip.
     */
    const source = await readFile(SOURCE("app/(auth)/auth/set-password/actions.ts"), "utf8");

    expect(source).toContain("auth.getUser()");
  });
});

describe("an expired link says so", () => {
  it("sends the visitor somewhere that explains it", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8");

    expect(source).toContain("otp_expired");
    expect(source).toContain("link_expired");
  });

  it("shows a fixed message rather than echoing the query string", async () => {
    // The login page is unauthenticated; reflecting arbitrary text into it is
    // how a sign-in screen becomes a phishing surface.
    const source = await readFile(SOURCE("app/(auth)/login/page.tsx"), "utf8");

    expect(source).toContain("LINK_REASONS");
    expect(source).not.toMatch(/\{\s*params\.reason\s*\}/);
  });
});

describe("the password rules", () => {
  it("rejects a mismatch", () => {
    const result = setPasswordSchema.safeParse({ password: "correct-horse", confirm: "battery" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Those passwords do not match");
    }
  });

  it("rejects something too short before the round trip", () => {
    const result = setPasswordSchema.safeParse({ password: "short", confirm: "short" });

    expect(result.success).toBe(false);
  });

  it("accepts a matching pair", () => {
    const result = setPasswordSchema.safeParse({
      password: "correct-horse-battery",
      confirm: "correct-horse-battery",
    });

    expect(result.success).toBe(true);
  });

  it("leaves composition rules to Supabase", async () => {
    /*
     * Restating character-class rules here would drift from the project's
     * actual policy, and the drift shows up as a form accepting a password the
     * server then rejects. Length and equality only.
     */
    const source = await readFile(SOURCE("lib/auth/validation.ts"), "utf8");

    expect(source).not.toMatch(/setPasswordSchema[\s\S]{0,600}\[A-Z\]/);
  });
});

/**
 * The third way it was broken, found only by an audit entry that was missing.
 *
 * ## What happened
 *
 * Supabase's default `{{ .ConfirmationURL }}` verifies the token and then hands
 * the session back in a **URL fragment** — `#access_token=…`. A fragment is
 * never transmitted to the server. The callback saw no `code`, no `error_code`,
 * and bounced to /login, which to the invitee is indistinguishable from a
 * broken invitation: they land on a sign-in form and are asked for a password
 * they were never offered the chance to create.
 *
 * The token was spent on the way, so the link was dead, and the next attempt
 * reported `otp_expired` — the same misleading symptom as the original bug,
 * from an unrelated cause.
 *
 * What made it hard to see is that it leaves no error anywhere. The only
 * evidence was an audit entry that should have existed and did not: a user with
 * `email_confirmed_at` and `last_sign_in_at` set by Supabase, but no
 * `user.signed_in` from us, because the route returned before writing one.
 *
 * These assertions read the source rather than exercising the flow. The route
 * needs a live Supabase to run, and the property worth protecting is structural:
 * that the token-hash arrival shape is still handled at all.
 */
describe("the callback accepts the shape email links actually arrive in", () => {
  it("verifies a token hash, not only a PKCE code", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8");

    // Every link this product sends is generated server-side by an admin
    // action, so there is no browser to have started a PKCE exchange. The
    // token-hash path is the one that carries real traffic.
    expect(source).toContain("token_hash");
    expect(source).toContain("verifyOtp");
  });

  it("treats a token hash as a reason to continue, not to bounce", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8");

    /*
     * The regression this guards: a guard written as `if (!code)` sends every
     * token-hash arrival to /login. It looks correct, it throws nothing, and it
     * breaks every invitation.
     */
    expect(source).not.toMatch(/if\s*\(\s*errorCode\s*\|\|\s*!code\s*\)/);
    expect(source).toMatch(/tokenHash\s*&&\s*otpType/);
  });

  it("redeems only the OTP types an email link should reach", async () => {
    const source = await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8");

    // `type` arrives from a URL. Passing it through would let a caller choose
    // which kind of token to redeem.
    expect(source).toContain("ALLOWED_OTP_TYPES");

    // Scoped to the list itself: the prose above it names the type that is
    // deliberately excluded, so scanning the whole file would match the reason
    // rather than the rule.
    const list = source.match(/ALLOWED_OTP_TYPES\s*=\s*new Set<EmailOtpType>\(\[([\s\S]*?)\]\)/)?.[1];

    expect(list).toBeDefined();
    expect(list).toContain("invite");
    expect(list).toContain("recovery");
    // An email-change token must not be redeemable through an invitation link.
    expect(list).not.toContain("email_change");
  });
});

/**
 * The second click.
 *
 * A one-time token is spent by the click that works, so clicking again fails —
 * and the failure looks exactly like a link that never worked. Observed in
 * production: an invitee opened her link, reached the password form, tapped the
 * link again two minutes later, and was sent to sign in with "ask an
 * administrator to send a new invitation" — for an account that had just
 * succeeded and still had no password set.
 *
 * A dead token is therefore not conclusive on its own. A live session alongside
 * it says the click already worked.
 */
describe("a spent link is not the same as a bad link", () => {
  it("checks for an existing session before sending anyone to sign in", async () => {
    const source = code(await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8"));

    expect(source).toContain("alreadySignedIn");

    // Both dead ends need it: the guard that runs when no usable token arrives,
    // and the failure after verifyOtp rejects one. Covering only the second
    // leaves a reload of a tokenless URL still bouncing to /login.
    const uses = source.match(/alreadySignedIn\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it("proves the session rather than trusting the cookie", async () => {
    // Stripped, because the note beside the call names `getSession` as the
    // thing being avoided — the same collision the `code()` helper exists for.
    const source = code(await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8"));

    const helper = source.match(/async function alreadySignedIn[\s\S]*?\n\}/)?.[0];

    expect(helper).toBeDefined();
    // This decides whether to admit somebody. `getSession` reads the cookie and
    // would accept a forged one.
    expect(helper).toContain("getUser");
    expect(helper).not.toContain("getSession");
  });

  it("sends them where the link was going, not to an error", async () => {
    const source = code(await readFile(SOURCE("app/(auth)/auth/callback/route.ts"), "utf8"));

    // `redirect(next)` inside the already-signed-in branches. Landing them on
    // /login would be the same dead end with an extra step.
    expect(source).toMatch(/alreadySignedIn\(\)\s*\)\s*\{[\s\S]{0,220}?redirect\(next\)/);
  });
});

/**
 * Only the newest link works.
 *
 * Supabase keeps one recovery token per account, so issuing a second cancels
 * the first. An admin who pressed the button twice and sent the earlier link
 * sent a dead one, and nothing on the screen said so.
 */
describe("the issued link says what will invalidate it", () => {
  it("warns that a newer link cancels this one, and that it opens once", async () => {
    const source = await readFile(SOURCE("app/(app)/admin/users/role-form.tsx"), "utf8");

    const panel = source.match(/function IssuedLink[\s\S]*?\n\}/)?.[0];

    expect(panel).toBeDefined();
    expect(panel).toMatch(/newest link works/i);
    expect(panel).toMatch(/opens once/i);
  });
});

/**
 * Why the invitation is a link rather than an email.
 *
 * Supabase's own template ends in a URL fragment that never reaches a server,
 * editing it needs a paid plan, and the free tier caps auth email at a handful
 * an hour. All three point the same way: mint the link here, let the admin
 * deliver it.
 */
describe("the invitation is generated, not emailed", () => {
  it("mints a token instead of sending Supabase's template", async () => {
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    expect(code(source)).toContain("generateLink");
    // `inviteUserByEmail` sends the broken template. Its absence is the point.
    expect(code(source)).not.toContain("inviteUserByEmail");
  });

  it("builds the link from the token, not from Supabase's action_link", async () => {
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    /*
     * `action_link` points at Supabase's verify endpoint, which redirects on
     * with the session in a fragment — the exact failure being replaced. The
     * link has to be assembled from `hashed_token` to arrive as a query string.
     */
    expect(code(source)).toContain("hashed_token");
    expect(code(source)).toContain("token_hash");
    expect(code(source)).not.toMatch(/action_link/);
  });

  it("returns the link to the caller so it can be shown once", async () => {
    // Supabase stores only a hash, so there is no second chance to display it.
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    expect(source).toMatch(/link:\s*callbackLink/);
  });

  it("offers a way back in for an account that already exists", async () => {
    // An invitation never completed and a forgotten password end at the same
    // screen, so they are one action rather than a trip to the Supabase console.
    const source = await readFile(SOURCE("lib/repositories/users.ts"), "utf8");

    expect(source).toContain("createPasswordLink");
    expect(source).toMatch(/type:\s*"recovery"/);
  });
});
