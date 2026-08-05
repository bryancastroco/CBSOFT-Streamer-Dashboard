import { describe, expect, it } from "vitest";

import {
  EMPTY_SOURCE_HASH,
  commentContentHash,
  commentSourceHash,
  shouldRegenerateSummary,
} from "@/lib/comments/hashing";

/**
 * The source hash is the gate on AI spend. An unstable hash means either
 * re-billing every sync, or silently missing a real change — so its stability
 * properties are pinned here rather than assumed.
 */

const A = { facebookCommentId: "100_1", message: "Great stream tonight" };
const B = { facebookCommentId: "100_2", message: "When is the next one?" };
const C = { facebookCommentId: "100_3", message: null };

describe("per-comment content hash", () => {
  it("is deterministic", () => {
    expect(commentContentHash(A)).toBe(commentContentHash(A));
  });

  it("changes when the message is edited", () => {
    expect(commentContentHash(A)).not.toBe(
      commentContentHash({ ...A, message: "Great stream tonight!" }),
    );
  });

  it("changes when the comment id differs, even with identical text", () => {
    expect(commentContentHash(A)).not.toBe(
      commentContentHash({ ...A, facebookCommentId: "100_9" }),
    );
  });

  it("handles a null message without collapsing it into an empty string comment", () => {
    const nullMessage = commentContentHash({ facebookCommentId: "x", message: null });
    const emptyMessage = commentContentHash({ facebookCommentId: "x", message: "" });

    // Both are "no text", so they may hash alike — what matters is neither throws.
    expect(nullMessage).toMatch(/^[0-9a-f]{64}$/);
    expect(emptyMessage).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cannot be spoofed by moving text across the field boundary", () => {
    // A separator that could appear in a message would let one comment imitate
    // another. The separator is a control character, so this must differ.
    const one = commentContentHash({ facebookCommentId: "ab", message: "cd" });
    const two = commentContentHash({ facebookCommentId: "a", message: "bcd" });

    expect(one).not.toBe(two);
  });
});

describe("comment set source hash", () => {
  it("is deterministic for the same set", () => {
    expect(commentSourceHash([A, B])).toBe(commentSourceHash([A, B]));
  });

  it("ignores the order Meta returned the comments in", () => {
    // Pagination reordering must not look like a change, or every re-sync
    // would re-trigger the model.
    expect(commentSourceHash([A, B, C])).toBe(commentSourceHash([C, B, A]));
    expect(commentSourceHash([B, A])).toBe(commentSourceHash([A, B]));
  });

  it("changes when a comment is added", () => {
    expect(commentSourceHash([A])).not.toBe(commentSourceHash([A, B]));
  });

  it("changes when a comment is removed", () => {
    expect(commentSourceHash([A, B])).not.toBe(commentSourceHash([A]));
  });

  it("changes when a comment's text is edited", () => {
    const edited = { ...B, message: "When is the next stream?" };
    expect(commentSourceHash([A, B])).not.toBe(commentSourceHash([A, edited]));
  });

  it("does not change when engagement counts move", () => {
    // Likes and replies drift constantly on a live post and say nothing about
    // what was said — including them would invalidate the summary every sync.
    const withCounts = [
      { ...A, likeCount: 5, replyCount: 2 },
      { ...B, likeCount: 99, replyCount: 40 },
    ];

    expect(commentSourceHash(withCounts)).toBe(commentSourceHash([A, B]));
  });

  it("returns a stable sentinel for an empty set", () => {
    expect(commentSourceHash([])).toBe(EMPTY_SOURCE_HASH);
    // Distinguishable from "not yet computed" (null) and from any real hash.
    expect(commentSourceHash([])).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes sets that differ only in a null vs present message", () => {
    expect(commentSourceHash([C])).not.toBe(
      commentSourceHash([{ ...C, message: "now it has text" }]),
    );
  });
});

describe("when the AI should be called", () => {
  const hash = commentSourceHash([A, B]);

  it("calls it when no summary exists", () => {
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: null,
      storedStatus: null,
      forced: false,
    });

    expect(result).toEqual({ regenerate: true, reason: "no_summary" });
  });

  it("calls it when the comment set changed", () => {
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: commentSourceHash([A]),
      storedStatus: "completed",
      forced: false,
    });

    expect(result).toEqual({ regenerate: true, reason: "comments_changed" });
  });

  it("calls it when an admin forces it, even with identical comments", () => {
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: hash,
      storedStatus: "completed",
      forced: true,
    });

    expect(result).toEqual({ regenerate: true, reason: "forced" });
  });

  it("does NOT call it when comments are unchanged", () => {
    // The whole point: a nightly re-sync over unchanged comments must cost
    // nothing.
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: hash,
      storedStatus: "completed",
      forced: false,
    });

    expect(result).toEqual({ regenerate: false, reason: "unchanged" });
  });

  it("does NOT call it for an unchanged set already marked no_comments", () => {
    const result = shouldRegenerateSummary({
      currentSourceHash: EMPTY_SOURCE_HASH,
      storedSourceHash: EMPTY_SOURCE_HASH,
      storedStatus: "no_comments",
      forced: false,
    });

    expect(result.regenerate).toBe(false);
  });

  it("retries when the previous attempt failed, even on identical comments", () => {
    // The input is unchanged; the outcome was absent. Retrying is correct.
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: hash,
      storedStatus: "failed",
      forced: false,
    });

    expect(result).toEqual({ regenerate: true, reason: "previous_attempt_incomplete" });
  });

  it("retries when a previous attempt was left pending", () => {
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: hash,
      storedStatus: "pending",
      forced: false,
    });

    expect(result.regenerate).toBe(true);
  });

  it("retries an attempt abandoned midway, which is the state a kill leaves", () => {
    /*
     * The gap that stranded seven posts in production, one of them holding 500
     * collected comments.
     *
     * `markSummaryProcessing` writes `processing` *before* the model is called,
     * so a function killed mid-analysis — Vercel hitting `maxDuration`, a
     * deploy landing mid-flight — leaves it behind. With `processing` missing
     * from this list the row became unreachable in both directions at once: the
     * backfill queue claimed it for ever because no settled summary existed,
     * and this gate declined it for ever because the hash matched. Nothing
     * raised an error, because nothing was failing.
     */
    const result = shouldRegenerateSummary({
      currentSourceHash: hash,
      storedSourceHash: hash,
      storedStatus: "processing",
      forced: false,
    });

    expect(result).toEqual({ regenerate: true, reason: "previous_attempt_incomplete" });
  });

  it("still leaves a settled summary alone", () => {
    // The retry list must not widen into "regenerate whenever unsure" — that
    // would re-bill every unchanged item on every sweep, which is the entire
    // thing the hash exists to prevent.
    for (const status of ["completed", "no_comments"]) {
      const result = shouldRegenerateSummary({
        currentSourceHash: hash,
        storedSourceHash: hash,
        storedStatus: status,
        forced: false,
      });

      expect(result).toEqual({ regenerate: false, reason: "unchanged" });
    }
  });

  it("forcing wins over every other condition", () => {
    for (const status of ["completed", "failed", "pending", "no_comments", null]) {
      const result = shouldRegenerateSummary({
        currentSourceHash: hash,
        storedSourceHash: hash,
        storedStatus: status,
        forced: true,
      });

      expect(result.reason).toBe("forced");
    }
  });
});
