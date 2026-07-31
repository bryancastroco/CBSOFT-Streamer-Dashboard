-- Phase 21a: canonical performance metrics.
--
-- The raw post_insights and video_insights tables are untouched. They remain
-- the record of exactly what Meta returned, and nothing here deletes or
-- rewrites them — this is a normalised view alongside, not a replacement.
--
-- Two tables:
--   content_metrics_current   one row per piece of content, the latest values
--   content_metric_snapshots  history, for trends, deduplicated by hash

CREATE TABLE IF NOT EXISTS "content_metrics_current" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_type" "content_type" NOT NULL,
  "post_id" uuid REFERENCES "posts"("id") ON DELETE CASCADE,
  "video_id" uuid REFERENCES "videos"("id") ON DELETE CASCADE,
  "streamer_id" uuid NOT NULL REFERENCES "streamers"("id") ON DELETE CASCADE,

  -- Every metric is nullable and stays null when Meta did not report it.
  -- A zero here means Meta returned zero; that distinction is the whole point.
  "reach" integer,
  "views" integer,
  "viewers" integer,
  "interactions" integer,
  "interactions_is_calculated" boolean DEFAULT false NOT NULL,
  "likes" integer,
  "reactions" integer,
  "comments" integer,
  "shares" integer,
  "watch_time_ms" bigint,
  "average_play_time_ms" bigint,
  "three_second_views" integer,
  "reels_plays" integer,

  -- Per-metric status and provenance: which Meta name supplied each value,
  -- from which endpoint, and why anything absent is absent.
  "availability_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_mapping_json" jsonb DEFAULT '{}'::jsonb NOT NULL,

  "graph_api_version" text NOT NULL,
  -- Deterministic hash of the metric values, so a snapshot is only written
  -- when something actually changed.
  "metric_hash" text NOT NULL,
  "last_collected_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- Exactly one content reference, matching the declared type. Without this a
  -- row could claim to be a post while carrying a video id, and every join
  -- downstream would quietly disagree about what it was reading.
  CONSTRAINT "content_metrics_current_one_target_check" CHECK (
    ("content_type" = 'post' AND "post_id" IS NOT NULL AND "video_id" IS NULL)
    OR
    ("content_type" = 'video' AND "video_id" IS NOT NULL AND "post_id" IS NULL)
  )
);

-- One current row per piece of content. Partial, because a post row has a null
-- video_id and a plain UNIQUE would treat every such null as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS "content_metrics_current_post_idx"
  ON "content_metrics_current" ("post_id") WHERE "post_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "content_metrics_current_video_idx"
  ON "content_metrics_current" ("video_id") WHERE "video_id" IS NOT NULL;

-- Dashboard filters by streamer and by date, in that order.
CREATE INDEX IF NOT EXISTS "content_metrics_current_streamer_idx"
  ON "content_metrics_current" ("streamer_id", "last_collected_at" DESC);

CREATE INDEX IF NOT EXISTS "content_metrics_current_type_idx"
  ON "content_metrics_current" ("content_type");

CREATE TABLE IF NOT EXISTS "content_metric_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_type" "content_type" NOT NULL,
  "post_id" uuid REFERENCES "posts"("id") ON DELETE CASCADE,
  "video_id" uuid REFERENCES "videos"("id") ON DELETE CASCADE,
  "streamer_id" uuid NOT NULL REFERENCES "streamers"("id") ON DELETE CASCADE,

  "reach" integer,
  "views" integer,
  "viewers" integer,
  "interactions" integer,
  "interactions_is_calculated" boolean DEFAULT false NOT NULL,
  "likes" integer,
  "reactions" integer,
  "comments" integer,
  "shares" integer,
  "watch_time_ms" bigint,
  "average_play_time_ms" bigint,
  "three_second_views" integer,
  "reels_plays" integer,

  "availability_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source_mapping_json" jsonb DEFAULT '{}'::jsonb NOT NULL,

  "graph_api_version" text NOT NULL,
  "metric_hash" text NOT NULL,
  "collected_at" timestamp with time zone NOT NULL,

  CONSTRAINT "content_metric_snapshots_one_target_check" CHECK (
    ("content_type" = 'post' AND "post_id" IS NOT NULL AND "video_id" IS NULL)
    OR
    ("content_type" = 'video' AND "video_id" IS NOT NULL AND "post_id" IS NULL)
  )
);

-- The deduplication guard. A sweep every six hours over unchanged lifetime
-- values would otherwise write four identical rows a day per item, and the
-- trend chart would be a flat line made of noise.
CREATE UNIQUE INDEX IF NOT EXISTS "content_metric_snapshots_post_hash_idx"
  ON "content_metric_snapshots" ("post_id", "metric_hash") WHERE "post_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "content_metric_snapshots_video_hash_idx"
  ON "content_metric_snapshots" ("video_id", "metric_hash") WHERE "video_id" IS NOT NULL;

-- Trend queries read one item newest-first.
CREATE INDEX IF NOT EXISTS "content_metric_snapshots_post_time_idx"
  ON "content_metric_snapshots" ("post_id", "collected_at" DESC) WHERE "post_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "content_metric_snapshots_video_time_idx"
  ON "content_metric_snapshots" ("video_id", "collected_at" DESC) WHERE "video_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "content_metric_snapshots_streamer_time_idx"
  ON "content_metric_snapshots" ("streamer_id", "collected_at" DESC);

-- RLS, matching every other table in the schema.
--
-- No permissive policy is added, which makes these deny-all to anyone who is
-- not the service role — the same posture as post_insights and video_insights.
-- The application reads them server-side through the service role; RLS is the
-- backstop for a leaked anon key, not the primary control.
ALTER TABLE public.content_metrics_current  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_metric_snapshots ENABLE ROW LEVEL SECURITY;
