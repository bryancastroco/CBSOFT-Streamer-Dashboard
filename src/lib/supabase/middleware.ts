import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isUserRole, type UserRole } from "@/lib/auth/roles";
import { publicEnv } from "@/config/public-env";

/**
 * Supabase session handling for middleware.
 *
 * Two jobs, and they must happen in this order:
 *   1. Refresh the auth cookies so a near-expiry session is renewed. The
 *      refreshed cookies have to be written onto the response we ultimately
 *      return, otherwise the browser keeps the stale pair and silently signs
 *      the user out.
 *   2. Report who the user is, so the route policy can decide.
 *
 * `getUser()` is used rather than `getSession()` on purpose: it validates the
 * JWT with the Auth server, whereas `getSession()` trusts whatever is in the
 * cookie. Middleware is a security boundary, so it must not trust the cookie.
 */

export type SessionContext = {
  isAuthenticated: boolean;
  userId: string | null;
  role: UserRole | null;
  /** Carries the refreshed auth cookies; every return path must use it. */
  response: NextResponse;
};

export async function readSessionFromRequest(request: NextRequest): Promise<SessionContext> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(publicEnv.supabaseUrl, publicEnv.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { isAuthenticated: false, userId: null, role: null, response };
  }

  // Read the role under the user's own session, so this query is subject to
  // the `users_select_self` RLS policy rather than bypassing it.
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const role: UserRole | null =
    profile && isUserRole(profile.role) ? (profile.role as UserRole) : null;

  return { isAuthenticated: true, userId: user.id, role, response };
}
