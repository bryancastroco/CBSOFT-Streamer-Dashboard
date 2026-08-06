import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The roster sweep, with every downstream service mocked.
 *
 * The behaviour under test is *orchestration*: which streamers are processed,
 * what happens when one of them fails, and how the outcome is aggregated. None
 * of that needs a database or a Graph call, and using real ones would make the
 * failure cases hard to arrange — you cannot easily ask Meta to rate-limit you
 * on demand.
 *
 * The requirement that shapes the whole file: **one streamer failing must not
 * end the sweep.** An expired token, a rate-limited Page, a Page deleted out
 * from under us — each is normal, and each must cost exactly that streamer's
 * results.
 */

const mocks = vi.hoisted(() => ({
  listSyncableStreamers: vi.fn(),
  validateStreamerToken: vi.fn(),
  syncStreamerPosts: vi.fn(),
  syncStreamerVideos: vi.fn(),
  syncContentComments: vi.fn(),
  listRecentPostIdsForStreamer: vi.fn(),
  listRecentVideoIdsForStreamer: vi.fn(),
  recordAuditLogSafe: vi.fn(),
  rollUpMetrics: vi.fn(),
  syncPageMetrics: vi.fn(),
  extendStreamerToken: vi.fn(),
  closedRuns: [] as { status: string; message: string | null; totals: unknown }[],
}));

/*
 * Both roster readers resolve to the same mock.
 *
 * `runSyncAll` asks two questions now: `listSyncableStreamers` for "how big is
 * the roster" (logging only) and `listPendingStreamersForRun` for "what has this
 * run not reached yet", which is what the slice comes from. Pointing both at one
 * mock keeps every existing expectation meaningful — a fresh run has attempted
 * nobody, so pending IS the whole roster.
 */
vi.mock("@/lib/repositories/streamers", () => ({
  listSyncableStreamers: mocks.listSyncableStreamers,
  listPendingStreamersForRun: mocks.listSyncableStreamers,
  validateStreamerToken: mocks.validateStreamerToken,
  extendStreamerToken: mocks.extendStreamerToken,
}));

vi.mock("@/lib/repositories/posts", () => ({
  listRecentPostIdsForStreamer: mocks.listRecentPostIdsForStreamer,
}));

vi.mock("@/lib/repositories/videos", () => ({
  listRecentVideoIdsForStreamer: mocks.listRecentVideoIdsForStreamer,
}));

vi.mock("@/lib/services/sync-posts", () => ({ syncStreamerPosts: mocks.syncStreamerPosts }));
vi.mock("@/lib/services/sync-videos", () => ({ syncStreamerVideos: mocks.syncStreamerVideos }));
vi.mock("@/lib/services/sync-comments", () => ({ syncContentComments: mocks.syncContentComments }));
/*
 * Audience collection, stubbed for the same reason as the rollup below: it
 * reaches for a Page token and a database, and an unstubbed failure would
 * downgrade every streamer to `completed_with_errors` — which these tests would
 * then report as a sweep bug rather than as a missing stub.
 */
vi.mock("@/lib/services/sync-page-metrics", () => ({ syncPageMetrics: mocks.syncPageMetrics }));
/*
 * The sweep's final step per streamer is rolling that streamer's new insights
 * into canonical metrics. Stubbed because this suite is about orchestration —
 * but stubbed deliberately rather than left out: an unstubbed rollup reaches
 * for a database, throws, and downgrades every streamer to
 * `completed_with_errors`, which these tests would then faithfully report as
 * the sweep's behaviour.
 */
vi.mock("@/lib/services/metric-rollup", () => ({ rollUpMetrics: mocks.rollUpMetrics }));
vi.mock("@/lib/audit/log", () => ({ recordAuditLogSafe: mocks.recordAuditLogSafe }));

/**
 * A database stub that records what the sweep writes to `sync_runs`.
 *
 * Only `update(...).set(...).where(...)` is exercised — the sweep's only write.
 * Capturing it lets the tests assert the run really was closed, which is the
 * one outcome a polling workflow depends on.
 */
