/**
 * Mocked Meta Graph API payloads.
 *
 * ## No real credentials, ever
 *
 * Every token-shaped string here is synthetic. `FAKE_PAGE_TOKEN` carries the
 * `EAA` prefix a real Meta token has — because the detectors in
 * `lib/automation/token-material.ts` and `lib/automation/sanitise.ts` key on
 * that prefix, and a fixture that did not look like a token would not exercise
 * them. It is followed by an obvious marker so nobody can mistake it for a
 * credential, and it authenticates against nothing.
 *
 * ## Shapes copied from the real thing
 *
 * The envelope shapes — `{ data: [...], paging: { cursors, next } }`, the
 * `{ error: { message, type, code, error_subcode, fbtrace_id } }` body, the
 * `reactions.limit(0).summary(true)` count form — mirror what the Graph API
 * actually returns. A fixture that is merely plausible tests the code against
 * an API that does not exist.
 */

export const FAKE_PAGE_TOKEN = "EAA_TEST_FAKE_TOKEN_NOT_A_REAL_CREDENTIAL_0000000000";
export const FAKE_PAGE_ID = "102938475610293";
export const FAKE_STREAMER_CODE = "CBS-TEST";

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** `GET /{page-id}/published_posts` — one page of results, no `next`. */
export function publishedPostsPage(count = 2) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      id: `${FAKE_PAGE_ID}_${8800 + index}`,
      message: `Ranked grind night ${index + 1}`,
      created_time: `2026-07-${String(20 + index).padStart(2, "0")}T18:00:00+0000`,
      permalink_url: `https://facebook.com/${FAKE_PAGE_ID}/posts/${8800 + index}`,
      reactions: { data: [], summary: { total_count: 400 + index } },
      comments: { data: [], summary: { total_count: 60 + index } },
      // `shares` deliberately absent on the first post: Meta omits it entirely
      // when a post has none, which is the case the whole
      // missing-is-never-zero rule exists for.
      ...(index > 0 ? { shares: { count: 12 } } : {}),
    })),
    paging: { cursors: { before: "BEFORE", after: "AFTER" } },
  };
}

/** A post with no id — Meta occasionally returns partial entries. */
export const MALFORMED_POST = { message: "no id here", created_time: "2026-07-20T18:00:00+0000" };

/** `GET /{post-id}/insights`, with the full range of value shapes. */
export const POST_INSIGHTS_RESPONSE = {
  data: [
    {
      name: "post_impressions",
      period: "lifetime",
      values: [{ value: 12_345 }],
      title: "Post impressions",
    },
    {
      name: "post_reactions_by_type_total",
      period: "lifetime",
      values: [{ value: { like: 301, love: 88, wow: 23 } }],
    },
    {
      name: "post_video_views",
      period: "day",
      values: [
        { value: 950, end_time: "2026-07-21T07:00:00+0000" },
        { value: 1120, end_time: "2026-07-22T07:00:00+0000" },
      ],
    },
    // Present but valueless. Must be recorded as unavailable, never as 0.
    { name: "post_clicks", period: "lifetime", values: [] },
  ],
};

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export function pageVideosPage(count = 2) {
  return {
    data: Array.from({ length: count }, (_, index) => ({
      id: `${FAKE_PAGE_ID}_v${900 + index}`,
      title: `Friday night VOD ${index + 1}`,
      description: "Climbing to diamond",
      created_time: `2026-07-${String(20 + index).padStart(2, "0")}T20:00:00+0000`,
      permalink_url: `https://facebook.com/watch/?v=${900 + index}`,
      // Fractional: Meta reports video length with sub-second precision.
      length: 7325.5 + index,
    })),
    paging: { cursors: { before: "BEFORE", after: "AFTER" } },
  };
}

export const VIDEO_INSIGHTS_RESPONSE = {
  data: [
    { name: "total_video_views", period: "lifetime", values: [{ value: 8_400 }] },
    {
      name: "video_retention_graph",
      period: "lifetime",
      values: [{ value: [1, 0.9, 0.72, 0.51, 0.4] }],
    },
    {
      name: "total_video_view_time_by_age_bucket_and_gender",
      period: "lifetime",
      values: [{ value: { "M.25-34": 12_000, "F.25-34": 9_400 } }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * `GET /{content-id}/comments`.
 *
 * Note what is **not** here: a `from` object. The application never requests
 * commenter identity, so a fixture that supplied one would be testing against a
 * response this system cannot receive.
 */
export function commentsPage(messages: string[], startId = 1) {
  return {
    data: messages.map((message, index) => ({
      id: `${FAKE_PAGE_ID}_c${startId + index}`,
      message,
      created_time: `2026-07-21T${String(10 + index).padStart(2, "0")}:00:00+0000`,
      like_count: index,
      comment_count: 0,
    })),
    paging: { cursors: { before: "BEFORE", after: "AFTER" } },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Meta's error envelope, as it actually arrives. */
export function metaErrorBody(params: {
  message: string;
  code: number;
  subcode?: number;
  type?: string;
}) {
  return {
    error: {
      message: params.message,
      type: params.type ?? "OAuthException",
      code: params.code,
      ...(params.subcode !== undefined ? { error_subcode: params.subcode } : {}),
      fbtrace_id: "AbCdEfGhIjK",
    },
  };
}

/** 190/463 — the token has expired. */
export const EXPIRED_TOKEN_ERROR = metaErrorBody({
  message: "Error validating access token: Session has expired.",
  code: 190,
  subcode: 463,
});

/** 200 — the token works but lacks a permission. */
export const MISSING_PERMISSION_ERROR = metaErrorBody({
  message: "(#200) Requires pages_read_engagement permission to manage the object",
  code: 200,
  type: "OAuthException",
});

/** 4 — the app-level rate limit. */
export const RATE_LIMIT_ERROR = metaErrorBody({
  message: "(#4) Application request limit reached",
  code: 4,
  type: "OAuthException",
});

/**
 * An error whose message echoes the request back — including the token.
 *
 * This is the case that makes outbound sanitisation necessary rather than
 * merely tidy: forwarding it verbatim would put a live credential into an n8n
 * execution log.
 */
export const ERROR_ECHOING_TOKEN = metaErrorBody({
  message: `Unsupported get request for GET /me?access_token=${FAKE_PAGE_TOKEN}&fields=id,name`,
  code: 100,
  type: "GraphMethodException",
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/** `GET /me?fields=id,name` for a Page token. */
export function meResponse(pageId = FAKE_PAGE_ID) {
  return { id: pageId, name: "CBSOFT Test Page" };
}

/** `GET /debug_token` for a healthy Page token. */
export function debugTokenResponse(params: {
  pageId?: string;
  scopes?: string[];
  expiresAt?: number;
  isValid?: boolean;
}) {
  return {
    data: {
      app_id: "1234567890",
      type: "PAGE",
      application: "CBSOFT Test App",
      // 0 means "never expires", which is what a long-lived Page token reports.
      expires_at: params.expiresAt ?? 0,
      is_valid: params.isValid ?? true,
      profile_id: params.pageId ?? FAKE_PAGE_ID,
      scopes: params.scopes ?? [
        "pages_show_list",
        "pages_read_engagement",
        "read_insights",
        "pages_read_user_content",
      ],
    },
  };
}
