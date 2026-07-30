# Production troubleshooting

Symptoms first. Each entry says how to confirm the cause before changing
anything, because most of these have more than one plausible explanation.

Start here:

```bash
curl -s https://cbsoft-streamer-dashboard.vercel.app/api/health
```

`status`, `environment`, `database.reachable`, `latency_ms`, `version`. If that
responds at all, the deployment is up and routing works, which rules out a
large class of causes immediately.

## The build fails on Vercel but `npm run verify` passes locally

This has happened twice, from different causes. Both times the local suite was
green, so treat "it works on my machine" as no evidence at all here.

**Always read the build log, not the error code.** Vercel's `errorCode` is
frequently `module_not_found` regardless of the real failure. The actual
message is in the log:

Vercel → Deployments → the failed one → **Building**. Or:

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v2/deployments/<dpl_id>/events?teamId=<team>&limit=500&direction=backward"
```

Newest lines come first.

### "Invalid segment configuration export detected"

`export const runtime`, `dynamic`, `revalidate` and `maxDuration` are read by
**static analysis**. Next never evaluates the module, so the value must be a
literal in that file:

```ts
export const maxDuration = 300;                 // fine
export const maxDuration = sharedMaxDuration;   // rejected — an imported binding
```

`tests/cron-alias.test.ts` guards this by reading the source rather than
importing it, because importing yields the evaluated value and would pass
against the very form that breaks the build.

### The Linux build cannot find a file that exists

Windows and macOS are case-insensitive; the build container is not.
`@/components/Foo` will not resolve `foo.tsx`. Confirm with the name git
actually stores:

```bash
git ls-files | grep -i thefilename
```

## `db:migrate` tries to re-apply migrations that already ran

Drizzle compares the sha256 of each migration file's bytes against
`drizzle.__drizzle_migrations`. A mismatch means "not applied".

```sql
select id, left(hash, 12), to_timestamp(created_at / 1000) from drizzle.__drizzle_migrations order by created_at;
```

Two causes:

- **Line endings.** A CRLF checkout hashes differently from LF. `.gitattributes`
  pins `*.sql` to LF; if someone bypassed it, re-normalise and recompute.
- **A migration applied outside drizzle** — through the Supabase SQL editor, for
  instance. The schema changes, the ledger does not, and the next `db:migrate`
  tries to replay it against tables that already exist. Backfill the ledger with
  the file's hash and the journal's timestamp rather than editing the SQL.

**Never "fix" this by editing an applied migration file.** That changes its
hash and makes the mismatch permanent.

## `drizzle-kit generate` invents a migration that drops things

If it proposes `DROP TYPE` or re-adds an existing column, the fault is almost
certainly in `drizzle/meta/`, not in the database.

`generate` diffs the schema against the **newest snapshot**. A migration written
by hand has no snapshot, so generate keeps rediscovering changes that shipped
long ago. Verify against the live database first:

```sql
select column_name from information_schema.columns where table_name = 'sync_runs';
```

If the column is there, delete the generated migration and repair the snapshot
chain instead of applying it. Applying it would drop a live enum.

## Every request redirects to `vercel.com/sso-api`

Deployment Protection, not the app. Preview deployments and the team-scoped
production hostname are behind Vercel Authentication; the production alias
`cbsoft-streamer-dashboard.vercel.app` is not.

- Sign in to Vercel in the same browser, or
- Use the production alias, or
- For automated checks, create a Protection Bypass for Automation and send
  `x-vercel-protection-bypass: <secret>`. **Revoke it when finished** — it is a
  long-lived credential that bypasses SSO for anyone holding it.

## n8n gets 401 from every endpoint

In order of likelihood:

1. **The secret does not match.** `N8N_API_SECRET` was changed in Vercel but not
   in the n8n credential, or vice versa. They are independent copies.
2. **Vercel was not redeployed.** A running deployment keeps the environment it
   was built with. Setting a variable changes nothing until a rebuild.
3. **The header is malformed.** It must be `Authorization: Bearer <secret>` —
   the scheme, a single space, the raw secret.

Isolate it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <secret>" \
  https://cbsoft-streamer-dashboard.vercel.app/api/automation/exports/streamers
```

