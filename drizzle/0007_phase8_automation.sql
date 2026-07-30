ALTER TYPE "public"."sync_type" ADD VALUE 'automation';--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "parent_sync_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_parent_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("parent_sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_parent_id_idx" ON "sync_runs" USING btree ("parent_sync_run_id");--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_parent_not_self_check" CHECK ("sync_runs"."parent_sync_run_id" <> "sync_runs"."id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grant the new column explicitly.
--
-- `sync_runs` is granted to `authenticated` COLUMN BY COLUMN, not at table
-- level — that is what keeps `streamers.encrypted_page_token` unreadable
-- elsewhere, and it has a consequence here: a column added later is NOT covered
-- by the existing grant. Without this line `parent_sync_run_id` would be
-- invisible to every client role, and the omission would only surface the first
-- time something selected it. See SECURITY.md on column-level grants.
--
-- The value is a run id. It is not token material and carries no secret.
-- ---------------------------------------------------------------------------
GRANT SELECT ("parent_sync_run_id") ON public.sync_runs TO authenticated;