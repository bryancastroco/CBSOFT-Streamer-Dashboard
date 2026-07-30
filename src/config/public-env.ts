/**
 * The ONLY environment values that may reach the browser.
 *
 * Kept in its own module (no `server-only` import) so Client Components can use
 * it. Anything added here is public by definition — never put a service role
 * key, app secret, encryption key or Page token in this file.
 *
 * Values are written as literal `process.env.NEXT_PUBLIC_*` reads so the
 * Next.js compiler can statically inline them.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
} as const;

export function isSupabaseConfigured(): boolean {
  return publicEnv.supabaseUrl.length > 0 && publicEnv.supabaseAnonKey.length > 0;
}
