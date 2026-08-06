import "server-only";

import { getServerEnv } from "@/config/env";
import { buildGraphUrl } from "@/lib/meta/client";

/**
 * The Facebook Login half of the Graph integration.
 *
 * Everything here is the server-side authorization-code flow. Architecture rule
 * 6 forbids a browser-side Facebook SDK, and that is not a formality: `FB.login`
 * hands the access token to JavaScript, which would put a credential in the
 * browser and break rule 5 in the same motion. The redirect flow never does —
 * the browser carries a one-time `code`, and only this server can spend it,
 * because spending it needs the app secret.
 *
 * ## The shape
 *
 *   1. Send the streamer to `dialog/oauth` with a `state` we can recognise.
 *   2. Meta redirects back with `?code=…&state=…`.
 *   3. Exchange the code for a short-lived **user** token.  (server)
 *   4. Exchange that for a long-lived user token.            (server)
 *   5. `GET /me/accounts` → the Pages they administer, each with a Page token.
 *
 * Step 5 is the payoff: a Page token obtained this way inherits the long-lived
 * user token's life, which is what makes it worth having over a pasted one.
 */

/** The permissions a Page needs to be readable by this product. */
export const CONNECT_SCOPES = [
  // The list of Pages they administer. Without it `/me/accounts` is empty and
  // there is nothing to choose from.
  "pages_show_list",
  // Post and video engagement — reactions, comments, shares.
  "pages_read_engagement",
  // Comment text, which the analysis reads.
  "pages_read_user_content",
  // Page and post insights: reach, views, follower counts.
  "read_insights",
] as const;

export type ManagedPage = {
  id: string;
  name: string;
  category: string | null;
  /**
   * The Page token. Present in the Graph response and deliberately typed here,
   * because this module is where it legitimately exists — every caller must
   * encrypt it or drop it, and none may return it to a browser.
   */
  accessToken: string;
};

export type OAuthOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Where the streamer is sent to approve.
 *
 * `config_id` when the deployment has one, `scope` otherwise. Facebook Login
 * for Business builds the permission set into a configuration in the app
 * dashboard and takes its id here; classic Facebook Login takes the list
 * inline. Supporting both means a workspace can adopt the newer flow without a
 * code change, and one that has not yet still works.
 *
 * `state` is the CSRF defence: the caller mints it, stores it in an
 * httpOnly cookie, and the callback refuses anything that does not match. Meta
 * echoes it back untouched.
 */
export function buildAuthorizeUrl(params: { state: string; redirectUri: string }): string {
  const env = getServerEnv();
  const version = env.META_GRAPH_API_VERSION;

  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("response_type", "code");

  const configId = env.META_LOGIN_CONFIG_ID;
  if (configId) {
    url.searchParams.set("config_id", configId);
  } else {
    url.searchParams.set("scope", CONNECT_SCOPES.join(","));
  }

  return url.toString();
}

/**
 * Read Meta's error out of a response body, whatever shape it arrived in.
 *
 * Returned to the streamer, so it says what went wrong without naming
 * internals. Never includes a token: the only credential in these requests is
 * the app secret, which is in the query rather than the body, and `redactUrl`
 * covers anything logged.
 */
function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error && typeof error === "object" && typeof error.message === "string") {
      return error.message;
    }
  }
  return fallback;
}

async function getJson(url: URL, fallback: string): Promise<OAuthOutcome<unknown>> {
  try {
    // `cache: no-store` because these are one-time credential exchanges. A
    // cached authorization-code response would be both useless and a credential
    // sitting in a cache.
    const response = await fetch(url.toString(), { cache: "no-store" });
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) return { ok: false, message: messageFrom(body, fallback) };

    return { ok: true, data: body };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? `Could not reach Facebook: ${cause.message}` : fallback,
    };
  }
}

/** Step 3: the one-time code becomes a short-lived user token. */
export async function exchangeCodeForUserToken(params: {
  code: string;
  redirectUri: string;
}): Promise<OAuthOutcome<{ accessToken: string; expiresInSeconds: number | null }>> {
  const env = getServerEnv();

  /*
   * `redirect_uri` must be byte-identical to the one sent to the dialog. Meta
   * compares them and rejects a mismatch — which is why both come from
   * `connectRedirectUri()` rather than being written out twice.
   */
  const url = buildGraphUrl("/oauth/access_token", {
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const result = await getJson(url, "Facebook refused the sign-in.");
  if (!result.ok) return result;

  const data = result.data as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string") {
    return { ok: false, message: "Facebook returned no access token." };
  }

  return {
    ok: true,
    data: {
      accessToken: data.access_token,
      expiresInSeconds: typeof data.expires_in === "number" ? data.expires_in : null,
    },
  };
}

/**
 * Step 4: short-lived becomes long-lived — roughly sixty days.
 *
 * Worth the extra round trip. A Page token derived from a short-lived user
 * token expires in about an hour, which would mean every streamer reconnecting
 * before the first nightly sweep ever ran.
 */
export async function exchangeForLongLivedUserToken(
  shortLivedToken: string,
): Promise<OAuthOutcome<{ accessToken: string; expiresInSeconds: number | null }>> {
  const env = getServerEnv();

  const url = buildGraphUrl("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: shortLivedToken,
  });

  const result = await getJson(url, "Facebook refused to extend the sign-in.");
  if (!result.ok) return result;

  const data = result.data as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string") {
    return { ok: false, message: "Facebook returned no long-lived token." };
  }

  return {
    ok: true,
    data: {
      accessToken: data.access_token,
      expiresInSeconds: typeof data.expires_in === "number" ? data.expires_in : null,
    },
  };
}

/**
 * Step 5: the Pages this person administers, each with its own Page token.
 *
 * Returns tokens because the caller needs one to store. Nothing that reaches a
 * browser may be built from this shape without dropping `accessToken` first —
 * `toChoice` below exists so that is one call rather than a habit.
 */
export async function listManagedPages(
  userToken: string,
): Promise<OAuthOutcome<ManagedPage[]>> {
  const url = buildGraphUrl("/me/accounts", {
    fields: "id,name,category,access_token",
    limit: "100",
    access_token: userToken,
  });

  const result = await getJson(url, "Could not read your Pages from Facebook.");
  if (!result.ok) return result;

  const data = result.data as { data?: unknown };
  if (!Array.isArray(data.data)) {
    return { ok: false, message: "Facebook returned an unexpected list of Pages." };
  }

  const pages: ManagedPage[] = [];

  for (const raw of data.data) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;

    // A Page with no token is one this person cannot grant access to. Listing
    // it would offer a choice that fails at the last step.
    if (typeof node["id"] !== "string" || typeof node["access_token"] !== "string") continue;

    pages.push({
      id: node["id"],
      name: typeof node["name"] === "string" ? node["name"] : node["id"],
      category: typeof node["category"] === "string" ? node["category"] : null,
      accessToken: node["access_token"],
    });
  }

  return { ok: true, data: pages };
}

/** A Page as the browser may see it. The token is dropped, by construction. */
export type PageChoice = { id: string; name: string; category: string | null };

export function toChoice(page: ManagedPage): PageChoice {
  return { id: page.id, name: page.name, category: page.category };
}

/**
 * The redirect target, in one place.
 *
 * Meta compares this byte-for-byte between the dialog and the code exchange,
 * and it must also be listed under "Valid OAuth Redirect URIs" in the app
 * dashboard. Deriving it once means those three can never drift apart.
 */
export function connectRedirectUri(origin: string): string {
  return `${origin}/api/connect/callback`;
}
