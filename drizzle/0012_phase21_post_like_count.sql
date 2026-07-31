-- Likes as a post field, because the insight is absent for most of the roster.
--
-- `post_reactions_by_type_total` supplies the LIKE subset today, and Meta
-- returned it for only 611 of 1,626 posts — so Likes reads "not available" on
-- the other 1,015 while total reactions is present for all of them.
--
-- `reactions.type(LIKE).limit(0).summary(true).as(like_reactions)` was probed on
-- Graph v25.0 (2026-07-31) and answers with an exact `summary.total_count` on
-- every post tried. A field is also structurally safer than an insight: it needs
-- no `read_insights`, and an unrecognised field fails only itself rather than
-- collapsing the whole request.
--
-- Nullable, like every other count on this table. Null means Meta did not report
-- it; it never means zero. Existing rows stay null until they are re-synced,
-- and the rollup's retention rule keeps whatever the insight already supplied.

ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "like_count" integer;

COMMENT ON COLUMN "posts"."like_count" IS
  'LIKE reactions only, from reactions.type(LIKE) on the post object. Null means Meta did not report it.';

-- The non-negative check has to be recreated, not merely extended: the schema
-- declares one constraint covering every count, and leaving the database's
-- version behind would let a negative like_count through while `schema.ts`
-- claims it cannot happen. Drift of that kind is invisible until it is not.
ALTER TABLE "posts" DROP CONSTRAINT IF EXISTS "posts_counts_non_negative_check";

ALTER TABLE "posts" ADD CONSTRAINT "posts_counts_non_negative_check" CHECK (
  ("reaction_count" is null or "reaction_count" >= 0)
  and ("comment_count" is null or "comment_count" >= 0)
  and ("share_count" is null or "share_count" >= 0)
  and ("like_count" is null or "like_count" >= 0)
);
