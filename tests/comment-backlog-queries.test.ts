import type { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";
import { FAKE_PAGE_ID } from "./fixtures/meta";

/**
 * The backlog queries, run against a real Postgres.
 *
 * ## Why this is not a unit test
 *
 * Both queues are raw SQL. Their correctness lives in a `NOT EXISTS` against a
 * partial index and a status list — a shape TypeScript cannot check and a mock
 * cannot disagree with. A typo in a column name or a status value produces
 * either an error nobody sees until the nightly run, or, worse, a query that
 * runs fine and quietly returns nothing, which is indistinguishable from a
 * finished backfill.
 *
 * The distinction being pinned here is the one migration 0014 exists for: a
 * post with no comments is *not* the same as a post nobody has looked at, and
 * conflating them gives a drain that re-walks the silent posts for ever and
 * never reaches the rest of the roster.
 */

const holder = vi.hoisted(() => ({ db: null as PgliteDatabase<typeof schema> | null }));

vi.mock("@/lib/db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("test database not ready");
    return holder.db;
  },
}));

const { countCommentBacklog, listContentAwaitingAnalysis, listContentAwaitingCollection } =
  await import("@/lib/repositories/comment-backlog");

let client: PGlite;
let streamerId: string;

/** A post, optionally already looked at, optionally carrying comments. */
async function seedPost(options: {
  handle: string;
  collected?: boolean;
  comments?: number;
  summaryStatus?: "completed" | "no_comments" | "failed" | "pending";
  daysOld?: number;
}): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into posts (streamer_id, facebook_post_id, created_time, raw_json, comments_synced_at)
     values ($1, $2, now() - ($3 || ' days')::interval, '{}'::jsonb,
             case when $4 then now() else null end)
     returning id`,
    [streamerId, options.handle, String(options.daysOld ?? 0), options.collected ?? false],
  );

  const id = inserted.rows[0]!.id;

  for (let index = 0; index < (options.comments ?? 0); index += 1) {
    await client.query(
      `insert into comments (content_type, post_id, facebook_comment_id, message,
                             created_time, content_hash)
       values ('post', $1, $2, 'nice one', now(), $3)`,
      [id, `${options.handle}_c${index}`, `hash_${options.handle}_${index}`],
    );
  }

  if (options.summaryStatus) {
    /*
     * `comment_summaries_status_consistency_check` demands prose on a
     * `completed` row and a reason on a `failed` one — a settled status that
     * carries nothing is exactly the state the table refuses to hold.
     */
    await client.query(
      `insert into comment_summaries (content_type, post_id, source_hash, comment_count,
                                      status, summary, error_message)
       values ('post', $1, 'hash', $2, $3, $4, $5)`,
      [
        id,
        options.comments ?? 0,
        options.summaryStatus,
        options.summaryStatus === "completed" ? "Commenters were positive." : null,
        options.summaryStatus === "failed" ? "The provider refused." : null,
      ],
    );
  }

  return id;
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

  const inserted = await client.query<{ id: string }>(
    // `streamers_token_consistency_check` insists ciphertext, last four and a
    // non-missing status travel together, so a connected streamer needs all three.
    `insert into streamers (streamer_code, streamer_name, page_id, page_name,
                            encrypted_page_token, page_token_last_four, token_status)
     values ('BACK', 'Backlog', $1, 'Backlog Page', 'v1.a.b.c', '1234', 'valid') returning id`,
    [FAKE_PAGE_ID],
  );

  streamerId = inserted.rows[0]!.id;
});

describe("the collection queue", () => {
  it("claims content nobody has looked at", async () => {
    await seedPost({ handle: "fresh" });

    const queue = await listContentAwaitingCollection(10);

    expect(queue).toHaveLength(1);
    expect(queue[0]?.facebookId).toBe("fresh");
  });

  it("leaves a post that was looked at and genuinely had no comments", async () => {
    /*
     * The whole reason `comments_synced_at` exists. This post has no comment
     * rows and never will — a queue keyed on "has no comments" would hand it
     * back on every run for ever, and the roster behind it would never be
     * reached.
     */
    await seedPost({ handle: "silent", collected: true, comments: 0 });

    expect(await listContentAwaitingCollection(10)).toHaveLength(0);
  });

  it("claims the newest content first", async () => {
    await seedPost({ handle: "old", daysOld: 90 });
    await seedPost({ handle: "recent", daysOld: 1 });

    const queue = await listContentAwaitingCollection(10);

    // Oldest-first would spend the first several nights on posts nobody opens,
    // leaving the part of the roster someone might read until last.
    expect(queue.map((entry) => entry.facebookId)).toEqual(["recent", "old"]);
  });

  it("ignores content belonging to a streamer with no usable token", async () => {
    // Claiming it would consume a slot in the run's budget to produce a
    // `no_token` outcome and nothing else.
    await client.query(
      "update streamers set encrypted_page_token = null, page_token_last_four = null, token_status = 'missing'",
    );
    await seedPost({ handle: "orphan" });

    expect(await listContentAwaitingCollection(10)).toHaveLength(0);
  });

  it.each(["expired", "invalid", "missing_permission"] as const)(
    "ignores content behind a %s token, which still has ciphertext stored",
    async (status) => {
      /*
       * The case a presence check misses, and the one that actually happened.
       *
       * An expired token is still *stored*, so "has a token" admits the Page —
       * and because the queue is newest-first, that Page's whole history sits
       * near the front failing identically on every run. The first real slice
       * spent a fifth of its budget on `(190) Session has expired`.
       */
      await client.query("update streamers set token_status = $1", [status]);
      await seedPost({ handle: "stale-token" });

      expect(await listContentAwaitingCollection(10)).toHaveLength(0);
    },
  );

  it("picks the content up again once the token is replaced", async () => {
    // Skipping must not mean forgetting: the item stays unmarked, so nothing
    // has to be re-detected when the credential is fixed.
    await client.query("update streamers set token_status = 'expired'");
    await seedPost({ handle: "waiting" });

    expect(await listContentAwaitingCollection(10)).toHaveLength(0);

    await client.query("update streamers set token_status = 'valid'");

    expect(await listContentAwaitingCollection(10)).toHaveLength(1);
  });

  it("honours the limit", async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedPost({ handle: `p${index}`, daysOld: index });
    }

    expect(await listContentAwaitingCollection(3)).toHaveLength(3);
  });
});

describe("the analysis queue", () => {
  it("claims content that has comments and no summary", async () => {
    await seedPost({ handle: "unanalysed", collected: true, comments: 2 });

    const queue = await listContentAwaitingAnalysis(10);

    expect(queue.map((entry) => entry.facebookId)).toEqual(["unanalysed"]);
  });

  it.each(["failed", "pending"] as const)("reclaims a %s attempt", async (status) => {
    // The comments are unchanged; the *outcome* was absent. Retrying is right.
    await seedPost({ handle: "retry", collected: true, comments: 2, summaryStatus: status });

    expect(await listContentAwaitingAnalysis(10)).toHaveLength(1);
  });

  it.each(["completed", "no_comments"] as const)("leaves a %s summary alone", async (status) => {
    await seedPost({ handle: "done", collected: true, comments: 2, summaryStatus: status });

    expect(await listContentAwaitingAnalysis(10)).toHaveLength(0);
  });

  it("never claims content with no comments to analyse", async () => {
    await seedPost({ handle: "silent", collected: true, comments: 0 });

    expect(await listContentAwaitingAnalysis(10)).toHaveLength(0);
  });
});

describe("the remaining counts", () => {
  it("counts the two queues separately", async () => {
    await seedPost({ handle: "uncollected" });
    await seedPost({ handle: "collected-unanalysed", collected: true, comments: 3 });
    await seedPost({
      handle: "finished",
      collected: true,
      comments: 3,
      summaryStatus: "completed",
    });

    const counts = await countCommentBacklog();

    expect(counts.awaitingCollection).toBe(1);
    expect(counts.awaitingAnalysis).toBe(1);
  });

  it("counts a streamer's content even when its token is gone, and says so", async () => {
    /*
     * Deliberately different from the claiming queries. Those skip a
     * token-less streamer because working on it is futile; the count must not,
     * or a Page with an expired token would silently report a finished backlog
     * while collecting nothing.
     *
     * `blockedByToken` is what keeps both of those true at once: the work is
     * still counted, and the reason it is not moving is stated.
     */
    await seedPost({ handle: "orphan" });
    await client.query("update streamers set token_status = 'expired'");

    const counts = await countCommentBacklog();

    expect(counts.awaitingCollection).toBe(1);
    expect(counts.blockedByToken).toBe(1);
    expect(await listContentAwaitingCollection(10)).toHaveLength(0);
  });

  it("counts nothing as blocked while the token is healthy", async () => {
    await seedPost({ handle: "fine" });

    const counts = await countCommentBacklog();

    expect(counts.awaitingCollection).toBe(1);
    expect(counts.blockedByToken).toBe(0);
  });

  it("reports zero once everything is settled", async () => {
    await seedPost({ handle: "a", collected: true, comments: 1, summaryStatus: "completed" });
    await seedPost({ handle: "b", collected: true, comments: 0 });

    expect(await countCommentBacklog()).toEqual({
      awaitingCollection: 0,
      awaitingAnalysis: 0,
      blockedByToken: 0,
      awaitingUpgrade: 0,
    });
  });
});
