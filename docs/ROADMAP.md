# Roadmap

Ten phases. Each is independently reviewable and leaves the application in a working, deployable
state.

---

## Phase 1 — Foundation ✅

Next.js App Router + TypeScript strict, Tailwind v4, shadcn/ui, ESLint + Prettier. Folder
structure, Zod environment contract, `server-only` boundaries, AES-256-GCM token crypto, bearer
auth for machine callers, `.env.example`, README, and the full documentation set. Placeholder
screens for login, dashboard, streamers, reports, admin and settings. No authentication, no data,
no live integrations.

## Phase 2 — Authentication and authorisation ✅

Supabase Auth email/password sign-in and sign-out, session refresh in `src/proxy.ts`, the four
Phase 2 tables (`users`, `streamers`, `sync_runs`, `audit_logs`) with indexes, foreign keys, check
constraints and triggers, RLS plus column-level grants, the `admin`/`viewer` role model with a
permission matrix, four-layer route protection, an `/unauthorized` page, admin user-management
screens, audited role changes, a first-admin seed script, and 89 tests including the real
migrations applied to a real Postgres.

**Exit criteria — met:** an unauthenticated request to any `(app)` route redirects to `/login`
carrying a sanitised return path; a viewer reaching `/admin/*` lands on `/unauthorized`; a viewer
invoking the role-change Server Action directly is refused; `encrypted_page_token` is unreadable by
`anon` and `authenticated` at the database level.

> **Role model change.** Phase 1 sketched `admin` / `manager` / `streamer`. The Phase 2
> specification defines exactly two roles, `admin` and `viewer`, and that is what was built.

## Phase 3 — Streamer management ✅

Admin CRUD over `streamers`: add, edit, disable, soft-delete. Page token storage with AES-256-GCM,
server-side validation against `/me` and `/debug_token`, the six-value health model, masked display,
manual sync queueing, and seven authenticated API routes. Audit entries for every streamer and
token action. No new tables — `token_status` was migrated and two token-health columns added.

**Exit criteria — met:** a token whose Page ID does not match is refused before anything is
written; a stored token is unreadable by `anon` and `authenticated` at the database level; the only
representation reaching a browser is `••••••••••••ABCD`; a viewer calling any admin API route gets
403.

## Phase 4 — Graph client and post synchronization ✅

Reusable server-side Graph client with configurable API version, timeout, retry
with full-jitter exponential backoff, rate-limit handling, pagination, bounded
concurrency, nine normalised error categories and redacted structured logging.
`posts` and `post_insights` tables. Page-post retrieval via `published_posts`
with dynamic insight storage, three API routes, a Sync Posts button, and post
list and detail screens.

**Exit criteria — met:** insights are stored without any hard-coded metric name;
a metric Meta did not report displays as "Metric not available from Meta" and is
never converted to zero; partial runs keep the posts they collected; the plaintext
token never leaves `withStreamerToken`.

## Phase 4b — Facebook Page connection (OAuth, deferred)

Server-side Meta OAuth with signed single-use `state`, `me/accounts` Page selection, encrypted
token persistence, connection health display, disconnect. Minimum scopes only. Personal profiles
rejected at both the edge and the validation guard.

**Exit criteria:** a token round-trips through encryption and is never present in any response
body, log line or client bundle.

## Phase 5 — Comment collection and AI summaries ✅

Paginated comment retrieval that never requests commenter identity, deterministic
per-comment and per-set hashing, an AI provider abstraction with an Anthropic
implementation using structured outputs plus Zod validation, hash-gated
summarisation, the five summary statuses, two admin endpoints, and comment
analysis on the post detail page.

**Exit criteria — met:** no commenter name is requested, stored, or displayed;
a re-sync over unchanged comments makes no AI call; a malformed or refused
model response becomes a `failed` row rather than a malformed summary; both
specified placeholder strings are produced.

## Phase 5b — Scheduled synchronisation (deferred)

`sync_runs` / `sync_run_items`, `streams`, `stream_metrics`, `page_daily_metrics`. Graph fetchers
with backoff and rate-limit budgeting. `/api/cron/daily-sync` and `/api/n8n/sync` become real.
Manual re-run from Admin. Nightly n8n workflow goes live.

## Phase 6 — Video synchronization ✅

`videos` and `video_insights` tables. Page-video retrieval via `/{PAGE_ID}/videos` with the six
specified fields, dynamic `/video_insights` storage that accepts any JSON shape, and the Phase 5
comment pipeline generalised over a `ContentRef` so posts and videos share one implementation of
pagination, deduplication, source hashing, privacy rules and AI summarisation. Three admin API
routes, video list and detail screens.

