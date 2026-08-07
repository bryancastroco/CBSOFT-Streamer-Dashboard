import type { DebugTokenData, GraphMeResponse, GraphResult } from "@/lib/meta/graph";

/**
 * Token health derivation — a PURE module.
 *
 * Deliberately separated from the network layer so every verdict
 * (`invalid` Page ID, `expired`, `missing_permission`, …) can be tested
 * exhaustively without HTTP. `validatePageToken()` in `token-validation.ts`
 * does the fetching and then calls `deriveTokenStatus()` here.
 *
 * No function in this file receives a token, so no message it produces can
 * contain one.
 */

export const TOKEN_STATUSES = [
  "valid",
  "expiring",
  "expired",
  "invalid",
  "missing_permission",
  "unknown",
] as const;

export type TokenHealth = (typeof TOKEN_STATUSES)[number];

/** Includes the "no token stored" state, which is not a health verdict. */
export type TokenStatus = TokenHealth | "missing";

/**
 * Narrow a value read back as text.
 *
 * The roster query casts `token_status::text` so one raw statement can serve
 * several columns, and this is what turns that string back into the union
 * without asserting.
 */
export function isTokenStatus(value: unknown): value is TokenStatus {
  return (
    typeof value === "string" &&
    (value === "missing" || (TOKEN_STATUSES as readonly string[]).includes(value))
  );
}

/**
 * Scopes the sync engine cannot function without. Absent → `missing_permission`.
 */
export const REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
] as const;

/**
 * Wanted, but not fatal when absent. Reported rather than failing the token.
 *
 * ## Why this list must only contain scopes the product asks for
 *
 * It also held `pages_manage_metadata`, pencilled in for webhook subscriptions
 * that were never built. Nothing requests it: `CONNECT_SCOPES` does not, and
 * asking would contradict what the connect page promises an outside streamer —
 * "nothing is posted or changed" — since `manage` is a write permission. It was
 * removed from the Meta login configuration for exactly that reason.
 *
 * So every connected Page displayed a permission with a hollow circle beside
 * it, permanently, on a screen whose other four entries are things to fix. An
 * admin reading that reasonably asks the streamer to grant it, and the streamer
 * cannot: it is not on the consent dialog, because we never ask for it. An
 * indicator that can only ever be unsatisfied is worse than no indicator, and
 * it devalues the four beside it that mean something.
 *
 * `tests/token-scopes.test.ts` now holds the rule: nothing is reported here
 * that the connect flow does not request.
 */
export const RECOMMENDED_SCOPES = ["pages_read_user_content"] as const;

export const EXPECTED_SCOPES = [...REQUIRED_SCOPES, ...RECOMMENDED_SCOPES] as const;

/** A token expiring inside this window is reported as `expiring`. */
export const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Meta error codes that mean "this token is finished" rather than
 * "this request was wrong". Subcode 463 is the explicit expiry signal.
 */
const OAUTH_ERROR_CODE = 190;
const SUBCODE_EXPIRED = 463;
const SUBCODE_PASSWORD_CHANGED = 460;
const SUBCODE_UNCONFIRMED_USER = 464;
const SUBCODE_SESSION_INVALIDATED = 467;

export type TokenValidation = {
  status: TokenStatus;
  /** The Page the token actually belongs to, when it could be determined. */
  pageId: string | null;
  pageName: string | null;
  scopes: string[];
  missingRequiredScopes: string[];
  missingRecommendedScopes: string[];
  expiresAt: Date | null;
  /** Operator-readable explanation. Never contains token material. */
  message: string;
};

export type DeriveInput = {
  expectedPageId: string;
  identity: GraphResult<GraphMeResponse>;
  /** `null` when the debug call was not attempted. */
  debug: GraphResult<DebugTokenData> | null;
  now: Date;
};

function collectScopes(data: DebugTokenData): string[] {
  const scopes = new Set<string>(data.scopes ?? []);
  // Newer apps receive granular_scopes instead of, or alongside, scopes.
  for (const granular of data.granular_scopes ?? []) {
    if (granular.scope) scopes.add(granular.scope);
  }
  return [...scopes];
}

function isExpiryError(code: number | undefined, subcode: number | undefined): boolean {
  if (code !== OAUTH_ERROR_CODE) return false;
  return (
    subcode === SUBCODE_EXPIRED ||
    subcode === SUBCODE_PASSWORD_CHANGED ||
    subcode === SUBCODE_UNCONFIRMED_USER ||
    subcode === SUBCODE_SESSION_INVALIDATED
  );
}

const EMPTY = {
  pageId: null,
  pageName: null,
  scopes: [] as string[],
  missingRequiredScopes: [] as string[],
  missingRecommendedScopes: [] as string[],
  expiresAt: null,
};

/**
 * Decide a token's health from what the Graph API said.
 *
 * Order of checks is significant: a token that cannot authenticate at all is
 * not additionally reported as missing scopes, and an expired token's scope
 * list is moot.
 */
