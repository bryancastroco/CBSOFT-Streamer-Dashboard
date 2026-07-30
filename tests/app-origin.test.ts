import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which origin the application believes it is served from.
 *
 * ## The bug this module exists to prevent
 *
 * Building an absolute URL from the request's `Host` header is host-header
 * poisoning: an attacker sends `Host: evil.test` to the password-reset
 * endpoint, and the victim receives a genuine reset token pointed at the
 * attacker's domain. Every source `resolveAppOrigin` trusts is set by the
 * platform or by an operator — never by a caller — and `originFromRequest`
 * validates a header against that set instead of echoing it.
 *
 * `publicEnv` reads `process.env.NEXT_PUBLIC_*` at module load, so each test
 * re-imports the module with `resetModules` after setting the environment.
 */

const ORIGINAL = { ...process.env };

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return import("@/lib/config/app-origin");
}

beforeEach(() => {
  vi.resetModules();
  for (const key of ["NEXT_PUBLIC_APP_URL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("resolveAppOrigin", () => {
  it("prefers the canonical URL when it is set", async () => {
    const { resolveAppOrigin } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
      VERCEL_URL: "some-preview-abc123.vercel.app",
    });

    expect(resolveAppOrigin()).toBe("https://cbsoft.example.com");
  });

  it("falls back to the deployment URL on a preview, where there is no canonical one", async () => {
    const { resolveAppOrigin } = await load({
      VERCEL_URL: "cbsoft-git-preview-abc123.vercel.app",
    });

    // VERCEL_URL has no scheme; https is assumed rather than http.
    expect(resolveAppOrigin()).toBe("https://cbsoft-git-preview-abc123.vercel.app");
  });

  it("falls back to localhost in development", async () => {
    const { resolveAppOrigin } = await load({});
    expect(resolveAppOrigin()).toBe("http://localhost:3000");
  });

  it("strips any path or trailing slash so callers can concatenate freely", async () => {
    const { resolveAppOrigin, absoluteUrl } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
    });

    expect(resolveAppOrigin()).toBe("https://cbsoft.example.com");
    expect(absoluteUrl("/login")).toBe("https://cbsoft.example.com/login");
    // A caller that forgets the leading slash still gets a valid URL.
    expect(absoluteUrl("login")).toBe("https://cbsoft.example.com/login");
  });

  it("ignores a malformed canonical URL rather than producing a broken origin", async () => {
    const { resolveAppOrigin } = await load({ NEXT_PUBLIC_APP_URL: "not a url" });
    expect(resolveAppOrigin()).toBe("http://localhost:3000");
  });
});

describe("originFromRequest refuses to trust a header", () => {
  it("returns null for a forged Host, rather than echoing it", async () => {
    /*
     * The attack in one assertion. If this ever returns the attacker's origin,
     * any absolute URL built from it — a reset link, an OAuth callback — points
     * at them while carrying a real token.
     */
    const { originFromRequest } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
      NODE_ENV: "production",
    });

    const headers = new Headers({ host: "evil.test" });
    expect(originFromRequest(headers)).toBeNull();
  });

  it("refuses a forged Origin header too", async () => {
    const { originFromRequest } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
    });

    expect(originFromRequest(new Headers({ origin: "https://evil.test" }))).toBeNull();
  });

  it("accepts the canonical origin", async () => {
    const { originFromRequest } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
    });

    expect(originFromRequest(new Headers({ origin: "https://cbsoft.example.com" }))).toBe(
      "https://cbsoft.example.com",
    );
  });

  it("accepts the current preview deployment", async () => {
    const { originFromRequest } = await load({
      VERCEL_URL: "cbsoft-git-preview-abc123.vercel.app",
    });

    expect(originFromRequest(new Headers({ host: "cbsoft-git-preview-abc123.vercel.app" }))).toBe(
      "https://cbsoft-git-preview-abc123.vercel.app",
    );
  });

  it("refuses a look-alike host that merely contains the real one", async () => {
    const { originFromRequest } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
    });

    for (const host of [
      "cbsoft.example.com.evil.test",
      "evil.test/cbsoft.example.com",
      "cbsoft.example.com.co",
    ]) {
      expect(originFromRequest(new Headers({ host })), host).toBeNull();
    }
  });

  it("returns null when no usable header is present", async () => {
    const { originFromRequest } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
    });

    expect(originFromRequest(new Headers())).toBeNull();
  });
});

describe("allowedOrigins", () => {
  it("does not include localhost in production", async () => {
    /*
     * A production allow-list containing localhost would make a page running in
     * the victim's own browser a valid redirect target.
     */
    const { allowedOrigins } = await load({
      NEXT_PUBLIC_APP_URL: "https://cbsoft.example.com",
      NODE_ENV: "production",
    });

    expect(allowedOrigins()).not.toContain("http://localhost:3000");
    expect(allowedOrigins()).toContain("https://cbsoft.example.com");
  });

  it("includes localhost outside production", async () => {
    const { allowedOrigins } = await load({ NODE_ENV: "development" });
    expect(allowedOrigins()).toContain("http://localhost:3000");
  });

  it("never returns an empty list, so a check can never vacuously pass", async () => {
    const { allowedOrigins } = await load({ NODE_ENV: "production" });
    expect(allowedOrigins().length).toBeGreaterThan(0);
  });
});
