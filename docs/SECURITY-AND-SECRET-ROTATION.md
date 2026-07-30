# Security and secret rotation

Posture in [SECURITY.md](./SECURITY.md); rotation procedures in
[ROLLBACK.md](./ROLLBACK.md). This page is the index and the rules that govern
both.

## The seven rules

1. Supabase PostgreSQL is the primary database.
2. Google Sheets is an export destination. Never read from it.
3. n8n reaches the system only through authenticated `/api/*` endpoints. It gets
   no database, Supabase or Meta credentials.
4. Facebook Page tokens are AES-256-GCM ciphertext at rest.
5. A Page token never reaches the browser, Google Sheets, or n8n.
6. Every Meta Graph call happens on the server.
7. Facebook Pages only. Never personal profiles.

Rule 5 is the one to check a change against: if a diff makes a token reachable
from a browser, an export or a log, the diff is wrong regardless of how
convenient it is.

## Where each secret lives

| Secret | Stored in | Reaches browser | Reaches n8n |
| --- | --- | --- | --- |
| Page tokens | Database, encrypted, per streamer | never | never |
| `TOKEN_ENCRYPTION_KEY` | Vercel, server-only | never | never |
| `DATABASE_URL` | Vercel, server-only | never | never |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel, server-only | never | never |
| `META_APP_SECRET` | Vercel, server-only | never | never |
| `ANTHROPIC_API_KEY` | Vercel, server-only | never | never |
| `N8N_API_SECRET` | Vercel + n8n credential | never | **yes, by design** |
| `CRON_SECRET` | Vercel, injected by Vercel Cron | never | never |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel, public | **yes, by design** | never |

`N8N_API_SECRET` and the anon key are the only two that legitimately leave the
server, and both are meant to. Everything else leaving the server is an
incident.

Page tokens are **never** environment variables. One key encrypts many
per-streamer rows, so revoking one streamer never touches another.

## Rotation at a glance

Full procedures in [ROLLBACK.md](./ROLLBACK.md#rotating-secrets).

| Secret | Difficulty | Watch out for |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | trivial | nothing; summaries only |
| `CRON_SECRET` | trivial | Vercel injects it; no second system |
| `N8N_API_SECRET` | easy | two copies — 401s until both match |
| `SUPABASE_SERVICE_ROLE_KEY` | easy | rotate in Supabase first |
| `DATABASE_URL` | moderate | keep the pooler host and port 6543 |
| `META_APP_SECRET` | hard | invalidates every Page token |
| `TOKEN_ENCRYPTION_KEY` | **dangerous** | orphans every stored token |

Every rotation needs a **redeploy**. Setting a variable in Vercel does not
change a running deployment. This is the most common reason a rotation appears
to fail.

### Read this before touching TOKEN_ENCRYPTION_KEY

Rotating it without re-encrypting makes every stored Page token permanently
undecryptable — including the copies inside every database backup. There is no
recovery except re-entering every token by hand.

Rotate it only on actual compromise, and read
[ROLLBACK.md](./ROLLBACK.md#token_encryption_key--the-dangerous-one) first.

## Controls that are verified rather than asserted

Each of these has a test or a live check behind it:

| Control | Evidence |
| --- | --- |
| No secret in the client bundle | `tests/bundle-secrets.test.ts` greps built chunks |
| Tokens redacted from logs | `tests/logger-redaction.test.ts` |
| Exports cannot carry a token | Zod contracts in `export-contract.ts` |
| Machine endpoints require the bearer | Live 401s, [SECURITY.md](./SECURITY.md) |
| Route protection | Three layers: proxy, `requireUser`/`requireAdmin`, `assertAdmin` |
| Security headers | Live header capture, [SECURITY.md](./SECURITY.md) |
| One active sweep | `tests/sync-lock.test.ts` against real Postgres |
| No invisible characters in source | `tests/source-control-characters.test.ts` |

That last one exists because a literal `\x08` inside a regex once disabled a
redaction rule while compiling, linting and typechecking clean — and being
invisible in an editor, in `grep` and in a file reader.

## If a token is exposed

1. Invalidate at Meta first — removing the app's access kills every token for
   that Page. Nothing you do in this system matters until that is done.
2. Overwrite or clear the stored ciphertext (Admin → Replace token).
3. Check where it leaked from. The plaintext exists in exactly one place by
   design, so an appearance anywhere else is a defect in that path, not bad
   luck.

```sql
select count(*) from public.audit_logs where metadata::text like '%EAA%';  -- must be 0
```

Full procedure in [ROLLBACK.md](./ROLLBACK.md#revoke-a-compromised-facebook-page-token).

## Deployment protection

Preview deployments and the team-scoped production hostname sit behind Vercel
Authentication. The production alias does not — the application's own login is
what guards it.

A **Protection Bypass for Automation** is a long-lived secret that defeats SSO
for anyone holding it. Create one only for a specific task and revoke it
immediately afterwards; confirm with:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<preview-url>/   # expect 302
```