vi.mock("@/lib/db", () => ({
  getDb: () => ({
    insert: () => ({
      values: () => ({ returning: async () => [{ id: "run-parent" }] }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          mocks.closedRuns.push({
            status: String(values["status"]),
            message: (values["errorMessage"] as string | null) ?? null,
            totals: values,
          });
        },
      }),
    }),
  }),
}));

/*
 * The housekeeping a finished sweep does, stubbed.
 *
 * `resolveContentGames` and `clearExpiredUserTokens` are collaborators, not the
 * subject: this file is about orchestration — that one streamer failing does
 * not end the sweep, and that the parent run is always closed. Reaching for the
 * `getDb` mock instead would mean teaching it Drizzle's `select` chain and
 * making `update` table-aware, which is a lot of fiction in service of a
 * question these tests are not asking.
 *
 * They are asserted on below, so stubbing them does not lose the coverage that
 * a sweep actually calls them.
 */
const housekeeping = vi.hoisted(() => ({
  resolveContentGames: vi.fn(async () => ({
    postsUpdated: 0,
    videosUpdated: 0,
    unattributed: 0,
    durationMs: 0,
  })),
  clearExpiredUserTokens: vi.fn(async () => 0),
}));

vi.mock("@/lib/services/resolve-games", () => ({
  resolveContentGames: housekeeping.resolveContentGames,
}));

vi.mock("@/lib/repositories/page-connections", () => ({
  clearExpiredUserTokens: housekeeping.clearExpiredUserTokens,
}));

const { runSyncAll } = await import("@/lib/services/sync-all");

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function streamer(code: string, id = `id-${code}`) {
  return { id, streamerCode: code, streamerName: `Streamer ${code}`, active: true };
}

function validToken(status = "valid") {
  return {
    ok: true as const,
    data: { streamer: {}, validation: { status, scopes: [], expiresAt: null } },
  };
}

function postsOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    result: {
      syncRunId: "run-posts",
      postsProcessed: 3,
      insightsWritten: 9,
      postsWithInsightErrors: 0,
      pagesFetched: 1,
      truncated: false,
      status: "completed" as const,
      insightErrors: [],
      ...overrides,
    },
  };
}

function videosOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    result: {
      syncRunId: "run-videos",
      videosProcessed: 2,
      insightsWritten: 4,
      videosWithInsightErrors: 0,
      pagesFetched: 1,
      truncated: false,
      status: "completed" as const,
      insightErrors: [],
      ...overrides,
    },
  };
}

function commentsOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    result: {
      content: { type: "post" as const, id: "p1" },
      commentsFetched: 5,
      commentsStored: 5,
      truncated: false,
      summaryRegenerated: true,
      regenerateReason: "comments_changed" as const,
      summaryStatus: "completed" as const,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closedRuns.length = 0;

  mocks.validateStreamerToken.mockResolvedValue(validToken());
  mocks.syncStreamerPosts.mockResolvedValue(postsOk());
  mocks.syncStreamerVideos.mockResolvedValue(videosOk());
  mocks.syncContentComments.mockResolvedValue(commentsOk());
  mocks.listRecentPostIdsForStreamer.mockResolvedValue([]);
  mocks.listRecentVideoIdsForStreamer.mockResolvedValue([]);
  mocks.recordAuditLogSafe.mockResolvedValue(undefined);
  mocks.rollUpMetrics.mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 });
  mocks.syncPageMetrics.mockResolvedValue({ ok: true, daysWritten: 30, latestFollowers: 40_112 });
  /*
   * The sweep renews each token while it still works. Stubbed as a no-op:
   * unstubbed it is undefined, the call throws, and the sweep quietly runs its
   * catch path on every streamer — passing tests exercising the failure branch.
   */
  mocks.extendStreamerToken.mockResolvedValue({
    ok: true,
    data: { outcome: { status: "unchanged", reason: "already permanent" } },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("the sweep processes every active streamer", () => {
  it("visits each one and aggregates their counters", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([
      streamer("CBS-001"),
      streamer("CBS-002"),
      streamer("CBS-003"),
    ]);

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(mocks.syncStreamerPosts).toHaveBeenCalledTimes(3);
    expect(mocks.syncStreamerVideos).toHaveBeenCalledTimes(3);

    expect(result.status).toBe("completed");
    expect(result.streamersTotal).toBe(3);
    expect(result.streamersSucceeded).toBe(3);
    expect(result.postsProcessed).toBe(9);
    expect(result.videosProcessed).toBe(6);
  });

  it("tags every child run as automation and links it to the parent", async () => {
    // This is what makes `GET /api/automation/sync-runs/{id}` able to report
    // the whole sweep from the one id the workflow holds.
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);

    await runSyncAll({ syncRunId: "run-parent" });

    expect(mocks.syncStreamerPosts).toHaveBeenCalledWith(
      expect.objectContaining({ syncType: "automation", parentSyncRunId: "run-parent" }),
    );
  });

  it("acts as a machine, with no user attributed to the work", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);

    await runSyncAll({ syncRunId: "run-parent" });

    // Inventing a user would corrupt the audit trail's answer to "who did
    // this?".
    expect(mocks.syncStreamerPosts).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null }),
    );
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null }),
    );
  });

  it("succeeds quietly on an empty roster", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([]);

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.status).toBe("completed");
    expect(result.streamersTotal).toBe(0);
    expect(mocks.closedRuns[0]?.message).toMatch(/No active streamers/i);
  });
});

