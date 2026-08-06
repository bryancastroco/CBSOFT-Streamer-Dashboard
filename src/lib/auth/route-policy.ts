import { type UserRole } from "@/lib/auth/roles";

/**
 * Which routes need what.
 *
 * Pure module with no framework imports, so the access decision can be unit
 * tested exhaustively rather than inferred from middleware behaviour.
 *
 * The list is **deny by default**: `resolveRouteAccess` returns `authenticated`
 * for anything it does not recognise. A new page is therefore protected the
 * moment it exists, and someone must consciously add it to `PUBLIC_ROUTES` to
 * open it up. The opposite default — public unless listed — is how routes get
 * accidentally exposed.
 */

export type RouteAccess =
  /** No session required. */
  | "public"
  /** Any signed-in user with a profile. */
  | "authenticated"
  /** Signed-in admins only. */
  | "admin"
  /** Bearer-authenticated machine endpoint; the session layer must not touch it. */
  | "machine";

type RouteRule = {
  /** Matches the path exactly, or as a `/`-delimited prefix. */
  path: string;
  access: RouteAccess;
};

/**
 * Ordered most-specific first. `resolveRouteAccess` takes the first match, so
 * `/admin` can be admin-only while `/api/health` stays public.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // Machine endpoints: authenticated by bearer secret, never by cookie.
  // The session layer must skip them entirely — a cookie-based redirect to
  // /login is a useless answer to give an n8n workflow, and it would turn an
  // authentication failure into a 307 that the workflow reads as success.
  { path: "/api/automation", access: "machine" },
  { path: "/api/n8n", access: "machine" },
  { path: "/api/cron", access: "machine" },
  { path: "/api/health", access: "public" },

  // Public surface.

  { path: "/login", access: "public" },
  { path: "/auth", access: "public" },
  // Public so a signed-out user landing here sees the page instead of being
  // bounced to /login and back — a redirect loop is a worse experience than an
  // explanatory page that leaks nothing.
  { path: "/unauthorized", access: "public" },

  /*
   * Self-service Page connection.
   *
   * Public because the audience has no account and never will: these are
   * streamers, invited by link, handing over access to their own Facebook Page.
   * Requiring a dashboard login would mean creating an account for everyone we
   * want a Page from, which is a larger grant than the thing being asked for.
   *
   * The invitation token in the path is the credential — high-entropy, stored
   * only as a hash, single-use, expiring, revocable. What it authorises is
   * narrow by construction: attach one Facebook Page that the holder already
   * administers. It grants no read access to anything in this product.
   */
  { path: "/connect", access: "public" },
  { path: "/api/connect", access: "public" },

  // Administrative surface.
  { path: "/admin", access: "admin" },

  // Everything else that is known to exist.
  { path: "/dashboard", access: "authenticated" },
  { path: "/posts", access: "authenticated" },
  { path: "/api/posts", access: "authenticated" },
  { path: "/videos", access: "authenticated" },
  { path: "/comment-analysis", access: "authenticated" },
  { path: "/streamers", access: "authenticated" },
  { path: "/reports", access: "authenticated" },
  { path: "/settings", access: "authenticated" },
  { path: "/api/export", access: "authenticated" },
] as const;

/**
 * The machine prefixes, derived rather than restated.
 *
 * Each of these needs a `[...unmatched]` catch-all route beside its real
 * endpoints. Access here is resolved by prefix, so an unmatched path under one
 * of them is still handed to Next as a machine endpoint — and with no route
 * file to answer it, Next renders the HTML not-found page with status **200**.
 * A 200 tells n8n the call worked, which is how a typo becomes a silently empty
 * export rather than a failed run.
 *
 * `tests/machine-route-not-found.test.ts` asserts a catch-all exists for every
 * entry, so adding a fourth prefix cannot quietly reintroduce that.
 */
export const MACHINE_NAMESPACES: readonly string[] = ROUTE_RULES.filter(
  (rule) => rule.access === "machine",
).map((rule) => rule.path);

/** Root is special: it only redirects, and decides where based on the session. */
const ROOT_ACCESS: RouteAccess = "public";