**Exit criteria — met:** `/live_videos` is not called anywhere, so no separate Meta App Review is
required; metric values that are numbers, strings, arrays, objects or nested JSON all round-trip
through `value_json` unflattened; a video-comment sync reuses the post code path rather than
duplicating it, so the no-commenter-name rule cannot drift between the two; `facebook_video_id` is
unique and deleting a video cascades to its comments, summary and metrics.

> **Numbering note.** Phase 1 sketched Phase 6 as dashboard analytics and Phase 7 as comments.
> The delivered specification ordered the work differently — comments landed in Phase 5 and videos
> in Phase 6. The entries below are the remaining sketched work; each takes its number when the
> user specifies that phase.

## Phase 7 — Dashboard and reporting interface ✅

The full responsive interface over everything Phases 4–6 collect. Ten dashboard cards; a shared
filter contract (Today / 7d / 30d / custom range / all time, per-streamer, posts-or-videos) that
lives in the URL; posts, videos and comment-analysis tables with search, server-side sorting and
pagination; a six-tab streamer detail screen; CSV export; light and dark themes; and explicit
loading, empty and error states throughout.

**Exit criteria — met:** every filter round-trips through one pure resolver, so a CSV contains
exactly the rows the table showed; a sort key from the query string cannot reach `ORDER BY`, only
an allow-listed column object can; engagement totals report how many rows did not report a figure
instead of summing them as zero; no export column, and no viewer-facing query, can carry token
material; and a spreadsheet formula planted in a comment is neutralised before it reaches a CSV.

## Phase 8 — Secure n8n automation ✅

Ten bearer-authenticated `/api/automation/*` endpoints. A roster-wide sweep that opens a parent
`sync_runs` row and returns its id immediately; a per-streamer sync; a polling endpoint reporting
the parent and every child run; and seven Sheets-shaped export datasets supporting an
`updated_after` checkpoint, a content-date window, a streamer filter and pagination behind a stable
column contract. Constant-time secret comparison, per-class rate limiting, sanitised errors, and a
`sync_runs.parent_sync_run_id` self-link. Full workflow documentation in
[`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md).

**Exit criteria — met:** n8n receives no Page token in either direction — a request carrying
credential material is refused `400` without echoing the value, and no export schema has a field
capable of holding one; a Meta error reaches n8n as four safe fields with the message scrubbed, so
a Graph URL carrying a token in its query string cannot land in an n8n execution log; one streamer
failing costs exactly that streamer's results and the sweep finishes `partial`; a sort or filter
parameter cannot reach SQL; and every export orders by `(watermark, id)` so pagination cannot skip
a row.

## Phase 9 — Google Sheets reporting mirror ✅

Seven documented spreadsheet tabs with human-readable headers and stable
matching keys, including a composite `Insight Key` that mirrors the database's
own uniqueness rule. A `format=sheets` projection returns rows already keyed by
those headers so an n8n branch needs no transform node.
`GET /api/automation/google-sheets/schema` serves the layout as JSON. Per-tab
CSV fallback for when n8n is unavailable. An `export_runs` table and a rebuilt
Settings page reporting export health. Full layout in
[`GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md).

**Exit criteria — met:** no tab has a column capable of carrying a Page token,
asserted against a duplicated literal per tab; a tab column can only name a
field the export contract already publishes, enforced by the type system rather
than by review; the sheet is written and never read, so a manager editing a cell
cannot change the system of record; the application holds no Google credential
and has no field to store one; and every tab is downloadable as CSV with
identical headers when the automation is down.

---

## Remaining sketched work

**Period aggregates and charts.** `streamer_period_metrics` materialisation, Recharts trend and
comparison views, period-over-period deltas. Phase 7 reports current counts; this adds the
history to compare them against.

**Scheduled synchronisation from within the app.** `/api/cron/daily-sync` still returns `501`.
Phase 8 made n8n the scheduler; a Vercel Cron path would be a second trigger for the same sweep,
and is only worth building if the deployment should not depend on n8n being up.

**Operations.** Audit log UI, workspace settings, alert rules and delivery via n8n,
connection-expiry notifications.

**Hardening and launch.** Security headers and CSP, redacting logger, rate limiting, error
tracking, `npm audit` in CI, query and index tuning, key-rotation runbook, load testing,
production rollout.

---

## Standing rules across all phases

1. No phase weakens an architecture rule from `ARCHITECTURE.md` §2.
2. A migration ships in the same phase as the code that reads and writes it.
3. No mock or seeded data in application code — fixtures live in tests only.
4. Any new outbound field must be added to a Zod schema first, so it is impossible to leak a column
   by accident.