// ---------------------------------------------------------------------------

describe("one streamer failing does not end the sweep", () => {
  it("continues past a streamer whose post sync throws", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([
      streamer("CBS-001"),
      streamer("CBS-BROKEN"),
      streamer("CBS-003"),
    ]);

    mocks.syncStreamerPosts.mockImplementation(async (params: { streamerId: string }) => {
      if (params.streamerId === "id-CBS-BROKEN") throw new Error("Graph exploded");
      return postsOk();
    });

    const result = await runSyncAll({ syncRunId: "run-parent" });

    // The two healthy streamers still produced their results.
    expect(result.streamersTotal).toBe(3);
    expect(result.streamersFailed).toBe(1);
    expect(result.postsProcessed).toBe(6);

    const broken = result.streamers.find((entry) => entry.streamer_code === "CBS-BROKEN");
    expect(broken?.status).toBe("failed");
    expect(broken?.errors[0]?.message).toContain("Graph exploded");
  });

  it("continues past a streamer whose sync returns a refusal", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001"), streamer("CBS-GONE")]);

    mocks.syncStreamerPosts.mockImplementation(async (params: { streamerId: string }) =>
      params.streamerId === "id-CBS-GONE"
        ? {
            ok: false as const,
            reason: "not_found" as const,
            message: "That streamer no longer exists.",
          }
        : postsOk(),
    );
    mocks.syncStreamerVideos.mockImplementation(async (params: { streamerId: string }) =>
      params.streamerId === "id-CBS-GONE"
        ? {
            ok: false as const,
            reason: "not_found" as const,
            message: "That streamer no longer exists.",
          }
        : videosOk(),
    );

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.streamersFailed).toBe(1);
    expect(result.streamers.find((e) => e.streamer_code === "CBS-001")?.status).toBe("completed");
  });

  it("reports partial rather than failed when some streamers worked", async () => {
    /*
     * The judgement that matters. A sweep where nine of ten Pages synced is a
     * partial success — calling it `failed` trains an operator to ignore the
     * status field, and then a real total failure goes unnoticed.
     */
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001"), streamer("CBS-BROKEN")]);
    mocks.syncStreamerPosts.mockImplementation(async (params: { streamerId: string }) => {
      if (params.streamerId === "id-CBS-BROKEN") throw new Error("boom");
      return postsOk();
    });

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.status).toBe("completed_with_errors");
    expect(mocks.closedRuns.at(-1)?.status).toBe("completed_with_errors");
  });

  it("reports failed only when nothing worked at all", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A"), streamer("CBS-B")]);
    mocks.syncStreamerPosts.mockRejectedValue(new Error("everything is down"));

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.status).toBe("failed");
    expect(result.streamersSucceeded).toBe(0);
  });

  it("closes the parent run on every path, so a poller is never stranded", async () => {
    // A run stuck in `running` is the one state a polling workflow cannot
    // recover from — it would poll until its own timeout, every night.
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A")]);
    mocks.syncStreamerPosts.mockRejectedValue(new Error("boom"));
    mocks.syncStreamerVideos.mockRejectedValue(new Error("boom"));

    await runSyncAll({ syncRunId: "run-parent" });

    expect(mocks.closedRuns).toHaveLength(1);
    expect(["completed", "completed_with_errors", "failed"]).toContain(mocks.closedRuns[0]?.status);
  });

  it("closes the run even when the roster itself cannot be read", async () => {
    mocks.listSyncableStreamers.mockRejectedValue(new Error("database unreachable"));

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.status).toBe("failed");
    expect(mocks.closedRuns[0]?.status).toBe("failed");
    // A failed run must carry a message — the check constraint demands one.
    expect(mocks.closedRuns[0]?.message).toBeTruthy();
  });

  it("never throws, because a background caller has nobody to throw to", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A")]);
    mocks.syncStreamerPosts.mockRejectedValue(new Error("boom"));
    mocks.syncStreamerVideos.mockRejectedValue(new Error("boom"));
    mocks.validateStreamerToken.mockRejectedValue(new Error("also boom"));

    await expect(runSyncAll({ syncRunId: "run-parent" })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe("token health decides whether a streamer is worth syncing", () => {
  it.each(["expired", "invalid", "missing", "missing_permission"])(
    "skips a streamer whose token is %s without spending Graph quota",
    async (status) => {
      mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-STALE")]);
      mocks.validateStreamerToken.mockResolvedValue(validToken(status));

      const result = await runSyncAll({ syncRunId: "run-parent" });

      // Skipped, not failed: nothing is broken, the credential needs replacing.
      // And no Graph call is attempted, because it could not succeed.
      expect(result.streamersSkipped).toBe(1);
      expect(result.streamers[0]?.status).toBe("skipped");
      expect(result.streamers[0]?.token_status).toBe(status);
      expect(mocks.syncStreamerPosts).not.toHaveBeenCalled();
      expect(mocks.syncStreamerVideos).not.toHaveBeenCalled();
    },
  );

  it.each(["valid", "expiring", "unknown"])("proceeds when the token is %s", async (status) => {
    // `expiring` still works today; refusing to sync would create the outage
    // the warning exists to prevent.
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-OK")]);
    mocks.validateStreamerToken.mockResolvedValue(validToken(status));

    await runSyncAll({ syncRunId: "run-parent" });

    expect(mocks.syncStreamerPosts).toHaveBeenCalledTimes(1);
  });

  it("skips a streamer whose token could not be validated at all", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-X")]);
    mocks.validateStreamerToken.mockResolvedValue({
      ok: false,
      reason: "no_token",
      message: "This streamer has no Page token.",
    });

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.streamersSkipped).toBe(1);
    expect(mocks.syncStreamerPosts).not.toHaveBeenCalled();
  });

  it("can be told to skip validation, for a sweep that has just validated", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-OK")]);

    await runSyncAll({ syncRunId: "run-parent", options: { skipTokenValidation: true } });

    expect(mocks.validateStreamerToken).not.toHaveBeenCalled();
    expect(mocks.syncStreamerPosts).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe("comment collection within the sweep", () => {
  it("refreshes comments for the newest content and counts the summaries", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    mocks.listRecentPostIdsForStreamer.mockResolvedValue(["p1", "p2"]);
    mocks.listRecentVideoIdsForStreamer.mockResolvedValue(["v1"]);

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(mocks.syncContentComments).toHaveBeenCalledTimes(3);
    expect(result.commentsProcessed).toBe(15);
    expect(result.summariesGenerated).toBe(3);
  });

  it("counts only the summaries that were actually regenerated", async () => {
    // The hash gate means an unchanged comment set costs a Graph fetch and no
    // AI call. Counting it as a summary would overstate the spend.
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    mocks.listRecentPostIdsForStreamer.mockResolvedValue(["p1", "p2"]);
    mocks.syncContentComments.mockResolvedValue(
      commentsOk({ summaryRegenerated: false, summaryStatus: "unchanged", commentsStored: 4 }),
    );

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.commentsProcessed).toBe(8);
    expect(result.summariesGenerated).toBe(0);
  });

  it("carries on when one item's comments fail", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    mocks.listRecentPostIdsForStreamer.mockResolvedValue(["p1", "p2", "p3"]);
    mocks.syncContentComments.mockImplementation(async (params: { content: { id: string } }) => {
      if (params.content.id === "p2") throw new Error("comment fetch failed");
      return commentsOk();
    });

    const result = await runSyncAll({ syncRunId: "run-parent" });

    // Two of three still collected; the streamer is partial, not failed.
    expect(result.commentsProcessed).toBe(10);
    expect(result.streamers[0]?.status).toBe("completed_with_errors");
  });

  it("skips comments entirely when asked", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    mocks.listRecentPostIdsForStreamer.mockResolvedValue(["p1"]);

    const result = await runSyncAll({
      syncRunId: "run-parent",
      options: { skipComments: true },
    });

    expect(mocks.syncContentComments).not.toHaveBeenCalled();
    expect(result.summariesGenerated).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("configured ceilings", () => {
  it("applies the lookback window rather than walking all history", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);

    await runSyncAll({ syncRunId: "run-parent" });

    const call = mocks.syncStreamerPosts.mock.calls[0]?.[0] as { since: Date };
    expect(call.since).toBeInstanceOf(Date);

    // CONTENT_SYNC_LOOKBACK_DAYS defaults to 30.
    const daysAgo = (Date.now() - call.since.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(29);
    expect(daysAgo).toBeLessThan(31);
  });

  it("lets an explicit instant override the window", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    const since = new Date("2026-01-01T00:00:00Z");

    await runSyncAll({ syncRunId: "run-parent", options: { since } });

    const call = mocks.syncStreamerPosts.mock.calls[0]?.[0] as { since: Date };
    expect(call.since.toISOString()).toBe(since.toISOString());
  });

  it("bounds the comment cap by the per-streamer content ceiling", async () => {
    // Refreshing comments for more content than the sweep collects makes no
    // sense, so the smaller of the two wins.
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-001")]);
    mocks.listRecentPostIdsForStreamer.mockResolvedValue([]);

    await runSyncAll({
      syncRunId: "run-parent",
      options: { maxPostsForComments: 10_000 },
    });

    const [, limit] = mocks.listRecentPostIdsForStreamer.mock.calls[0] as [string, number];
    // MAX_POSTS_PER_STREAMER defaults to 100.
    expect(limit).toBeLessThanOrEqual(100);
  });
});

describe("a sweep larger than one function window", () => {
  /**
   * The Vercel constraint made behavioural.
   *
   * A function is killed at `maxDuration`, and `after()` work is bounded by the
   * same ceiling, so a roster that cannot be swept in one invocation must be
   * advanced across several. The run stays open in between — closing it early is
   * exactly the silent truncation this exists to prevent.
   */
  it("processes only the slice and leaves the run open", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([
      streamer("CBS-A"),
      streamer("CBS-B"),
      streamer("CBS-C"),
    ]);

    const result = await runSyncAll({
      syncRunId: "run-parent",
      options: { maxStreamers: 2 },
    });

    expect(mocks.syncStreamerPosts).toHaveBeenCalledTimes(2);
    expect(result.streamersTotal).toBe(2);
    expect(result.remaining).toBe(1);
    expect(result.finished).toBe(false);

    // Progress recorded, but the run is still `running` — never a terminal state.
    expect(mocks.closedRuns.at(-1)?.status).toBe("processing");
    expect(mocks.closedRuns.every((entry) => entry.status !== "completed")).toBe(true);
  });

  it("does not record a completion audit entry for an unfinished slice", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([
      streamer("CBS-A"),
      streamer("CBS-B"),
      streamer("CBS-C"),
    ]);

    await runSyncAll({ syncRunId: "run-parent", options: { maxStreamers: 1 } });

    // Auditing every slice would turn one sweep into several indistinguishable
    // "sync completed" entries.
    expect(mocks.recordAuditLogSafe).not.toHaveBeenCalled();
  });

  it("closes the run on the invocation that consumes the last streamer", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A"), streamer("CBS-B")]);

    const result = await runSyncAll({
      syncRunId: "run-parent",
      options: { maxStreamers: 5 },
    });

    expect(result.remaining).toBe(0);
    expect(result.finished).toBe(true);
    expect(result.status).toBe("completed");
    expect(mocks.closedRuns.at(-1)?.status).toBe("completed");
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledTimes(1);
  });

  it("still isolates a failing streamer inside a slice", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([
      streamer("CBS-A"),
      streamer("CBS-BROKEN"),
      streamer("CBS-C"),
    ]);

    mocks.syncStreamerPosts.mockImplementation(async (params: { streamerId: string }) => {
      if (params.streamerId === "id-CBS-BROKEN") throw new Error("Graph exploded");
      return postsOk();
    });

    const result = await runSyncAll({
      syncRunId: "run-parent",
      options: { maxStreamers: 2 },
    });

    // One of the two in this slice failed; the other still produced data, and
    // the third is untouched and still pending.
    expect(result.streamersFailed).toBe(1);
    expect(result.streamersSucceeded).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.finished).toBe(false);
  });
});

