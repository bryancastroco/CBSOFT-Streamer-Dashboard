CREATE TYPE "public"."export_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset" text NOT NULL,
	"format" text DEFAULT 'json' NOT NULL,
	"caller" text DEFAULT 'n8n' NOT NULL,
	"status" "export_status" NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"total_available" integer,
	"filters_json" jsonb,
	"error_message" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_runs_row_count_non_negative_check" CHECK ("export_runs"."row_count" >= 0),
	CONSTRAINT "export_runs_failure_has_message_check" CHECK ("export_runs"."status" <> 'failed' or "export_runs"."error_message" is not null)
);
--> statement-breakpoint
CREATE INDEX "export_runs_created_at_idx" ON "export_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "export_runs_dataset_created_at_idx" ON "export_runs" USING btree ("dataset","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "export_runs_succeeded_idx" ON "export_runs" USING btree ("created_at" DESC NULLS LAST) WHERE "export_runs"."status" = 'succeeded';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Security posture, matching every table since Phase 2.
--
-- `export_runs` is operational telemetry: which dataset was exported, how many
-- rows, and whether it worked. It holds no token, no secret and no personal
-- data — `filters_json` carries only the query parameters a caller supplied.
--
-- Readable by any signed-in user because the Settings page shows it. Written
-- only by server code holding the service role, so there is no write policy at
-- all: an insert from a browser session is refused by the absence of a policy
-- rather than by a rule someone has to remember.
-- ---------------------------------------------------------------------------
ALTER TABLE "export_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS export_runs_select_authenticated ON public.export_runs;--> statement-breakpoint
CREATE POLICY export_runs_select_authenticated ON public.export_runs
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

-- Table-level grants are revoked first. A table-level GRANT silently overrides
-- a column-level REVOKE, which is the trap documented in SECURITY.md — even
-- though every column here is safe, the pattern stays consistent so nobody
-- learns the wrong habit from this file.
REVOKE ALL ON public.export_runs FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON public.export_runs TO authenticated;