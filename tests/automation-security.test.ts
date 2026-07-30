import { describe, expect, it } from "vitest";

import {
  REDACTION,
  sanitiseMessage,
  sanitiseMetaError,
  sanitiseThrown,
} from "@/lib/automation/sanitise";
import { containsTokenMaterial, findTokenMaterial } from "@/lib/automation/token-material";
import { RateLimiter, rateLimitHeaders } from "@/lib/security/rate-limit";

/**
 * A token shaped like the real thing. Not a real credential — the prefix and
 * length are what the detectors key on.
 */
const META_TOKEN = `EAA${"Gm0BA1ZC8xyzQWERTY".repeat(3)}`;
const CIPHERTEXT = "v1.YWJjZGVmZ2hpamtsbW5vcA==.cXJzdHV2d3h5emFiY2RlZg==.Zm9vYmFyYmF6cXV4";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";

// ---------------------------------------------------------------------------
// Refusing tokens on the way in
// ---------------------------------------------------------------------------

describe("refusing Page token material", () => {
  it("accepts an ordinary automation body", () => {
    expect(
      containsTokenMaterial({
        mode: "async",
        max_pages: 5,
        skip_comments: false,
        since: "2026-07-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("accepts an empty body", () => {
    expect(containsTokenMaterial({})).toBe(false);
    expect(containsTokenMaterial(null)).toBe(false);
  });

  it.each([
    "access_token",
    "accessToken",
    "page_access_token",
    "pageAccessToken",
    "page_token",
    "encrypted_page_token",
    "client_secret",
    "app_secret",
    "token",
    "secret",
    "api_key",
    "password",
  ])("refuses a field named %j whatever its value", (field) => {
    const findings = findTokenMaterial({ [field]: "anything at all" });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe(field);
  });

  it("refuses a credential-shaped value hidden under an innocent key", () => {
    // The case a key allow-list alone would miss.
    const findings = findTokenMaterial({ note: `use ${META_TOKEN} for the call` });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("Meta access token");
  });

  it("refuses this application's own ciphertext envelope", () => {
    // A request carrying one means somebody read the encrypted column.
    expect(containsTokenMaterial({ data: CIPHERTEXT })).toBe(true);
  });

  it("refuses a JSON Web Token", () => {
    expect(containsTokenMaterial({ payload: JWT })).toBe(true);
  });

  it("finds material nested inside arrays and objects", () => {
    const findings = findTokenMaterial({
      streamers: [{ id: "a" }, { id: "b", credentials: { access_token: "x" } }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.path).toBe("streamers.1.credentials.access_token");
  });

  it("reports every finding at once, not just the first", () => {
    // A caller fixing their workflow should learn about all of it in one go.
    const findings = findTokenMaterial({ access_token: "a", nested: { client_secret: "b" } });

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.path).sort()).toEqual([
      "access_token",
      "nested.client_secret",
    ]);
  });

  it("never echoes the offending value back", () => {
    const serialised = JSON.stringify(findTokenMaterial({ access_token: META_TOKEN }));

    expect(serialised).not.toContain(META_TOKEN);
    expect(serialised).not.toContain("EAA");
  });

  it("does not fire on legitimate metadata names", () => {
    // `token_status` is a health enum and `tokens_used` is a cost figure.
    // Refusing them would break honest callers for no gain.
    expect(
      containsTokenMaterial({ token_status: "valid", tokens_used: 1200, has_token: true }),
    ).toBe(false);
  });

  it("does not fire on ordinary prose that happens to start with EAA", () => {
    expect(containsTokenMaterial({ note: "EAA is a three letter prefix" })).toBe(false);
  });

  it("survives a hostile deeply-nested body", () => {
    let body: unknown = { access_token: "buried" };
    for (let depth = 0; depth < 200; depth += 1) body = { nested: body };

    // The depth cap means the buried value is not found — but the important
    // property is that it terminates rather than blowing the stack.
    expect(() => findTokenMaterial(body)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sanitising errors on the way out
// ---------------------------------------------------------------------------

describe("error sanitisation", () => {
  it("strips a Meta token from a message", () => {
    const message = sanitiseMessage(`Request failed: GET /me?access_token=${META_TOKEN}&fields=id`);

    expect(message).not.toContain(META_TOKEN);
    expect(message).toContain(REDACTION);
  });

  it("strips a credential query parameter whatever its value", () => {
    // The parameter is the signal; the value need not look like a token.
    const message = sanitiseMessage("failed for ?access_token=short&fields=id");

    expect(message).not.toContain("short");
    expect(message).toContain("access_token=[redacted]");
    // A harmless parameter is left intact.
    expect(message).toContain("fields=id");
  });

  it.each([
    ["appsecret_proof", "?appsecret_proof=abc123"],
    ["client_secret", "&client_secret=abc123"],
    ["input_token", "&input_token=abc123"],
  ])("strips %s", (_name, fragment) => {
    expect(sanitiseMessage(`Graph error ${fragment}`)).not.toContain("abc123");
  });

  it("strips ciphertext and JWTs", () => {
    expect(sanitiseMessage(`stored ${CIPHERTEXT}`)).not.toContain(CIPHERTEXT);
    expect(sanitiseMessage(`bearer ${JWT}`)).not.toContain(JWT);
  });

  it("truncates a very long message", () => {
    // Length is itself the signal: a Graph message is long precisely when it is
    // echoing the request back, which is the case most likely to carry a token
    // the patterns did not anticipate.
    const message = sanitiseMessage("x".repeat(5000));

    expect(message.length).toBeLessThan(400);
    expect(message).toContain("truncated");
  });

  it("leaves an ordinary operator message readable", () => {
    expect(sanitiseMessage("The Page token has expired. Replace it in the admin panel.")).toBe(
      "The Page token has expired. Replace it in the admin panel.",
    );
  });

  it("collapses whitespace so a multi-line payload becomes one line", () => {
    expect(sanitiseMessage("line one\n\n  line two")).toBe("line one line two");
  });

  it("reduces a normalised Meta error to four safe fields", () => {
    const safe = sanitiseMetaError({
      category: "invalid_token",
      message: `token ${META_TOKEN} is invalid`,
      retryable: false,
      code: 190,
      subcode: 463,
      httpStatus: 400,
      fbtraceId: "AbCdEf123456",
    });

    expect(safe).toEqual({
      category: "invalid_token",
      code: 190,
      subcode: 463,
      message: expect.stringContaining(REDACTION),
    });

    // Rebuilt, not spread — so a field added to the error type later is
    // excluded by default rather than leaking.
    expect(Object.keys(safe).sort()).toEqual(["category", "code", "message", "subcode"]);
    expect(JSON.stringify(safe)).not.toContain("AbCdEf123456");
    expect(JSON.stringify(safe)).not.toContain(META_TOKEN);
  });

  it("never returns a stack trace", () => {
    const error = new Error(`connect failed postgres://user:hunter2@db.example/postgres`);
    const message = sanitiseThrown(error);

    expect(message).not.toContain("at ");
    expect(message).toBe(error.message);
  });

  it("falls back rather than returning an empty message", () => {
    expect(sanitiseThrown(null)).toBe("Unexpected failure.");
    expect(sanitiseThrown(new Error(""))).toBe("Unexpected failure.");
    expect(sanitiseThrown(undefined, "Custom.")).toBe("Custom.");
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  /** A controllable clock, so no test sleeps. */
  function fixedClock(start = 1_000_000) {
    let current = start;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  const rule = { limit: 3, windowMs: 60_000 };

  it("allows requests up to the limit", () => {
    const limiter = new RateLimiter(fixedClock().now);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(limiter.check("k", rule).allowed, `attempt ${attempt}`).toBe(true);
    }
  });

  it("denies the one after", () => {
    const limiter = new RateLimiter(fixedClock().now);
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check("k", rule);

    const denied = limiter.check("k", rule);

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts down remaining", () => {
    const limiter = new RateLimiter(fixedClock().now);

    expect(limiter.check("k", rule).remaining).toBe(2);
    expect(limiter.check("k", rule).remaining).toBe(1);
    expect(limiter.check("k", rule).remaining).toBe(0);
  });

  it("keeps separate budgets per key", () => {
    // Reads and writes have very different costs, so they cannot share a window.
    const limiter = new RateLimiter(fixedClock().now);
    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check("write", rule);

    expect(limiter.check("write", rule).allowed).toBe(false);
    expect(limiter.check("read", rule).allowed).toBe(true);
  });

  it("opens a fresh window once the old one expires", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter(clock.now);

    for (let attempt = 0; attempt < 4; attempt += 1) limiter.check("k", rule);
    expect(limiter.check("k", rule).allowed).toBe(false);

    clock.advance(60_001);

    expect(limiter.check("k", rule).allowed).toBe(true);
  });

  it("keeps counting a denied request, so hammering does not reset the window", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter(clock.now);

    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check("k", rule);

    const first = limiter.check("k", rule);
    clock.advance(30_000);
    const later = limiter.check("k", rule);

    expect(first.allowed).toBe(false);
    expect(later.allowed).toBe(false);
    // The window still ends when it was always going to.
    expect(later.resetAt).toBe(first.resetAt);
    expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
  });

  it("prunes expired windows so a long-lived instance does not grow without bound", () => {
    const clock = fixedClock();
    const limiter = new RateLimiter(clock.now);

    for (let key = 0; key < 50; key += 1) limiter.check(`k${key}`, rule);
    expect(limiter.size).toBe(50);

    clock.advance(60_001);
    limiter.prune();

    expect(limiter.size).toBe(0);
  });

  it("advertises the limit, and Retry-After only on a denial", () => {
    const limiter = new RateLimiter(fixedClock().now);

    const allowed = rateLimitHeaders(limiter.check("k", rule));
    expect(allowed["RateLimit-Limit"]).toBe("3");
    expect(allowed["Retry-After"]).toBeUndefined();

    for (let attempt = 0; attempt < 3; attempt += 1) limiter.check("k", rule);
    const denied = rateLimitHeaders(limiter.check("k", rule));

    expect(denied["Retry-After"]).toBeDefined();
    expect(Number(denied["Retry-After"])).toBeGreaterThan(0);
  });
});
