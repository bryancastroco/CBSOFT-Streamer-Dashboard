import "server-only";

import { debugToken, fetchTokenIdentity } from "@/lib/meta/graph";
import { deriveTokenStatus, type TokenValidation } from "@/lib/meta/token-status";

/**
 * Validate a Page access token against the Meta Graph API.
 *
 * Two calls, per the Phase 3 specification:
 *
 *   GET /{version}/me?fields=id,name&access_token={token}
 *       — proves the token authenticates, and identifies the Page it belongs
 *         to so it can be matched against the entered Page ID.
 *
 *   GET /debug_token?input_token={token}&access_token={app_id}|{app_secret}
 *       — reveals expiry and granted scopes, which /me does not.
 *
 * The plaintext token exists only as this function's argument and inside the
 * two request URLs. It is never returned, never persisted by this function,
 * and never placed in the result — `TokenValidation` has no field that could
 * hold one.
 */
export async function validatePageToken(params: {
  token: string;
  expectedPageId: string;
  now?: Date;
}): Promise<TokenValidation> {
  const now = params.now ?? new Date();

  const identity = await fetchTokenIdentity(params.token);

  // Skip the second call when the first already disqualified the token: there
  // is nothing useful to learn, and it avoids a needless credentialed request.
  const shouldDebug = identity.ok;
  const debug = shouldDebug ? await debugToken(params.token) : null;

  return deriveTokenStatus({
    expectedPageId: params.expectedPageId,
    identity,
    debug,
    now,
  });
}
