-- Which game a piece of content is about.
--
-- ## The problem this solves
--
-- A streamer covers several titles. "How is Cabal Mobile doing" is not a
-- question the roster can answer while every post is filed only under the
-- person who wrote it.
--
-- ## Why attribution is stored rather than computed
--
-- It could be derived on every read: extract hashtags from the message, look
-- one up. But that is a regex over every row on every filtered query, and the
-- filter is meant to be usable on a dashboard. Resolving once and storing the
-- answer follows what `content_metrics_current` already does, and re-resolving
-- after an edit is a pass, not a schema change.
--
-- ## Why a hashtag belongs to exactly one game
--
-- `game_hashtags.tag` is globally unique. If `#cabalsea` could belong to two
-- games there would be no answer to which one a post is about, and the
-- resolver would have to pick arbitrarily — a coin toss dressed as data.
--
-- ## Why the fallback exists at all
--
-- Measured on 2026-08-06: 102 of 1,624 posts carry any hashtag, and 7 of 42
-- videos. Hashtag-only attribution would leave 94% of the roster unfilterable.
-- So a streamer declares the games they stream, one marked primary, and content
-- with no matching tag inherits that. `game_source` records which rule applied,
-- because "tagged as Cabal Mobile" and "assumed Cabal Mobile" are different
-- claims and a report should not blur them.

CREATE TABLE IF NOT EXISTS public.games (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "name" text NOT NULL,
  -- A stable, URL-safe handle. Used in filter links, so it must survive a
  -- rename of the display name.
  "slug" text NOT NULL,

  "active" boolean NOT NULL DEFAULT true,
  "notes" text,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "games_name_not_blank_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "games_slug_format_check" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "games_slug_key" ON public.games ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "games_name_lower_key" ON public.games (lower("name"));

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_hashtags (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "game_id" uuid NOT NULL REFERENCES public.games("id") ON DELETE CASCADE,

  -- Stored normalised: lower case, no leading '#'. Facebook hashtags are
  -- case-insensitive, and storing '#CabalSEA' and 'cabalsea' as two rows would
  -- make matching depend on how somebody typed it.
  "tag" text NOT NULL,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "game_hashtags_format_check" CHECK ("tag" ~ '^[a-z0-9_]+$')
);

-- Globally unique, not per game: a tag that mapped to two games would make
-- attribution ambiguous, and the resolver would have to guess.
CREATE UNIQUE INDEX IF NOT EXISTS "game_hashtags_tag_key" ON public.game_hashtags ("tag");
CREATE INDEX IF NOT EXISTS "game_hashtags_game_idx" ON public.game_hashtags ("game_id");

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.streamer_games (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  "streamer_id" uuid NOT NULL REFERENCES public.streamers("id") ON DELETE CASCADE,
  "game_id" uuid NOT NULL REFERENCES public.games("id") ON DELETE CASCADE,

  -- The game an untagged post is assumed to be about. Exactly one per
  -- streamer, enforced below.
  "is_primary" boolean NOT NULL DEFAULT false,

  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "streamer_games_unique" UNIQUE ("streamer_id", "game_id")
);

-- At most one primary per streamer. Partial, because the constraint is about
-- the trues only — a streamer may have any number of non-primary games.
CREATE UNIQUE INDEX IF NOT EXISTS "streamer_games_one_primary_idx"
  ON public.streamer_games ("streamer_id")
  WHERE "is_primary";

CREATE INDEX IF NOT EXISTS "streamer_games_game_idx" ON public.streamer_games ("game_id");

-- ---------------------------------------------------------------------------
-- Resolved attribution on the content itself.
--
-- `on delete set null` rather than cascade: deleting a game must not delete the
-- posts that mentioned it. The content is the record; the game is a label on it.

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS "game_id" uuid REFERENCES public.games("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "game_source" text;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS "game_id" uuid REFERENCES public.games("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "game_source" text;

-- 'hashtag' — a tag in the text named this game.
-- 'streamer' — no tag matched; the streamer's primary game was assumed.
-- NULL      — not resolved, or the streamer has no primary game.
ALTER TABLE public.posts  DROP CONSTRAINT IF EXISTS "posts_game_source_check";
ALTER TABLE public.posts  ADD CONSTRAINT "posts_game_source_check"
  CHECK ("game_source" IS NULL OR "game_source" IN ('hashtag', 'streamer'));

ALTER TABLE public.videos DROP CONSTRAINT IF EXISTS "videos_game_source_check";
ALTER TABLE public.videos ADD CONSTRAINT "videos_game_source_check"
  CHECK ("game_source" IS NULL OR "game_source" IN ('hashtag', 'streamer'));

CREATE INDEX IF NOT EXISTS "posts_game_id_created_time_idx"
  ON public.posts ("game_id", "created_time" DESC) WHERE "game_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "videos_game_id_created_time_idx"
  ON public.videos ("game_id", "created_time" DESC) WHERE "game_id" IS NOT NULL;

-- RLS, matching every other table. No permissive policy: deny-all to anyone
-- who is not the service role.
ALTER TABLE public.games          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_hashtags  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.streamer_games ENABLE ROW LEVEL SECURITY;
