/**
 * Meta Graph API error taxonomy — a PURE module.
 *
 * Every failure the client can produce is normalised into one of nine
 * categories. Callers branch on the category, never on a raw Meta code, so the
 * mapping lives in one testable place instead of being re-derived at each call
 * site.
 *
 * No function here receives a token, so no message it produces can contain one.
 */

export const META_ERROR_CATEGORIES = [
  "invalid_token",
  "expired_token",
  "missing_permission",
  "rate_limited",
  "page_unavailable",
  "content_unavailable",
  "network_error",
  "meta_api_error",
  "unknown_error",
] as const;

export type MetaErrorCategory = (typeof META_ERROR_CATEGORIES)[number];

/** The error envelope Meta returns on a failed Graph call. */
export type GraphApiError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

export type NormalizedMetaError = {
  category: MetaErrorCategory;
  /** Operator-readable. Safe to persist and display. Never token material. */
  message: string;
  /** Whether retrying the identical request could plausibly succeed. */
  retryable: boolean;
  code?: number;
  subcode?: number;
  httpStatus?: number;
  fbtraceId?: string;
  /** Seconds to wait before retrying, when Meta or the transport told us. */
  retryAfterSeconds?: number;
};

// ---------------------------------------------------------------------------
// Meta's numeric vocabulary
// ---------------------------------------------------------------------------

const OAUTH_ERROR = 190;

/** Subcodes of 190 that mean the token is finished, not merely wrong. */
const EXPIRY_SUBCODES = new Set([
  458, // app not installed / re-auth required
  459, // user checkpointed
  460, // password changed
  463, // session expired
  464, // unconfirmed user
  467, // session invalidated
]);

/** Throttling. 4 and 17 are app/user rate limits; 613 is a custom-rate limit. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Business-use-case throttling, returned as 80000-series codes. */
function isBusinessRateLimit(code: number | undefined): boolean {
  return typeof code === "number" && code >= 80000 && code <= 80014;
}

/** Permission errors. 10 and the 200-299 band are "app lacks a capability". */
function isPermissionCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return code === 10 || (code >= 200 && code <= 299);
}

/**
 * Code 100 subcode 33 is Meta's catch-all for "this object does not exist, or
 * you do not have permission to see it" — deliberately indistinguishable, so
 * it maps to unavailability rather than to a permission problem.
 */
const NONEXISTENT_SUBCODE = 33;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function describe(error: GraphApiError, fallback: string): string {
  // error_user_msg is the human-facing text when Meta supplies one.
  return error.error_user_msg?.trim() || error.message?.trim() || fallback;
}

/**
 * Map a Graph API error envelope onto a category.
 *
 * `context` lets the caller say whether the request targeted a Page or a piece
 * of content, which is the only way to distinguish `page_unavailable` from
 * `content_unavailable` — Meta reports both as code 100.
 */
export function normalizeGraphApiError(
  error: GraphApiError,
  httpStatus: number,
  context: "page" | "content" | "unknown" = "unknown",
): NormalizedMetaError {
  const code = error.code;
  const subcode = error.error_subcode;

  const base = {
    code,
    subcode,
    httpStatus,
    ...(error.fbtrace_id ? { fbtraceId: error.fbtrace_id } : {}),
  };

  // --- Token problems ------------------------------------------------------
  if (code === OAUTH_ERROR) {
    if (subcode !== undefined && EXPIRY_SUBCODES.has(subcode)) {
      return {
        ...base,
        category: "expired_token",
        message: describe(error, "The Page access token has expired or been revoked."),
        // Retrying with the same dead token cannot help.
        retryable: false,
      };
    }

    return {
      ...base,
      category: "invalid_token",
      message: describe(error, "Meta rejected the Page access token."),
      retryable: false,
    };
  }

  // --- Throttling ----------------------------------------------------------
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || isBusinessRateLimit(code)) {
    return {
      ...base,
      category: "rate_limited",
      message: describe(error, "Meta is rate limiting this application."),
      retryable: true,
    };
  }

  // --- Permissions ---------------------------------------------------------
  if (isPermissionCode(code)) {
    return {
      ...base,
      category: "missing_permission",
      message: describe(error, "The token does not grant permission for this request."),
      retryable: false,
    };
  }

  // --- Existence -----------------------------------------------------------
  if (code === 803 || (code === 100 && subcode === NONEXISTENT_SUBCODE)) {
    const unavailable = context === "page" ? "page_unavailable" : "content_unavailable";
    return {
      ...base,
      category: unavailable,
      message: describe(
        error,
        context === "page"
          ? "The Facebook Page is unavailable, or the token cannot see it."
          : "The content is unavailable, or the token cannot see it.",
      ),
      retryable: false,
    };
  }

  if (code === 100) {
    // Code 100 without subcode 33 is usually a malformed request — a bad field
    // name or parameter. Retrying identically will fail identically.
    return {
      ...base,
      category: "meta_api_error",
      message: describe(error, "Meta rejected the request as invalid."),
      retryable: false,
    };
  }

  // --- Anything else Meta reported ----------------------------------------
  if (code !== undefined || error.message) {
    // 5xx is Meta's problem and often transient; 4xx is ours and is not.
    const retryable = httpStatus >= 500 || code === 2;
    return {
      ...base,
      category: "meta_api_error",
      message: describe(error, `Meta returned an error (HTTP ${httpStatus}).`),
      retryable,
    };
  }

  return {
    ...base,
    category: "unknown_error",
    message: `Unrecognised response from Meta (HTTP ${httpStatus}).`,
    retryable: httpStatus >= 500,
  };
}

/** Transport-level failure: DNS, TLS, connection reset, timeout. */
export function normalizeTransportError(cause: unknown): NormalizedMetaError {
  const isTimeout =
    cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");

  return {
    category: "network_error",
    message: isTimeout ? "The request to Meta timed out." : "Could not reach the Meta Graph API.",
    retryable: true,
  };
}

/** A failure that is not a Graph error and not a transport error. */
export function normalizeUnknownError(cause: unknown): NormalizedMetaError {
  return {
    category: "unknown_error",
    message:
      cause instanceof Error
        ? `Unexpected failure: ${cause.message}`
        : "Unexpected failure while calling Meta.",
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const META_ERROR_LABELS: Record<MetaErrorCategory, string> = {
  invalid_token: "Invalid token",
  expired_token: "Expired token",
  missing_permission: "Missing permission",
  rate_limited: "Rate limited",
  page_unavailable: "Page unavailable",
  content_unavailable: "Content unavailable",
  network_error: "Network error",
  meta_api_error: "Meta API error",
  unknown_error: "Unknown error",
};

/**
 * Categories that mean "this streamer's token needs an admin", as opposed to
 * "try again later". Used to flag the streamer after a failed run.
 */
export function indicatesTokenProblem(category: MetaErrorCategory): boolean {
  return (
    category === "invalid_token" ||
    category === "expired_token" ||
    category === "missing_permission"
  );
}
