# Data Model

Supabase PostgreSQL schema. Ten tables exist and are migrated, through Phase 6; anything under
"Planned" is design intent only.

Conventions:

- Primary keys are `uuid`. Application tables default to `gen_random_uuid()`; `users.id` does not,
  because it mirrors `auth.users.id`.
- Timestamps are `timestamptz`, always stored UTC. Display is a separate concern: the screens
  render them in `DISPLAY_TIME_ZONE` (`src/lib/time/zone.ts`). Nothing stored is zone-shifted.
- Every table has RLS **enabled**. A table with RLS on and no matching policy denies everything,
  which is the correct default.
- Metric tables (Phase 5+) are snapshot-based and append-only: a failed sync must never overwrite
  good data with nulls.

> **Note on the Phase 1 draft.** Phase 1 sketched a larger set (`profiles`, `facebook_pages`,
> `facebook_page_connections`, `teams`). Phase 2 specified `users` and a single `streamers` table
> that carries its own Page connection. That is what was built, and this document reflects it. The
> Page token is still isolated — not by being in its own table, but by a column-level grant that
> denies it to every client role.

---

## Implemented — Phase 2

Migrations: `drizzle/0000_phase2_core.sql` (tables) and `drizzle/0001_phase2_security.sql`
(RLS, grants, triggers, the `auth.users` link).

### `users`

