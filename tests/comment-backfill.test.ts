import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unattended drain that gets every post to a stored analysis.
 *
 * ## What these tests are actually protecting
 *
 * The backfill runs nightly with nobody watching, against a provider on a free
 * tier, spending Meta quota. Three of its rules are the difference between a
 * drain that finishes and one that quietly does damage, and none of them is
 * visible from the outside until it is too late:
 *
 *   1. A Graph walk that failed must not be marked collected. If it is, that
 *      item is skipped for ever and its comments are lost silently.
 *   2. A provider failure ends the run. It is never about the one item — a rate
 *      limit means the next fifty fail too — and carrying on writes the same
 *      error against every remaining item, burying one cause under hundreds of
 *      symptoms.
 *   3. A local tally is a loan, never a substitution. It is stored against the
 *      current comment hash, which closes the ordinary regeneration gate — so
 *      it is recorded as `offline` and re-claimed for a model summary later.
 *      Without that second half, an hour of rate limiting would leave a
 *      permanent tally behind with nothing in the data saying so.
 */

const mocks = vi.hoisted(() => ({
  syncContentComments: vi.fn(),
  listContentAwaitingCollection: vi.fn(),
  listContentAwaitingAnalysis: vi.fn(),
  listSummariesAwaitingUpgrade: vi.fn(),
  countCommentBacklog: vi.fn(),
  aiEnabled: { value: true },
  offlineFallback: { value: true },
}));

vi.mock("@/lib/services/sync-comments", () => ({
  syncContentComments: mocks.syncContentComments,
}));

vi.mock("@/lib/repositories/comment-backlog", () => ({
  listContentAwaitingCollection: mocks.listContentAwaitingCollection,
  listContentAwaitingAnalysis: mocks.listContentAwaitingAnalysis,
  listSummariesAwaitingUpgrade: mocks.listSummariesAwaitingUpgrade,
  countCommentBacklog: mocks.countCommentBacklog,
  toContentRef: (item: { type: string; id: string }) => ({ type: item.type, id: item.id }),
}));

vi.mock("@/config/env", () => ({
  getServerEnv: () => ({
    AI_SUMMARIZATION_ENABLED: mocks.aiEnabled.value,
    AI_OFFLINE_FALLBACK: mocks.offlineFallback.value,
  }),
}));

const { backfillCommentAnalysis } = await import("@/lib/services/comment-backfill");

/** A backlog row as the repository hands it over. */
function item(id: string, type: "post" | "video" = "post") {
  return { type, id, streamerId: "streamer-1", facebookId: `fb_${id}` };
}

/** A successful collection outcome. */
function collected(commentsStored = 3) {
  return {
    ok: true,
    result: {
      content: { type: "post", id: "x" },
      commentsFetched: commentsStored,
      commentsStored,
      truncated: false,
      summaryRegenerated: false,
      regenerateReason: "deferred",
      summaryStatus: "deferred",
    },
  };
}

function analysed(status: "completed" | "no_comments" | "unchanged") {
  return {
    ok: true,
    result: {
      content: { type: "post", id: "x" },
      commentsFetched: 0,
      commentsStored: 0,
      truncated: false,
      summaryRegenerated: status === "completed",
      regenerateReason: "no_summary",
      summaryStatus: status,
    },
  };
}

function analysisFailed(retryable: boolean) {
  return {
    ok: true,
    result: {
      content: { type: "post", id: "x" },
      commentsFetched: 0,
      commentsStored: 0,
      truncated: false,
      summaryRegenerated: false,
      regenerateReason: "no_summary",
      summaryStatus: "failed",
      summaryError: retryable ? "Rate limited." : "The API key was rejected.",
      summaryRetryable: retryable,
    },
  };
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: several tests queue outcomes with
  // `mockResolvedValueOnce`, and clearing only wipes the call log — an unspent
  // queued value survives into the next test and answers its first call.
  vi.resetAllMocks();
  mocks.aiEnabled.value = true;
  mocks.offlineFallback.value = true;
  mocks.listContentAwaitingCollection.mockResolvedValue([]);
  mocks.listContentAwaitingAnalysis.mockResolvedValue([]);
  mocks.listSummariesAwaitingUpgrade.mockResolvedValue([]);
  mocks.countCommentBacklog.mockResolvedValue({
    awaitingCollection: 0,
    awaitingAnalysis: 0,
    blockedByToken: 0,
    awaitingUpgrade: 0,
  });
});

