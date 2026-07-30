import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getServerEnv } from "@/config/env";

/**
 * Request-scoped Supabase client that carries the signed-in user's session.
 *
 * Still anon-key based, so RLS applies. This is the client used for everything
 * the user is allowed to see. Authorisation logic lands in Phase 2.
 */
export async function createSupabaseServerClient() {
  const env = getServerEnv();
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render, where cookies are readonly.
          // Session refresh is handled in middleware instead (Phase 2).
        }
      },
    },
  });
}
