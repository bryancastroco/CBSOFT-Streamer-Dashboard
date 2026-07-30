CREATE TYPE "public"."comment_sentiment" AS ENUM('positive', 'mixed', 'negative', 'neutral', 'no_comments');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('post', 'video');--> statement-breakpoint
CREATE TYPE "public"."summary_status" AS ENUM('pending', 'processing', 'completed', 'no_comments', 'failed');--> statement-breakpoint
CREATE TABLE "comment_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" "content_type" NOT NULL,
	"post_id" uuid,
	"video_id" uuid,
	"source_hash" text NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"sentiment" "comment_sentiment",
	"positive_points_json" jsonb,
	"concerns_json" jsonb,
	"suggestions_json" jsonb,
	"questions_json" jsonb,
	"urgent_issues_json" jsonb,
	"ai_provider" text,
	"model" text,
	"status" "summary_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"raw_ai_response" jsonb,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_summaries_one_parent_check" CHECK (("comment_summaries"."content_type" = 'post' and "comment_summaries"."post_id" is not null and "comment_summaries"."video_id" is null)
        or ("comment_summaries"."content_type" = 'video' and "comment_summaries"."video_id" is not null and "comment_summaries"."post_id" is null)),
	CONSTRAINT "comment_summaries_comment_count_check" CHECK ("comment_summaries"."comment_count" >= 0),
	CONSTRAINT "comment_summaries_status_consistency_check" CHECK (("comment_summaries"."status" <> 'failed' or "comment_summaries"."error_message" is not null)
        and ("comment_summaries"."status" <> 'completed' or "comment_summaries"."summary" is not null))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_type" "content_type" NOT NULL,
	"post_id" uuid,
	"video_id" uuid,
	"facebook_comment_id" text NOT NULL,
	"message" text,
	"created_time" timestamp with time zone NOT NULL,
	"like_count" integer,
	"reply_count" integer,
	"content_hash" text NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_one_parent_check" CHECK (("comments"."content_type" = 'post' and "comments"."post_id" is not null and "comments"."video_id" is null)
        or ("comments"."content_type" = 'video' and "comments"."video_id" is not null and "comments"."post_id" is null)),
	CONSTRAINT "comments_counts_non_negative_check" CHECK (("comments"."like_count" is null or "comments"."like_count" >= 0)
        and ("comments"."reply_count" is null or "comments"."reply_count" >= 0))
);
--> statement-breakpoint
ALTER TABLE "comment_summaries" ADD CONSTRAINT "comment_summaries_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_summaries_post_key" ON "comment_summaries" USING btree ("post_id") WHERE "comment_summaries"."post_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_summaries_video_key" ON "comment_summaries" USING btree ("video_id") WHERE "comment_summaries"."video_id" is not null;--> statement-breakpoint
CREATE INDEX "comment_summaries_status_idx" ON "comment_summaries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "comment_summaries_generated_at_idx" ON "comment_summaries" USING btree ("generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "comments_facebook_comment_id_key" ON "comments" USING btree ("facebook_comment_id");--> statement-breakpoint
CREATE INDEX "comments_post_id_created_time_idx" ON "comments" USING btree ("post_id","created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_video_id_created_time_idx" ON "comments" USING btree ("video_id","created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_content_type_idx" ON "comments" USING btree ("content_type");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Security posture, matching Phases 2 and 4.
--
-- Comment text is public on Facebook, and no commenter identity is stored — the
-- Graph request never asks for the `from` field, and there is no column for one.
-- Both tables are read-only to clients; the sync engine writes them as the
-- service role.
-- ---------------------------------------------------------------------------
ALTER TABLE "comments"           ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment_summaries"  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS comments_select_authenticated ON public.comments;--> statement-breakpoint
CREATE POLICY comments_select_authenticated ON public.comments
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

DROP POLICY IF EXISTS comment_summaries_select_authenticated ON public.comment_summaries;--> statement-breakpoint
CREATE POLICY comment_summaries_select_authenticated ON public.comment_summaries
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

REVOKE ALL ON public.comments          FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON public.comment_summaries FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON public.comments          TO authenticated;--> statement-breakpoint
GRANT SELECT ON public.comment_summaries TO authenticated;--> statement-breakpoint

DROP TRIGGER IF EXISTS comments_set_updated_at ON public.comments;--> statement-breakpoint
CREATE TRIGGER comments_set_updated_at
  BEFORE UPDATE ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();--> statement-breakpoint

DROP TRIGGER IF EXISTS comment_summaries_set_updated_at ON public.comment_summaries;--> statement-breakpoint
CREATE TRIGGER comment_summaries_set_updated_at
  BEFORE UPDATE ON public.comment_summaries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();