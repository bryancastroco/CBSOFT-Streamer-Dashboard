import type { PGlite } from "@electric-sql/pglite";
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { streamers, syncRuns } from "@/lib/db/schema";

import { createTestDatabase } from "./helpers/test-database";

/**
 * Resumable sweeps: the query and the arithmetic behind them.
 *
 * ## Why this matters on Vercel
 *
 * A serverless function is killed at `maxDuration`, and work handed to `after()`
 * is bounded by the same ceiling. A roster larger than one window therefore
 * cannot be swept in a single invocation — and the previous design closed the
 * parent run anyway, marking a truncated sweep complete.
 *
 * So a sweep now takes a bounded slice and is resumed with the same run id.
 * "Already attempted" is derived from the child `sync_runs` rows rather than a
 * cursor column, which is what these tests pin: the exclusion subquery compiled
 * by Drizzle has to actually run, and it has to be scoped to *this* parent.
 */

let client: PGlite;
let db: PgliteDatabase;

let parentRunId: string;
let otherRunId: string;
const streamerIds: Record<string, string> = {};

beforeAll(async () => {
  client = await createTestDatabase();
  db = drizzle(client);
});

afterAll(async () => {
  await client?.close();
});

/** The production query, built with the same Drizzle constructs. */
function pendingFor(parentId: string) {
  const attempted = db
    .select({ streamerId: syncRuns.streamerId })
    .from(syncRuns)
    .where(eq(syncRuns.parentSyncRunId, parentId));

  return db
    .select({ id: streamers.id, streamerCode: streamers.streamerCode })
    .from(streamers)
    .where(
      and(
        isNull(streamers.deletedAt),
        eq(streamers.active, true),
        isNotNull(streamers.pageTokenLastFour),
        notInArray(streamers.id, attempted),
      ),
    )
    .orderBy(streamers.streamerCode);
}

beforeEach(async () => {
  await client.query("delete from sync_runs");
  await client.query("delete from streamers");

  // Five syncable streamers. `page_token_last_four` present, so each looks
  // connected; the consistency constraint needs a ciphertext alongside it.
  // `page_id` is constrained to digits — real Facebook Page ids are numeric.
  for (const [index, code] of ["A", "B", "C", "D", "E"].entries()) {
    const inserted = await client.query<{ id: string }>(
      `insert into streamers
         (streamer_code, streamer_name, page_id, page_name,
          encrypted_page_token, page_token_last_four, token_status)
       values ($1, $1, $2, $1, 'v1.aa.bb.cc', 'abcd', 'valid')
       returning id`,
      [code, `10000000000000${index}`],
    );
    streamerIds[code] = inserted.rows[0]!.id;
  }

  const parent = await client.query<{ id: string }>(
    `insert into sync_runs (streamer_id, sync_type, status) values (null, 'automation', 'processing') returning id`,
  );
  parentRunId = parent.rows[0]!.id;

  /*
   * The second parent is CLOSED, not active. Phase 13 added a partial unique
   * index permitting only one `queued`/`processing` top-level run at a time, so
   * two active sweeps can no longer coexist — which is the point of the lock.
   * A completed run is still a valid parent for the scoping assertion below.
   */
  const other = await client.query<{ id: string }>(
    `insert into sync_runs (streamer_id, sync_type, status, completed_at)
     values (null, 'automation', 'completed', now()) returning id`,
  );
  otherRunId = other.rows[0]!.id;
});

async function attempt(parentId: string, code: string, status = "completed") {
  // `sync_runs_failure_has_message_check` requires a message on a failed run,
  // so a failed attempt has to carry one.
  await client.query(
    `insert into sync_runs
       (streamer_id, sync_type, status, parent_sync_run_id, completed_at, error_message)
     values ($1, 'automation', $2, $3, now(), $4)`,
    [streamerIds[code], status, parentId, status === "failed" ? "Token expired." : null],
  );
}

describe("pending streamers for a run", () => {
  it("returns the whole roster before anything is attempted", async () => {
    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("excludes streamers already attempted under this run", async () => {
    await attempt(parentRunId, "A");
    await attempt(parentRunId, "B");

    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).toEqual(["C", "D", "E"]);
  });

  it("excludes a FAILED attempt too, so a broken Page cannot loop forever", async () => {
    /*
     * The important half of the rule. If only successes counted as attempted, a
     * streamer whose token is dead would be picked up by every resume and the
     * run would never reach `remaining: 0` — an infinite loop driven by n8n.
     */
    await attempt(parentRunId, "A", "failed");

    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).not.toContain("A");
  });

  it("is scoped to its own parent — another run's progress does not count", async () => {
    await attempt(otherRunId, "A");
    await attempt(otherRunId, "B");

    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns nothing once every streamer has been attempted", async () => {
    for (const code of ["A", "B", "C", "D", "E"]) await attempt(parentRunId, code);

    expect(await pendingFor(parentRunId)).toEqual([]);
  });

  it("still excludes inactive and token-less streamers", async () => {
    await client.query(`update streamers set active = false where streamer_code = 'A'`);
    await client.query(
      `update streamers set encrypted_page_token = null, page_token_last_four = null,
                            token_status = 'missing' where streamer_code = 'B'`,
    );

    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).toEqual(["C", "D", "E"]);
  });

  it("ignores a soft-deleted streamer", async () => {
    await client.query(`update streamers set deleted_at = now() where streamer_code = 'C'`);

    const pending = await pendingFor(parentRunId);
    expect(pending.map((row) => row.streamerCode)).toEqual(["A", "B", "D", "E"]);
  });
});

describe("slice arithmetic", () => {
  /**
   * The two lines in `runSyncAll` that decide whether a run closes. Cheap to
   * get subtly wrong — an off-by-one leaves one streamer unswept forever, or
   * closes a run with work outstanding.
   */
  function slice(pendingCount: number, maxStreamers: number) {
    const pending = Array.from({ length: pendingCount }, (_, index) => index);
    const taken = pending.slice(0, maxStreamers);
    const remaining = pending.length - taken.length;
    return { taken: taken.length, remaining, finished: remaining === 0 };
  }

  it("takes the whole roster when it fits", () => {
    expect(slice(3, 5)).toEqual({ taken: 3, remaining: 0, finished: true });
  });

  it("takes exactly the cap and reports the rest", () => {
    expect(slice(12, 5)).toEqual({ taken: 5, remaining: 7, finished: false });
  });

  it("finishes on the invocation that consumes the last streamer", () => {
    expect(slice(5, 5)).toEqual({ taken: 5, remaining: 0, finished: true });
  });

  it("treats an empty roster as finished rather than as work pending", () => {
    expect(slice(0, 5)).toEqual({ taken: 0, remaining: 0, finished: true });
  });

  it("converges: repeated slices always reach zero", () => {
    let outstanding = 23;
    let invocations = 0;

    while (outstanding > 0) {
      outstanding = slice(outstanding, 5).remaining;
      invocations += 1;
      expect(invocations).toBeLessThan(20);
    }

    expect(invocations).toBe(5);
  });
});
