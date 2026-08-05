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

const { getCommentOverview } = await import("@/lib/repositories/comment-overview");

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
