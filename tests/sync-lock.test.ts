import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "./helpers/test-database";

/**
 * Only one roster sweep at a time, enforced by the database.
 *
 * ## Why a unique index rather than a check in code
 *
 * The previous guard read `sync_runs` for an in-flight sweep and then inserted.
 * That is a read-then-write race: n8n and Vercel Cron arriving in the same
 * second both saw nothing and both started a sweep. Two sweeps against the same
 * Pages is not merely wasteful — Meta's rate limit is per app, so the second one
 * degrades the first.
 *
 * `sync_runs_one_active_sweep_idx` moves the decision to Postgres, which is the
 * only participant that sees both inserts. The loser gets 23505.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec("delete from sync_runs");
});

async function openSweep(status = "processing") {
  return db.query<{ id: string }>(
    `insert into sync_runs (streamer_id, sync_type, status) values (null, 'automation', $1) returning id`,
    [status],
  );
}

async function attempt(fn: () => Promise<unknown>) {
  try {
    await fn();
    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code;
    return { ok: false as const, message, code };
  }
}

describe("one active sweep", () => {
  it("permits the first", async () => {
    const first = await attempt(() => openSweep());
    expect(first.ok).toBe(true);
  });

  it("refuses a second concurrent sweep with a unique violation", async () => {
    await openSweep();
    const second = await attempt(() => openSweep());

    expect(second.ok).toBe(false);
    expect(
      !second.ok && (second.code === "23505" || /unique|duplicate/i.test(second.message)),
    ).toBe(true);
  });

  it("refuses a queued sweep while another is processing", async () => {
    // Both non-terminal states count as active; a run sitting in `queued`
    // still owns the slot.
    await openSweep("processing");
    expect((await attempt(() => openSweep("queued"))).ok).toBe(false);
  });

  it("allows a new sweep once the previous one is closed", async () => {
    const first = await openSweep();
    await db.query(
      `update sync_runs set status = 'completed', completed_at = now() where id = $1`,
      [first.rows[0]!.id],
    );

    expect((await attempt(() => openSweep())).ok).toBe(true);
  });

  it("treats a cancelled sweep as closed, so it does not wedge the lock", async () => {
    /*
     * The reason `cancelled` had to exist. Before it, an abandoned sweep could
     * only be left `processing` or lied about as `completed` — and the first of
     * those would hold this lock forever.
     */
    const first = await openSweep();
    await db.query(
      `update sync_runs set status = 'cancelled', completed_at = now() where id = $1`,
      [first.rows[0]!.id],
    );

    expect((await attempt(() => openSweep())).ok).toBe(true);
  });

  it("does not restrict per-streamer child runs", async () => {
    // The lock is on roster sweeps only. Children run in parallel by design,
    // and locking them would serialise the whole sweep.
    const parent = await openSweep();

    const streamer = await db.query<{ id: string }>(
      `insert into streamers (streamer_code, streamer_name, page_id, page_name)
       values ('LOCK1', 'Lock Subject', '100000000000077', 'Lock Page') returning id`,
    );

    for (let i = 0; i < 3; i += 1) {
      const child = await attempt(() =>
        db.query(
          `insert into sync_runs (streamer_id, sync_type, status, parent_sync_run_id)
           values ($1, 'automation', 'processing', $2)`,
          [streamer.rows[0]!.id, parent.rows[0]!.id],
        ),
      );
      expect(child.ok, `child ${i}`).toBe(true);
    }
  });
});

describe("terminal statuses carry a completion time", () => {
  it.each(["completed", "failed", "completed_with_errors", "cancelled"])(
    "%s requires completed_at",
    async (status) => {
      const result = await attempt(() =>
        db.query(
          `insert into sync_runs (streamer_id, sync_type, status, error_message)
           values (null, 'manual', $1, 'because')`,
          [status],
        ),
      );

      expect(result.ok, `${status} without completed_at should be refused`).toBe(false);
    },
  );

  it.each(["queued", "processing"])("%s must NOT have completed_at", async (status) => {
    const result = await attempt(() =>
      db.query(
        `insert into sync_runs (streamer_id, sync_type, status, completed_at)
         values (null, 'manual', $1, now())`,
        [status],
      ),
    );

    expect(result.ok).toBe(false);
  });
});

describe("trigger source", () => {
  it.each(["admin", "n8n", "vercel_cron", "system_retry"])("accepts %s", async (source) => {
    const result = await attempt(() =>
      db.query(
        `insert into sync_runs (streamer_id, sync_type, status, trigger_source)
         values (null, 'manual', 'queued', $1)`,
        [source],
      ),
    );

    expect(result.ok, source).toBe(true);
    await db.exec("delete from sync_runs");
  });

  it("rejects a source outside the enum", async () => {
    const result = await attempt(() =>
      db.query(
        `insert into sync_runs (streamer_id, sync_type, status, trigger_source)
         values (null, 'manual', 'queued', 'whoever')`,
      ),
    );

    expect(result.ok).toBe(false);
  });

  it("allows null, because runs predating the column do not know", async () => {
    const result = await attempt(() =>
      db.query(
        `insert into sync_runs (streamer_id, sync_type, status) values (null, 'manual', 'queued')`,
      ),
    );

    expect(result.ok).toBe(true);
  });
});
