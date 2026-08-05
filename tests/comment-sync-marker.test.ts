import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When `comments_synced_at` is written — and, more importantly, when it is not.
 *
 * ## The failure this prevents
 *
 * The marker is what the backfill claims work from: null means "nobody has
 * looked at this item". Writing it on a walk that *failed* would tell the drain
 * the item is done, and it would never come back — that post's comments would
 * be lost silently and permanently, with a backlog counter reading zero and
 * nothing anywhere recording the loss.
 *
 * The trap is that a failed walk does not throw. `fetchComments` reports a rate
 * limit or an expired token as `error` on an otherwise ordinary result, so
 * "we got an answer" and "the answer was an error" arrive through the same
 * return value. Stamping unconditionally after the call looks correct and is
 * the exact bug.
 */

const mocks = vi.hoisted(() => ({
  fetchComments: vi.fn(),
  markCommentsSynced: vi.fn(),
  upsertContentComments: vi.fn(),
  listCommentsForContent: vi.fn(),
  getSummaryForContent: vi.fn(),
  getPostById: vi.fn(),
}));

vi.mock("@/config/env", () => ({
  getServerEnv: () => ({
    MAX_COMMENTS_PER_CONTENT: 500,
    AI_SUMMARIZATION_ENABLED: true,
    AI_PROVIDER: "gemini",
  }),
}));

vi.mock("@/lib/meta/comments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/comments")>()),
  fetchComments: mocks.fetchComments,
}));

vi.mock("@/lib/repositories/comments", () => ({
  markCommentsSynced: mocks.markCommentsSynced,
  upsertContentComments: mocks.upsertContentComments,
  listCommentsForContent: mocks.listCommentsForContent,
  getSummaryForContent: mocks.getSummaryForContent,
  markSummaryProcessing: vi.fn(),
  saveSummaryFailure: vi.fn(),
  saveSummarySuccess: vi.fn(),
}));

vi.mock("@/lib/repositories/posts", () => ({ getPostById: mocks.getPostById }));
vi.mock("@/lib/repositories/videos", () => ({ getVideoById: vi.fn() }));

vi.mock("@/lib/repositories/streamers", () => ({
  // Lends a plaintext token to the callback and never returns it — the same
  // contract as production, so nothing here can observe one.
  withStreamerToken: async (_id: string, run: (token: string) => Promise<void>) => {
    await run("test-token");
    return { ok: true };
  },
}));

vi.mock("@/lib/audit/log", () => ({ recordAuditLogSafe: vi.fn() }));
vi.mock("@/lib/ai/resolve", () => ({ analyzeWithFallback: vi.fn() }));

const { syncContentComments } = await import("@/lib/services/sync-comments");

const CONTENT = { type: "post" as const, id: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  vi.resetAllMocks();

  mocks.getPostById.mockResolvedValue({
    id: CONTENT.id,
    facebookPostId: "page_123",
    streamerId: "streamer-1",
  });
  mocks.upsertContentComments.mockResolvedValue({ written: 0 });
  mocks.listCommentsForContent.mockResolvedValue([]);
  mocks.getSummaryForContent.mockResolvedValue(null);
});

describe("the collection marker", () => {
  it("is written when the walk succeeds", async () => {
    mocks.fetchComments.mockResolvedValue({ comments: [], truncated: false });

    await syncContentComments({ actorId: null, content: CONTENT, deferAnalysis: true });

    expect(mocks.markCommentsSynced).toHaveBeenCalledWith(CONTENT);
  });

  it("is written even when the item genuinely has no comments", async () => {
    /*
     * The case the marker exists for. "We looked, there were none" is a fact
     * the presence of comment rows cannot express, and without it recorded the
     * backfill hands this item back for ever.
     */
    mocks.fetchComments.mockResolvedValue({ comments: [], truncated: false });

    await syncContentComments({ actorId: null, content: CONTENT, deferAnalysis: true });

    expect(mocks.markCommentsSynced).toHaveBeenCalledTimes(1);
    expect(mocks.upsertContentComments).not.toHaveBeenCalled();
  });

  it.each([
    ["rate_limited", "Meta is throttling this app"],
    ["expired_token", "the Page token lapsed"],
    ["meta_api_error", "Meta returned an error"],
  ])("is NOT written when the walk reports %s — %s", async (category) => {
    mocks.fetchComments.mockResolvedValue({
      comments: [],
      truncated: false,
      error: { category, message: `simulated ${category}`, code: 4 },
    });

    const outcome = await syncContentComments({
      actorId: null,
      content: CONTENT,
      deferAnalysis: true,
    });

    // Left claimable, so the next run returns to it.
    expect(mocks.markCommentsSynced).not.toHaveBeenCalled();

    // And the caller is told, so the run's summary counts it as failed rather
    // than reporting a collection that did not happen.
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.fetchError).toBeDefined();
  });

  it("is not touched when the caller skipped the fetch entirely", async () => {
    // The analysis stage passes `skipFetch`. It walked nothing, so it has
    // learned nothing about when this item was last collected.
    mocks.listCommentsForContent.mockResolvedValue([]);

    await syncContentComments({ actorId: null, content: CONTENT, skipFetch: true });

    expect(mocks.markCommentsSynced).not.toHaveBeenCalled();
    expect(mocks.fetchComments).not.toHaveBeenCalled();
  });
});

describe("deferred analysis", () => {
  it("collects without reading the comment set back", async () => {
    /*
     * Deliberately returns before the hash read. Hashing here would be work the
     * analysis stage repeats moments later, multiplied by every item in a
     * thousand-item run.
     */
    mocks.fetchComments.mockResolvedValue({ comments: [], truncated: false });

    const outcome = await syncContentComments({
      actorId: null,
      content: CONTENT,
      deferAnalysis: true,
    });

    expect(mocks.listCommentsForContent).not.toHaveBeenCalled();
    expect(mocks.getSummaryForContent).not.toHaveBeenCalled();

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.summaryStatus).toBe("deferred");
      expect(outcome.result.summaryRegenerated).toBe(false);
    }
  });
});
