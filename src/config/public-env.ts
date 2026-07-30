/**
 * The ONLY environment values that may reach the browser.
 *
 * Kept in its own module (no `server-only` import) so Client Components can use
 * it. Anything added here is public by definition — never put a service role
 * key, app secret, encryption key or Page token in this file.
 *
 * Values are written as literal `process.env.NEXT_PUBLIC_*` reads so the
 * Next.js compiler can statically inline them. A computed key
 * (`process.env[name]`) is NOT inlined and arrives as `undefined` in the
 * browser, which is why every read below is spelled out in full.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",

  /** Display name only. Carries no authority and gates nothing. */
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "CBSOFT Streamer Performance Dashboard",

  /**
   * Canonical production origin, or `""` when not configured.
   *
   * Empty on preview deployments and in development by design — a preview has
   * no stable hostname. Server code needing an origin should call
   * `resolveAppOrigin()` from `@/lib/config/app-origin`, which handles the
   * preview and localhost cases; this raw value is for display and for code
   * that specifically wants "the canonical URL or nothing".
   */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
} as const;

export function isSupabaseConfigured(): boolean {
  return publicEnv.supabaseUrl.length > 0 && publicEnv.supabaseAnonKey.length > 0;
}