401 with a secret you believe is right means Vercel holds a different value.

## A sync run is stuck in `processing`

`sync_runs_one_active_sweep_idx` permits one active roster sweep. A run
abandoned mid-flight — a deployment replaced under it, a function timeout —
holds that lock and every later sweep gets a unique violation.

```sql
select id, status, started_at, trigger_source
  from public.sync_runs
 where status in ('queued', 'processing') and parent_sync_run_id is null;
```

If it is genuinely abandoned rather than slow, close it as `cancelled` — the
status exists for this case. The statement is in [ROLLBACK.md](./ROLLBACK.md).

Before cancelling, check it is not simply slow: a sweep across many Pages with
comment fetching takes minutes, and `MAX_STREAMERS_PER_SYNC` bounds each run.

## Meta Graph errors

| What you see | What it means | What to do |
| --- | --- | --- |
| `code 190` | Token expired or revoked | Re-enter via Admin → Streamers → Replace token |
| `code 200` | Missing permission | Page needs `read_insights`; re-grant and reissue |
| `code 4` / `17` | Rate limited — per **app**, not per Page | Lower `MAX_STREAMERS_PER_SYNC`, spread the schedule |
| `code 3001` | Insights call without a `metric` parameter | A code bug: v25 requires explicit metrics |
| `code 100` | Field unavailable for this object | Often normal — not every metric exists for every post |

Rate limiting is per app. Two concurrent sweeps do not go twice as fast; they
degrade each other. That is why the single-sweep lock exists.

## Insights come back empty but the sync says it succeeded

Distinguish two cases before assuming a bug:

- **Meta declined to report the metric.** Common on posts with little
  engagement, and normal. The row is absent, not zero.
- **Nothing was written.** Check the counters against the table:

  ```sql
  select count(*) from public.post_insights where post_id = '<id>';
  ```

A counter that says what the code *intended* to write is not evidence that
Postgres accepted it. This bit us before: a malformed array parameter made
every insight write silently fail while the run still reported success.

## Comment summaries never appear

Check in this order:

1. `AI_SUMMARIZATION_ENABLED` — if false, nothing is generated by design.
2. `ANTHROPIC_API_KEY` — if the flag is true and the key is missing, environment
   validation fails at startup with an explicit message.
3. **The content hash has not changed.** Summaries are gated on a deterministic
   hash of the comment set, so re-running produces nothing new when the comments
   are unchanged. That is the intent. Force one with **Regenerate summary**.

## The dashboard renders but every number is zero

Usually an empty database rather than a broken query:

```sql
select
  (select count(*) from public.streamers where active) as active_streamers,
  (select count(*) from public.posts) as posts,
  (select count(*) from public.post_insights) as insights;
```

If those are non-zero and the UI still shows zero, check the date filter — the
dashboard defaults to a recent window, and content older than it is excluded.

## Nothing reaches Google Sheets

The app never talks to Google. It emits rows; n8n writes them. So test the two
halves separately:

```bash
curl -s -H "Authorization: Bearer <secret>" \
  "https://cbsoft-streamer-dashboard.vercel.app/api/automation/exports/streamers?format=sheets&limit=5"
```

Rows returned means the app's half works and the fault is in n8n — most often
the Google credential, or a Sheet node whose tab name does not match. Sheet
nodes are set to continue on error so one bad tab does not stop the rest, which
means a partial export looks like success. Check the execution log per node.

## Reading logs

Vercel → the deployment → **Runtime Logs**, or:

```bash
npx vercel logs <deployment-url> --token <VERCEL_TOKEN> --scope combo-inter-active
```

Every log line passes through `redact()`. Page tokens, JWTs, `sb_secret_…`,
`sk-ant-…` and database URL passwords are replaced before emission. If you ever
see a real credential in a log, that is a defect in the redaction rules — fix
`src/lib/observability/logger.ts` and add a case to
`tests/logger-redaction.test.ts`.

Correlate a report with a request using `x-request-id`, which is echoed on
every response and accepted from the caller so n8n and the app agree on names.
