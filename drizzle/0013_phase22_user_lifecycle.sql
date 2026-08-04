-- Deactivation, so an account can be switched off without being destroyed.
--
-- Soft, deliberately. A hard delete would take the person's audit history with
-- it — `audit_logs.user_id` references this table — and the whole point of that
-- trail is that it survives the departure of whoever acted. "Who promoted this
-- account to admin" must remain answerable after they leave.
--
-- Nullable timestamp rather than a boolean: `active = false` records that
-- someone is switched off, `deactivated_at` records when, and the second
-- question is always asked once the first matters.
--
-- Who did it lives in `audit_logs`, which already carries actor, target and
-- timestamp in one transaction with the change itself.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "deactivated_at" timestamptz;

COMMENT ON COLUMN public.users."deactivated_at" IS
  'Set when an admin switches the account off. Enforced in getSession(), not merely hidden in the UI.';

-- Reading the roster filters on this constantly, and it is null for almost
-- every row — a partial index is small and answers "who is switched off".
CREATE INDEX IF NOT EXISTS "users_deactivated_at_idx"
  ON public.users ("deactivated_at")
  WHERE "deactivated_at" IS NOT NULL;
