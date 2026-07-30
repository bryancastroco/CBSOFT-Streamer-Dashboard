CREATE TYPE "public"."sync_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."sync_type" AS ENUM('full', 'incremental', 'manual', 'backfill', 'token_check');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('missing', 'active', 'expired', 'revoked', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_action_format_check" CHECK ("audit_logs"."action" ~ '^[a-z_]+\.[a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "streamers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_code" text NOT NULL,
	"streamer_name" text NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text NOT NULL,
	"encrypted_page_token" text,
	"page_token_last_four" varchar(4),
	"token_status" "token_status" DEFAULT 'missing' NOT NULL,
	"token_expires_at" timestamp with time zone,
	"token_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"last_successful_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "streamers_streamer_code_format_check" CHECK ("streamers"."streamer_code" ~ '^[A-Z0-9][A-Z0-9-]*$'),
	CONSTRAINT "streamers_page_id_format_check" CHECK ("streamers"."page_id" ~ '^[0-9]+$'),
	CONSTRAINT "streamers_last_four_length_check" CHECK ("streamers"."page_token_last_four" ~ '^.{4}$'),
	CONSTRAINT "streamers_token_consistency_check" CHECK (("streamers"."encrypted_page_token" is null and "streamers"."page_token_last_four" is null and "streamers"."token_status" = 'missing')
        or ("streamers"."encrypted_page_token" is not null and "streamers"."page_token_last_four" is not null and "streamers"."token_status" <> 'missing')),
	CONSTRAINT "streamers_token_is_ciphertext_check" CHECK ("streamers"."encrypted_page_token" is null or "streamers"."encrypted_page_token" ~ '^v[0-9]+\.')
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid,
	"sync_type" "sync_type" NOT NULL,
	"status" "sync_status" DEFAULT 'pending' NOT NULL,
	"posts_processed" integer DEFAULT 0 NOT NULL,
	"videos_processed" integer DEFAULT 0 NOT NULL,
	"comments_processed" integer DEFAULT 0 NOT NULL,
	"summaries_generated" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"error_details_json" jsonb,
	CONSTRAINT "sync_runs_counters_non_negative_check" CHECK ("sync_runs"."posts_processed" >= 0 and "sync_runs"."videos_processed" >= 0
        and "sync_runs"."comments_processed" >= 0 and "sync_runs"."summaries_generated" >= 0),
	CONSTRAINT "sync_runs_completed_after_started_check" CHECK ("sync_runs"."completed_at" is null or "sync_runs"."completed_at" >= "sync_runs"."started_at"),
	CONSTRAINT "sync_runs_terminal_status_check" CHECK (("sync_runs"."status" in ('succeeded', 'failed', 'partial') and "sync_runs"."completed_at" is not null)
        or ("sync_runs"."status" in ('pending', 'running') and "sync_runs"."completed_at" is null)),
	CONSTRAINT "sync_runs_failure_has_message_check" CHECK ("sync_runs"."status" <> 'failed' or "sync_runs"."error_message" is not null)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_format_check" CHECK (position('@' in "users"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "streamers_streamer_code_active_key" ON "streamers" USING btree ("streamer_code") WHERE "streamers"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "streamers_page_id_active_key" ON "streamers" USING btree ("page_id") WHERE "streamers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "streamers_active_idx" ON "streamers" USING btree ("active") WHERE "streamers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "streamers_token_status_idx" ON "streamers" USING btree ("token_status");--> statement-breakpoint
CREATE INDEX "streamers_last_successful_sync_at_idx" ON "streamers" USING btree ("last_successful_sync_at");--> statement-breakpoint
CREATE INDEX "sync_runs_streamer_id_started_at_idx" ON "sync_runs" USING btree ("streamer_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_runs_status_idx" ON "sync_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_runs_in_flight_idx" ON "sync_runs" USING btree ("started_at" DESC NULLS LAST) WHERE "sync_runs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");