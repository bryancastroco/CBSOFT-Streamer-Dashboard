-- Phase 29 — post, video, livestream.
--
-- A livestream recording arrives from Meta twice: once in `/{page}/videos` and
-- once in the Page feed, because Facebook publishes a feed story alongside a
-- broadcast. Both were stored, so 33 of 286 posts were a second copy of a
-- video. Every content count was inflated by that many, and each broadcast was
-- split across two rows — the comments on one, the watch time on the other.
--
-- Two columns fix the classification and one fixes the duplication.

ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "live_status" text;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "media_kind" text NOT NULL DEFAULT 'video';--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "media_kind_source" text;--> statement-breakpoint

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "video_id" uuid;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'posts_video_id_videos_id_fk'
  ) THEN
    ALTER TABLE "posts"
      ADD CONSTRAINT "posts_video_id_videos_id_fk"
      FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE SET NULL;
  END IF;
END
$$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "posts_video_id_idx" ON "posts" ("video_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "videos_media_kind_created_time_idx"
  ON "videos" ("media_kind", "created_time" DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Link each feed story to the video it describes.
--
-- A post id is `{page-id}_{object-id}`, and for a video post the object id is
-- the video id. That is not a coincidence to be exploited carefully — it is
-- how Meta identifies the pair, and the permalink on both rows agrees.
-- ---------------------------------------------------------------------------
UPDATE "posts" p
SET "video_id" = v."id"
FROM "videos" v
WHERE v."facebook_video_id" = split_part(p."facebook_post_id", '_', 2)
  AND p."video_id" IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Classify what is already stored.
--
-- `live_status` was not requested until this phase, so every existing row is
-- classified structurally and marked `inferred`. The next sync replaces both
-- with Meta's own answer. See `lib/meta/media-kind` for why the rule is two
-- signals rather than length alone, and for the measurements behind it:
-- livestreams run 62 min to 2h45m and all carry a feed story; reels and short
-- uploads top out at 3.5 min and carry none.
--
-- Reels are excluded explicitly rather than relying on their length. A reel
-- belongs under Video whatever its runtime.
-- ---------------------------------------------------------------------------
UPDATE "videos" v
SET "media_kind" = 'livestream',
    "media_kind_source" = 'inferred'
WHERE COALESCE(v."permalink_url", '') NOT LIKE '%/reel/%'
  AND COALESCE(v."length_seconds", 0) >= 1200
  AND EXISTS (SELECT 1 FROM "posts" p WHERE p."video_id" = v."id");--> statement-breakpoint

UPDATE "videos"
SET "media_kind_source" = 'inferred'
WHERE "media_kind_source" IS NULL;
