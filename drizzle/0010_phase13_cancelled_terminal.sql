-- Phase 13, part two: teach the terminal-status rule about `cancelled`.
--
-- Split from 0009 because Postgres refuses to use an enum value in the same
-- transaction that added it:
--
--   ERROR: unsafe use of new value "cancelled" of enum type sync_status
--
-- The value is committed by the time this file runs, so the constraint can
-- name it. Recreated rather than supplemented: two overlapping constraints for
-- one invariant is how contradictory rules get shipped.

ALTER TABLE "sync_runs" DROP CONSTRAINT IF EXISTS "sync_runs_terminal_status_check";--> statement-breakpoint

ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_terminal_status_check" CHECK (
  (
    "status" IN ('completed', 'failed', 'completed_with_errors', 'cancelled')
    AND "completed_at" IS NOT NULL
  )
  OR (
    "status" IN ('queued', 'processing')
    AND "completed_at" IS NULL
  )
);