describe("collection", () => {
  it("collects without spending the model budget", async () => {
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValue(collected());

    const summary = await backfillCommentAnalysis({ stages: ["collection"] });

    expect(summary.collection.collected).toBe(2);
    expect(summary.collection.commentsStored).toBe(6);

    // Every collection call defers. The analysis stage is paced separately, and
    // collapsing the two would drag the whole drain down to the model's rate.
    for (const call of mocks.syncContentComments.mock.calls) {
      expect(call[0].deferAnalysis).toBe(true);
    }
  });

  it("counts a failed Graph walk as failed, not collected", async () => {
    /*
     * The marker is written inside `syncContentComments` and only on a walk
     * that produced an answer, so a rate-limited item stays claimable. What
     * this asserts is that the *summary* agrees — a run reporting 400 collected
     * when 40 of them errored would hide a Page-wide problem completely.
     */
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValueOnce(collected()).mockResolvedValueOnce({
      ok: true,
      result: {
        ...collected().result,
        fetchError: { category: "rate_limited", message: "Meta says slow down.", code: 4 },
      },
    });

    const summary = await backfillCommentAnalysis({ stages: ["collection"] });

    expect(summary.collection.collected).toBe(1);
    expect(summary.collection.failed).toBe(1);
    expect(summary.errors.some((entry) => entry.stage === "collection")).toBe(true);
  });

  it("keeps going when one item throws", async () => {
    // One post whose streamer lost its token must not end the roster's drain.
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a"), item("b"), item("c")]);
    mocks.syncContentComments
      .mockResolvedValueOnce(collected())
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(collected());

    const summary = await backfillCommentAnalysis({ stages: ["collection"] });

    expect(summary.collection.attempted).toBe(3);
    expect(summary.collection.collected).toBe(2);
    expect(summary.collection.failed).toBe(1);
  });
});

describe("analysis", () => {
  it("analyses stored comments without spending Graph quota", async () => {
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a")]);
    mocks.syncContentComments.mockResolvedValue(analysed("completed"));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.analysis.completed).toBe(1);

    const call = mocks.syncContentComments.mock.calls[0]?.[0];
    expect(call.skipFetch).toBe(true);
    // Rule 3: never a tally, because a tally would close the hash gate.
    expect(call.allowOfflineFallback).toBe(false);
  });

  /** Calls that went to the provider, as opposed to the local analyser. */
  function providerCalls() {
    return mocks.syncContentComments.mock.calls.filter((call) => !call[0].useOfflineAnalyser);
  }

  function localCalls() {
    return mocks.syncContentComments.mock.calls.filter(
      (call) => call[0].useOfflineAnalyser === true,
    );
  }

  it("stops asking the provider after the first failure", async () => {
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a"), item("b"), item("c")]);
    mocks.syncContentComments
      .mockResolvedValueOnce(analysed("completed"))
      .mockResolvedValueOnce(analysisFailed(true))
      .mockResolvedValue(analysed("completed"));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.stoppedBecause).toBe("provider_unavailable");
    // Two provider calls: the success and the failure. The third item was never
    // offered to it — the failure was about the provider, not about that item,
    // and asking again would have produced the same error.
    expect(providerCalls()).toHaveLength(2);
  });

  it("stops asking on a rejected key too", async () => {
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValue(analysisFailed(false));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.stoppedBecause).toBe("provider_unavailable");
    expect(providerCalls()).toHaveLength(1);
  });

  it("fills the rest locally rather than leaving them blank", async () => {
    /*
     * Measured, not hypothetical: this deployment's free-tier key completed
     * five analyses and then refused for as long as it was asked. Waiting for
     * quota at one scheduled run a night would leave most posts showing an
     * empty panel for months.
     *
     * The local tally is a loan, not a substitution — it is recorded as
     * `offline` and re-claimed for a model summary later.
     */
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a"), item("b"), item("c")]);
    mocks.syncContentComments
      .mockResolvedValueOnce(analysisFailed(true))
      .mockResolvedValue(analysed("completed"));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.stoppedBecause).toBe("provider_unavailable");
    expect(summary.analysis.filledLocally).toBe(3);

    for (const call of localCalls()) {
      // Forced, because the item may carry the `failed` row from the request
      // that just exhausted the quota.
      expect(call[0].forceRegenerate).toBe(true);
      expect(call[0].skipFetch).toBe(true);
    }
  });

  it("says so when it claims items and fills none of them", async () => {
    /*
     * The local analyser is string counting with no network call, so it cannot
     * fail on its own. A run that claims work and fills nothing therefore means
     * something upstream is wrong — and "filled 0" with no error attached gives
     * nobody anywhere to look. That is exactly how seven posts stuck in
     * `processing` went unexplained for a while.
     */
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a")]);
    mocks.syncContentComments
      .mockResolvedValueOnce(analysisFailed(true))
      .mockResolvedValue({ ok: false, reason: "content_not_found", message: "It is gone." });

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.analysis.filledLocally).toBe(0);
    expect(summary.errors.map((entry) => entry.message)).toContain("It is gone.");
  });

  it("leaves them blank when the local analyser is switched off", async () => {
    // `AI_OFFLINE_FALLBACK=false` is an operator saying "a failure should look
    // like a failure". Filling anyway would overrule that.
    mocks.offlineFallback.value = false;
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValue(analysisFailed(true));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.analysis.filledLocally).toBe(0);
    expect(localCalls()).toHaveLength(0);
  });

  it("replaces a local tally once the provider is answering again", async () => {
    mocks.listContentAwaitingAnalysis.mockResolvedValue([]);
    mocks.listSummariesAwaitingUpgrade.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValue(analysed("completed"));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.analysis.upgraded).toBe(2);

    for (const call of mocks.syncContentComments.mock.calls) {
      // Forced past the hash gate: the stored summary is `completed` against
      // the current comments, so every other caller correctly sees `unchanged`.
      expect(call[0].forceRegenerate).toBe(true);
      // And a failed upgrade must not be worse than not attempting one.
      expect(call[0].preserveExistingOnFailure).toBe(true);
    }
  });

  it("never upgrades while something has no analysis at all", async () => {
    // An empty panel always outranks a readable stand-in.
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a")]);
    mocks.listSummariesAwaitingUpgrade.mockResolvedValue([item("b")]);
    mocks.syncContentComments.mockResolvedValue(analysisFailed(true));

    await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(mocks.listSummariesAwaitingUpgrade).not.toHaveBeenCalled();
  });

  it("does not count an item the hash gate settled as work done", async () => {
    // The SQL filter is deliberately coarse — it cannot hash comment text — so
    // some claimed items turn out to be current. That costs a read, not a call.
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a")]);
    mocks.syncContentComments.mockResolvedValue(analysed("unchanged"));

    const summary = await backfillCommentAnalysis({ stages: ["analysis"], throttleMs: 0 });

    expect(summary.analysis.unchanged).toBe(1);
    expect(summary.analysis.completed).toBe(0);
  });

  it("still collects when summarisation is switched off", async () => {
    /*
     * The kill switch is about spend, not about comments. Collection costs Meta
     * quota only, and stopping it too would mean that turning AI off during a
     * billing problem quietly threw away weeks of comments.
     */
    mocks.aiEnabled.value = false;
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a")]);
    mocks.syncContentComments.mockResolvedValue(collected());

    const summary = await backfillCommentAnalysis({ throttleMs: 0 });

    expect(summary.collection.collected).toBe(1);
    expect(summary.stoppedBecause).toBe("analysis_disabled");
    expect(mocks.listContentAwaitingAnalysis).not.toHaveBeenCalled();
  });
});