Application profile for a Supabase Auth account.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | FK → `auth.users.id`, `ON DELETE CASCADE`. Not generated. |
| `email` | text NOT NULL | Unique on `lower(email)`, matching Auth's case-insensitivity |
| `full_name` | text | |
| `role` | `user_role` NOT NULL | `admin` \| `viewer`, **default `viewer`** |
| `created_at`, `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

Indexes: `users_email_lower_key` (unique), `users_role_idx`.
Check: email contains `@` beyond position 1.

**Provisioning.** The `on_auth_user_created` trigger on `auth.users` inserts the profile as
`viewer`. There is no code path by which signing up produces administrative access — an admin is
created only by `npm run seed:admin` or promoted by an existing admin.

**RLS.** `users_select_self` (read own row), `users_select_admin` (admins read all),
`users_update_admin` (admins update, `WITH CHECK (is_admin() AND id <> auth.uid())`). No INSERT or
DELETE policy. The `id <> auth.uid()` clause is what blocks self-promotion at the database level.

**Grants.** `authenticated` gets `SELECT` and `UPDATE (full_name, role)`. `anon` gets nothing.

### `streamers`

A CBSOFT streamer and the Facebook Page they broadcast on.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `streamer_code` | text NOT NULL | Business key, e.g. `CBS-014`. Format-checked `^[A-Z0-9][A-Z0-9-]*$` |
| `streamer_name` | text NOT NULL | |
| `page_id` | text NOT NULL | Meta Page ID. Numeric-checked. Public identifier — exportable |
| `page_name` | text NOT NULL | |
| `encrypted_page_token` | text | **AES-256-GCM ciphertext.** Revoked from every client role |
| `page_token_last_four` | varchar(4) | Last 4 chars of the plaintext, for operator recognition |
| `token_status` | `token_status` NOT NULL | `missing` \| `valid` \| `expiring` \| `expired` \| `invalid` \| `missing_permission` \| `unknown`, default `missing` |
| `token_expires_at` | timestamptz | |
| `token_scopes` | text[] NOT NULL | Default `{}` |
| `token_last_validated_at` | timestamptz | Phase 3. When the token was last checked against Meta |
| `token_validation_error` | text | Phase 3. Why the last check was not `valid`. Never token material |
| `active` | boolean NOT NULL | Default true |
| `notes` | text | |
| `last_successful_sync_at` | timestamptz | |
| `last_sync_error` | text | Sanitised message. Never token material |
| `created_at`, `updated_at` | timestamptz NOT NULL | |
| `deleted_at` | timestamptz | Soft delete; sync history survives |

Indexes: partial unique on `streamer_code` and on `page_id` where `deleted_at is null` (so a code
may be reused after deletion but never duplicated among live rows); `streamers_active_idx`
(partial), `streamers_token_status_idx`, `streamers_last_successful_sync_at_idx`.

Constraints worth calling out:

- `streamers_token_consistency_check` — a stored token must carry both its recognition suffix and a
  status other than `missing`; an absent token must carry neither. "Is this Page connected?" is
  answerable from one column.
- `streamers_token_is_ciphertext_check` — the value must match `^v[0-9]+\.`, the crypto envelope
  prefix. A plaintext token written by a future bug is rejected by the database.

**RLS.** Read for any authenticated user where `deleted_at is null`. Insert, update and delete are
admin-only.

**Grants.** `authenticated` receives column-level `SELECT`, `INSERT` and `UPDATE` on every column
**except** `encrypted_page_token`, which only `service_role` can read or write.

### `sync_runs`

One row per synchronisation attempt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `streamer_id` | uuid | FK → `streamers.id`, `ON DELETE SET NULL`. Null for roster-wide runs |
| `sync_type` | `sync_type` NOT NULL | `full` \| `incremental` \| `manual` \| `backfill` \| `token_check` |
| `status` | `sync_status` NOT NULL | `pending` \| `running` \| `succeeded` \| `failed` \| `partial` |
| `posts_processed` | integer NOT NULL | Default 0 |
| `videos_processed` | integer NOT NULL | Default 0 |
| `comments_processed` | integer NOT NULL | Default 0 |
| `summaries_generated` | integer NOT NULL | Default 0 |
| `started_at` | timestamptz NOT NULL | Default `now()` |
| `completed_at` | timestamptz | |
| `error_message` | text | |
| `error_details_json` | jsonb | Structured detail. Never token material |

Indexes: `(streamer_id, started_at desc)`, `status`, `started_at desc`, and a partial
`sync_runs_in_flight_idx` for the "what is running now?" admin query.

Constraints: counters non-negative; `completed_at >= started_at`; a terminal status must have
`completed_at` and an open status must not; a `failed` run must carry an `error_message`.

**RLS.** Read for any authenticated user. No write policy at all — sync runs are written only by
server code using the service role.

### `audit_logs`

Append-only trail.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid | FK → `users.id`, `ON DELETE SET NULL`. Null for machine actors |
| `action` | text NOT NULL | `namespace.verb`, checked `^[a-z_]+\.[a-z_]+$` |
| `entity_type` | text NOT NULL | |
| `entity_id` | text | Text, not uuid — some entities are keyed by a Meta identifier |
| `metadata_json` | jsonb NOT NULL | Default `{}`. **Never contains secrets or token material** |
| `created_at` | timestamptz NOT NULL | |

Indexes: `created_at desc`, `(user_id, created_at desc)`, `action`, `(entity_type, entity_id)`.

**Append-only** is enforced by the `audit_logs_append_only` trigger, which raises on any UPDATE or
DELETE. A trigger rather than a policy, so it holds for the service role and for a direct `psql`
session too — a trail that privileged code can quietly rewrite is not a trail.

**RLS.** Admins read. No insert policy; the server writes it.

---

## Implemented — Phase 4

Migration: `drizzle/0004_phase4_posts.sql`.

### `posts`

One row per published Page post.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `streamer_id` | uuid NOT NULL | FK → `streamers.id`, `ON DELETE CASCADE` |
| `facebook_post_id` | text NOT NULL | Meta's `{page-id}_{post-id}`. **Globally unique** — the upsert target, so a re-sync updates rather than duplicates |
| `message` | text | |
| `created_time` | timestamptz NOT NULL | |
| `permalink_url` | text | |
| `reaction_count`, `comment_count`, `share_count` | integer | Nullable. Null means Meta did not report it — never coerced to 0 |
| `raw_json` | jsonb NOT NULL | The unmodified Graph response, for later re-derivation |
| `last_synced_at`, `created_at`, `updated_at` | timestamptz NOT NULL | |

Indexes: `posts_facebook_post_id_key` (unique), `(streamer_id, created_time desc)`,
`created_time desc`, `last_synced_at desc`.
Check: each count is null or non-negative.

### `post_insights`

Dynamically stored metrics. **No metric name is hard-coded anywhere** — whatever Meta returns is
what is stored.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `post_id` | uuid NOT NULL | FK → `posts.id`, `ON DELETE CASCADE` |
| `metric_name` | text NOT NULL | Whatever Meta called it |
| `period` | text | `lifetime`, `day`, `week`, `days_28`, … |
| `value_json` | jsonb | The raw `value`. Null means the metric was absent, which the UI renders as "Metric not available from Meta" |
| `end_time` | timestamptz | |
| `raw_json` | jsonb NOT NULL | The unmodified insight entry |
| `collected_at` | timestamptz NOT NULL | |

Upsert key: a **unique expression index** on
`(post_id, metric_name, coalesce(period,''), coalesce(end_time,'epoch'::timestamptz))`. The
coalesces exist because either column may be absent, and NULLs would otherwise defeat uniqueness
and let a re-sync accumulate duplicate rows for the same metric.

---

## Implemented — Phase 5

Migration: `drizzle/0005_phase5_comments.sql`. Enums added: `content_type` (`post` | `video`),
`comment_sentiment`, `summary_status`.

### `comments`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `content_type` | `content_type` NOT NULL | |
| `post_id` / `video_id` | uuid | FK, `ON DELETE CASCADE`. **Exactly one is non-null** |
| `facebook_comment_id` | text NOT NULL | **Globally unique** — the dedupe key |
| `message` | text | |
| `created_time` | timestamptz NOT NULL | |
| `like_count`, `reply_count` | integer | |
| `content_hash` | text NOT NULL | SHA-256 of this comment's identity and text; changes when Meta reports an edit |
| `last_synced_at`, `created_at`, `updated_at` | timestamptz NOT NULL | |

**There is no commenter column.** Not a name, not an id, not a hash of one. The Graph field list
never asks for `from`, so identity is not merely discarded — it is never received.

Constraint `comments_one_parent_check` — exactly one parent, and it must agree with
`content_type`. Without it a comment could be orphaned or claim two parents at once.

### `comment_summaries`

One current summary per content item.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `content_type` | `content_type` NOT NULL | |
| `post_id` / `video_id` | uuid | FK, `ON DELETE CASCADE`. Exactly one is non-null |
| `source_hash` | text NOT NULL | Deterministic SHA-256 over the comment ids and messages the summary was built from. Equality means "the same comments" — the gate on re-billing the AI |
| `comment_count` | integer NOT NULL | |
| `summary` | text | |
| `sentiment` | `comment_sentiment` | |
| `positive_points_json`, `concerns_json`, `suggestions_json`, `questions_json`, `urgent_issues_json` | jsonb | |
| `ai_provider`, `model` | text | |
| `status` | `summary_status` NOT NULL | Default `pending` |
| `error_message` | text | |
| `raw_ai_response` | jsonb | For debugging a bad summary |
| `generated_at`, `created_at`, `updated_at` | timestamptz | |

Uniqueness is two **partial** unique indexes — one `WHERE post_id IS NOT NULL`, one
`WHERE video_id IS NOT NULL` — rather than one composite index, because exactly one of the two
columns is populated.

---

## Implemented — Phase 6

Migration: `drizzle/0006_phase6_videos.sql`. This migration also adds the two `video_id` foreign
keys that Phase 5 had to leave as bare columns, because `videos` did not exist yet.

### `videos`

Retrieved from `/{PAGE_ID}/videos`. **Not `/live_videos`**, which can require separate Meta App
Review; ended broadcasts appear on the general edge as VODs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `streamer_id` | uuid NOT NULL | FK → `streamers.id`, `ON DELETE CASCADE` |
| `facebook_video_id` | text NOT NULL | **Globally unique** — the external identifier and upsert target |
| `title` | text | |
| `description` | text | |
| `length_seconds` | double precision | Meta reports fractional seconds, so this is not an integer. Null means no length was reported; 0 is a real value |
| `created_time` | timestamptz NOT NULL | |
| `permalink_url` | text | |
| `raw_json` | jsonb NOT NULL | |
| `last_synced_at`, `created_at`, `updated_at` | timestamptz NOT NULL | `updated_at` maintained by trigger |

Indexes: `videos_facebook_video_id_key` (unique), `(streamer_id, created_time desc)`,
`created_time desc`, `last_synced_at desc`.
Check: `length_seconds` is null or non-negative.

### `video_insights`

Same shape and same dynamic-storage rule as `post_insights`, keyed on `video_id`. Video metrics in
particular come back in every JSON shape — a scalar count, a status string, a retention curve
array, a reactions-by-type object, a nested demographics tree — so `value_json` is `jsonb` and the
value is stored exactly as received rather than flattened, summed or coerced.

Upsert key: the same coalescing expression index, on
`(video_id, metric_name, coalesce(period,''), coalesce(end_time,'epoch'::timestamptz))`.

**RLS and grants (Phases 4–6).** All six tables have RLS enabled with a single
`SELECT TO authenticated USING (true)` policy — this content is already public on Facebook. None
has a write policy: they are written only by server code holding the service role. Table-level
grants are revoked from `anon` and `authenticated`, then `SELECT` is granted back to
`authenticated` alone.

---

## Planned

### Page connection (OAuth) — deferred

No new tables. Replaces the Phase 3 paste-a-token flow with a server-side OAuth handshake, writing
to the same columns. Token storage, validation and health are already in place — see
[`PAGE-TOKENS.md`](./PAGE-TOKENS.md).

### Scheduled synchronisation

- **`page_daily_metrics`** — daily rollup per streamer. Unique on `(streamer_id, metric_date)`;
  the upsert target for the nightly sync.
- `sync_run_items` for per-entity provenance within a run.

### Aggregates

- **`streamer_period_metrics`** — materialised per-streamer aggregates, unique on
  `(streamer_id, period_type, period_start)`. Maps one-to-one onto `streamerPerformanceRowSchema`
  in the export contract, so a report never recomputes across snapshot rows.

### Reporting

- **`report_definitions`** — saved report configuration.
- **`export_jobs`** — audit trail of what left the system for Google Sheets: `dataset`, period,
  `row_count`, `status`, `trigger_source`.

### Operations

- **`workspace_settings`** — timezone, week start, default period, engagement-rate formula.
- **`alert_rules`** / **`alert_deliveries`** — thresholds and a delivery log. The application
  decides *whether* to alert; n8n decides *how* to deliver.

---

## Summary

| Phase | Tables | Status |
|-------|--------|--------|
| 2 | `users`, `streamers`, `sync_runs`, `audit_logs` | **Migrated** |
| 3 | none — `token_status` migrated, 2 token-health columns added | **Migrated** |
| 4 | `posts`, `post_insights` | **Migrated** |
| 5 | `comments`, `comment_summaries` | **Migrated** |
| 6 | `videos`, `video_insights` + the two deferred `video_id` FKs | **Migrated** |
| — | `page_daily_metrics`, `streamer_period_metrics` | Planned |
| — | `report_definitions`, `export_jobs` | Planned |
| — | `workspace_settings`, `alert_rules`, `alert_deliveries` | Planned |

The column that matters most is `streamers.encrypted_page_token`. It is denied to `anon` and
`authenticated` by column-level grant, and only `service_role` — used exclusively by server code —
can read it. No RLS policy should ever be written that appears to relax this, and no table-wide
`GRANT SELECT ON streamers` may be issued, because a table-level grant silently overrides a
column-level revoke.
