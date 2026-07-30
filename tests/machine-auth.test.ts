import { beforeEach, describe, expect, it } from "vitest";

import { FAKE_PAGE_TOKEN } from "./fixtures/meta";
import { buildContentSecurityPolicy, buildSecurityHeaders, originOf } from "@/lib/security/headers";
import {
  checkLoginAttempt,
  clearLoginAttempts,
  clientAddressFrom,
  resetLoginThrottleForTests,
} from "@/lib/security/login-throttle";
import { authenticateMachineRequest } from "@/lib/security/machine-auth";

/**
 * The machine-to-machine boundary, and the headers that wrap every response.
 *
 * `N8N_API_SECRET` and `CRON_SECRET` are generated per test run by
 * `tests/setup/env.ts`. Neither is a real credential and neither authenticates
 * against anything.
 */

const N8N_SECRET = process.env["N8N_API_SECRET"] as string;
const CRON_SECRET = process.env["CRON_SECRET"] as string;

function requestWith(authorization: string | null, url = "https://example.test/api/automation/x") {
  return new Request(url, {
    headers: authorization === null ? {} : { authorization },
  });
}

// ---------------------------------------------------------------------------
// n8n and cron authentication
// ---------------------------------------------------------------------------

describe("n8n API authentication", () => {
  it("accepts the correct secret as a bearer token", () => {
    const result = authenticateMachineRequest(requestWith(`Bearer ${N8N_SECRET}`), "n8n");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.caller).toBe("n8n");
  });

  it("rejects a missing Authorization header", () => {
    const result = authenticateMachineRequest(requestWith(null), "n8n");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a wrong secret", () => {
    const result = authenticateMachineRequest(requestWith("Bearer definitely-not-it"), "n8n");
    expect(result.ok).toBe(false);
  });

  it("rejects the right secret sent without the Bearer scheme", () => {
    // A common misconfiguration. Failing it keeps the header format
    // unambiguous rather than accepting two shapes.
    expect(authenticateMachineRequest(requestWith(N8N_SECRET), "n8n").ok).toBe(false);
  });

  it("rejects a different auth scheme carrying the secret", () => {
    expect(authenticateMachineRequest(requestWith(`Basic ${N8N_SECRET}`), "n8n").ok).toBe(false);
  });

  it("accepts the scheme case-insensitively, as RFC 7235 requires", () => {
    expect(authenticateMachineRequest(requestWith(`bearer ${N8N_SECRET}`), "n8n").ok).toBe(true);
    expect(authenticateMachineRequest(requestWith(`BEARER ${N8N_SECRET}`), "n8n").ok).toBe(true);
  });

  it("rejects an empty bearer value", () => {
    expect(authenticateMachineRequest(requestWith("Bearer "), "n8n").ok).toBe(false);
    expect(authenticateMachineRequest(requestWith("Bearer"), "n8n").ok).toBe(false);
  });

  it("tolerates surrounding whitespace, which a pasted credential often carries", () => {
    /*
     * Deliberate leniency, not an oversight. A secret pasted into an n8n
     * credential field routinely picks up a trailing space or newline, and
     * refusing it produces a 401 that looks identical to a wrong secret —
     * hours of debugging for an invisible character.
     *
     * It costs nothing: trimming whitespace does not weaken the constant-time
     * comparison of the secret itself, and the next test shows that one extra
     * *non-whitespace* character is still refused.
     */
    expect(authenticateMachineRequest(requestWith(`Bearer ${N8N_SECRET} `), "n8n").ok).toBe(true);
    expect(authenticateMachineRequest(requestWith(`Bearer  ${N8N_SECRET}`), "n8n").ok).toBe(true);
  });

  it("rejects a secret with any extra non-whitespace character", () => {
    expect(authenticateMachineRequest(requestWith(`Bearer ${N8N_SECRET}x`), "n8n").ok).toBe(false);
    expect(authenticateMachineRequest(requestWith(`Bearer x${N8N_SECRET}`), "n8n").ok).toBe(false);
  });

  it("rejects a truncated secret", () => {
    const truncated = N8N_SECRET.slice(0, -1);
    expect(authenticateMachineRequest(requestWith(`Bearer ${truncated}`), "n8n").ok).toBe(false);
  });
});

