import "server-only";

import { getServerEnv } from "@/config/env";
import {
  normalizeGraphApiError,
  normalizeTransportError,
  normalizeUnknownError,
  type GraphApiError,
  type NormalizedMetaError,
} from "@/lib/meta/errors";
import {
  DEFAULT_RETRY_POLICY,
  USAGE_SLOWDOWN_THRESHOLD,
  nextDelayMs,
  parseRetryAfter,
  parseUsagePercent,
  shouldRetry,
  sleep,
  type RetryPolicy,
} from "@/lib/meta/retry";
import { childLogger, type Logger } from "@/lib/observability/logger";

/**
 * The reusable Meta Graph API client.
 *
 * Everything that touches Meta goes through `graphRequest`, so timeout, retry,
 * rate-limit handling, error normalisation and logging are implemented once.
 *
 * ## Tokens
 *
 * A token is only ever a function argument, and it is placed in the query
 * string because that is the only transport the Graph API accepts. Consequently
 * **no URL from this module may be logged raw** — `redactUrl()` exists for that,
 * and the structured logger scrubs credential-shaped values as a second pass.
 * This module never decrypts anything; callers obtain a plaintext token through
 * `withStreamerToken()`, which keeps it inside a callback.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;

/** What the request is addressing, so a 100 can be attributed correctly. */
export type RequestContext = "page" | "content" | "unknown";

export type GraphSuccess<T> = { ok: true; data: T };
export type GraphFailure = { ok: false; error: NormalizedMetaError };
export type GraphOutcome<T> = GraphSuccess<T> | GraphFailure;

export type GraphRequestOptions = {
  token: string;
  params?: Record<string, string>;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  context?: RequestContext;
  logger?: Logger;
  /** Unversioned endpoints such as `/debug_token`. */
  unversioned?: boolean;
};

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

