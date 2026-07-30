import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIGNED_IN_PATH,
  LOGIN_PATH,
  UNAUTHORIZED_PATH,
  buildLoginRedirect,
  decideMiddleware,
  resolveRouteAccess,
  sanitiseNextPath,
} from "@/lib/auth/route-policy";

describe("resolveRouteAccess", () => {
  it("treats the machine endpoints as bearer-authenticated", () => {
    expect(resolveRouteAccess("/api/n8n/sync")).toBe("machine");
    expect(resolveRouteAccess("/api/n8n/export")).toBe("machine");
    expect(resolveRouteAccess("/api/cron/daily-sync")).toBe("machine");
  });

  it("keeps the health check and the auth surface public", () => {
    expect(resolveRouteAccess("/api/health")).toBe("public");
    expect(resolveRouteAccess("/login")).toBe("public");
    expect(resolveRouteAccess("/unauthorized")).toBe("public");
    expect(resolveRouteAccess("/")).toBe("public");
  });

  it("requires admin for everything under /admin", () => {
    expect(resolveRouteAccess("/admin")).toBe("admin");
    expect(resolveRouteAccess("/admin/users")).toBe("admin");
    expect(resolveRouteAccess("/admin/users/deeply/nested")).toBe("admin");
  });

  it("requires a session for the application routes", () => {
    for (const path of ["/dashboard", "/streamers", "/reports", "/settings"]) {
      expect(resolveRouteAccess(path)).toBe("authenticated");
    }
  });

  it("denies by default so a new route is protected before anyone remembers to list it", () => {
    expect(resolveRouteAccess("/some-future-page")).toBe("authenticated");
    expect(resolveRouteAccess("/api/internal/whatever")).toBe("authenticated");
  });

  it("ignores a trailing slash", () => {
    expect(resolveRouteAccess("/admin/")).toBe("admin");
    expect(resolveRouteAccess("/login/")).toBe("public");
  });

  it("does not let a lookalike prefix inherit a rule", () => {
    // `/admins-only` must not match the `/admin` rule and become admin-gated
    // by accident — nor may it silently become public.
    expect(resolveRouteAccess("/administration")).toBe("authenticated");
    expect(resolveRouteAccess("/logindecoy")).toBe("authenticated");
  });
});

describe("sanitiseNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(sanitiseNextPath("/dashboard")).toBe("/dashboard");
    expect(sanitiseNextPath("/admin/users?tab=roles")).toBe("/admin/users?tab=roles");
  });

  it("rejects anything that could leave the site", () => {
    // Protocol-relative URLs are the classic open-redirect payload.
    expect(sanitiseNextPath("//evil.example.com")).toBeNull();
    expect(sanitiseNextPath("https://evil.example.com")).toBeNull();
    expect(sanitiseNextPath("http://evil.example.com")).toBeNull();
    expect(sanitiseNextPath("/\\evil.example.com")).toBeNull();
    expect(sanitiseNextPath("javascript:alert(1)")).toBeNull();
    expect(sanitiseNextPath("dashboard")).toBeNull();
  });

  it("handles absent input", () => {
    expect(sanitiseNextPath(null)).toBeNull();
    expect(sanitiseNextPath(undefined)).toBeNull();
    expect(sanitiseNextPath("")).toBeNull();
  });
});

describe("buildLoginRedirect", () => {
  it("round-trips the requested path", () => {
    expect(buildLoginRedirect("/admin/users")).toBe("/login?next=%2Fadmin%2Fusers");
  });

  it("preserves the query string", () => {
    expect(buildLoginRedirect("/reports", "?period=july")).toBe(
      "/login?next=%2Freports%3Fperiod%3Djuly",
    );
  });

  it("never points back at itself", () => {
    expect(buildLoginRedirect("/login")).toBe("/login");
  });
});

describe("decideMiddleware — route protection", () => {
  it("sends an anonymous visitor to login with a return path", () => {
    const decision = decideMiddleware({
      pathname: "/dashboard",
      isAuthenticated: false,
      role: null,
    });

    expect(decision).toEqual({
      type: "redirect",
      to: "/login?next=%2Fdashboard",
      reason: "unauthenticated",
    });
  });

  it("protects admin routes from anonymous visitors", () => {
    const decision = decideMiddleware({
      pathname: "/admin/users",
      isAuthenticated: false,
      role: null,
    });

    expect(decision.type).toBe("redirect");
    expect(decision).toMatchObject({ reason: "unauthenticated" });
  });

  it("protects an unknown route, because the default is deny", () => {
    const decision = decideMiddleware({
      pathname: "/not-yet-invented",
      isAuthenticated: false,
      role: null,
    });

    expect(decision).toMatchObject({ reason: "unauthenticated" });
  });

  it("lets a signed-in viewer through to the application", () => {
    for (const path of ["/dashboard", "/streamers", "/reports", "/settings"]) {
      expect(decideMiddleware({ pathname: path, isAuthenticated: true, role: "viewer" })).toEqual({
        type: "continue",
      });
    }
  });

  it("never runs the session layer for machine endpoints", () => {
    expect(
      decideMiddleware({ pathname: "/api/n8n/sync", isAuthenticated: false, role: null }),
    ).toEqual({ type: "continue" });

    expect(
      decideMiddleware({ pathname: "/api/cron/daily-sync", isAuthenticated: false, role: null }),
    ).toEqual({ type: "continue" });
  });

  it("keeps the public health check open", () => {
    expect(
      decideMiddleware({ pathname: "/api/health", isAuthenticated: false, role: null }),
    ).toEqual({ type: "continue" });
  });

  it("bounces a signed-in user away from the login form", () => {
    expect(decideMiddleware({ pathname: "/login", isAuthenticated: true, role: "viewer" })).toEqual(
      { type: "redirect", to: DEFAULT_SIGNED_IN_PATH, reason: "already_authenticated" },
    );
  });

  it("leaves the login form alone for anonymous visitors", () => {
    expect(decideMiddleware({ pathname: LOGIN_PATH, isAuthenticated: false, role: null })).toEqual({
      type: "continue",
    });
  });

  it("keeps /unauthorized reachable so it cannot form a redirect loop", () => {
    expect(
      decideMiddleware({ pathname: UNAUTHORIZED_PATH, isAuthenticated: false, role: null }),
    ).toEqual({ type: "continue" });

    expect(
      decideMiddleware({ pathname: UNAUTHORIZED_PATH, isAuthenticated: true, role: null }),
    ).toEqual({ type: "continue" });
  });
});

