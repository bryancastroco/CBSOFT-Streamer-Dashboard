CREATE TABLE "video_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"metric_name" text NOT NULL,
	"period" text,
	"value_json" jsonb,
	"end_time" timestamp with time zone,
	"raw_json" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid NOT NULL,
	"facebook_video_id" text NOT NULL,
	"title" text,
	"description" text,
	"length_seconds" double precision,
	"created_time" timestamp with time zone NOT NULL,
	"permalink_url" text,
	"raw_json" jsonb NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "videos_length_non_negative_check" CHECK ("videos"."length_seconds" is null or "videos"."length_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "video_insights" ADD CONSTRAINT "video_insights_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_insights_metric_key" ON "video_insights" USING btree ("video_id","metric_name",coalesce("period", ''),coalesce("end_time", 'epoch'::timestamptz));--> statement-breakpoint
CREATE INDEX "video_insights_video_id_idx" ON "video_insights" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "video_insights_metric_name_idx" ON "video_insights" USING btree ("metric_name");--> statement-breakpoint
CREATE INDEX "video_insights_collected_at_idx" ON "video_insights" USING btree ("collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "videos_facebook_video_id_key" ON "videos" USING btree ("facebook_video_id");--> statement-breakpoint
CREATE INDEX "videos_streamer_id_created_time_idx" ON "videos" USING btree ("streamer_id","created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "videos_created_time_idx" ON "videos" USING btree ("created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "videos_last_synced_at_idx" ON "videos" USING btree ("last_synced_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "comment_summaries" ADD CONSTRAINT "comment_summaries_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Security posture, matching Phases 2, 4 and 5.
--
-- Video metadata is public on Facebook. Both tables are read-only to clients;
-- the sync engine writes them as the service role.
-- ---------------------------------------------------------------------------
ALTER TABLE "videos"         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "video_insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS videos_select_authenticated ON public.videos;--> statement-breakpoint
CREATE POLICY videos_select_authenticated ON public.videos
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

DROP POLICY IF EXISTS video_insights_select_authenticated ON public.video_insights;--> statement-breakpoint
CREATE POLICY video_insights_select_authenticated ON public.video_insights
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

REVOKE ALL ON public.videos         FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON public.video_insights FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON public.videos         TO authenticated;--> statement-breakpoint
GRANT SELECT ON public.video_insights TO authenticated;--> statement-breakpoint

DROP TRIGGER IF EXISTS videos_set_updated_at ON public.videos;--> statement-breakpoint
CREATE TRIGGER videos_set_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();