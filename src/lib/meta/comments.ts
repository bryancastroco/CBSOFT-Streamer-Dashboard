import "server-only";

import { graphPaginate } from "@/lib/meta/client";
import type { NormalizedMetaError } from "@/lib/meta/errors";
import type { Logger } from "@/lib/observability/logger";

/**
 * Comment retrieval from the Meta Graph API.
 *
 *   GET /{post-id}/comments?fields=id,message,created_time,like_count,comment_count
 *
 * ## Commenter identity is never requested
 *
 * The field list has no `from`. Meta returns author information only when it is
 * asked for, so not asking is the enforcement — there is no name to discard
 * later, no author column to accidentally populate, and nothing to redact.
 * This field list is the single point where that decision is made; changing it
 * is the only way to break the guarantee, which is why it is a frozen constant
 * with a test asserting its contents.
 */

/**
 * Requested fields. **Do not add `from`, `username`, or `parent`** — see above.
 *
 * `comment_count` on a comment is its number of replies, which is why it maps
 * to `reply_count` in storage.
 */
export const COMMENT_FIELDS = ["id", "message", "created_time", "like_count", "comment_count"].join(
  ",",
);

/** Comments requested per page. Meta's practical maximum for this edge. */
export const COMMENTS_PAGE_SIZE = 100;

/**
 * `chronological` gives a stable, resumable ordering. The default
 * (`ranked`) reorders by engagement between requests, which would make
 * pagination non-deterministic and defeat the source hash.
 */
export const COMMENT_ORDER = "chronological";

export type RawComment = {
  id?: string;
  message?: string;
  created_time?: string;
  like_count?: number;
  /** Meta's reply count for this comment. */
  comment_count?: number;
};

export type FetchCommentsResult = {
  comments: RawComment[];
  pagesFetched: number;
  /** True when the per-content cap or the page cap stopped collection early. */
  truncated: boolean;
  error?: NormalizedMetaError;
};

/**
 * Retrieve comments for a post, following pagination up to `maxComments`.
 *
 * Partial results survive a mid-pagination failure — comments already collected
 * are returned alongside the error, exactly as in the post fetch.
 */
export async function fetchComments(params: {
  contentId: string;
  token: string;
  maxComments: number;
  logger?: Logger;
}): Promise<FetchCommentsResult> {
  // One extra page beyond what the cap strictly needs, so `truncated` can be
  // detected rather than inferred from an exact-multiple boundary.
  const maxPages = Math.ceil(params.maxComments / COMMENTS_PAGE_SIZE) + 1;

  const outcome = await graphPaginate<RawComment>(`${params.contentId}/comments`, {
    token: params.token,
    params: {
      fields: COMMENT_FIELDS,
      limit: String(COMMENTS_PAGE_SIZE),
      order: COMMENT_ORDER,
      filter: "toplevel",
    },
    context: "content",
    maxPages,
    ...(params.logger ? { logger: params.logger } : {}),
  });

  const capped = outcome.items.slice(0, params.maxComments);

  return {
    comments: capped,
    pagesFetched: outcome.pagesFetched,
    truncated: outcome.truncated || outcome.items.length > params.maxComments,
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Normalisation — pure
// ---------------------------------------------------------------------------

export type NormalizedComment = {
  facebookCommentId: string;
  message: string | null;
  createdTime: Date;
  /** `null` means Meta did not report it. Never coerced to zero. */
  likeCount: number | null;
  replyCount: number | null;
};

/**
 * Convert a Graph comment into the row shape.
 *
 * Returns `null` for a comment with no id or no parseable `created_time` —
 * both are required by the schema, and a comment missing either cannot be
 * deduplicated or ordered.
 */
export function normalizeComment(raw: RawComment): NormalizedComment | null {
  if (!raw.id) return null;
  if (!raw.created_time) return null;

  const createdTime = new Date(raw.created_time);
  if (Number.isNaN(createdTime.getTime())) return null;

  return {
    facebookCommentId: raw.id,
    message: typeof raw.message === "string" && raw.message.length > 0 ? raw.message : null,
    createdTime,
    likeCount: typeof raw.like_count === "number" ? raw.like_count : null,
    replyCount: typeof raw.comment_count === "number" ? raw.comment_count : null,
  };
}

/** Drop duplicates by Meta comment id, keeping the first occurrence. */
export function dedupeComments(comments: NormalizedComment[]): NormalizedComment[] {
  const seen = new Set<string>();
  const unique: NormalizedComment[] = [];

  for (const comment of comments) {
    if (seen.has(comment.facebookCommentId)) continue;
    seen.add(comment.facebookCommentId);
    unique.push(comment);
  }

  return unique;
}