/*
 * A refusal has to suit what asked for it.
 *
 * Redirecting a page request to /login is right — the reader signs in and comes
 * back. Redirecting a *fetch* is wrong, and the concrete failure is worse than
 * untidy: the Settings page has `<a download>` links to the CSV endpoints, and
 * on an expired session a 307 is followed silently, saving the login page to
 * disk as `cbsoft-posts-2026-07-30.csv`. The user gets a file that looks right
 * and contains HTML.
 */
describe("decideMiddleware — API paths are refused, not redirected", () => {
  it("denies an unauthenticated API request with 401 JSON", () => {
    const decision = decideMiddleware({
      pathname: "/api/export/sheets/posts",
      isAuthenticated: false,
      role: null,
    });

    expect(decision).toEqual({ type: "deny", status: 401, reason: "unauthenticated" });
  });

  it("still redirects the equivalent page request", () => {
    const decision = decideMiddleware({
      pathname: "/reports",
      isAuthenticated: false,
      role: null,
    });

    expect(decision.type).toBe("redirect");
  });

  it("denies an authenticated caller with no profile", () => {
    const decision = decideMiddleware({
      pathname: "/api/posts",
      isAuthenticated: true,
      role: null,
    });

    expect(decision).toEqual({ type: "deny", status: 403, reason: "no_profile" });
  });

  it("denies a viewer reaching an admin-only page path with 403 JSON", () => {
    // No `/api/admin` page exists, but the rule is prefix-based, so this is the
    // shape an admin-only API path would get if one were ever added to
    // ROUTE_RULES.
    const decision = decideMiddleware({
      pathname: "/admin/api/whatever",
      isAuthenticated: true,
      role: "viewer",
    });

    expect(decision).toMatchObject({ reason: "insufficient_role" });
  });

  it("lets a viewer through to /api/admin/*, because the handler is the gate there", () => {
    /*
     * Deliberate, and worth stating: `/api/admin/*` is NOT in the admin route
     * rule. Those handlers call `requireApiAdmin()`, which returns a proper
     * 403 JSON body with an error code a client can branch on — richer than
     * anything the middleware could produce without knowing the route.
     *
     * The middleware stays the optimistic first gate. The handler is
     * authoritative. See AUTHORIZATION.md §2.
     */
    expect(
      decideMiddleware({
        pathname: "/api/admin/streamers",
        isAuthenticated: true,
        role: "viewer",
      }),
    ).toEqual({ type: "continue" });
  });

  it("leaves machine endpoints alone — they authenticate by bearer secret", () => {
    // A JSON 401 from here would pre-empt the bearer check and stop n8n from
    // ever reaching the endpoint.
    for (const pathname of [
      "/api/automation/sync-all",
      "/api/automation/exports/posts",
      "/api/n8n/sync",
      "/api/cron/daily-sync",
    ]) {
      expect(decideMiddleware({ pathname, isAuthenticated: false, role: null })).toEqual({
        type: "continue",
      });
    }
  });

  it("does not treat a page whose name merely starts with 'api' as an API path", () => {
    const decision = decideMiddleware({
      pathname: "/apiary",
      isAuthenticated: false,
      role: null,
    });

    expect(decision.type).toBe("redirect");
  });
});

describe("decideMiddleware — role authorization", () => {
  it("refuses a viewer at every admin route", () => {
    for (const path of ["/admin", "/admin/users", "/admin/users/anything"]) {
      expect(decideMiddleware({ pathname: path, isAuthenticated: true, role: "viewer" })).toEqual({
        type: "redirect",
        to: UNAUTHORIZED_PATH,
        reason: "insufficient_role",
      });
    }
  });

  it("admits an admin to admin routes", () => {
    expect(
      decideMiddleware({ pathname: "/admin/users", isAuthenticated: true, role: "admin" }),
    ).toEqual({ type: "continue" });
  });

  it("admits an admin to ordinary routes too", () => {
    expect(
      decideMiddleware({ pathname: "/dashboard", isAuthenticated: true, role: "admin" }),
    ).toEqual({ type: "continue" });
  });

  it("fails closed when a session exists but the profile does not", () => {
    // Authenticated in Supabase, unprovisioned in the application. The
    // dangerous bug would be to treat this as a default viewer.
    expect(decideMiddleware({ pathname: "/dashboard", isAuthenticated: true, role: null })).toEqual(
      { type: "redirect", to: UNAUTHORIZED_PATH, reason: "no_profile" },
    );

    expect(decideMiddleware({ pathname: "/admin", isAuthenticated: true, role: null })).toEqual({
      type: "redirect",
      to: UNAUTHORIZED_PATH,
      reason: "no_profile",
    });
  });
});