export function deriveTokenStatus(input: DeriveInput): TokenValidation {
  const { identity, debug, expectedPageId, now } = input;

  // ---- 1. Could we reach Meta at all? ------------------------------------
  if (!identity.ok && identity.kind === "network_error") {
    return {
      ...EMPTY,
      status: "unknown",
      message: `Could not verify the token: ${identity.message}.`,
    };
  }

  // ---- 2. Did the token authenticate? ------------------------------------
  if (!identity.ok) {
    const { code, error_subcode: subcode, message } = identity.error;

    if (isExpiryError(code, subcode)) {
      return {
        ...EMPTY,
        status: "expired",
        message: `Meta rejected the token as expired or revoked: ${message}`,
      };
    }

    return {
      ...EMPTY,
      status: "invalid",
      message: `Meta rejected the token: ${message}`,
    };
  }

  const pageId = identity.data.id ?? null;
  const pageName = identity.data.name ?? null;

  // ---- 3. Does it belong to the Page the admin entered? ------------------
  // This is also what keeps personal-profile tokens out: a user token resolves
  // to a person here, which can never match the entered Page ID.
  if (!pageId || pageId !== expectedPageId) {
    return {
      ...EMPTY,
      pageId,
      pageName,
      status: "invalid",
      message: pageId
        ? `This token belongs to Page ${pageId}${pageName ? ` (${pageName})` : ""}, not ${expectedPageId}. Check that you copied the token for the right Page.`
        : `The token did not resolve to a Facebook Page. Personal profile tokens are not supported.`,
    };
  }

  // ---- 4. Inspect expiry and scopes --------------------------------------
  if (!debug) {
    return {
      ...EMPTY,
      pageId,
      pageName,
      status: "unknown",
      message:
        "The token authenticated and matches the Page, but its permissions and expiry were not checked.",
    };
  }

  if (!debug.ok) {
    const reason =
      debug.kind === "network_error"
        ? debug.message
        : `${debug.error.message}${debug.error.code ? ` (code ${debug.error.code})` : ""}`;

    // The token demonstrably works — /me succeeded and the Page matched — so
    // reporting it as invalid would be wrong. We simply cannot see its scopes.
    // Usually this means META_APP_ID / META_APP_SECRET are not configured.
    return {
      ...EMPTY,
      pageId,
      pageName,
      status: "unknown",
      message: `The token authenticated and matches the Page, but permissions and expiry could not be verified: ${reason}. Check META_APP_ID and META_APP_SECRET.`,
    };
  }

  const data = debug.data;
  const scopes = collectScopes(data);
  const expiresAt =
    typeof data.expires_at === "number" && data.expires_at > 0
      ? new Date(data.expires_at * 1000)
      : null;

  const missingRequiredScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  const missingRecommendedScopes = RECOMMENDED_SCOPES.filter((scope) => !scopes.includes(scope));

  const base = {
    pageId,
    pageName,
    scopes,
    missingRequiredScopes,
    missingRecommendedScopes,
    expiresAt,
  };

  // ---- 5. Expired beats everything else ----------------------------------
  if (data.is_valid === false) {
    const subcode = data.error?.subcode;
    const expiredByClock = expiresAt !== null && expiresAt.getTime() <= now.getTime();

    if (subcode === SUBCODE_EXPIRED || expiredByClock) {
      return {
        ...base,
        status: "expired",
        message: data.error?.message
          ? `Token has expired: ${data.error.message}`
          : "Token has expired. Replace it with a freshly generated Page token.",
      };
    }

    return {
      ...base,
      status: "invalid",
      message: data.error?.message
        ? `Token is not valid: ${data.error.message}`
        : "Meta reports this token as not valid.",
    };
  }

  if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return {
      ...base,
      status: "expired",
      message: "Token has expired. Replace it with a freshly generated Page token.",
    };
  }

  // ---- 6. Scopes ---------------------------------------------------------
  if (missingRequiredScopes.length > 0) {
    return {
      ...base,
      status: "missing_permission",
      message: `Token is missing required permission${missingRequiredScopes.length === 1 ? "" : "s"}: ${missingRequiredScopes.join(", ")}. Re-generate it with these scopes granted.`,
    };
  }

  // ---- 7. Expiring soon --------------------------------------------------
  if (expiresAt !== null && expiresAt.getTime() - now.getTime() <= EXPIRING_WINDOW_MS) {
    return {
      ...base,
      status: "expiring",
      message: `Token expires on ${expiresAt.toISOString().slice(0, 10)}. Replace it before then to avoid a gap in metrics.`,
    };
  }

  // ---- 8. Healthy --------------------------------------------------------
  const caveat =
    missingRecommendedScopes.length > 0
      ? ` Optional permissions not granted: ${missingRecommendedScopes.join(", ")}.`
      : "";

  return {
    ...base,
    status: "valid",
    message: `Token is valid for ${pageName ?? `Page ${pageId}`}${expiresAt ? `, expires ${expiresAt.toISOString().slice(0, 10)}` : ", does not expire"}.${caveat}`,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = {
  missing: "No token",
  valid: "Valid",
  expiring: "Expiring soon",
  expired: "Expired",
  invalid: "Invalid",
  missing_permission: "Missing permission",
  unknown: "Unknown",
};

/** Maps a status onto a shadcn Badge variant. */
export function tokenStatusTone(
  status: TokenStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "valid":
      return "default";
    case "expiring":
    case "missing_permission":
    case "unknown":
      return "outline";
    case "expired":
    case "invalid":
      return "destructive";
    case "missing":
      return "secondary";
  }
}

/** True when an admin needs to act on this token. */
export function tokenNeedsAttention(status: TokenStatus): boolean {
  return status === "expired" || status === "invalid" || status === "missing_permission";
}