export function buildGraphUrl(path: string, params: Record<string, string> = {}): URL {
  const { META_GRAPH_API_VERSION } = getServerEnv();
  const normalised = path.replace(/^\/+/, "");

  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${normalised}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

export function buildRootGraphUrl(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`https://graph.facebook.com/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/**
 * Strip credentials from a URL so it is safe to log or embed in an error.
 * Every code path that mentions a URL must go through this.
 */
export function redactUrl(url: URL | string): string {
  const copy = new URL(url.toString());
  for (const key of ["access_token", "input_token", "client_secret"]) {
    if (copy.searchParams.has(key)) copy.searchParams.set(key, "[redacted]");
  }
  return copy.toString();
}

/** The path portion only — enough to identify an endpoint in a log line. */
function endpointOf(url: URL): string {
  return url.pathname;
}

// ---------------------------------------------------------------------------
// The request engine
// ---------------------------------------------------------------------------

type AttemptResult<T> =
  { kind: "success"; data: T } | { kind: "failure"; error: NormalizedMetaError };

async function attempt<T>(
  url: URL,
  timeoutMs: number,
  context: RequestContext,
): Promise<AttemptResult<T>> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      // A metrics read must never be served from a cache.
      cache: "no-store",
    });
  } catch (cause) {
    return { kind: "failure", error: normalizeTransportError(cause) };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body on a failed response is normal (HTML error pages).
    body = null;
  }

  const hasError = Boolean(body && typeof body === "object" && "error" in body);

  if (response.ok && !hasError) {
    return { kind: "success", data: body as T };
  }

  const envelope: GraphApiError = hasError
    ? ((body as { error: GraphApiError }).error ?? {})
    : { message: `Graph API returned HTTP ${response.status}` };

  const error = normalizeGraphApiError(envelope, response.status, context);

  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== undefined) error.retryAfterSeconds = retryAfter;

  return { kind: "failure", error };
}

/**
 * Perform a Graph request with timeout, retry and rate-limit handling.
 *
 * Retries only what could plausibly succeed on repetition — throttling,
 * transport failures and Meta 5xx. An invalid token or a missing permission is
 * returned immediately; retrying those wastes quota and delays the real
 * feedback the operator needs.
 */
export async function graphRequest<T>(
  path: string,
  options: GraphRequestOptions,
): Promise<GraphOutcome<T>> {
  const {
    token,
    params = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryPolicy = DEFAULT_RETRY_POLICY,
    context = "unknown",
    unversioned = false,
  } = options;

  const url = unversioned
    ? buildRootGraphUrl(path, { ...params, access_token: token })
    : buildGraphUrl(path, { ...params, access_token: token });

  const log = options.logger ?? childLogger({ component: "meta.client" });
  const endpoint = endpointOf(url);

  let lastError: NormalizedMetaError = {
    category: "unknown_error",
    message: "Request was never attempted.",
    retryable: false,
  };

  for (let tries = 0; tries <= retryPolicy.maxRetries; tries += 1) {
    const startedAt = Date.now();

    let result: AttemptResult<T>;
    try {
      result = await attempt<T>(url, timeoutMs, context);
    } catch (cause) {
      result = { kind: "failure", error: normalizeUnknownError(cause) };
    }

    const durationMs = Date.now() - startedAt;

    if (result.kind === "success") {
      log.debug("graph.request.ok", { endpoint, attempt: tries, durationMs });
      return { ok: true, data: result.data };
    }

    lastError = result.error;

    const retrying = shouldRetry(lastError, tries, retryPolicy);

    log.warn("graph.request.failed", {
      endpoint,
      attempt: tries,
      durationMs,
      category: lastError.category,
      code: lastError.code,
      subcode: lastError.subcode,
      httpStatus: lastError.httpStatus,
      fbtraceId: lastError.fbtraceId,
      retrying,
      // The message is redacted by the logger before it is emitted.
      message: lastError.message,
    });

    if (!retrying) break;

    await sleep(nextDelayMs(tries, lastError, retryPolicy));
  }

  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export type GraphPage<T> = {
  data: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
    previous?: string;
  };
};

export type PaginateOptions = GraphRequestOptions & {
  /** Hard stop, so a runaway cursor cannot loop forever. */
  maxPages?: number;
  /** Stop early — e.g. once a post older than the sync window is reached. */
  stopWhen?: (item: unknown) => boolean;
};

export const DEFAULT_MAX_PAGES = 25;

export type PaginateOutcome<T> = {
  items: T[];
  pagesFetched: number;
  /** Set when pagination stopped because of a failure rather than exhaustion. */
  error?: NormalizedMetaError;
  /** True when `maxPages` was hit with more data still available. */
  truncated: boolean;
};

/**
 * Follow Meta's `paging.next` cursors, accumulating `data`.
 *
 * Partial results are returned alongside the error rather than discarded: 200
 * posts collected before a rate limit are still 200 posts, and throwing them
 * away would make every subsequent run start from nothing.
 */
export async function graphPaginate<T>(
  path: string,
  options: PaginateOptions,
): Promise<PaginateOutcome<T>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const log = options.logger ?? childLogger({ component: "meta.client" });

  const items: T[] = [];
  let pagesFetched = 0;
  let nextUrl: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const outcome: GraphOutcome<GraphPage<T>> = nextUrl
      ? await graphRequestAbsolute<GraphPage<T>>(nextUrl, options)
      : await graphRequest<GraphPage<T>>(path, options);

    if (!outcome.ok) {
      return { items, pagesFetched, error: outcome.error, truncated: false };
    }

    pagesFetched += 1;
    const batch = outcome.data.data ?? [];
    items.push(...batch);

    if (options.stopWhen && batch.some((item) => options.stopWhen?.(item))) {
      log.debug("graph.paginate.stopped_early", { pagesFetched, collected: items.length });
      return { items, pagesFetched, truncated: false };
    }

    nextUrl = outcome.data.paging?.next ?? null;
    if (!nextUrl) {
      return { items, pagesFetched, truncated: false };
    }
  }

  log.warn("graph.paginate.truncated", { pagesFetched, collected: items.length, maxPages });
  return { items, pagesFetched, truncated: true };
}

/**
 * Follow a `paging.next` URL, which already carries its own query string
 * including the access token.
 */
async function graphRequestAbsolute<T>(
  absoluteUrl: string,
  options: GraphRequestOptions,
): Promise<GraphOutcome<T>> {
  const url = new URL(absoluteUrl);

  // Meta echoes the token back in `paging.next`. Rebuild from the path and
  // params so the token in use is the one we were given, not one parsed out of
  // a response body.
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "access_token") continue;
    params[key] = value;
  }

  const path = url.pathname.replace(/^\/+/, "").replace(/^v\d+\.\d+\//, "");

  return graphRequest<T>(path, { ...options, params });
}

// ---------------------------------------------------------------------------
// Quota awareness
// ---------------------------------------------------------------------------

/**
 * Inspect Meta's usage headers and pause when the app is near its quota.
 *
 * Backing off before being throttled is cheaper than being throttled: Meta's
 * penalties lengthen with repeated violations.
 */
export async function respectUsageHeaders(
  headers: Headers,
  log: Logger = childLogger({ component: "meta.client" }),
): Promise<void> {
  const usage = Math.max(
    parseUsagePercent(headers.get("x-app-usage")) ?? 0,
    parseUsagePercent(headers.get("x-business-use-case-usage")) ?? 0,
  );

  if (usage >= USAGE_SLOWDOWN_THRESHOLD) {
    log.warn("graph.quota.slowdown", { usagePercent: usage });
    await sleep(2_000);
  }
}
