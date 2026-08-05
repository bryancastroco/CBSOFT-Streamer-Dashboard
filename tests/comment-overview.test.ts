import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The roster-level comment reading, and the filters it must obey.
 *
 * ## Why this is against a real Postgres
 *
 * The entire feature is a scoping question: a comment reaches its streamer and
 * its date through whichever of `post_id` or `video_id` is set, expressed as
 * correlated EXISTS rather than a join because joining both multiplies rows. A
 * mock cannot disagree with that, and getting it wrong produces a summary that
 * looks perfectly plausible while describing the wrong comments — the worst
 * kind of failure for a panel a person reads and believes.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const aiMocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  provider: { value: "gemini" as string },
  enabled: { value: true },
}));

vi.mock("@/config/env", () => ({
  getServerEnv: () => ({
    AI_PROVIDER: aiMocks.provider.value,
    AI_SUMMARIZATION_ENABLED: aiMocks.enabled.value,
  }),
}));

vi.mock("@/lib/ai/resolve", () => ({ analyzeWithFallback: aiMocks.analyze }));

const { getCommentOverview } = await import("@/lib/repositories/comment-overview");

/** A model answer, distinguishable from the counter's output. */
function written(summary = "Players are asking about migration.") {
  return {
    ok: true as const,
    analysis: {
      summary,
      sentiment: "mixed" as const,
      positive_points: ["Community enthusiasm"],
      concerns: ["Migration delays"],
      suggestions: [],
      questions: ["When does migration finish?"],
      urgent_issues: [],
    },
    model: "gemini-flash-latest",
    provider: "gemini" as const,
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: {},
  };
}

let client: PGlite;
let alpha: string;
let beta: string;

async function seedStreamer(code: string, pageId: string): Promise<string> {
  const row = await client.query<{ id: string }>(
    `insert into streamers (streamer_code, streamer_name, page_id, page_name)
     values ($1, $1, $2, $1) returning id`,
    [code, pageId],
  );
  return row.rows[0]!.id;
}

