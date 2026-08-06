-- Audience size over time, one row per Page per day.
--
-- ## Why a table rather than a live Graph call
--
-- Meta serves `page_follows` for a rolling window only. Asking it on every
-- render would also mean a Graph call per dashboard view, spending rate limit
-- on a number that changes once a day — and would leave the dashboard blank
-- whenever a token lapsed, rather than showing the history already collected.
--
-- ## Why daily granularity
--
-- That is the granularity Meta reports. Storing anything finer would invent
-- precision the source does not have.
--
-- ## What the columns mean, because two of them look alike
--
--   followers        the running total on that day. `page_follows`.
--   new_follows      how many were gained that day. `page_daily_follows`.
--
-- The second is not the difference of the first: unfollows are invisible, so a
-- day with 7 new follows and 3 departures moves the total by 4 while
-- `new_follows` says 7. Both are kept because they answer different questions —
-- "how big is the audience" and "how much reach did this week's posting earn" —
-- and deriving either from the other would be wrong.
--
-- Probed against GM Blade on v25.0, 2026-08-06, before any of this was written:
-- `page_follows`, `page_daily_follows`, `page_daily_follows_unique` and
-- `page_views_total` all answer. `page_fans`, `page_fan_adds`,
-- `page_fan_removes` and `page_impressions` are rejected with
-- `(#100) The value must be a valid insights metric`.

CREATE TABLE IF NOT EXISTS public.page_metrics_daily (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "streamer_id" uuid NOT NULL REFERENCES public.streamers("id") ON DELETE CASCADE,

  -- The day the figures describe, in UTC. A date rather than a timestamp: Meta
  -- reports one value per day and a time would imply a precision it never gave.
  "metric_date" date NOT NULL,

  "followers" integer,
  "new_follows" integer,
  "page_views" integer,

  -- The unmodified insight payload, so a metric added later can be derived from
  -- history already collected instead of waiting for it to accumulate again.
  "raw_json" jsonb NOT NULL DEFAULT '{}'::jsonb,

  "collected_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),

  -- Meta can revise a recent day, so a re-fetch has to update in place rather
  -- than accumulate duplicates.
  CONSTRAINT "page_metrics_daily_streamer_date_key" UNIQUE ("streamer_id", "metric_date"),

  CONSTRAINT "page_metrics_daily_non_negative_check" CHECK (
    ("followers"   IS NULL OR "followers"   >= 0) AND
    ("new_follows" IS NULL OR "new_follows" >= 0) AND
    ("page_views"  IS NULL OR "page_views"  >= 0)
  )
);

-- The query every growth figure makes: one streamer, a date window, in order.
CREATE INDEX IF NOT EXISTS "page_metrics_daily_streamer_date_idx"
  ON public.page_metrics_daily ("streamer_id", "metric_date" DESC);

-- Roster-wide totals for a period, without touching the streamer index.
CREATE INDEX IF NOT EXISTS "page_metrics_daily_date_idx"
  ON public.page_metrics_daily ("metric_date" DESC);

COMMENT ON TABLE public.page_metrics_daily IS
  'Daily Page audience figures from Meta Page insights. followers is a running total; new_follows is that day''s gain.';

-- RLS, matching every other table. No permissive policy: deny-all to anyone
-- who is not the service role. The application reads it server-side.
ALTER TABLE public.page_metrics_daily ENABLE ROW LEVEL SECURITY;
