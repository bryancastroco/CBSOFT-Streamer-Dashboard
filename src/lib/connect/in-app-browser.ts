/**
 * Detecting the webview a social app opens links in — a PURE module.
 *
 * ## Why this matters here specifically
 *
 * The invitation is delivered over Messenger or a Facebook post, so the natural
 * thing to do is tap it there. That opens Facebook's own in-app browser, and an
 * OAuth dialog back to facebook.com inside it frequently never completes: it
 * blanks, bounces, or hands off to the app and does not return. The person sees
 * "Opening Facebook…" and nothing else.
 *
 * From our side that is invisible. The POST arrives, `opened_at` is stamped,
 * the redirect is issued — a textbook successful start. Every invitation that
 * dies this way looks identical to one where the streamer simply changed their
 * mind, and there is nothing to record because nothing failed here.
 *
 * So the only useful move is before the fact: recognise the webview and say to
 * open the link properly. It is a hint, not a gate — the button stays enabled,
 * because user-agent matching is guesswork and blocking someone whose browser
 * merely looks unusual would be worse than the problem.
 *
 * ## On sniffing user agents
 *
 * Normally a mistake. Here there is no feature to detect: nothing in the page
 * can observe whether an unrelated origin will complete a redirect, and the
 * failure happens after we have handed control away. The string is the only
 * signal available.
 */

/**
 * Tokens these webviews put in their user agent.
 *
 * - `FBAN` / `FBAV` / `FB_IAB` / `FBIOS` — Facebook app and its browser.
 * - `Messenger` — delivered by chat, which is the common route.
 * - `Instagram` — same company, same behaviour.
 * - `Line` / `MicroMessenger` — included because they behave the same way and
 *   cost nothing to name.
 */
const IN_APP_MARKERS = [
  "FBAN",
  "FBAV",
  "FB_IAB",
  "FBIOS",
  "Messenger",
  "Instagram",
  "MicroMessenger",
  "Line/",
] as const;

export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;

  const value = userAgent.toLowerCase();
  return IN_APP_MARKERS.some((marker) => value.includes(marker.toLowerCase()));
}

/**
 * What to tell someone in one.
 *
 * Phrased as an instruction they can follow without knowing the words "webview"
 * or "OAuth", and hedged — "may not finish" — because it sometimes does work,
 * and being told something is broken when it is about to succeed is its own
 * kind of wrong.
 */
export const IN_APP_BROWSER_NOTICE =
  "You have opened this inside the Facebook app's browser, where signing in often does not finish. Tap the ⋯ or ⋮ menu at the top and choose “Open in browser” (Chrome or Safari), then try again there.";
