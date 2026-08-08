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

/**
 * Somebody has to actually take the next slice.
 *
 * ## The bug this was written after
 *
 * Everything above was green while the roster went half-swept for days. The
 * arithmetic was right and the resume query was right; nothing *called* them
 * a second time. n8n is documented to re-POST with `resume_sync_run_id`, but
 * Vercel Cron fires a GET and throws the response away — so on a roster of
 * eight with a cap of five, every night swept STM-001 to STM-005 and stopped.
 *
 * The run then stayed `processing`, which the partial unique index treats as a
 * sweep in flight, so the next tick was refused until the twenty-minute
 * reclaim; and because pending is per-run, the run after that started at the
 * top of the roster again. STM-006, STM-007 and STM-008 were unreachable by
 * *any* run, and read "Synced never" with no error anywhere to explain it.
 *
 * The `converges` test above is exactly this loop written by hand in a test —
 * which is why it proved nothing about production. These pin the driver's own
 * two rules instead: keep going while time allows, and stop if a slice makes
 * no progress.
 */
describe("the driver that advances a run", () => {
  /**
   * The cron's loop, in the same shape as `slice()` models the sweep's.
   *
   * `skipped` are streamers that open no child run — one skipped for token
   * health returns before the posts sync, and pending is derived from child
   * runs, so it stays pending for ever.
   */
  function drive(params: {
    roster: number;
    cap: number;
    skipped?: number;
    budgetSlices?: number;
  }) {
    const { roster, cap, skipped = 0, budgetSlices = 10 } = params;

    // Which streamers have opened a child run. The skipped ones are the lowest
    // indices, because pending is ordered by streamer code and that is the
    // worst arrangement for the guard: they are re-taken by every slice.
    const attempted = new Set<number>();
    let remaining = 0;
    let slices = 0;

    while (slices < budgetSlices) {
      const pending = Array.from({ length: roster }, (_, index) => index).filter(
        (index) => !attempted.has(index),
      );
      const taken = pending.slice(0, cap);
      const before = remaining;

      // `remaining` is pending minus this slice's take, decided when the slice
      // is planned — not re-derived afterwards. A streamer skipped inside the
      // slice still counts as taken by it.
      remaining = pending.length - taken.length;
      slices += 1;

      for (const index of taken) if (index >= skipped) attempted.add(index);

      if (remaining === 0) return { slices, remaining, stalled: false };

      // From the second slice on, no fall in `remaining` means no progress.
      if (slices > 1 && remaining >= before) return { slices, remaining, stalled: true };
    }

    return { slices, remaining, stalled: false };
  }

  it("finishes an eight-streamer roster that one slice cannot hold", () => {
    // The production case. One slice left three streamers permanently unswept.
    expect(drive({ roster: 8, cap: 5 })).toEqual({ slices: 2, remaining: 0, stalled: false });
  });

  it("takes one slice when the roster already fits", () => {
    expect(drive({ roster: 4, cap: 5 })).toEqual({ slices: 1, remaining: 0, stalled: false });
  });

  it("stops rather than spinning when a whole slice is skipped", () => {
    /*
     * Twelve streamers, and the five that sort first are all skipped for token
     * health. Each opens no child run, so it is still pending next time — the
     * slice takes the same five for ever and `remaining` sits at seven.
     *
     * Without the guard this revalidates the same five dead tokens against Meta
     * on every pass until the time budget expires, turning a handful of expired
     * credentials into a quota-burning loop that also starves the streamers
     * behind them.
     */
    expect(drive({ roster: 12, cap: 5, skipped: 5 })).toEqual({
      slices: 2,
      remaining: 7,
      stalled: true,
    });
  });

  it("keeps going when only part of a slice is skipped", () => {
    // Progress is progress. One dead token must not stop the roster — this is
    // the live case: eight streamers, one invalid token.
    expect(drive({ roster: 8, cap: 5, skipped: 1 })).toEqual({
      slices: 2,
      remaining: 0,
      stalled: false,
    });
  });

  it("finishes when the skipped streamers all fit in one slice", () => {
    // `remaining` is decided when the slice is planned, so a skip inside the
    // last slice does not hold the run open.
    expect(drive({ roster: 5, cap: 5, skipped: 5 })).toEqual({
      slices: 1,
      remaining: 0,
      stalled: false,
    });
  });

  it("leaves the rest pending when the budget runs out, rather than closing", () => {
    // A roster too big for one night ends part-swept and resumable — not
    // reported as complete, which is what the old design did.
    const result = drive({ roster: 40, cap: 5, budgetSlices: 3 });

    expect(result.remaining).toBe(25);
    expect(result.stalled).toBe(false);
  });
});
