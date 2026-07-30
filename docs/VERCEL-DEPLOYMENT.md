# Vercel deployment

## The project as configured

| Setting | Value |
| --- | --- |
| Project | `cbsoft-streamer-dashboard` (`prj_fnf0f17PKUReuX4Zp1yHIKiaYGEg`) |
| Team | `combo-inter-active` (`team_kwdTlg9433LkSBg53jbMXjPJ`) |
| Repository | `bryancastroco/CBSOFT-Streamer-Dashboard` |
| Framework | Next.js (auto-detected) |
| Root directory | repository root |
| Package manager | npm |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Node.js | 24.x |
| Production alias | `cbsoft-streamer-dashboard.vercel.app` |
| Deployment Protection | Vercel Authentication, `all_except_custom_domains` |

`npm ci` rather than `npm install` is deliberate: it installs exactly what
`package-lock.json` pins and fails if the lockfile and manifest disagree,
rather than quietly resolving something new during a production build.

## A branch mismatch you should fix

The project's **production branch is `preview`**, while all development happens
on `main`. That is inverted, and it has one real consequence: a push to the
`preview` branch deploys to production, and a push to `main` produces a preview.

The Vercel REST API rejects changing this field, so it has to be done in the
dashboard: **Settings → Git → Production Branch → `main`**. GitHub's default
branch should move to `main` at the same time.

Until then, production deployments are created explicitly against `main` rather
than by pushing (see below), which works but is easy to forget.

## Deploying

### Explicit production deployment from `main`

This is what the current production deployment used. It targets production
regardless of which branch Vercel considers production:

```bash
curl -s -X POST -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" \
  "https://api.vercel.com/v13/deployments?teamId=team_kwdTlg9433LkSBg53jbMXjPJ&skipAutoDetectionConfirmation=1" \
  -d '{"name":"cbsoft-streamer-dashboard","project":"prj_fnf0f17PKUReuX4Zp1yHIKiaYGEg","target":"production","gitSource":{"type":"github","repoId":1317159078,"ref":"main"}}'
```

Or with the CLI, from a clean checkout:

```bash
npx vercel --prod --token $VERCEL_TOKEN --scope combo-inter-active
```

### Preview deployments

Pushing any branch produces a preview build. Previews are behind Vercel
Authentication, so an unauthenticated request returns `302` to
`vercel.com/sso-api` — see [PRODUCTION-TROUBLESHOOTING.md](./PRODUCTION-TROUBLESHOOTING.md)
for how to reach one from a script, and revoke any bypass afterwards.

## Environment variables

Set under **Settings → Environment Variables**, per target. Values are never
printed by this project's tooling and should not be pasted into issues or
chats.

| Variable | Production | Preview | Browser-visible |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | ✅ | no |
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | ✅ | **yes** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | ✅ | **yes** |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | ✅ | no |
| `TOKEN_ENCRYPTION_KEY` | ✅ | ✅ | no |
| `META_APP_ID` | ✅ | ✅ | no |
| `META_APP_SECRET` | ✅ | ✅ | no |
| `META_GRAPH_API_VERSION` | ✅ | ✅ | no |
| `N8N_API_SECRET` | ✅ | ✅ | no |
| `CRON_SECRET` | ✅ | ✅ | no |
| `ANTHROPIC_API_KEY` | required only when AI is on | — | no |
| `AI_SUMMARIZATION_ENABLED` | ✅ | ✅ | no |
| `NEXT_PUBLIC_APP_NAME` | ✅ | ✅ | **yes** |
| `NEXT_PUBLIC_APP_URL` | optional | optional | **yes** |
| `SYNC_FREQUENCY_HOURS` | ✅ | ✅ | no |
| `MAX_STREAMERS_PER_SYNC` | ✅ | ✅ | no |
| `MAX_POSTS_PER_STREAMER` | ✅ | ✅ | no |
| `MAX_VIDEOS_PER_STREAMER` | ✅ | ✅ | no |
| `MAX_COMMENTS_PER_CONTENT` | ✅ | ✅ | no |
| `CONTENT_SYNC_LOOKBACK_DAYS` | ✅ | ✅ | no |
| `GOOGLE_SHEETS_EXPORT_ENABLED` | ✅ | ✅ | no |

Only the four `NEXT_PUBLIC_*` values reach the browser. Everything else is
server-only, enforced by the `server-only` import in `src/lib/**` and by
`tests/bundle-secrets.test.ts`, which greps the built client chunks.

**Individual Facebook Page tokens are never Vercel environment variables.**
They are per-streamer database rows, encrypted with `TOKEN_ENCRYPTION_KEY`.

### Changing a variable requires a redeploy

A running deployment keeps the environment it was built with. Setting a
variable in the dashboard changes nothing until you rebuild. This is the single
most common cause of "I rotated the secret and it still fails".

## Cron

`vercel.json` schedules `/api/cron/daily-sync`. **The Hobby plan only permits
daily crons** — a finer schedule is rejected when the deployment is *created*,
before any build record exists, so the failure shows up as a deployment that
never appears rather than one that fails.

Vercel Cron is a fallback. n8n remains the primary scheduler at six-hourly
intervals; both are safe to run together because the database enforces a single
active roster sweep.

## Verifying a deployment

```bash
curl -s https://cbsoft-streamer-dashboard.vercel.app/api/health
```

Expect `status: ok`, the right `environment`, and `database.reachable: true`.
Then confirm the security posture is live:

```bash
curl -s -o /dev/null -D - https://cbsoft-streamer-dashboard.vercel.app/login \
  | grep -iE "content-security-policy|strict-transport|x-frame|referrer-policy"
```

And that the machine endpoints still refuse anonymous callers:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://cbsoft-streamer-dashboard.vercel.app/api/automation/exports/posts   # 401
```
