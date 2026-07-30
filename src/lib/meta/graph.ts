import "server-only";

import { getServerEnv } from "@/config/env";
import { buildGraphUrl, graphRequest, redactUrl, type GraphOutcome } from "@/lib/meta/client";
import type { GraphApiError } from "@/lib/meta/errors";

/**
 * Token identification and inspection.
 *
 * The request engine lives in `client.ts`; this module is the two Graph calls
 * that Phase 3 token validation needs, expressed in the result shape
 * `token-status.ts` consumes.
 *
 * Architecture rules 6 and 7 still hold: every call happens on the server, and
 * only Pages are supported — enforced by comparing the `/me` id against the
 * entered Page ID.
 */

export { buildGraphUrl, redactUrl };
export type { GraphApiError };

/**
 * The Phase 3 result shape. Retained because `token-status.ts` is a pure module
 * that branches on `kind`, and because it distinguishes "Meta said no" from
 * "we never reached Meta" — a distinction that matters for token health.
 */
export type GraphResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "api_error"; error: GraphApiError; httpStatus: number }
  | { ok: false; kind: "network_error"; message: string };

/** Adapt the normalised client outcome to the token-validation result shape. */
function toGraphResult<T>(outcome: GraphOutcome<T>): GraphResult<T> {
  if (outcome.ok) return { ok: true, data: outcome.data };

  const { error } = outcome;

  if (error.category === "network_error") {
    return { ok: false, kind: "network_error", message: error.message };
  }

  return {
    ok: false,
    kind: "api_error",
    httpStatus: error.httpStatus ?? 0,
    error: {
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.subcode !== undefined ? { error_subcode: error.subcode } : {}),
      ...(error.fbtraceId ? { fbtrace_id: error.fbtraceId } : {}),
    },
  };
}

/**
 * Token validation runs while an admin waits, so it retries once rather than
 * the default three times — a fast honest answer beats a slow one.
 */
const VALIDATION_RETRY_POLICY = {
  maxRetries: 1,
  baseDelayMs: 400,
  maxDelayMs: 2_000,
  factor: 2,
} as const;

// ---------------------------------------------------------------------------

export type GraphMeResponse = {
  id: string;
  name?: string;
  category?: string;
};

/**
 * Identify the node a Page access token belongs to.
 *
 * A user token resolves to a person here, which can never match a Page ID —
 * that comparison is what keeps personal profiles out of the system.
 */
export async function fetchTokenIdentity(token: string): Promise<GraphResult<GraphMeResponse>> {
  const outcome = await graphRequest<GraphMeResponse>("me", {
    token,
    params: { fields: "id,name" },
    context: "page",
    retryPolicy: VALIDATION_RETRY_POLICY,
  });

  return toGraphResult(outcome);
}

// ---------------------------------------------------------------------------

export type DebugTokenData = {
  app_id?: string;
  type?: string;
  application?: string;
  /** Unix seconds. 0 or absent means "never expires". */
  expires_at?: number;
  data_access_expires_at?: number;
  is_valid?: boolean;
  scopes?: string[];
  granular_scopes?: { scope: string; target_ids?: string[] }[];
  profile_id?: string;
  user_id?: string;
  error?: { code?: number; subcode?: number; message?: string };
};

type DebugTokenEnvelope = { data: DebugTokenData };

/**
 * Inspect a token using the app's own credentials.
 *
 * The token being inspected goes in `input_token`; `access_token` carries the
 * app token `{app_id}|{app_secret}`. Assembled here so a caller cannot swap
 * them and leak the app secret's authority.
 */
export async function debugToken(token: string): Promise<GraphResult<DebugTokenData>> {
  const { META_APP_ID, META_APP_SECRET } = getServerEnv();

  const outcome = await graphRequest<DebugTokenEnvelope>("debug_token", {
    token: `${META_APP_ID}|${META_APP_SECRET}`,
    params: { input_token: token },
    unversioned: true,
    context: "unknown",
    retryPolicy: VALIDATION_RETRY_POLICY,
  });

  const result = toGraphResult(outcome);
  if (!result.ok) return result;

  return { ok: true, data: result.data?.data ?? {} };
}

/**
 * Guard used by the Page connection flow. Nodes on the `me/accounts` edge are
 * Pages exclusively; this re-validates before anything is persisted.
 */
export function isSupportedPageNode(node: { id?: string; category?: string }): boolean {
  return typeof node.id === "string" && node.id.length > 0 && typeof node.category === "string";
}
