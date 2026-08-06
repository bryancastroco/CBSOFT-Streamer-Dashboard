-- Self-service Page connection: a streamer grants access instead of pasting a
-- token.
--
-- ## The problem
--
-- Getting a Page token out of a streamer today means walking them through Graph
-- API Explorer: pick the app, pick the permissions, generate, switch the
-- dropdown from User to Page, copy the right string, send it over chat. Every
-- step is a place to get it wrong, and the last one asks somebody to paste a
-- live credential into a message. At thirty streamers that is thirty chances to
-- send the wrong token, or the right one to the wrong place.
--
-- Facebook Login exists for exactly this. The streamer approves a permission
-- dialog; the Page token is fetched server-side and never shown to anyone.
--
-- ## Why the invitation is a row rather than a signed URL
--
-- A signed link would need no table. But then nothing can be revoked before it
-- expires, nothing records that it was used, and an admin cannot answer "who
-- have I invited and who has actually connected" — which is the whole reason
-- for asking. State that an admin monitors has to be state that exists.
--
-- ## Why only the hash of the token is stored
--
-- The link is a bearer credential: whoever holds it can attach a Page to this
-- workspace. Storing it in plaintext would mean a database read is enough to
-- impersonate an invited streamer. Hashed, a leaked backup grants nothing, and
-- the only copy of the raw token is the one in the admin's clipboard.
--
-- SHA-256 rather than a password hash, deliberately: the token is 256 bits of
-- randomness, so there is no dictionary to slow down, and lookup happens on
-- every request to the page.

CREATE TABLE IF NOT EXISTS public.page_connections (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SHA-256 of the raw invitation token, hex encoded. Unique so a lookup is an
  -- index hit rather than a scan.
  "token_hash" text NOT NULL,

  -- Who this was meant for. Free text, for the admin's own reference — this is
  -- not an identity and nothing authenticates against it.
  "invitee_label" text NOT NULL,
  "invitee_email" text,

  -- Set when the invitation is for a streamer that already exists, so an
  -- existing record gains a token rather than a duplicate being created.
  -- `set null` because deleting a streamer must not erase the record that they
  -- were invited.
  "streamer_id" uuid REFERENCES public.streamers("id") ON DELETE SET NULL,

  -- pending   — created, not yet opened
  -- opened    — the streamer loaded the page
  -- connected — a Page token was stored
  -- revoked   — an admin cancelled it
  --
  -- Expiry is NOT a status: it is derived from `expires_at` at read time. A
  -- stored `expired` would need a job to write it, and until that job ran the
  -- table would disagree with the clock.
  "status" text NOT NULL DEFAULT 'pending',

  "created_by" uuid REFERENCES public.users("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "opened_at" timestamptz,
  "connected_at" timestamptz,
  "revoked_at" timestamptz,

  -- What they connected. Identity only — the token itself lives on the
  -- streamer row, encrypted, exactly as a manually entered one does.
  "connected_page_id" text,
  "connected_page_name" text,

  /*
   * The user access token, encrypted, held only between the OAuth callback and
   * the streamer choosing which Page to attach.
   *
   * Two steps are needed because the callback knows the person but not which of
   * their Pages they mean. Holding the user token is what lets the second step
   * fetch that Page's token server-side, so the browser is never handed one —
   * the selection posts back a Page id and nothing else.
   *
   * Cleared the moment the connection completes. A credential kept past its
   * purpose is a credential waiting to leak.
   */
  "encrypted_user_token" text,
  "user_token_expires_at" timestamptz,

  -- The last failure, for the admin table. Never contains token material.
  "last_error" text,

  CONSTRAINT "page_connections_status_check"
    CHECK ("status" IN ('pending', 'opened', 'connected', 'revoked')),
  CONSTRAINT "page_connections_label_not_blank_check"
    CHECK (length(btrim("invitee_label")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "page_connections_token_hash_key"
  ON public.page_connections ("token_hash");

CREATE INDEX IF NOT EXISTS "page_connections_created_at_idx"
  ON public.page_connections ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "page_connections_streamer_idx"
  ON public.page_connections ("streamer_id");

-- RLS, matching every other table. No permissive policy: deny-all to anyone who
-- is not the service role. The public connect page reads through the service
-- role after resolving the token hash, never as an anonymous client.
ALTER TABLE public.page_connections ENABLE ROW LEVEL SECURITY;
