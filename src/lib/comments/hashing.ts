import { createHash } from "node:crypto";

/**
 * Deterministic hashing for comment sets — a PURE module.
 *
 * Two hashes, for two different questions:
 *
 *   `commentContentHash`  — did *this comment* change?
 *   `commentSourceHash`   — did *the comment set* change?
 *
 * The source hash is the gate on AI spend: if it matches what a stored summary
 * was built from, the comments are byte-identical and re-running the model
 * would produce the same analysis at full cost. Determinism is therefore not a
 * nicety — an unstable hash means either paying for every re-sync, or missing
 * a real change.
 *
 * Kept free of I/O so the stability properties can be asserted directly.
 */

/** Field separator. A control character, so it cannot occur in comment text. */
const FIELD = "";
/** Record separator, likewise. */
const RECORD = "";

export type HashableComment = {
  facebookCommentId: string;
  message: string | null;
};

/**
 * Hash one comment's identity and text.
 *
 * Only the id and message participate. `like_count` and `reply_count` drift
 * constantly on a live post and say nothing about what was *said* — including
 * them would invalidate the summary every sync for no analytical gain.
 */
export function commentContentHash(comment: HashableComment): string {
  return createHash("sha256")
    .update(`${comment.facebookCommentId}${FIELD}${comment.message ?? ""}`, "utf8")
    .digest("hex");
}

/**
 * Hash a whole comment set.
 *
 * Sorted by comment id before hashing, so the result depends on the *content*
 * of the set and not on the order Meta happened to return it in. Without the
 * sort, pagination reordering alone would look like a change and re-trigger
 * the model.
 *
 * An empty set hashes to a stable sentinel rather than to the hash of an empty
 * string, so "no comments" is distinguishable from "not yet computed".
 */
export function commentSourceHash(comments: readonly HashableComment[]): string {
  if (comments.length === 0) return EMPTY_SOURCE_HASH;

  const sorted = [...comments].sort((a, b) =>
    a.facebookCommentId < b.facebookCommentId
      ? -1
      : a.facebookCommentId > b.facebookCommentId
        ? 1
        : 0,
  );

  const hash = createHash("sha256");
  for (const comment of sorted) {
    hash.update(comment.facebookCommentId, "utf8");
    hash.update(FIELD, "utf8");
    hash.update(comment.message ?? "", "utf8");
    hash.update(RECORD, "utf8");
  }

  return hash.digest("hex");
}

/** The source hash of a content item with no comments. */
export const EMPTY_SOURCE_HASH = "empty";

/**
 * Should the AI be called?
 *
 * The Phase 5 rule, in one place: only when comments are new, comments changed,
 * or an admin explicitly asked. Everything else reuses the stored summary.
 */
export function shouldRegenerateSummary(params: {
  currentSourceHash: string;
  storedSourceHash: string | null;
  storedStatus: string | null;
  forced: boolean;
}): { regenerate: boolean; reason: RegenerateReason } {
  if (params.forced) return { regenerate: true, reason: "forced" };

  // Nothing stored — first time this content has been analysed.
  if (params.storedSourceHash === null) return { regenerate: true, reason: "no_summary" };

  if (params.storedSourceHash !== params.currentSourceHash) {
    return { regenerate: true, reason: "comments_changed" };
  }

  // Same comments, but the last attempt never produced anything usable.
  // Retrying is correct here: the input is unchanged, the *outcome* was absent.
  if (params.storedStatus === "failed" || params.storedStatus === "pending") {
    return { regenerate: true, reason: "previous_attempt_incomplete" };
  }

  return { regenerate: false, reason: "unchanged" };
}

export type RegenerateReason =
  | "forced"
  | "no_summary"
  | "comments_changed"
  | "previous_attempt_incomplete"
  | "unchanged"
  /** AI_SUMMARIZATION_ENABLED is false. Not a decision about the comments. */
  | "disabled";

export const REGENERATE_REASON_LABELS: Record<RegenerateReason, string> = {
  forced: "Regeneration requested by an admin",
  no_summary: "No summary existed yet",
  comments_changed: "The comment set changed since the last summary",
  previous_attempt_incomplete: "The previous attempt did not complete",
  unchanged: "Comments are unchanged — the stored summary still applies",
  disabled: "AI summarisation is switched off (AI_SUMMARIZATION_ENABLED=false)",
};
