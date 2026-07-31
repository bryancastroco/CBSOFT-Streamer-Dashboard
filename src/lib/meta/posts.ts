import "server-only";

import { graphPaginate, graphRequest, type GraphOutcome } from "@/lib/meta/client";
import type { NormalizedMetaError } from "@/lib/meta/errors";
import { POST_INSIGHT_METRIC_PARAM } from "@/lib/meta/insight-metrics";
import type { Logger } from "@/lib/observability/logger";

/**
 * Page post and post-insight retrieval.
 *
 * Two endpoints:
 *
 *   GET /{page-id}/published_posts   — the posts themselves, paginated
 *   GET /{post-id}/insights          — every metric Meta has for a post
 *
 * The insights call names its metrics explicitly, which it did not originally.
 * Graph v25 rejects a request with no `metric` parameter, so the schemaless
 * approach stopped being available — see `meta/insight-metrics.ts` for the list
 * and the reasoning. Storage is still schemaless: whatever comes back is stored
 * under its own metric name with no column per metric.
 */

/**
 * Requested fields for `published_posts`.
 *
 * `.limit(0).summary(true)` asks for the summary count without the payload —
 * we want "how many reactions", not the reactions themselves.
 */
export const PUBLISHED_POST_FIELDS = [
  "id",
  "message",
  "created_time",
  "permalink_url",
  "reactions.limit(0).summary(true)",
  /*
   * Likes, as a field rather than an insight.
   *
   * `post_reactions_by_type_total` is the only other source for the LIKE
   * subset, and Meta returned it for 611 of 1,626 posts — so Likes read "not
   * available" on the rest while total reactions was present throughout.
   *
   * The alias is not optional. Two `reactions` requests in one field list would
   * collide on the same response key; `.as(like_reactions)` renames this one so
   * both arrive together. Probed on v25.0 (2026-07-31): one response carrying
   * `reactions.summary.total_count: 35` and `like_reactions.summary.total_count:
   * 27` for the same post.
   *
   * A field is also structurally safer than an insight here — it needs no
   * `read_insights`, and an unrecognised field fails only itself instead of
   * collapsing the entire request the way an invalid metric name does.
   */
  "reactions.type(LIKE).limit(0).summary(true).as(like_reactions)",
  "comments.limit(0).summary(true)",
  "shares",
].join(",");

/** Posts requested per page. Meta caps this; 100 is the practical maximum. */
export const POSTS_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

type SummaryEnvelope = { summary?: { total_count?: number } };

export type RawPublishedPost = {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  reactions?: SummaryEnvelope;
  /** The `.as(like_reactions)` alias: LIKE reactions only. */
  like_reactions?: SummaryEnvelope;
  comments?: SummaryEnvelope;
  /**
   * Absent entirely when a post has no shares — Meta omits the field rather
   * than returning zero. Callers must not infer 0 from its absence.
   */
  shares?: { count?: number };
};

export type RawInsightValue = {
  value?: unknown;
  end_time?: string;
};

export type RawInsight = {
  name?: string;
  period?: string;
  title?: string;
  description?: string;
  values?: RawInsightValue[];
  id?: string;
};

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export type FetchPostsResult = {
  posts: RawPublishedPost[];
  pagesFetched: number;
  truncated: boolean;
  error?: NormalizedMetaError;
};

/**
 * Retrieve published posts for a Page, following pagination.
 *
 * Partial results survive a mid-pagination failure: the posts already
 * collected are returned alongside the error, so a rate limit on page 4 does
 * not discard pages 1–3.
 */
