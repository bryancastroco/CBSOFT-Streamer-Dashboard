-- Workspace preferences an admin sets from the interface.
--
-- ## Why this exists when `/admin/general` argues configuration belongs in env
--
-- That argument still holds, and this is not a counter-example. Everything on
-- that screen is an operational ceiling — batch sizes, lookback windows, cron
-- budgets — where the question "which value was in effect three weeks ago when
-- the numbers looked wrong" has to be answerable from the deployment alone. An
-- editable database copy of those would be a second source of truth.
--
-- What lives here is a different category: a choice about what the interface
-- offers, made by the person using it, with no environment equivalent and no
-- bearing on what any query computes. Putting it in Vercel would mean a
-- redeploy to change which entries appear in a dropdown.
--
-- The distinction to hold on to: env decides how the system behaves, this
-- decides what the interface presents. Anything that changes a stored number
-- belongs in env.
--
-- ## Why key/value rather than a column per setting
--
-- There is one setting today. A table with one boolean column would need a
-- migration for the second, and the shape of these is genuinely open —
-- preferences arrive one at a time and rarely share a type. The trade is that
-- the database cannot validate the payload, so every read parses through a Zod
-- schema that supplies defaults; an unknown or malformed row degrades to the
-- default rather than breaking a page.

CREATE TABLE IF NOT EXISTS public.app_settings (
  -- A namespaced key, e.g. `game_filter.options`. Not an enum: the set grows,
  -- and a migration to add a preference is exactly what this avoids.
  "key" text PRIMARY KEY,

  "value_json" jsonb NOT NULL,

  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- `set null` rather than cascade: who changed a setting is worth keeping
  -- after they leave, and the row must survive them. The audit trail carries
  -- the durable record either way.
  "updated_by" uuid REFERENCES public.users("id") ON DELETE SET NULL,

  CONSTRAINT "app_settings_key_format_check" CHECK ("key" ~ '^[a-z0-9_]+\.[a-z0-9_]+$')
);

-- RLS, matching every other table. No permissive policy: deny-all to anyone
-- who is not the service role.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
