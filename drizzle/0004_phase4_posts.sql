CREATE TABLE "post_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"metric_name" text NOT NULL,
	"period" text,
	"value_json" jsonb,
	"end_time" timestamp with time zone,
	"raw_json" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"streamer_id" uuid NOT NULL,
	"facebook_post_id" text NOT NULL,
	"message" text,
	"created_time" timestamp with time zone NOT NULL,
	"permalink_url" text,
	"reaction_count" integer,
	"comment_count" integer,
	"share_count" integer,
	"raw_json" jsonb NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_counts_non_negative_check" CHECK (("posts"."reaction_count" is null or "posts"."reaction_count" >= 0)
        and ("posts"."comment_count" is null or "posts"."comment_count" >= 0)
        and ("posts"."share_count" is null or "posts"."share_count" >= 0))
);
--> statement-breakpoint
ALTER TABLE "post_insights" ADD CONSTRAINT "post_insights_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_streamer_id_streamers_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_insights_metric_key" ON "post_insights" USING btree ("post_id","metric_name",coalesce("period", ''),coalesce("end_time", 'epoch'::timestamptz));--> statement-breakpoint
CREATE INDEX "post_insights_post_id_idx" ON "post_insights" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_insights_metric_name_idx" ON "post_insights" USING btree ("metric_name");--> statement-breakpoint
CREATE INDEX "post_insights_collected_at_idx" ON "post_insights" USING btree ("collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "posts_facebook_post_id_key" ON "posts" USING btree ("facebook_post_id");--> statement-breakpoint
CREATE INDEX "posts_streamer_id_created_time_idx" ON "posts" USING btree ("streamer_id","created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_created_time_idx" ON "posts" USING btree ("created_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_last_synced_at_idx" ON "posts" USING btree ("last_synced_at" DESC NULLS LAST);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Security posture, matching Phase 2.
--
-- Post content is public on Facebook, so there is nothing secret here — but
-- the tables are still read-only to clients and written exclusively by server
-- code using the service role, so a stolen anon key cannot fabricate metrics.
-- ---------------------------------------------------------------------------
ALTER TABLE "posts"         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_insights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS posts_select_authenticated ON public.posts;--> statement-breakpoint
CREATE POLICY posts_select_authenticated ON public.posts
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

DROP POLICY IF EXISTS post_insights_select_authenticated ON public.post_insights;--> statement-breakpoint
CREATE POLICY post_insights_select_authenticated ON public.post_insights
  FOR SELECT TO authenticated
  USING (true);--> statement-breakpoint

-- No write policy on either table: synchronisation runs as the service role.
REVOKE ALL ON public.posts         FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON public.post_insights FROM anon, authenticated;--> statement-breakpoint
GRANT SELECT ON public.posts         TO authenticated;--> statement-breakpoint
GRANT SELECT ON public.post_insights TO authenticated;--> statement-breakpoint

DROP TRIGGER IF EXISTS posts_set_updated_at ON public.posts;--> statement-breakpoint
CREATE TRIGGER posts_set_updated_at
  BEFORE UPDATE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();