/**
 * The housekeeping a finished sweep is responsible for.
 *
 * Both of these were previously reachable only from an admin screen, so they
 * ran when configuration changed and never when data did. Asserted here rather
 * than only at the source level, because "the sweep calls it" is the property —
 * a future refactor that moves the call into one caller and forgets the others
 * would pass a grep and fail this.
 */
describe("a finished sweep files and tidies", () => {
  beforeEach(() => {
    housekeeping.resolveContentGames.mockClear();
    housekeeping.clearExpiredUserTokens.mockClear();
  });

  it("attributes the content it just collected", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A")]);

    await runSyncAll({ syncRunId: "run-parent" });

    expect(housekeeping.resolveContentGames).toHaveBeenCalledTimes(1);
    // `onlyMissing`: the nightly question is "file tonight's content". The
    // admin screen omits it because a changed hashtag must re-file rows that
    // already have an answer.
    expect(housekeeping.resolveContentGames).toHaveBeenCalledWith({ onlyMissing: true });
  });

  it("drops connect credentials whose hold has lapsed", async () => {
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A")]);

    await runSyncAll({ syncRunId: "run-parent" });

    expect(housekeeping.clearExpiredUserTokens).toHaveBeenCalledTimes(1);
  });

  it("does neither until the last slice", async () => {
    /*
     * Attribution is a whole-roster pass. Running it per slice would repeat the
     * same scan for no benefit — and on a sliced sweep the run is not finished,
     * so there is nothing to tidy up after yet.
     */
    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A"), streamer("CBS-B")]);

    const result = await runSyncAll({ syncRunId: "run-parent", options: { maxStreamers: 1 } });

    expect(result.finished).toBe(false);
    expect(result.remaining).toBe(1);
    expect(housekeeping.resolveContentGames).not.toHaveBeenCalled();
    expect(housekeeping.clearExpiredUserTokens).not.toHaveBeenCalled();
  });

  it("still finishes the sweep when housekeeping throws", async () => {
    // Content collected but unlabelled beats a sync reported as failed because
    // a labelling pass did not run.
    housekeeping.resolveContentGames.mockRejectedValueOnce(new Error("boom"));
    housekeeping.clearExpiredUserTokens.mockRejectedValueOnce(new Error("boom"));

    mocks.listSyncableStreamers.mockResolvedValue([streamer("CBS-A")]);

    const result = await runSyncAll({ syncRunId: "run-parent" });

    expect(result.finished).toBe(true);
    expect(result.status).not.toBe("failed");
  });
});