export async function fetchPublishedPosts(params: {
  pageId: string;
  token: string;
  maxPages?: number;
  since?: Date;
  logger?: Logger;
}): Promise<FetchPostsResult> {
  const query: Record<string, string> = {
    fields: PUBLISHED_POST_FIELDS,
    limit: String(POSTS_PAGE_SIZE),
  };

  // Meta accepts a Unix timestamp for `since`, which lets an incremental run
  // ask only for what is new instead of walking the whole history.
  if (params.since) {
    query["since"] = String(Math.floor(params.since.getTime() / 1000));
  }

  const outcome = await graphPaginate<RawPublishedPost>(`${params.pageId}/published_posts`, {
    token: params.token,
    params: query,
    context: "page",
    ...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
  });

  return {
    posts: outcome.items,
    pagesFetched: outcome.pagesFetched,
    truncated: outcome.truncated,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

export type FetchInsightsResult = GraphOutcome<{ data: RawInsight[] }>;

/**
 * Retrieve the insights Meta will give for a post.
 *
 * The `metric` parameter is mandatory on v25 — omitting it returns error 3001
 * and no data at all. That was the original behaviour, and against a live Page
 * it meant `post_insights` stayed permanently empty while every sync reported
 * success.
 */
export async function fetchPostInsights(params: {
  postId: string;
  token: string;
  logger?: Logger;
}): Promise<FetchInsightsResult> {
  return graphRequest<{ data: RawInsight[] }>(`${params.postId}/insights`, {
    token: params.token,
    params: { metric: POST_INSIGHT_METRIC_PARAM },
    context: "content",
    ...(params.logger ? { logger: params.logger } : {}),
  });
}

// ---------------------------------------------------------------------------
// Normalisation — pure, so the "never invent a zero" rule is testable
// ---------------------------------------------------------------------------

export type NormalizedPost = {
  facebookPostId: string;
  message: string | null;
  createdTime: Date;
  permalinkUrl: string | null;
  /** `null` means Meta did not report it. It never means zero. */
  reactionCount: number | null;
  /** LIKE reactions only. A subset of `reactionCount`, never equal to it. */
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  raw: RawPublishedPost;
};

function summaryCount(envelope: SummaryEnvelope | undefined): number | null {
  const total = envelope?.summary?.total_count;
  return typeof total === "number" ? total : null;
}

/**
 * Convert a Graph post into the row shape.
 *
 * Returns `null` for a post with no id or no `created_time` — both are required
 * by the schema, and a post missing either is not something we can meaningfully
 * store or order.
 */
export function normalizePost(raw: RawPublishedPost): NormalizedPost | null {
  if (!raw.id || !raw.created_time) return null;

  const createdTime = new Date(raw.created_time);
  if (Number.isNaN(createdTime.getTime())) return null;

  return {
    facebookPostId: raw.id,
    message: typeof raw.message === "string" && raw.message.length > 0 ? raw.message : null,
    createdTime,
    permalinkUrl: raw.permalink_url ?? null,
    reactionCount: summaryCount(raw.reactions),
    // Absent for a post nobody liked *and* for a post whose likes we were not
    // given. `summaryCount` returns null for both, which is the honest reading
    // — the alternative invents a zero indistinguishable from a measurement.
    likeCount: summaryCount(raw.like_reactions),
    commentCount: summaryCount(raw.comments),
    // `shares` absent means Meta reported nothing. It is NOT zero: a post with
    // no shares and a post whose share count we were not given are different
    // facts, and flattening them would fabricate data.
    shareCount: typeof raw.shares?.count === "number" ? raw.shares.count : null,
    raw,
  };
}

export type NormalizedInsight = {
  metricName: string;
  period: string | null;
  /** `null` when Meta returned the metric with no value. Not zero. */
  value: unknown;
  endTime: Date | null;
  raw: RawInsight;
};

/**
 * Flatten Meta's insight structure into one row per (metric, period, end_time).
 *
 * A metric arrives as `{ name, period, values: [{ value, end_time }, …] }`.
 * Lifetime metrics have a single entry; periodic ones have a series. Each entry
 * becomes its own row, so a time series is preserved rather than collapsed.
 *
 * A metric with an empty `values` array yields a single row with a null value —
 * recording that Meta acknowledged the metric but had nothing for it, which is
 * different from the metric not existing at all.
 */
export function normalizeInsights(raw: RawInsight[]): NormalizedInsight[] {
  const rows: NormalizedInsight[] = [];

  for (const insight of raw) {
    if (!insight?.name) continue;

    const period = typeof insight.period === "string" ? insight.period : null;
    const values = Array.isArray(insight.values) ? insight.values : [];

    if (values.length === 0) {
      rows.push({
        metricName: insight.name,
        period,
        value: null,
        endTime: null,
        raw: insight,
      });
      continue;
    }

    for (const entry of values) {
      const endTime = entry?.end_time ? new Date(entry.end_time) : null;

      rows.push({
        metricName: insight.name,
        period,
        // `undefined` is normalised to null so "absent" round-trips through
        // JSON storage intact.
        value: entry?.value === undefined ? null : entry.value,
        endTime: endTime && !Number.isNaN(endTime.getTime()) ? endTime : null,
        raw: insight,
      });
    }
  }

  return rows;
}
