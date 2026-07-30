# Rollback

What to do when a production change goes wrong. Nothing here has been rehearsed
against production data — rollback drills on live rows are how you turn one
incident into two.

Read the whole procedure before starting it. Most of these are quick; the
dangerous ones are marked.

## Roll back a Vercel deployment

The fastest recovery available, and almost always the right first move. It
changes which build serves traffic and touches no data.

1. Vercel → the project → **Deployments**.
2. Find the last deployment that was healthy. Deployment IDs and commit SHAs
   are both shown.
3. **⋯ → Promote to Production**.

Promotion re-points the production alias at an existing build. It does not
rebuild, so it takes seconds and cannot fail on a compile error.

From the CLI:

```bash
npx vercel promote <deployment-url> --token <VERCEL_TOKEN> --scope combo-inter-active
```

**Important:** promoting an older build does *not* roll back the database. If
the bad deployment ran a migration, see below — an older build against a newer
schema can be worse than the problem you started with.

## Restore the previous production deployment

Same mechanism as above; the distinction is knowing *which* build to go back
to. `GET /api/health` reports `version`, and the Vercel deployment list records
the commit SHA. To confirm what a given build contains:

```bash
git log --oneline <sha> -1
```

If the alias itself is wrong rather than the build, reassign it:

```bash
npx vercel alias set <deployment-url> cbsoft-streamer-dashboard.vercel.app
```

## Roll back a database migration — only when safe

**Read this before running anything.** Drizzle has no `down` migrations in this
project, by choice: a generated `down` gives false confidence, because dropping
a column is not the inverse of adding one once rows exist.

Judge the migration first:

| Migration did | Safe to reverse? | How |
| --- | --- | --- |
| Added a table | Yes | `DROP TABLE` — nothing else referenced it |
| Added a nullable column | Yes | `ALTER TABLE … DROP COLUMN` loses only that column's data |
| Added an index or constraint | Yes | `DROP INDEX` / `ALTER TABLE … DROP CONSTRAINT` |
| Added an enum value | Usually not | Postgres cannot remove one; leave it unused |
| Renamed a column or enum value | **No** | Reversing it strands rows written since |
| Dropped or narrowed a column | **No** | The data is already gone; restore from backup |

For anything in the "No" rows, restore from a Supabase backup instead:
Supabase → **Database** → **Backups** → *Restore*. Point-in-time recovery is a
paid feature; on the free tier you get daily snapshots, so the recovery point
is up to 24 hours old.

Then reconcile the ledger, or the next `db:migrate` will disagree with reality:

```sql
-- Inspect what drizzle believes has been applied.
select id, left(hash, 12), to_timestamp(created_at / 1000) from drizzle.__drizzle_migrations order by created_at;
```

If you remove a migration's effects, remove its ledger row too. If you restore
a backup taken before a migration, the ledger comes back with it and needs no
help.

The ledger stores a sha256 of each migration file's **bytes**. `.gitattributes`
pins those files to LF for exactly this reason: a CRLF checkout hashes
differently and the same migration looks unapplied.

## Disable n8n temporarily

The scheduler is the loudest moving part, and stopping it stops all automated
writes and all exports.

- **One workflow:** open *CBSOFT Streamer Sync to Google Sheets* and toggle
  **Active** off. In-flight executions finish; no new ones start.
- **Everything:** n8n → **Settings → Workflows** and deactivate, or suspend the
  n8n Cloud instance.

The app needs no change. Its automation endpoints simply stop being called.

To let n8n keep running but refuse it at the door, rotate `N8N_API_SECRET` in
Vercel (below). Every n8n call then gets 401 while the site stays up — useful
when the workflow itself is the problem.

## Disable a problematic streamer

Preferred over deleting: it stops sync while keeping history and insights.

1. Sign in as an admin → **Admin → Streamers**.
2. Open the streamer → set **Active** to off → save.

The roster sweep skips inactive streamers. Existing posts, videos, insights and
summaries stay queryable and keep exporting.

Directly, if the admin UI is the thing that is broken:

```sql
update public.streamers set active = false where streamer_code = 'THE_CODE';
```

## Revoke a compromised Facebook Page token

Assume compromise if a token has appeared in a log, a screenshot, a support
thread, or anywhere outside the database.

