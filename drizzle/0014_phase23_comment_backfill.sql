-- "We have looked at this item's comments" — the marker the backfill walks.
--
-- Without it, a post with no comment rows is ambiguous in exactly the way that
-- makes an unattended backfill impossible: it means either "never collected"
-- or "collected, and this post genuinely has no comments". A drain that cannot
-- tell those apart re-walks every silent post on every run and never reaches
-- the end of the roster.
--
-- Nullable timestamp rather than a boolean, for the same reason as
-- `users.deactivated_at`: null is "never", and once "yes" matters, "when"
-- always follows. It is also what lets a future re-collection policy say
-- "anything not looked at for 30 days" without another column.
--
-- Deliberately separate from `last_synced_at`, which records when the post
-- object itself was refreshed. The two happen on different schedules and under
-- different ceilings — the post sweep covers everything in the lookback window,
-- comment collection is capped far lower because each item costs its own
-- paginated walk of the comments edge.

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS "comments_synced_at" timestamptz;
ALTER TABLE public.videos ADD COLUMN IF NOT EXISTS "comments_synced_at" timestamptz;

COMMENT ON COLUMN public.posts."comments_synced_at" IS
  'When the comments edge was last walked for this post. Null means never — the backfill claims these first.';
COMMENT ON COLUMN public.videos."comments_synced_at" IS
  'When the comments edge was last walked for this video. Null means never — the backfill claims these first.';

-- Partial, because the query that matters asks only for the nulls, and that set
-- shrinks to nothing as the backfill completes. A full index would stay large
-- forever to answer a question that ends up having no rows.
CREATE INDEX IF NOT EXISTS "posts_comments_never_synced_idx"
  ON public.posts ("created_time" DESC)
  WHERE "comments_synced_at" IS NULL;

CREATE INDEX IF NOT EXISTS "videos_comments_never_synced_idx"
  ON public.videos ("created_time" DESC)
  WHERE "comments_synced_at" IS NULL;

-- Backdate what has already been collected.
--
-- Comment collection has been running nightly against the newest items for
-- weeks, so those posts have been looked at — they simply predate the column.
-- Leaving them null would send the first backfill run to re-walk the items that
-- need it least, spending Graph quota to learn what is already stored.
--
-- `last_synced_at` is the honest stand-in: it is when that item was last
-- touched by the sweep that also collected its comments.
UPDATE public.posts p
   SET "comments_synced_at" = p."last_synced_at"
 WHERE p."comments_synced_at" IS NULL
   AND EXISTS (SELECT 1 FROM public.comments c WHERE c."post_id" = p."id");

UPDATE public.videos v
   SET "comments_synced_at" = v."last_synced_at"
 WHERE v."comments_synced_at" IS NULL
   AND EXISTS (SELECT 1 FROM public.comments c WHERE c."video_id" = v."id");
