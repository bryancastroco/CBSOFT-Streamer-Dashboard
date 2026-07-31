import "server-only";

import { graphRequest } from "@/lib/meta/client";

/**
 * Turn a Page token that expires into one that does not.
 *
 * ## What Meta actually does, verified rather than assumed
 *
 * Probed against both stored Pages on 2026-07-31, Graph v25.0. A Page token
 * showing a sixty-day expiry was put through both documented paths:
 *
 *   GET /oauth/access_token
 *       ?grant_type=fb_exchange_token    → token whose debug showed the SAME expiry
 *   GET /{page-id}?fields=access_token   → token whose debug showed expires_at = 0
 *
 * Afterwards the *originally stored* token also debugged as `expires_at = 0`.
 * A Page token's expiry is inherited from the user grant behind it, so one of
 * those calls extended that grant and every derived Page token with it.
 *
 * Which one is not established. `fb_exchange_token` is the likelier candidate —
 * extending the underlying token is its documented purpose — but the two ran
 * seconds apart and the observation cannot separate them. What is established
 * is that the Page-field read reports the permanent value immediately, so it is
 * what this uses: a path whose *response* is trustworthy beats one whose effect
 * has to be inferred from a later check.
 *
 * ## The hard limit
 *
 * Every path requires a token that is **still valid**. An expired token cannot
 * be refreshed, extended, or exchanged — Meta answers `(190) Session has
 * expired` to all of them. Once a token lapses, only a human signing into
 * Facebook can produce another. That is why this runs *before* expiry and why
 * an expiring token is worth acting on rather than merely reporting.
 *
 * ## What "never expires" does not cover
 *
 * `data_access_expires_at` is a separate clock. Meta cuts an app off from a
 * user's data roughly ninety days after that user last engaged with it,
 * whatever the token says, and no server-side call resets it. A permanent token
 * removes the routine sixty-day failure; it does not remove the need for the
 * Page admin to reconnect periodically.
 */

export type TokenExtension =
  | {
      status: "extended";
      /** The replacement. Caller encrypts it; it is never logged or returned. */
      token: string;
      /** Null means Meta reported no expiry at all — the outcome worth having. */
      expiresAt: Date | null;
    }
  | {
      /** Already permanent, or already as long-lived as Meta will make it. */
      status: "unchanged";
      reason: string;
      /**
       * What Meta says the expiry is, which is not always what we stored.
       *
       * `token_expires_at` is our cache, written at the last validation. It can
       * be stale in the direction that matters: this Page's column read
       * "28 September" while Meta already considered the token permanent, so
       * the UI kept warning about a deadline that no longer existed. Returning
       * the observed value lets the caller correct the record even when there
       * is no token to rotate.
       */
      expiresAt: Date | null | undefined;
    }
  | {
      status: "failed";
      /** Safe to surface: Meta's own wording, never the token. */
      message: string;
      /** True when the token is past saving and a human must re-authenticate. */
      needsReauthentication: boolean;
    };

type PageTokenEnvelope = { access_token?: string; id?: string };

type DebugEnvelope = {
  data?: { expires_at?: number; is_valid?: boolean; type?: string };
};

/**
 * Ask Meta when a token expires. `null` means never.
 *
 * Zero is Meta's own encoding for "no expiry", and it is the whole point of
 * this module — so it is translated once, here, rather than left for every
 * caller to remember.
 */
async function expiryOf(token: string, appProof: string): Promise<Date | null | undefined> {
  const outcome = await graphRequest<DebugEnvelope>("debug_token", {
    token: appProof,
    params: { input_token: token },
    context: "unknown",
  });

  if (!outcome.ok) return undefined;

  const expiresAt = outcome.data.data?.expires_at;
  if (expiresAt === undefined) return undefined;

  return expiresAt === 0 ? null : new Date(expiresAt * 1000);
}

/**
 * Obtain a non-expiring Page token, given one that still works.
 *
 * Returns `unchanged` rather than an error when the token is already permanent
 * — that is a success, and treating it as a failure would make a healthy
 * roster look broken every night.
 */
export async function extendPageToken(params: {
  token: string;
  pageId: string;
  appId: string;
  appSecret: string;
}): Promise<TokenExtension> {
  const appProof = `${params.appId}|${params.appSecret}`;

  const current = await expiryOf(params.token, appProof);

  if (current === null) {
    return {
      status: "unchanged",
      reason: "This token already has no expiry.",
      expiresAt: null,
    };
  }

  /*
   * The Page's own token field. Not the oauth exchange — that returns another
   * token with the same sixty-day expiry, which is indistinguishable from
   * success until the day it stops working.
   */
  const outcome = await graphRequest<PageTokenEnvelope>(params.pageId, {
    token: params.token,
    params: { fields: "access_token" },
    context: "page",
  });

  if (!outcome.ok) {
    const error = outcome.error;

    /*
     * 190 is the whole family of "this token is no longer usable". There is no
     * recovery from it on the server, so say so plainly rather than letting an
     * operator retry a button that cannot work.
     */
    const needsReauthentication =
      error.code === 190 || /session has expired|access token/i.test(error.message);

    return {
      status: "failed",
      message: error.message,
      needsReauthentication,
    };
  }

  const replacement = outcome.data.access_token;

  if (!replacement) {
    return {
      status: "failed",
      message: "Meta returned no access token for this Page.",
      needsReauthentication: false,
    };
  }

  const expiresAt = await expiryOf(replacement, appProof);

  if (expiresAt === undefined) {
    return {
      status: "failed",
      message: "The replacement token could not be inspected, so it was not stored.",
      needsReauthentication: false,
    };
  }

  /*
   * Refuse a replacement that is no better than what we hold. Rotating a
   * credential buys nothing here and costs the audit noise of a change that
   * did not change anything.
   */
  if (expiresAt !== null && current !== undefined && expiresAt <= current) {
    return {
      status: "unchanged",
      reason: "Meta offered no longer-lived token than the one already stored.",
      expiresAt: current,
    };
  }

  return { status: "extended", token: replacement, expiresAt };
}