function normalise(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function matches(pathname: string, rulePath: string): boolean {
  return pathname === rulePath || pathname.startsWith(`${rulePath}/`);
}

export function resolveRouteAccess(pathname: string): RouteAccess {
  const path = normalise(pathname);

  if (path === "" || path === "/") return ROOT_ACCESS;

  for (const rule of ROUTE_RULES) {
    if (matches(path, rule.path)) return rule.access;
  }

  // Deny by default.
  return "authenticated";
}

// ---------------------------------------------------------------------------
// The middleware decision, as a pure function
// ---------------------------------------------------------------------------

export type MiddlewareContext = {
  pathname: string;
  /** Whether a valid Supabase session was found. */
  isAuthenticated: boolean;
  /**
   * The signed-in user's role, or `null` when there is no session or no
   * profile row. A missing profile is treated as "not authorised", never as
   * "assume viewer".
   */
  role: UserRole | null;
};

export type MiddlewareDecision =
  | { type: "continue" }
  | { type: "redirect"; to: string; reason: MiddlewareRedirectReason }
  /** A JSON refusal, for a path a browser is not navigating to. */
  | { type: "deny"; status: 401 | 403; reason: MiddlewareRedirectReason };

export type MiddlewareRedirectReason =
  "unauthenticated" | "insufficient_role" | "no_profile" | "already_authenticated";

export const LOGIN_PATH = "/login";
export const UNAUTHORIZED_PATH = "/unauthorized";
export const DEFAULT_SIGNED_IN_PATH = "/dashboard";

/**
 * Build the `?next=` value for a post-login bounce.
 *
 * Only same-origin absolute paths are ever echoed back. Accepting a raw
 * attacker-supplied value here would turn the login page into an open
 * redirect, so `//evil.com` and `https://evil.com` are rejected — a leading
 * `//` is protocol-relative and would leave the site.
 */
export function sanitiseNextPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  if (!candidate.startsWith("/")) return null;
  if (candidate.startsWith("//")) return null;
  if (candidate.startsWith("/\\")) return null;
  if (candidate.includes("://")) return null;
  return candidate;
}

export function buildLoginRedirect(pathname: string, search = ""): string {
  const next = sanitiseNextPath(`${pathname}${search}`);
  if (!next || next === LOGIN_PATH) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * The whole middleware policy in one testable function.
 *
 * Middleware is the first gate, not the only one: `machine` routes are skipped
 * entirely (they authenticate by bearer secret), and every admin page and
 * server action re-checks the role server-side. See `src/lib/auth/guards.ts`.
 */
/**
 * Is this a path a browser is *navigating* to, or one it is fetching?
 *
 * A redirect is the right refusal for a page: the reader lands on the login
 * form and comes back. It is the wrong refusal for an API path, and the
 * failure is worse than untidy — a `<a download>` pointing at a CSV endpoint on
 * an expired session follows the 307 and saves the **login page** to disk as
 * `cbsoft-posts-2026-07-30.csv`. A `401` makes that a visible error instead of a
 * corrupt file.
 *
 * Session-authenticated API routes only. `machine` paths never reach here.
 */
function isApiPath(pathname: string): boolean {
  return normalise(pathname).startsWith("/api/");
}

export function decideMiddleware(context: MiddlewareContext): MiddlewareDecision {
  const access = resolveRouteAccess(context.pathname);

  if (access === "machine") {
    return { type: "continue" };
  }

  // A signed-in user has no reason to look at the login form.
  if (access === "public") {
    if (context.isAuthenticated && normalise(context.pathname) === LOGIN_PATH) {
      return {
        type: "redirect",
        to: DEFAULT_SIGNED_IN_PATH,
        reason: "already_authenticated",
      };
    }
    return { type: "continue" };
  }

  const api = isApiPath(context.pathname);

  if (!context.isAuthenticated) {
    return api
      ? { type: "deny", status: 401, reason: "unauthenticated" }
      : {
          type: "redirect",
          to: buildLoginRedirect(context.pathname),
          reason: "unauthenticated",
        };
  }

  // Authenticated in Supabase but with no application profile: fail closed.
  if (context.role === null) {
    return api
      ? { type: "deny", status: 403, reason: "no_profile" }
      : { type: "redirect", to: UNAUTHORIZED_PATH, reason: "no_profile" };
  }

  if (access === "admin" && context.role !== "admin") {
    return api
      ? { type: "deny", status: 403, reason: "insufficient_role" }
      : { type: "redirect", to: UNAUTHORIZED_PATH, reason: "insufficient_role" };
  }

  return { type: "continue" };
}
