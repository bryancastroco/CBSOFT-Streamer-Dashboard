import { NextResponse, type NextRequest } from "next/server";

import { buildLoginRedirect, decideMiddleware, resolveRouteAccess } from "@/lib/auth/route-policy";
import { buildContentSecurityPolicy, buildSecurityHeaders, originOf } from "@/lib/security/headers";
import { readSessionFromRequest } from "@/lib/supabase/middleware";

/**
 * The first authorisation gate, and the place security headers are applied.
 *
 * Next.js 16 renamed the `middleware` convention to `proxy`; the behaviour is
 * unchanged.
 *
 * This is deliberately not the only gate. Next's own guidance is that proxy
 * should not be a complete authorisation solution — it runs before the request
 * reaches the app, so it is the right place for a cheap optimistic check and
 * the wrong place to be the last word. Every protected page therefore calls a
 * server-side guard, and every mutation re-checks the role. See
 * `src/lib/auth/guards.ts`.
 */

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Headers forwarded to the render so Next can stamp its own scripts.
 *
 * Next extracts the nonce by parsing the `Content-Security-Policy` header **on
 * the request** and looking for `'nonce-…'` — so the policy has to travel
 * inbound as well as outbound. `x-nonce` is the conventional companion for
 * application code that needs the raw value.
 *
 * This only works on a dynamically rendered page: a static page is built before
 * any request exists, so there is no nonce to inject. Every route in this
 * application that ships JavaScript is `force-dynamic`.
 */
const NONCE_HEADER = "x-nonce";
const CSP_HEADER = "Content-Security-Policy";

function generateNonce(): string {
  // Web Crypto: the proxy runs on the edge runtime, where `node:crypto` is not
  // available.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Apply the security headers to any response leaving the proxy. */
function harden(response: NextResponse, csp: string): NextResponse {
  response.headers.set(CSP_HEADER, csp);

  for (const [header, value] of Object.entries(buildSecurityHeaders({ isDevelopment }))) {
    response.headers.set(header, value);
  }

  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    isDevelopment,
    /*
     * Null in production: the browser never calls Supabase. Sign-in and
     * sign-out are Server Actions and session refresh happens here in the
     * proxy, so `connect-src` stays at `'self'`.
     *
     * Allowed in development only, where the Supabase local stack and its
     * dashboard links make a browser-side call plausible while debugging.
     * Introducing a real browser-side feature means changing this line.
     */
    supabaseOrigin: isDevelopment ? originOf(process.env["NEXT_PUBLIC_SUPABASE_URL"]) : null,
  });

  // Machine endpoints authenticate with a bearer secret. Running the cookie
  // refresh for them would be pointless work and would let a caller influence
  // the session layer with a forged cookie.
  if (resolveRouteAccess(pathname) === "machine") {
    return harden(NextResponse.next(), csp);
  }

  const session = await readSessionFromRequest(request);

  const decision = decideMiddleware({
    pathname,
    isAuthenticated: session.isAuthenticated,
    role: session.role,
  });

  if (decision.type === "continue") {
    /*
     * The nonce is forwarded on the request headers so the render can stamp it
     * onto the scripts Next emits. Rebuilding the response is the documented
     * way to attach request headers from proxy — the session response's cookies
     * are copied across so a refreshed session is not thrown away.
     */
    const forwarded = new Headers(request.headers);
    forwarded.set(NONCE_HEADER, nonce);
    forwarded.set(CSP_HEADER, csp);

    const response = NextResponse.next({ request: { headers: forwarded } });

    for (const cookie of session.response.cookies.getAll()) {
      response.cookies.set(cookie);
    }

    return harden(response, csp);
  }

  /*
   * Session-authenticated API paths are refused with JSON, not a redirect.
   *
   * A redirect is right for a page and wrong for a fetch. The failure it causes
   * is not cosmetic: an `<a download>` pointing at a CSV endpoint follows the
   * 307 on an expired session and saves the login page to disk under the CSV's
   * filename. A 401 makes that a visible error instead of a corrupt file.
   */
  if (decision.type === "deny") {
    const denied = NextResponse.json(
      {
        error: decision.reason === "unauthenticated" ? "unauthenticated" : "forbidden",
        message:
          decision.reason === "unauthenticated"
            ? "You must be signed in to do that."
            : "Your account is not authorised for this.",
      },
      { status: decision.status, headers: { "cache-control": "no-store" } },
    );

    for (const cookie of session.response.cookies.getAll()) {
      denied.cookies.set(cookie);
    }

    return harden(denied, csp);
  }

  const target =
    decision.reason === "unauthenticated" ? buildLoginRedirect(pathname, search) : decision.to;

  const url = request.nextUrl.clone();
  const [targetPath, targetQuery] = target.split("?");
  url.pathname = targetPath ?? "/";
  url.search = targetQuery ? `?${targetQuery}` : "";

  const redirect = NextResponse.redirect(url);

  // Preserve any refreshed cookies across the redirect, otherwise the session
  // that was just renewed is thrown away.
  for (const cookie of session.response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  return harden(redirect, csp);
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image optimisation. Kept as an
     * exclusion rather than an inclusion list so a new route is covered the
     * moment it is created.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