describe("cron authentication", () => {
  it("accepts CRON_SECRET", () => {
    expect(authenticateMachineRequest(requestWith(`Bearer ${CRON_SECRET}`), "cron").ok).toBe(true);
  });

  it("rejects a missing or wrong secret", () => {
    expect(authenticateMachineRequest(requestWith(null), "cron").ok).toBe(false);
    expect(authenticateMachineRequest(requestWith("Bearer nope"), "cron").ok).toBe(false);
  });
});

describe("the two machine secrets are not interchangeable", () => {
  /*
   * The reason they are separate: an n8n compromise must not be able to drive
   * the scheduler, and rotating one must not disturb the other.
   */
  it("refuses the n8n secret on a cron endpoint", () => {
    expect(authenticateMachineRequest(requestWith(`Bearer ${N8N_SECRET}`), "cron").ok).toBe(false);
  });

  it("refuses the cron secret on an n8n endpoint", () => {
    expect(authenticateMachineRequest(requestWith(`Bearer ${CRON_SECRET}`), "n8n").ok).toBe(false);
  });

  it("generated them as different values", () => {
    expect(N8N_SECRET).not.toBe(CRON_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

describe("login throttling", () => {
  beforeEach(() => {
    resetLoginThrottleForTests();
  });

  const attempt = (email: string, clientAddress: string | null = "203.0.113.10") =>
    checkLoginAttempt({ email, clientAddress });

  it("allows a normal run of attempts", () => {
    for (let i = 0; i < 6; i += 1) {
      expect(attempt("user@example.test").allowed, `attempt ${i + 1}`).toBe(true);
    }
  });

  it("refuses once the per-address budget is spent", () => {
    for (let i = 0; i < 6; i += 1) attempt("user@example.test");

    const denied = attempt("user@example.test");

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate budgets per email address", () => {
    for (let i = 0; i < 7; i += 1) attempt("victim@example.test");

    expect(attempt("victim@example.test").allowed).toBe(false);
    // A different account is unaffected — one person being attacked must not
    // lock out everybody else.
    expect(attempt("someone-else@example.test").allowed).toBe(true);
  });

  it("treats an address case-insensitively", () => {
    // Otherwise `User@…` and `user@…` would each get a fresh budget, and the
    // limit would be trivially bypassed.
    for (let i = 0; i < 6; i += 1) attempt("user@example.test");

    expect(attempt("USER@example.test").allowed).toBe(false);
    expect(attempt("  User@Example.Test  ").allowed).toBe(false);
  });

  it("also refuses a spray across many addresses from one client", () => {
    // The case a per-email budget alone would miss entirely.
    let denied = false;
    for (let i = 0; i < 40; i += 1) {
      if (!attempt(`user${i}@example.test`, "198.51.100.7").allowed) {
        denied = true;
        break;
      }
    }

    expect(denied).toBe(true);
  });

  it("clears an address's failures after a successful sign-in", () => {
    for (let i = 0; i < 5; i += 1) attempt("typo@example.test");
    clearLoginAttempts("typo@example.test");

    // Somebody who mistypes their password five times and then gets it right
    // is not punished for the rest of the window.
    expect(attempt("typo@example.test").allowed).toBe(true);
  });

  it("still throttles when the client address is unknown", () => {
    // Behind an unusual proxy there may be no usable address. The per-email
    // budget has to hold on its own.
    for (let i = 0; i < 6; i += 1) attempt("user@example.test", null);
    expect(attempt("user@example.test", null).allowed).toBe(false);
  });
});

describe("client address extraction", () => {
  it("takes the left-most entry of x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.5, 70.41.3.18, 150.172.238.178" });
    expect(clientAddressFrom(headers)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip", () => {
    expect(clientAddressFrom(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("returns null when neither header is present", () => {
    expect(clientAddressFrom(new Headers())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe("Content-Security-Policy", () => {
  const policy = (isDevelopment = false) =>
    buildContentSecurityPolicy({
      nonce: "TESTNONCE123",
      isDevelopment,
      supabaseOrigin: "https://project.supabase.co",
    });

  it("carries the request nonce and strict-dynamic", () => {
    expect(policy()).toContain("'nonce-TESTNONCE123'");
    expect(policy()).toContain("'strict-dynamic'");
  });

  it("locks down the directives that matter", () => {
    const value = policy();

    expect(value).toContain("default-src 'self'");
    expect(value).toContain("object-src 'none'");
    expect(value).toContain("frame-ancestors 'none'");
    // Stops an injected <base> re-pointing every relative URL in the page.
    expect(value).toContain("base-uri 'self'");
    expect(value).toContain("form-action 'self'");
  });

  it("allows the browser to reach Supabase, and nothing else remote", () => {
    // Auth is the only thing the browser calls directly. Every Meta and
    // Anthropic call happens on the server, which is what keeps this short.
    const value = policy();
    const connect = value.split("connect-src ")[1]?.split(";")[0] ?? "";

    expect(connect).toContain("'self'");
    expect(connect).toContain("https://project.supabase.co");
    expect(connect).not.toContain("graph.facebook.com");
    expect(connect).not.toContain("api.anthropic.com");
  });

  it("never allows unsafe-eval in production", () => {
    expect(policy(false)).not.toContain("'unsafe-eval'");
    // Development needs it for React's refresh runtime.
    expect(policy(true)).toContain("'unsafe-eval'");
  });

  it("upgrades insecure requests in production only", () => {
    expect(policy(false)).toContain("upgrade-insecure-requests");
    // Would break a plain-HTTP dev server.
    expect(policy(true)).not.toContain("upgrade-insecure-requests");
  });

  it("omits the Supabase origin cleanly when it is not configured", () => {
    const value = buildContentSecurityPolicy({
      nonce: "N",
      isDevelopment: false,
      supabaseOrigin: null,
    });

    expect(value).toContain("connect-src 'self';");
  });

  it("produces a fresh policy per nonce", () => {
    const a = buildContentSecurityPolicy({
      nonce: "A",
      isDevelopment: false,
      supabaseOrigin: null,
    });
    const b = buildContentSecurityPolicy({
      nonce: "B",
      isDevelopment: false,
      supabaseOrigin: null,
    });

    expect(a).not.toBe(b);
  });
});

describe("the other security headers", () => {
  it("sets the ones a browser acts on", () => {
    const headers = buildSecurityHeaders({ isDevelopment: false });

    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("sends HSTS in production only", () => {
    // On http://localhost it would teach the browser to force HTTPS on
    // localhost for two years, which is genuinely annoying to undo.
    expect(buildSecurityHeaders({ isDevelopment: false })["Strict-Transport-Security"]).toContain(
      "max-age=",
    );
    expect(
      buildSecurityHeaders({ isDevelopment: true })["Strict-Transport-Security"],
    ).toBeUndefined();
  });
});

describe("origin extraction", () => {
  it("reduces a URL to its origin", () => {
    expect(originOf("https://project.supabase.co/rest/v1")).toBe("https://project.supabase.co");
  });

  it("returns null rather than throwing on nonsense", () => {
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("fixtures carry no real credentials", () => {
  it("uses an obviously synthetic Page token", () => {
    // It has to start with EAA so the token detectors fire on it, and it has to
    // be unmistakably fake so nobody treats it as a secret.
    expect(FAKE_PAGE_TOKEN).toMatch(/^EAA/);
    expect(FAKE_PAGE_TOKEN).toContain("NOT_A_REAL_CREDENTIAL");
  });

  it("generated the machine secrets fresh for this run", () => {
    // `tests/setup/env.ts` uses randomBytes, so nothing here outlives the run.
    expect(N8N_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(CRON_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
