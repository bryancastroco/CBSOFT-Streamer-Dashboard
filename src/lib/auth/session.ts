import "server-only";

import { cache } from "react";

import { isUserRole, type UserRole } from "@/lib/auth/roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Who is making this request, according to the server.
 *
 * Never derived from a prop, a header, a search param or anything else the
 * client controls — only from the Supabase session cookie, validated against
 * the Auth server, joined to the profile row in `public.users`.
 */
export type CurrentUser = {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
};

/**
 * Why a request has no current user. The caller decides what to do about it:
 * "no session" means sign in, "no profile" means an account exists in Auth but
 * has not been provisioned in the application, which is an admin problem.
 */
export type SessionFailure = "no_session" | "no_profile" | "invalid_role" | "deactivated";

export type SessionResult = { ok: true; user: CurrentUser } | { ok: false; reason: SessionFailure };

/**
 * Wrapped in `React.cache` so several guards and Server Components in one
 * render share a single Auth round trip.
 */
export const getSession = cache(async (): Promise<SessionResult> => {
  const supabase = await createSupabaseServerClient();

  // getUser() revalidates the JWT with Supabase Auth. getSession() would just
  // decode the cookie, which is not good enough for an authorisation decision.
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return { ok: false, reason: "no_session" };
  }

  const { data: profile } = await supabase
    .from("users")
    .select("id, email, full_name, role, deactivated_at")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile) {
    // Authenticated but unprovisioned. Fail closed — do not invent a default
    // role for someone the application has never heard of.
    return { ok: false, reason: "no_profile" };
  }

  /*
   * Deactivation is enforced here, and only here.
   *
   * Supabase Auth still holds a valid session for a deactivated person — their
   * cookie has not been revoked and their JWT has not expired — so every check
   * that matters has to be this one. Removing them from the admin roster or
   * hiding the nav would leave a working session behind, which is not a
   * security control but the appearance of one.
   *
   * Placed before the role check deliberately: a deactivated admin is
   * deactivated first and an admin second.
   */
  if (profile.deactivated_at !== null && profile.deactivated_at !== undefined) {
    return { ok: false, reason: "deactivated" };
  }

  if (!isUserRole(profile.role)) {
    return { ok: false, reason: "invalid_role" };
  }

  return {
    ok: true,
    user: {
      id: profile.id as string,
      email: (profile.email as string | null) ?? user.email ?? "",
      fullName: (profile.full_name as string | null) ?? null,
      role: profile.role,
    },
  };
});

/** Convenience for rendering paths that tolerate an anonymous visitor. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const result = await getSession();
  return result.ok ? result.user : null;
}
