-- Phase 13: sync-run lifecycle — statuses, trigger source, and a real lock.
--
-- Three changes, each solving a problem the previous design left open.
--
-- 1. STATUS NAMES
--
--    The lifecycle is renamed, not rebuilt:
--
--      pending    -> queued
--      running    -> processing
--      succeeded  -> completed
--      partial    -> completed_with_errors
--      (new)         cancelled
--
--    `ALTER TYPE ... RENAME VALUE` is used rather than a new enum plus a column
--    swap. It rewrites nothing: existing rows keep their identity because
--    Postgres stores the enum's OID, not its label. For the same reason the two
--    CHECK constraints that name these values keep working without being
--    recreated — their stored expressions reference the same OIDs and simply
--    render with the new labels afterwards.
--
--    `cancelled` is genuinely new. Until now a sweep could be abandoned but not
--    recorded as abandoned, so an operator could not tell "stopped on purpose"
--    from "still running since Tuesday".
--
-- 2. TRIGGER SOURCE
--
--    `sync_type` described WHAT a run did (full, incremental, token_check). It
--    was also being used to imply WHO asked for it, which is a different
--    question and the one an operator actually asks first when a run misbehaves.
--    They are now separate columns.
--
-- 3. ONE ACTIVE SWEEP, ENFORCED BY THE DATABASE
--
--    The old guard read `sync_runs` for an in-flight run and then inserted —
--    a read-then-write race. Two callers arriving together both saw nothing and
--    both started a sweep, which on Meta's rate limit is expensive.
--
--    A partial unique index makes concurrency the database's problem: at most
--    one top-level run may be `queued` or `processing` at any moment, and the
--    second inserter gets a unique violation instead of a second sweep. Child
--    runs are excluded, so per-streamer runs still proceed in parallel.

ALTER TYPE "sync_status" RENAME VALUE 'pending' TO 'queued';--> statement-breakpoint
ALTER TYPE "sync_status" RENAME VALUE 'running' TO 'processing';--> statement-breakpoint
ALTER TYPE "sync_status" RENAME VALUE 'succeeded' TO 'completed';--> statement-breakpoint
ALTER TYPE "sync_status" RENAME VALUE 'partial' TO 'completed_with_errors';--> statement-breakpoint

ALTER TYPE "sync_status" ADD VALUE IF NOT EXISTS 'cancelled';--> statement-breakpoint

-- Who asked for the run. Nullable: rows that predate this column genuinely do
-- not know, and inventing a value for them would be a lie an operator could
-- later read as fact.
CREATE TYPE "trigger_source" AS ENUM ('admin', 'n8n', 'vercel_cron', 'system_retry');--> statement-breakpoint

ALTER TABLE "sync_runs" ADD COLUMN "trigger_source" "trigger_source";--> statement-breakpoint

-- The lock. `(parent_sync_run_id IS NULL)` is constant-true inside the WHERE
-- clause, so the index admits exactly one matching row.
CREATE UNIQUE INDEX IF NOT EXISTS "sync_runs_one_active_sweep_idx"
  ON "sync_runs" (("parent_sync_run_id" IS NULL))
  WHERE "parent_sync_run_id" IS NULL AND "status" IN ('queued', 'processing');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sync_runs_trigger_source_idx" ON "sync_runs" ("trigger_source");--> statement-breakpoint

-- The client roles read run history on the admin screen; they never write it.
GRANT SELECT ("trigger_source") ON "sync_runs" TO authenticated;