1. **Invalidate it at Meta first.** The Page admin opens
   [Business Integrations](https://www.facebook.com/settings?tab=business_tools)
   and removes the app's access, which kills every token issued for that Page.
   Rotating the app secret (below) also invalidates outstanding tokens.
2. **Remove the stored copy.** Admin → Streamers → the streamer → **Replace
   token**. Pasting a new token overwrites the ciphertext. To leave it empty:

   ```sql
   update public.streamers
      set encrypted_page_token = null, token_status = 'invalid'
    where streamer_code = 'THE_CODE';
   ```

3. **Confirm it is gone.** The plaintext exists nowhere else by design — not in
   logs, not in exports, not in the browser. Check anyway:

   ```sql
   select count(*) from public.audit_logs where metadata::text like '%EAA%';
   ```

   That must return 0. If it does not, the leak is in whatever wrote that row.

## Rotating secrets

The general shape is the same for all of them:

1. Create the new value at the source.
2. Set it in Vercel for **Production** (and Preview if shared).
3. Redeploy — environment variables are read at build and runtime, and an
   existing deployment keeps its old values until it is rebuilt.
4. Update any external consumer.
5. Revoke the old value.

Step 3 is the one people skip. Setting a variable in Vercel does **not** affect
the running deployment.

```bash
# After changing any variable, redeploy production:
npx vercel --prod --token <VERCEL_TOKEN> --scope combo-inter-active
```

### TOKEN_ENCRYPTION_KEY — the dangerous one

**Rotating this without re-encrypting makes every stored Page token
unreadable.** The key decrypts the `v1.<iv>.<tag>.<ciphertext>` envelope in
`encrypted_page_token`; a new key cannot decrypt what the old one wrote.

Only two safe paths exist:

- **Re-encrypt.** Read every token with the old key, re-encrypt with the new,
  write back — in one transaction, with both keys available. There is no script
  for this yet; write one before you need it.
- **Re-enter.** Set the new key, then have each Page admin supply a fresh token
  through **Replace token**. Simpler, and honest about the cost: every streamer
  is down until their token is re-entered.

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Rotate only on actual compromise. This is not a routine-hygiene rotation.

### META_APP_SECRET

Meta → **App Dashboard → Settings → Basic → App Secret → Reset**.

Resetting invalidates outstanding Page tokens, so plan it together with token
re-entry. Set the new value in Vercel, redeploy, then re-validate each streamer
from Admin → Streamers.

### ANTHROPIC_API_KEY

[Anthropic Console](https://console.anthropic.com/settings/keys) → create a new
key → set it in Vercel → redeploy → delete the old key.

Lowest-risk rotation here. A bad key degrades AI summaries only; sync, exports
and the dashboard are unaffected, and summaries resume once the key is right.

### N8N_API_SECRET

Shared between the app and n8n, so both sides change together and there is a
brief window where they disagree.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

1. Set it in Vercel → **redeploy**.
2. In n8n, open the *CBSOFT Automation Bearer* credential and paste the same
   value. Every HTTP node shares that one credential.
3. Run the workflow manually once. A 401 means the two sides still disagree.

Between steps 1 and 2 every n8n call returns 401. That is the intended failure
mode — the workflow stops rather than exporting with stale credentials.

### CRON_SECRET

Only Vercel Cron uses it. Set the new value, redeploy, and confirm:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://cbsoft-streamer-dashboard.vercel.app/api/cron/facebook-sync
# expect 401
```

Vercel injects the header itself for scheduled invocations, so there is no
second system to update.

## After any rollback

```bash
curl -s https://cbsoft-streamer-dashboard.vercel.app/api/health
```

`status: ok`, the `version` you expect, and `database.reachable: true`. Then
check **Admin → Sync Logs** for runs stuck in `processing` — a deployment
replaced mid-sweep can leave one holding the single-sweep lock:

```sql
-- Frees the lock. Only for runs you have confirmed are abandoned.
update public.sync_runs
   set status = 'cancelled', completed_at = now(), error_message = 'Abandoned: deployment rolled back'
 where status in ('queued', 'processing')
   and parent_sync_run_id is null
   and started_at < now() - interval '1 hour';
```

`cancelled` exists for this. Before it, an abandoned sweep could only be left
`processing` — holding the lock forever — or dishonestly marked `completed`.
