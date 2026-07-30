# Setup

Every external service, in the order you need them. Roughly 45 minutes end to
end, most of it waiting on Meta.

| # | Step | Blocks |
|---|---|---|
| 1 | [Supabase](#1-supabase) | everything |
| 2 | [Meta app and permissions](#2-meta-app-and-permissions) | collecting anything |
| 3 | [Anthropic](#3-anthropic) | comment summaries only |
| 4 | [Local environment](#4-local-environment) | running it |
| 5 | [Database migrations](#5-database-migrations) | running it |
| 6 | [First administrator](#6-first-administrator) | signing in |
| 7 | [First streamer](#7-first-streamer) | collecting anything |
| 8 | [Vercel](#8-vercel-deployment) | production |
| 9 | [Cron](#9-cron) | scheduled collection |
| 10 | [n8n and Google Sheets](#10-n8n-and-google-sheets) | reporting mirror |

---

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com). Pick the region
   closest to your Vercel deployment — every page render makes several
   round trips, and cross-continent latency is felt immediately.
2. **Project Settings → API**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
3. **Project Settings → Database → Connection string → URI**, copy it twice:
   - the **transaction pooler** (port 6543) → `DATABASE_URL` for normal running
   - the **direct** connection (port 5432) → used only while migrating

   URL-encode special characters in the password. A `#` or `@` left raw
   truncates the string and produces a confusing "password authentication
   failed".
4. **Authentication → Providers**: leave Email enabled, disable everything else.
   There is no signup path in this application — accounts are created by an
   admin — so an enabled OAuth provider is a way in that nobody is watching.
5. **Authentication → Policies → Password Protection**: enable *Leaked password
   protection*. It cannot be set from SQL or a migration, which is why it is a
   manual step. Supabase's linter reports it as a warning until you do.

> **Why RLS matters here even though the app uses the service role.** Every
> table has RLS enabled and a deliberate policy set. The application reads
> through the service role, so RLS is not what protects it day to day — it is
> what protects you if the anon key is ever used directly against the REST API,
> and it is why the anon key can be public at all.

---

## 2. Meta app and permissions

### Create the app

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** →
   **Create App** → type **Business**.
2. Add the **Facebook Login for Business** product.
3. **App settings → Basic**: copy the App ID → `META_APP_ID` and the App Secret
   → `META_APP_SECRET`.

### The four permissions

| Permission | Why it is needed | Without it |
|---|---|---|
| `pages_show_list` | Confirms the token belongs to the Page it claims | Token validation cannot verify the Page id |
| `pages_read_engagement` | Posts, videos and their engagement counts | No content at all |
| `read_insights` | The `/insights` and `/video_insights` edges | Content collects; every metric is empty |
| `pages_read_user_content` | Comments | No comments, so no AI analysis |

`src/lib/meta/token-status.ts` treats the first three as **required** — a token
missing any of them is marked `missing_permission` and skipped by the sweep
rather than being allowed to fail one call at a time.

### App Review

The four permissions above need App Review before they work on Pages your
Facebook user does not administer. During development, a token for a Page **you
admin** works without review, which is enough to get the whole pipeline running
end to end.

Two things worth knowing before you submit:

- **`/live_videos` is deliberately not used.** It can require a separate review
  track. Ended broadcasts appear on the ordinary `/videos` edge as VODs, so this
  application reads that instead and needs no extra permission. See
  `docs/SYNC-ENGINE.md` §4b.
- **Business verification** is usually required alongside review for these
  permissions. Start it early; it is the slowest part.

### Getting a Page token

1. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) → pick
   your app → **User Token** with the four permissions → **Generate**.
2. Call `GET /me/accounts`. Each entry has an `access_token` — that is the Page
   token, and it is the value you paste into the admin panel.
3. Paste it into **Admin → Streamers → Add streamer**. The application validates
   it against `/me` and `/debug_token`, encrypts it with AES-256-GCM, and stores
   only the ciphertext plus the last four characters.

> Page tokens derived from a long-lived user token do not expire, but they are
> revoked when the admin changes their password, removes the app, or loses their
> Page role. The Streamers tab's *Token Status* column is what surfaces that —
> see the token-health alert in `docs/N8N-PRODUCTION-WORKFLOW.md`.

---

## 3. Anthropic

1. [console.anthropic.com](https://console.anthropic.com) → **API keys** →
   create one → `ANTHROPIC_API_KEY`.
2. Set a **spend limit** on the workspace. The summariser is bounded by
   `MAX_COMMENTS_PER_CONTENT` and by the source-hash gate — an unchanged comment
   set costs nothing — but a limit is the backstop that does not depend on those
   working.
3. Leave `ANTHROPIC_MODEL` at the default unless you have a reason.

To run everything except summarisation, set `AI_SUMMARIZATION_ENABLED=false`.
Comments are still collected and stored; no Anthropic call is made.

---

## 4. Local environment

Node.js 20.9 or newer.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Generate the three secrets you create yourself:

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"
```

```bash
node -e "console.log('N8N_API_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"
```

Run each separately — `CRON_SECRET` and `N8N_API_SECRET` must differ.

---

## 5. Database migrations

Point `DATABASE_URL` at the **direct** connection (port 5432) first.

```bash
npm run db:migrate
```

Then switch `DATABASE_URL` back to the transaction pooler (6543) for running
the app.

To check the migrations without a database at all — this boots Postgres
in-process via PGlite and applies the real files:

```bash
npm run db:verify
```

That is what runs in CI, and it has caught two production-affecting bugs before
deploy: a column-level `GRANT` that a table-level grant was silently overriding,
and an enum migration that broke a check constraint.

### Adding a migration later

```bash
npm run db:generate
```

Rename the generated file to `NNNN_phase_description.sql`, update the `tag` in
`drizzle/meta/_journal.json` to match, then apply it. Write the journal without
a BOM — PowerShell's `Set-Content -Encoding utf8` adds one and the migration
harness parses that file as JSON.

> **Column-level grants.** `streamers` and `sync_runs` are granted to
> `authenticated` column by column, so a column added by a later migration is
> **not** covered by the existing grant and is invisible to client roles until
> granted explicitly. See `docs/SECURITY.md`.

---

## 6. First administrator

Every account created through Supabase Auth is provisioned as a **viewer** by a
database trigger. There is no signup path that yields administrative access, so
the first admin is seeded:

```bash
npm run seed:admin -- --email you@cbsoft.example --name "Your Name"
```

The script creates the Auth user if the email is new (generated password, email
pre-confirmed), ensures the profile row exists, promotes it to `admin`, and
writes a `user.role_changed` audit entry — all in one transaction.

The generated password is printed **once** and stored nowhere. Change it after
signing in, or pass `--password "…"` to choose your own.

Re-running is safe: an account that is already an admin is left alone.

After that, promote further admins through **Admin → Users**, which is audited.
A user must sign in once before they appear there — that is what creates their
profile row.

---

## 7. First streamer

1. Sign in and go to **Admin → Streamers → Add streamer**.
2. Fill in:
   - **Streamer code** — your business key, e.g. `CBS-014`. Uppercase letters,
     digits and hyphens.
   - **Streamer name** — display name.
   - **Page ID** — numeric, from the Page's About section or `/me/accounts`.
   - **Page name**.
   - **Page access token** — from step 2.
3. Save. The application calls `GET /{version}/me?fields=id,name` and
   `GET /debug_token` before storing anything. **A token whose Page ID does not
   match the one you entered is refused outright** — storing it would silently
   attach the wrong credential to the wrong streamer.
4. On the streamer's **Settings** tab, click **Sync Posts**. You should see
   posts appear under **Posts** within a few seconds.
5. Open a post and click **Sync comments** to check the analysis pipeline.

If the token is accepted but marked `missing_permission`, the four permissions
in step 2 are not all granted — the Settings tab lists which are missing.

---

## 8. Vercel deployment

1. Push to GitHub, then **Add New → Project** in Vercel and import the repo.
   Framework preset **Next.js**; leave the build settings alone.
2. **Settings → Environment Variables**: add every variable from `.env.local`
   for **Production** and **Preview**.
   - `DATABASE_URL` must be the **transaction pooler** (6543). The direct
     connection is IPv6-only on new Supabase projects and Vercel functions will
     not reach it.
   - `TOKEN_ENCRYPTION_KEY` must be the **same value** as the one that encrypted
     the tokens in your database. A different key makes every stored token
     unreadable.
3. Deploy.
4. Open `/settings` on the deployment. It reports which variables are missing by
   **name** — it never displays a value.
5. Check `/api/health` returns `200`.

`vercel.json` already pins the function durations a sweep needs (800 s for
`sync-all` and the cron route). Those exceed the Hobby plan's limit — the sweep
needs Pro.

---

## 9. Cron

`vercel.json` registers the schedule:

```json
{ "path": "/api/cron/daily-sync", "schedule": "0 */6 * * *" }
```

Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically, using the
`CRON_SECRET` environment variable. Nothing else to configure.

Change the cadence by editing both `vercel.json` **and** `SYNC_FREQUENCY_HOURS`
— the endpoint refuses a run that arrives sooner than `SYNC_FREQUENCY_HOURS`
after the last one, so a schedule tighter than the variable results in every
other tick being skipped.

Trigger one by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://your-app.vercel.app/api/cron/daily-sync?force=true"
```

`force=true` bypasses the frequency gap. It cannot bypass the in-flight check —
that one is about correctness, not scheduling.

**If you are running n8n, you do not need cron.** They are alternative triggers
for the same sweep. Cron is the fallback for a deployment that should keep
collecting when n8n is unavailable; running both is harmless because of the
overlap protection, but it doubles nothing and gains little.

---

## 10. n8n and Google Sheets

Full instructions:

- **[`docs/N8N-PRODUCTION-WORKFLOW.md`](./N8N-PRODUCTION-WORKFLOW.md)** — the
  complete workflow, node by node, with alerting.
- **[`docs/GOOGLE-SHEETS.md`](./GOOGLE-SHEETS.md)** — the seven tabs and their
  columns.
- **[`docs/N8N-AUTOMATION.md`](./N8N-AUTOMATION.md)** — the API reference.

In short:

1. Create one **Header Auth** credential in n8n:
   `Authorization: Bearer <N8N_API_SECRET>`.
2. Create a spreadsheet with the seven tabs, and share it with the Google
   account n8n authenticates as. Restrict it to named accounts.
3. Build the workflow: Schedule → `POST /api/automation/sync-all` → poll
   `GET /api/automation/sync-runs/{id}` until `finished` → seven export
   branches → seven **Append or Update Row** nodes.
4. Set `GOOGLE_SHEETS_EXPORT_ENABLED=true`.
5. Check **Settings** afterwards: seven datasets should show a recent
   successful run.

Get the tab layout as JSON, so a setup workflow can create the tabs rather than
someone typing column names:

```bash
curl -H "Authorization: Bearer $N8N_API_SECRET" \
  https://your-app.vercel.app/api/automation/google-sheets/schema
```

> **n8n owns the Google credential.** This application has no field to store
> one, never asks for one, and never calls the Google Sheets API.

---

## Troubleshooting

### Sign-in and access

**"Invalid email or password" for a password you are sure of.**
The message is deliberately identical for a wrong password and an unknown
account — distinguishing them turns the form into an account-enumeration
oracle. Check the address is exactly the one you seeded. `audit_logs` records
every `user.sign_in_failed` with the attempted address.

**"Too many sign-in attempts."**
Six failures per address in fifteen minutes. Wait it out or restart the server
locally — the counter is in memory. A successful sign-in clears it.

**Signed in but every page bounces to `/unauthorized`.**
The Auth user exists but has no `public.users` profile row. The
`on_auth_user_created` trigger creates it; if the account predates the trigger,
run `npm run seed:admin` with that address, which repairs the row.

**A viewer cannot see Admin.**
Correct. Promote through **Admin → Users**; the change is audited and nobody
can change their own role.

### Database

**`password authentication failed for user "postgres"`.**
Either the password is wrong, or a special character in it is not URL-encoded.
Reset it in **Project Settings → Database** and update `DATABASE_URL`. A
password change takes a moment to propagate to the pooler — if it fails
immediately after a reset, wait a minute and retry.

**`tenant or user not found`.**
The pooler hostname is wrong. Check the region in the connection string matches
your project; `aws-0-` and `aws-1-` are different pooler fleets and only one
hosts a given project.

**Migrations hang or fail with a DDL error.**
You are on the transaction pooler. Switch `DATABASE_URL` to the direct
connection (5432) to migrate, then switch back.

**A new column is invisible to the app.**
`streamers` and `sync_runs` use column-level grants. Add
`GRANT SELECT ("new_column") ON public.<table> TO authenticated;` to the
migration.

### Meta

**Token accepted but `missing_permission`.**
One of `pages_show_list`, `pages_read_engagement` or `read_insights` is not
granted. The streamer's Settings tab lists which. Re-generate the token in the
Graph API Explorer with all four ticked.

**Token rejected on save with a Page-ID mismatch.**
The token belongs to a different Page than the ID you typed. This is refused on
purpose — storing it would attach the wrong credential to the streamer. Check
`GET /me/accounts` for which Page the token is actually for.

**`token_status` flips to `expired` or `invalid` overnight.**
Page tokens are revoked when the granting admin changes their password, removes
the app, or loses their Page role. Generate a new one and use **Replace token**.

**Posts collect but every metric is empty.**
`read_insights` is missing, or the Page is too new or too small for Meta to
report insights. An empty metric shows as *"Metric not available from Meta"* —
never as zero.

**`(#4) Application request limit reached`.**
The app-level rate limit. The client already backs off with full jitter and
records the run as `partial`. If it recurs, lower `MAX_POSTS_PER_STREAMER` and
`MAX_VIDEOS_PER_STREAMER`, or lengthen `SYNC_FREQUENCY_HOURS`.

**Videos are missing for a Page that definitely streams.**
This application reads `/videos`, not `/live_videos`. An *in-progress* broadcast
is not there yet; it appears as a VOD once it ends.

### Synchronisation

**A sweep reports `partial`.**
Normal, and not an error. It means at least one streamer was skipped or failed
while others succeeded. The `streamers` array in the run status names which and
why.

**The cron endpoint always returns `skipped`.**
Either a run is stuck in `running`, or the schedule is tighter than
`SYNC_FREQUENCY_HOURS`. Check for a stuck run:

```sql
SELECT id, started_at FROM sync_runs WHERE status = 'running';
```

A run left `running` by a hard process kill blocks every subsequent tick. Close
it:

```sql
UPDATE sync_runs
SET status = 'failed', completed_at = now(), error_message = 'Abandoned; closed manually'
WHERE status = 'running';
```

**Comments collect but no summary appears.**
Check `AI_SUMMARIZATION_ENABLED`. If it is true, the source-hash gate is
probably doing its job — an unchanged comment set is not re-analysed. Use
**Regenerate summary** to force one.

**Summaries are `failed`.**
The Anthropic call failed or returned something the Zod contract rejected. The
message is on the summary row. A refusal or a malformed response is stored as
`failed` rather than as a malformed summary.

### Exports and Sheets

**Google Sheets rows duplicate every night.**
The node is set to **Append** rather than **Append or Update Row**, or the
matching column is wrong. Correct values are in `docs/GOOGLE-SHEETS.md` §3.

**Every export re-sends everything.**
`updated_after` is not being fed back, or it is being taken from a row's
timestamp column rather than from `max_watermark`. Row columns are
millisecond-precision; `max_watermark` is microsecond-precision, and a
checkpoint even slightly too early re-delivers the whole previous batch.

**`401` from an automation endpoint.**
The secret is wrong, or the header is missing the `Bearer ` prefix. The response
body is identical for both, deliberately.

**`429 rate_limited`.**
Ten writes or 120 reads per minute. Turn on **Retry On Fail** with a 5-second
delay in the n8n node.

**`400 token_material_refused`.**
A workflow is sending a field named like a credential, or a value shaped like
one. The response names the field. Remove it — this application decrypts Page
tokens server-side and calls Meta itself.

### Build and deploy

**Build fails with a `server-only` error.**
A Client Component is importing a server module. The error names the file. Move
the data access into a Server Component and pass the result down as props.

**Styles or scripts blocked by CSP in the browser console.**
Something is rendering a script Next did not emit. Every route must be
dynamically rendered for the nonce to be applied — check the build output for a
`○ (Static)` route.

**`npm test` fails on `bundle-secrets`.**
It needs `.next/static`, which `npm run build` produces. The suite skips those
assertions when the directory is absent; if it fails rather than skips, a real
secret was found — read the failure, it names the file.
