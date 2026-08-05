-- One cached reading per distinct set of content.
--
-- The dashboard panel wants a written summary across everything the filters
-- select, which means a model call. A dashboard re-renders on every filter
-- change, every navigation and every refresh, so calling the model each time
-- would bill for the same answer repeatedly — the exact mistake the per-post
-- hash gate exists to prevent, repeated at roster scale.
--
-- So the answer is stored and re-used until its input changes.
--
-- ## Why the key is a hash of the content, not the filters
--
-- "Last 30 days" resolves to a different instant every render, so a key built
-- from the filter values would never hit. Two selections that resolve to the
-- same posts and videos deserve the same answer, and a hash over the sampled
-- content ids plus their comment counts says exactly that: same content, same
-- conversation, same reading. New comments change the count, which changes the
-- hash, which is precisely when a fresh reading is warranted.

CREATE TABLE IF NOT EXISTS public.comment_overview_summaries (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- sha256 over the sampled content ids and their comment counts.
  "source_hash" text NOT NULL,

  "summary" text NOT NULL,
  "sentiment" comment_sentiment,

  "positive_points_json" jsonb,
  "concerns_json" jsonb,
  "suggestions_json" jsonb,
  "questions_json" jsonb,
  "urgent_issues_json" jsonb,

  -- 'gemini', 'anthropic' or 'offline'. The panel says which produced it, so a
  -- counted tally is never mistaken for a written interpretation.
  "ai_provider" text NOT NULL,
  "model" text NOT NULL,

  "content_sampled" integer NOT NULL DEFAULT 0,
  "comment_count" integer NOT NULL DEFAULT 0,

  "generated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "comment_overview_counts_non_negative_check"
    CHECK ("content_sampled" >= 0 AND "comment_count" >= 0)
);

-- The lookup, and the reason a second identical computation cannot be stored.
CREATE UNIQUE INDEX IF NOT EXISTS "comment_overview_source_hash_key"
  ON public.comment_overview_summaries ("source_hash");

-- Reading it back oldest-first, for a future eviction pass. Nothing prunes this
-- table yet: a row is a few hundred bytes and the distinct-content-set space is
-- bounded by how many filter combinations anyone actually opens.
CREATE INDEX IF NOT EXISTS "comment_overview_generated_at_idx"
  ON public.comment_overview_summaries ("generated_at" DESC);

COMMENT ON TABLE public.comment_overview_summaries IS
  'Cached roster-level comment readings, keyed by a hash of the content they cover.';

-- RLS, matching every other table in the schema.
--
-- No permissive policy, which makes this deny-all to anyone who is not the
-- service role — the same posture as post_insights, video_insights and the
-- canonical metric tables. The application reads it server-side; RLS is the
-- backstop for a leaked anon key, not the primary control.
--
-- It matters more here than it looks: these rows contain pooled comment text
-- and the model's reading of it, which is the most quotable content in the
-- database.
ALTER TABLE public.comment_overview_summaries ENABLE ROW LEVEL SECURITY;