describe("budgets", () => {
  it("reports the ceiling rather than pretending to be finished", async () => {
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a"), item("b")]);
    mocks.syncContentComments.mockResolvedValue(collected());
    mocks.countCommentBacklog.mockResolvedValue({
      awaitingCollection: 1_400,
      awaitingAnalysis: 0,
      blockedByToken: 0,
      awaitingUpgrade: 0,
    });

    const summary = await backfillCommentAnalysis({ maxCollect: 2, stages: ["collection"] });

    expect(summary.stoppedBecause).toBe("budget");
    expect(summary.finished).toBe(false);
    expect(summary.remaining.awaitingCollection).toBe(1_400);
  });

  it("stops on the wall clock before the platform can kill it", async () => {
    mocks.listContentAwaitingCollection.mockResolvedValue([item("a"), item("b"), item("c")]);
    mocks.syncContentComments.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return collected();
    });

    const summary = await backfillCommentAnalysis({ timeBudgetMs: 30, stages: ["collection"] });

    expect(summary.stoppedBecause).toBe("time");
    expect(summary.collection.attempted).toBeLessThan(3);
  });

  it("is finished only when both queues are empty by count", async () => {
    /*
     * Not "the loop ran out of items". A run can empty its claimed queue while
     * new content arrives behind it, and reporting that as finished is how a
     * backlog silently stops being drained.
     */
    mocks.countCommentBacklog.mockResolvedValue({
      awaitingCollection: 0,
      awaitingAnalysis: 4,
      blockedByToken: 0,
      awaitingUpgrade: 0,
    });

    const summary = await backfillCommentAnalysis({ throttleMs: 0 });

    expect(summary.finished).toBe(false);
  });

  it("is finished when nothing remains", async () => {
    const summary = await backfillCommentAnalysis({ throttleMs: 0 });

    expect(summary.finished).toBe(true);
    expect(summary.stoppedBecause).toBe("complete");
  });

  it("paces model calls, but never sleeps past the deadline", async () => {
    mocks.listContentAwaitingAnalysis.mockResolvedValue([item("a"), item("b"), item("c")]);
    mocks.syncContentComments.mockResolvedValue(analysed("completed"));

    const summary = await backfillCommentAnalysis({
      stages: ["analysis"],
      throttleMs: 50,
      // Less than one throttle interval, so the second item's pause would end
      // after the deadline. It must not be taken.
      timeBudgetMs: 40,
    });

    // First item runs immediately — the pause spaces requests, so paying it
    // before the first one would spend budget on nothing.
    expect(summary.analysis.attempted).toBe(1);
    expect(summary.stoppedBecause).toBe("time");
  });
});
