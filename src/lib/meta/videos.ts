import "server-only";

import { graphPaginate, graphRequest, type GraphOutcome } from "@/lib/meta/client";
import type { NormalizedMetaError } from "@/lib/meta/errors";
import type { RawInsight } from "@/lib/meta/posts";
import type { Logger } from "@/lib/observability/logger";

/**
 * Page video and video-insight retrieval.
 *
 *   GET /{page-id}/videos          — the videos themselves, paginated
 *   GET /{video-id}/video_insights — every metric Meta has for a video
 *
 * ## Why `/videos` and not `/live_videos`
 *
 * The `/live_videos` edge can require separate Meta App Review, which would
 * block the integration behind an approval cycle. `/videos` needs only the
 * permissions the Page token already carries, and it returns live broadcasts
 * as VODs once they end — so the data arrives either way, just after the
 * broadcast rather than during it. Live-specific fields (concurrent viewers
 * while streaming) are the trade-off, and they are not part of this phase.
 *
 * As with post insights, the insights call sends **no `metric` parameter** and
 * nothing here enumerates metric names.
 */

/** Requested fields for `/{page-id}/videos`. */
export const VIDEO_FIELDS = [
  "id",
  "title",
  "description",
  "created_time",
  "permalink_url",
  "length",
].join(",");

/** Videos requested per page. */
export const VIDEOS_PAGE_SIZE = 50;

export type RawVideo = {
  id?: string;
  title?: string;
  description?: string;
  created_time?: string;
  permalink_url?: string;
  /** Fractional seconds. Absent for some video types. */
  length?: number;
};

export type FetchVideosResult = {
  videos: RawVideo[];
  pagesFetched: number;
  truncated: boolean;
  error?: NormalizedMetaError;
};

/**
 * Retrieve videos for a Page, following pagination.
 *
 * Partial results survive a mid-pagination failure — videos already collected
 * are returned alongside the error.
 */
export async function fetchPageVideos(params: {
  pageId: string;
  token: string;
  maxPages?: number;
  since?: Date;
  logger?: Logger;
}): Promise<FetchVideosResult> {
  const query: Record<string, string> = {
    fields: VIDEO_FIELDS,
    limit: String(VIDEOS_PAGE_SIZE),
  };

  if (params.since) {
    query["since"] = String(Math.floor(params.since.getTime() / 1000));
  }

  const outcome = await graphPaginate<RawVideo>(`${params.pageId}/videos`, {
    token: params.token,
    params: query,
    context: "page",
    ...(params.maxPages !== undefined ? { maxPages: params.maxPages } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
  });

  return {
    videos: outcome.items,
    pagesFetched: outcome.pagesFetched,
    truncated: outcome.truncated,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

export type FetchVideoInsightsResult = GraphOutcome<{ data: RawInsight[] }>;

/**
 * Retrieve every insight Meta will give for a video.
 *
 * Note the edge name differs from posts: videos use `/video_insights`, posts
 * use `/insights`. Same schemaless treatment of what comes back.
 */
export async function fetchVideoInsights(params: {
  videoId: string;
  token: string;
  logger?: Logger;
}): Promise<FetchVideoInsightsResult> {
  return graphRequest<{ data: RawInsight[] }>(`${params.videoId}/video_insights`, {
    token: params.token,
    context: "content",
    ...(params.logger ? { logger: params.logger } : {}),
  });
}

// ---------------------------------------------------------------------------
// Normalisation — pure
// ---------------------------------------------------------------------------

export type NormalizedVideo = {
  facebookVideoId: string;
  title: string | null;
  description: string | null;
  /** `null` means Meta did not report a length. Never coerced to zero. */
  lengthSeconds: number | null;
  createdTime: Date;
  permalinkUrl: string | null;
  raw: RawVideo;
};

/**
 * Convert a Graph video into the row shape.
 *
 * Returns `null` for a video with no id or no parseable `created_time` — both
 * are required by the schema, and a video missing either cannot be
 * deduplicated or ordered.
 */
export function normalizeVideo(raw: RawVideo): NormalizedVideo | null {
  if (!raw.id) return null;
  if (!raw.created_time) return null;

  const createdTime = new Date(raw.created_time);
  if (Number.isNaN(createdTime.getTime())) return null;

  // A non-finite length (NaN, Infinity) is not a measurement; treat it as
  // absent rather than storing a value that breaks arithmetic downstream.
  const length =
    typeof raw.length === "number" && Number.isFinite(raw.length) && raw.length >= 0
      ? raw.length
      : null;

  return {
    facebookVideoId: raw.id,
    title: typeof raw.title === "string" && raw.title.length > 0 ? raw.title : null,
    description:
      typeof raw.description === "string" && raw.description.length > 0 ? raw.description : null,
    lengthSeconds: length,
    createdTime,
    permalinkUrl: absolutePermalink(raw.permalink_url),
    raw,
  };
}

/** Where Meta's relative permalinks are rooted. */
const FACEBOOK_ORIGIN = "https://www.facebook.com";

/**
 * Make a video permalink absolute.
 *
 * Meta is inconsistent between edges: `/{page}/published_posts` returns an
 * absolute `permalink_url`, while `/{page}/videos` returns a **relative** path —
 * `/reel/1379961884346781/`. Storing that verbatim produced a value that is not
 * a URL, so the export contract rejected the whole videos and comment-summaries
 * datasets with `contract_violation` (`permalink_url: Invalid URL`) once real
 * reels arrived.
 *
 * Normalising here rather than loosening the contract keeps the guarantee worth
 * having: every permalink that reaches a spreadsheet is one a reader can click.
 */
export function absolutePermalink(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (/^https?:\/\//i.test(value)) return value;

  return `${FACEBOOK_ORIGIN}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** `3725.4` → `1h 2m 05s`. Returns `null` when no length was reported. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${String(secs).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