/** A post with comments, at a chosen age. */
async function seedPost(options: {
  streamerId: string;
  handle: string;
  daysOld: number;
  comments: string[];
  sentiment?: "positive" | "negative" | "neutral" | "mixed";
}): Promise<void> {
  const post = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json)
     values ($1, $2, now() - ($3 || ' days')::interval, '{}'::jsonb) returning id`,
    [options.streamerId, options.handle, String(options.daysOld)],
  );
  const id = post.rows[0]!.id;

  for (const [index, message] of options.comments.entries()) {
    await client.query(
      `insert into comments (content_type, post_id, facebook_comment_id, message,
                             created_time, content_hash)
       values ('post', $1, $2, $3, now() - ($4 || ' days')::interval, $5)`,
      [
        id,
        `${options.handle}_c${index}`,
        message,
        String(options.daysOld),
        `h_${options.handle}_${index}`,
      ],
    );
  }

  if (options.sentiment) {
    await client.query(
      `insert into comment_summaries (content_type, post_id, source_hash, comment_count,
                                      status, sentiment, summary)
       values ('post', $1, 'h', $2, 'completed', $3, 'A summary.')`,
      [id, options.comments.length, options.sentiment],
    );
  }
}

async function seedVideo(options: {
  streamerId: string;
  handle: string;
  daysOld: number;
  comments: string[];
}): Promise<void> {
  const video = await client.query<{ id: string }>(
    `insert into videos (streamer_id, facebook_video_id, created_time, raw_json)
     values ($1, $2, now() - ($3 || ' days')::interval, '{}'::jsonb) returning id`,
    [options.streamerId, options.handle, String(options.daysOld)],
  );
  const id = video.rows[0]!.id;

  for (const [index, message] of options.comments.entries()) {
    await client.query(
      `insert into comments (content_type, video_id, facebook_comment_id, message,
                             created_time, content_hash)
       values ('video', $1, $2, $3, now() - ($4 || ' days')::interval, $5)`,
      [
        id,
        `${options.handle}_c${index}`,
        message,
        String(options.daysOld),
        `h_${options.handle}_${index}`,
      ],
    );
  }
}

/** No period bound — "all time". */
const ALL_TIME = { from: null, to: null } as const;

function filters(overrides: Record<string, unknown> = {}) {
  return {
    period: ALL_TIME,
    scope: "all",
    ...overrides,
  } as Parameters<typeof getCommentOverview>[0];
}

beforeAll(async () => {
  client = await createTestDatabase();
  holder.db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.query("delete from streamers");
  await client.query("delete from comment_overview_summaries");

  aiMocks.analyze.mockReset();
  aiMocks.analyze.mockResolvedValue(written());
  aiMocks.provider.value = "gemini";
  aiMocks.enabled.value = true;

  alpha = await seedStreamer("ALPHA", FAKE_PAGE_ID);
  beta = await seedStreamer("BETA", "987654321098765");
});

describe("it obeys the streamer filter", () => {
  it("pools only the selected streamer's comments", async () => {
    await seedPost({ streamerId: alpha, handle: "a1", daysOld: 1, comments: ["great stream"] });
    await seedPost({ streamerId: beta, handle: "b1", daysOld: 1, comments: ["nice one", "good"] });

    const scoped = await getCommentOverview(filters({ streamerId: alpha }));

    expect(scoped.analysed).toBe(1);
    expect(scoped.contentInScope).toBe(1);
  });

  it("pools every streamer when none is chosen", async () => {
    await seedPost({ streamerId: alpha, handle: "a1", daysOld: 1, comments: ["great stream"] });
    await seedPost({ streamerId: beta, handle: "b1", daysOld: 1, comments: ["nice one", "good"] });

    expect((await getCommentOverview(filters())).analysed).toBe(3);
  });
});

describe("it obeys the period filter", () => {
  it("excludes content outside the window", async () => {
    // The date that matters is the *content's*, not the comment's — the filter
    // bar selects posts and videos, and a comment inherits its parent's period.
    await seedPost({ streamerId: alpha, handle: "recent", daysOld: 2, comments: ["inside"] });
    await seedPost({
      streamerId: alpha,
      handle: "old",
      daysOld: 90,
      comments: ["outside", "also"],
    });

    const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const scoped = await getCommentOverview(filters({ period: { from: thirtyDays, to: null } }));

    expect(scoped.analysed).toBe(1);
    expect(scoped.contentSampled).toBe(1);
  });
});

describe("it obeys the content filter", () => {
  beforeEach(async () => {
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["from a post"] });
    await seedVideo({
      streamerId: alpha,
      handle: "v1",
      daysOld: 1,
      comments: ["from a video", "another"],
    });
  });

  it("counts both by default", async () => {
    expect((await getCommentOverview(filters())).analysed).toBe(3);
  });

  it("counts posts only", async () => {
    expect((await getCommentOverview(filters({ scope: "posts" }))).analysed).toBe(1);
  });

  it("counts videos only", async () => {
    expect((await getCommentOverview(filters({ scope: "videos" }))).analysed).toBe(2);
  });
});

describe("what it reports", () => {
  it("says when it read only part of the selection", async () => {
    /*
     * A reading that silently covers a fifth of its stated scope is worse than
     * one that admits it, because nothing on screen would give the reader a
     * clue.
     */
    await seedPost({ streamerId: alpha, handle: "newest", daysOld: 1, comments: ["a", "b"] });
    await seedPost({ streamerId: alpha, handle: "older", daysOld: 5, comments: ["c"] });

    const capped = await getCommentOverview(filters(), { contentCap: 1 });

    expect(capped.contentSampled).toBe(1);
    expect(capped.contentInScope).toBe(2);
    expect(capped.truncated).toBe(true);
    // The newest item, not an arbitrary one — "what are people saying" means
    // lately, and a sample from the oldest end answers a different question.
    expect(capped.analysed).toBe(2);
  });

  it("does not claim truncation when it read everything", async () => {
    await seedPost({ streamerId: alpha, handle: "small", daysOld: 1, comments: ["one", "two"] });

    const full = await getCommentOverview(filters());

    expect(full.truncated).toBe(false);
    expect(full.contentSampled).toBe(full.contentInScope);
  });

  it("reports sentiment from the stored per-item analyses", async () => {
    /*
     * Not re-scored from the pooled text. Those stored rows are what the
     * sentiment chart and the analysis table already count, and a second,
     * differently derived number under the same word would read as a bug.
     */
    await seedPost({
      streamerId: alpha,
      handle: "p1",
      daysOld: 1,
      comments: ["good"],
      sentiment: "positive",
    });
    await seedPost({
      streamerId: alpha,
      handle: "p2",
      daysOld: 1,
      comments: ["bad"],
      sentiment: "negative",
    });

    const overview = await getCommentOverview(filters());

    expect(overview.sentiment.positive).toBe(1);
    expect(overview.sentiment.negative).toBe(1);
  });

  it("returns an empty result rather than failing when nothing matches", async () => {
    const overview = await getCommentOverview(filters({ streamerId: beta }));

    expect(overview.analysed).toBe(0);
    expect(overview.contentSampled).toBe(0);
    expect(overview.analysis.sentiment).toBe("no_comments");
  });

  it("counts content items, not comments, as coverage", async () => {
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["a", "b", "c"] });
    await seedPost({ streamerId: alpha, handle: "p2", daysOld: 1, comments: ["d"] });

    const overview = await getCommentOverview(filters());

    expect(overview.contentSampled).toBe(2);
    expect(overview.analysed).toBe(4);
  });
});

describe("the written reading, and paying for it once", () => {
  it("uses the configured provider rather than the counter", async () => {
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    const overview = await getCommentOverview(filters());

    expect(aiMocks.analyze).toHaveBeenCalledTimes(1);
    expect(overview.provider).toBe("gemini");
    expect(overview.analysis.summary).toContain("migration");
  });

  it("does not call the model again for the same content", async () => {
    /*
     * The whole reason the cache exists. A dashboard re-renders on every filter
     * change, navigation and refresh; billing for the same answer each time is
     * the mistake the per-post hash gate already prevents, at roster scale.
     */
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    const first = await getCommentOverview(filters());
    const second = await getCommentOverview(filters());

    expect(aiMocks.analyze).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(first.cached).toBe(false);
    // Same answer, not a differently worded one.
    expect(second.analysis.summary).toBe(first.analysis.summary);
  });

  it("hits the same cache row for two filter selections covering the same content", async () => {
    /*
     * The key is the content, not the filter values — "last 30 days" resolves
     * to a different instant every render, so a key built from those would
     * never hit and the cache would be decorative.
     */
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    await getCommentOverview(filters());
    const byStreamer = await getCommentOverview(filters({ streamerId: alpha }));

    expect(aiMocks.analyze).toHaveBeenCalledTimes(1);
    expect(byStreamer.cached).toBe(true);
  });

  it("computes again once a new comment arrives", async () => {
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });
    await getCommentOverview(filters());

    await client.query(
      `insert into comments (content_type, post_id, facebook_comment_id, message,
                             created_time, content_hash)
       select 'post', id, 'new_one', 'bagong tanong?', now(), 'h_new'
         from posts where facebook_post_id = 'p1'`,
    );

    const after = await getCommentOverview(filters());

    // The conversation changed, so the reading should too.
    expect(aiMocks.analyze).toHaveBeenCalledTimes(2);
    expect(after.cached).toBe(false);
  });

  it("sends the model a bounded sample, not every comment", async () => {
    /*
     * Comments become prompt tokens. Five thousand of them would turn a
     * dashboard render into a real expense, and a tone-and-themes reading does
     * not improve materially past a few hundred.
     */
    await seedPost({
      streamerId: alpha,
      handle: "busy",
      daysOld: 1,
      comments: Array.from({ length: 600 }, (_, index) => `comment number ${index}`),
    });

    await getCommentOverview(filters());

    const sent = aiMocks.analyze.mock.calls[0]?.[0] as { messages: string[] };
    expect(sent.messages.length).toBe(400);
  });

  it("falls back to the counter when the provider refuses", async () => {
    // A dashboard panel must render. A depleted balance is not a reason to
    // show nothing.
    aiMocks.analyze.mockResolvedValue({
      ok: false,
      category: "rate_limited",
      message: "Prepayment credits are depleted.",
      retryable: true,
      provider: "gemini",
      model: "gemini-flash-latest",
    });

    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    const overview = await getCommentOverview(filters());

    expect(overview.provider).toBe("offline");
    expect(overview.analysis.summary).toContain("without a language model");
  });

  it("never calls a provider when summarisation is switched off", async () => {
    aiMocks.enabled.value = false;
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    const overview = await getCommentOverview(filters());

    expect(aiMocks.analyze).not.toHaveBeenCalled();
    expect(overview.provider).toBe("offline");
  });

  it("never calls a provider when the configured one is the counter", async () => {
    aiMocks.provider.value = "offline";
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    await getCommentOverview(filters());

    expect(aiMocks.analyze).not.toHaveBeenCalled();
  });
});

describe("a stored tally is a loan, not the final answer", () => {
  it("asks the model again after a fallback was cached", async () => {
    /*
     * The freeze this prevents, and a mistake already made once on the
     * per-post path.
     *
     * When the provider refuses, the counter's reading is stored so the panel
     * renders. If that counted as a cache hit, the content would never change,
     * so the hash would never move, so the model would never be asked again —
     * no matter how much credit was added afterwards. The panel would show a
     * tally for ever and nothing would explain why.
     */
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    aiMocks.analyze.mockResolvedValueOnce({
      ok: false,
      category: "rate_limited",
      message: "Prepayment credits are depleted.",
      retryable: true,
      provider: "gemini",
      model: "gemini-flash-latest",
    });

    const refused = await getCommentOverview(filters());
    expect(refused.provider).toBe("offline");

    // Credit returns. Same content, same hash — and it must try again.
    const recovered = await getCommentOverview(filters());

    expect(aiMocks.analyze).toHaveBeenCalledTimes(2);
    expect(recovered.provider).toBe("gemini");
    expect(recovered.analysis.summary).toContain("migration");
  });

  it("replaces the stored tally rather than leaving it beside the real one", async () => {
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    aiMocks.analyze.mockResolvedValueOnce({
      ok: false,
      category: "unavailable",
      message: "High demand.",
      retryable: true,
      provider: "gemini",
      model: "gemini-flash-latest",
    });

    await getCommentOverview(filters());
    await getCommentOverview(filters());

    const stored = await client.query<{ ai_provider: string; n: string }>(
      `select ai_provider, count(*)::text as n from comment_overview_summaries group by 1`,
    );

    // One row, upgraded — not two rows disagreeing about the same content.
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.ai_provider).toBe("gemini");
  });

  it("still serves a cached model answer without asking again", async () => {
    // The saving has to survive the fix, or every render bills afresh.
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    await getCommentOverview(filters());
    const second = await getCommentOverview(filters());

    expect(aiMocks.analyze).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it("treats a stored tally as final when the counter is the configured provider", async () => {
    // Nothing to upgrade to. Recomputing every render would be pure waste.
    aiMocks.provider.value = "offline";
    await seedPost({ streamerId: alpha, handle: "p1", daysOld: 1, comments: ["ano po?"] });

    await getCommentOverview(filters());
    const second = await getCommentOverview(filters());

    expect(second.cached).toBe(true);
    expect(aiMocks.analyze).not.toHaveBeenCalled();
  });
});
