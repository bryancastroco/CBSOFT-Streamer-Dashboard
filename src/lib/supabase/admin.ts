import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/config/env";

/**
 * Service-role Supabase client. BYPASSES Row Level Security.
 *
 * Use only for trusted server work that genuinely cannot run as the user:
 *   - sync jobs writing metric snapshots
 *   - reading encrypted Page tokens for an outbound Meta Graph call
 *   - n8n-triggered export queries
 *
 * Never construct this in a Client Component, never derive a response body
 * directly from its results without filtering, and never select
 * `access_token_encrypted` into anything that gets serialised to a client.
 */
export function createSupabaseAdminClient() {
  const env = getServerEnv();

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
