# Security Risks and Controls

Threat analysis for the CBSOFT Streamer Performance Dashboard. Risks are ordered by expected
severity. Each names the phase in which its control ships; **anything marked "Phase 1 ✅" is already
enforced in the code**.

---

## Assets worth protecting

| Asset | Impact if leaked |
|-------|------------------|
| Facebook Page access tokens | An attacker can post as the Page, read private insights, and delete content. This is the highest-value asset in the system. |
| `SUPABASE_SERVICE_ROLE_KEY` | Full read/write on every table, bypassing RLS. |
| `TOKEN_ENCRYPTION_KEY` | Turns a database dump into a set of live Page tokens. |
| `META_APP_SECRET` | Enables token exchange and app-level Graph calls. |
| `N8N_API_SECRET` / `CRON_SECRET` | Lets an attacker trigger syncs and pull all report data. |
| Streamer performance data | Commercially sensitive; also personal to the streamers. |
| Viewer comment text | Third-party personal data, subject to Meta platform terms. |

---

## R1 — Page token exfiltration (Critical)

**Threat.** A token reaches a client bundle, a log line, an API response, a Sheet, or an n8n
execution log. Meta tokens are long-lived and grant real posting authority.

**Controls**

- `src/lib/crypto/tokens.ts` is `server-only`; importing it into a Client Component fails the
  build. ESLint additionally blocks `@/lib/crypto/*`, `@/lib/meta/*` and `@/lib/db/*` from
  non-server files. — *Phase 1 ✅*
- Tokens are stored as AES-256-GCM ciphertext with a versioned envelope. — *Phase 1 ✅*
- `maskToken()` is the only representation permitted to leave the server. — *Phase 1 ✅*
- The Google Sheets export schemas contain no field capable of holding a token, so no workflow edit
  can cause one to be exported. — *Phase 1 ✅*
- `streamers.encrypted_page_token` is denied to `anon` and `authenticated` by **column-level
  grant**, so PostgREST cannot return it even to an admin session, even via `select *`. Only
  `service_role` can read it. — *Phase 2 ✅*
- A check constraint rejects any value not matching the `v<n>.` crypto envelope, so a plaintext
  token written by a future bug is refused by the database. — *Phase 2 ✅*
- Tokens are validated before storage, encrypted with AES-256-GCM, and reduced to ciphertext plus
  a four-character suffix. The plaintext exists only as a function argument. — *Phase 3 ✅*
- Only `••••••••••••ABCD` is ever displayed, built from the stored suffix — the server never
  decrypts a token in order to show one. The `EAAB…` prefix is never revealed. — *Phase 3 ✅*
- `decryptToken()` is called in exactly one file, and `encrypted_page_token` is referenced in only
  two. Both are asserted by `tests/token-containment.test.ts` against the real source tree, so the
  boundary fails on the commit that widens it. — *Phase 3 ✅*
- Graph URLs carry the token in the query string, so `redactUrl()` exists and no URL is ever logged
  raw; a test greps for token-bearing `console.*` calls. — *Phase 3 ✅*
- Structured logging redacts any value matching a token shape. — *Phase 10*

> **Implementation note, worth remembering.** Column-level privileges only work if the role holds
> no table-wide grant for that command. In Postgres `GRANT SELECT ON t TO r` implies every column,
> and a subsequent `REVOKE SELECT (secret) ON t FROM r` has **no effect**. The first version of
> migration 0001 made exactly that mistake; it was caught by
> `tests/migrations.test.ts`. The fix is to revoke all table-level grants first and then
> re-grant column by column. Never issue a table-wide `GRANT SELECT ON streamers`.

**Residual risk.** A future developer writes `select *` on the connections table into an API
response. Mitigated by an explicit column allow-list in the repository layer (Phase 3) and by code
review.

---

## R2 — Service-role key misuse (Critical)

**Threat.** The service-role client bypasses RLS entirely. A single Server Action that filters
by a client-supplied `streamerId` without an ownership check exposes the whole roster.

**Controls**

- Separate modules make the privilege level explicit at the import site: `supabase/server.ts`
  (user session, RLS applies) versus `supabase/admin.ts` (service role, RLS bypassed). — *Phase 1 ✅*
- The service-role client is documented as sync-jobs / token-reads / export-queries only. — *Phase 1 ✅*
- `src/lib/repositories/*` documents that it assumes `assertAdmin()` has already run, and every
  caller does run it. — *Phase 2 ✅*
- Every service-role query re-derives authorisation from the session, never from request
  parameters: `changeUserRoleAction` takes the actor id from `assertAdmin()`, never from the form
  body. — *Phase 2 ✅*
- Vercel env var is Production-scoped and not exposed to Preview deployments. — *operational*

---

## R3 — Encryption key compromise or loss (High)

**Threat.** `TOKEN_ENCRYPTION_KEY` alongside a database backup yields plaintext tokens. Losing the
key bricks every stored connection.

**Controls**

- Key lives only in Vercel environment variables — never in the repository, never in n8n, never in
  a Sheet. `.env.local` is git-ignored. — *Phase 1 ✅*
- Ciphertext carries a `v1.` version prefix so rotation can decrypt-old / encrypt-new. — *Phase 1 ✅*
- Key length is validated at startup, so a truncated key fails loudly instead of producing
  undecryptable records. — *Phase 1 ✅*
- Documented recovery path: if the key is lost, every Page must be reconnected by hand. There is no
  backdoor, and that is the correct design. — *Phase 1 ✅*
- Scheduled rotation runbook. — *Phase 10*

---

## R4 — Unauthenticated or replayed machine calls (High)

**Threat.** `/api/automation/*` and `/api/cron/*` have no user session. If the bearer secret leaks
or the comparison is sloppy, an attacker triggers syncs (burning Meta rate limit and Anthropic
tokens) and pulls all report data.

**Controls**

- Constant-time comparison via `timingSafeEqual`; length mismatch still performs a comparison so
  the fast path does not leak length. — *Phase 1 ✅*
- Separate secrets for n8n and cron, each ≥32 characters and validated at startup. — *Phase 1 ✅*
- Error bodies are terse and identical for a missing and an invalid secret, so a caller learns
  nothing about which. — *Phase 1 ✅, tightened Phase 8*
- Authentication happens **before** the rate-limit check, so an unauthenticated stranger cannot
  consume the real workflow's budget. — *Phase 8 ✅*
- Rate limiting per endpoint class: 10 writes and 120 reads per minute, with `RateLimit-*` headers
  and `Retry-After`. — *Phase 8 ✅*
- Every automation run is recorded in `sync_runs` and in `audit_logs` under
  `automation.sync_started` / `automation.sync_completed`, with a **null** user — n8n is a machine
  actor, and attributing a sweep to a person would corrupt the trail. — *Phase 8 ✅*
- Request bodies are screened and refused if they carry credential material, so a misconfigured
  workflow cannot push a Page token into this application's logs. — *Phase 8 ✅*

**Residual risk.** No replay protection and no idempotency key. A replayed `sync-all` starts a
second sweep: it cannot corrupt data — every write is an upsert keyed on a Meta identifier — but it
spends quota twice. The rate limiter bounds the damage rather than preventing it.

The limiter's counters are **per process**. On a serverless platform the effective ceiling is
`limit × instances`, so it stops a runaway schedule and a retry storm, not a determined attacker.
The security boundary is the secret; the limiter is a blast-radius control. A hard global ceiling
would need a shared store — the `RateLimiter` class is the seam for one.

---

## R5 — Broken access control between roles (High)

**Threat.** A viewer reaches admin functions — managing streamers, reading Page token metadata,
triggering a sync. The sidebar hides links, but hiding a link is not access control: a viewer can
type `/admin/users`, or POST directly to a Server Action.

**Controls**

- Four independent layers, none of them trusted alone: proxy at the edge, `requireAdmin()` in the
  layout, `assertAdmin()` inside every Server Action, and RLS in Postgres. Detailed in
  [`AUTHORIZATION.md`](./AUTHORIZATION.md) §2. — *Phase 2 ✅*
- Sidebar visibility is documented in the component itself as cosmetic. — *Phase 2 ✅*
- Route policy **denies by default**: an unrecognised path requires authentication, so a new page
  is protected before anyone remembers to list it. — *Phase 2 ✅*
- Server Actions derive the actor from `assertAdmin()`, never from the submitted form. — *Phase 2 ✅*
- 89 tests cover the policy and guard matrices, including every viewer-versus-admin-route
  combination and the "authenticated but unprovisioned" case. — *Phase 2 ✅*

**Residual risk.** Proxy runs before the app and only performs an optimistic check; Next's own
guidance is not to treat it as the authorization solution. That is why layers 2–4 exist.

---

## R5a — Privilege escalation through role self-assignment (High)

**Threat.** A viewer promotes themselves, or an admin demotes the only other admin and locks the
workspace out of its own administration.

**Controls**

- New accounts are always provisioned `viewer` by the `on_auth_user_created` trigger. No signup
  path yields admin. — *Phase 2 ✅*
- Nobody may change their own role. Enforced in the transaction **and** in the
  `users_update_admin` policy via `WITH CHECK (is_admin() AND id <> auth.uid())`, so the rule holds
  through the server and through PostgREST. — *Phase 2 ✅*
- The last admin cannot be demoted; the row is locked `FOR UPDATE` so a concurrent demotion cannot
  race past the check. — *Phase 2 ✅*
- Role changes are written to `audit_logs` in the same transaction that applies them — a failed
  audit insert rolls back the role change. — *Phase 2 ✅*
- `audit_logs` is append-only by trigger, so the trail cannot be rewritten even by the service
  role. — *Phase 2 ✅*

---

## R6 — Meta OAuth flow abuse (High)

**Threat.** CSRF on the OAuth callback attaches an attacker's Page to a CBSOFT account, or a
victim's Page to an attacker's account. Over-broad scopes grant more authority than needed.

**Controls**

- Signed, single-use `state` parameter bound to the session; exact redirect-URI allow-list. — *Phase 4*
- Minimum scopes only: `pages_show_list`, `pages_read_engagement`, `read_insights`. No publishing
  scopes are ever requested. — *Phase 4*
- Short-lived tokens are exchanged for long-lived Page tokens server-side; the exchange never
  touches the browser. — *Phase 4*
- Only nodes from the `me/accounts` edge may be persisted, re-validated by
  `isSupportedPageNode()` — this is the enforcement of "Pages only, never personal profiles",
  which is a privacy control as much as a product rule. — *Phase 1 ✅ (guard), Phase 4 (flow)*
- In the Phase 3 manual flow, the same rule is enforced by comparison: `/me` must return the
  entered Page ID. A personal-profile token resolves to a person and can never match, so it is
  refused before anything is written. — *Phase 3 ✅*
- Token validation reads the granted scopes and reports a missing required scope rather than
  silently proceeding with less authority than the sync engine needs. — *Phase 3 ✅*

---

## R7 — Secret leakage through logs, errors and telemetry (Medium-High)

**Threat.** A stack trace, a Vercel log line or an n8n execution log captures a token, a
connection string or a key.

**Controls**

- `decryptToken` swallows the underlying crypto error rather than surfacing it, so failures cannot
  distinguish "wrong key" from "tampered ciphertext". — *Phase 1 ✅*
- Env validation errors list key **names** only, never values. — *Phase 1 ✅*
- `/api/health` reports missing key names, never values. — *Phase 1 ✅*
- The Settings page renders configuration status, never configuration content. — *Phase 1 ✅*
- Redacting logger: every logged field passes through `redact()`, which strips secret-named keys
  and credential-shaped values, and no Graph URL is logged raw. — *Phase 4 ✅*
- **Outbound sanitisation on the automation surface.** A Meta error reaching n8n is reduced to
  `{category, code, subcode, message}` and the message is scrubbed of tokens, ciphertext, JWTs and
  credential query parameters, then length-capped. This matters specifically because a Graph error
  can echo the request that caused it, and a Graph request carries the access token in its query
  string — forwarding one verbatim would put a live credential in an n8n execution log. Verified
  end to end: a database failure returns `{"error":"export_failed"}` with no query text, no
  connection detail and no SQLSTATE. — *Phase 8 ✅*
- Error boundaries never render `error.message`; only `digest`, for log correlation. — *Phase 7 ✅*
- Error-tracking scrubbers. — *Phase 10*

---

## R8 — Google Sheets over-sharing (Medium-High)

**Threat.** Sheets sharing is outside application control. A "anyone with the link" setting exposes
the entire roster's commercial performance.

**Controls**

- Only non-sensitive, business-level columns are exportable by contract. Every column of all seven
  datasets is declared one at a time in `google-sheets/export-contract.ts` — there is no spread and
  no `Object.keys(row)` — so a column added to a table cannot appear in an export by accident. No
  token in any of its three stored forms, no Supabase user id, no commenter identity. Row content
  UUIDs (`post_id`, `summary_id`) *are* exported: they are the upsert keys the Sheets node needs,
  and they identify a post, not a person. — *Phase 1 contract, Phase 8 populated ✅*
- `tests/automation-exports.test.ts` asserts the exact column list of every dataset against a
  duplicated literal, so a rename requires two deliberate edits. — *Phase 8 ✅*
- Rows are validated against the published Zod schema before being sent; a mismatch is a `500`
  rather than a reshaped payload, because Sheets is upsert-oriented and a half-corrupted sheet is
  far more expensive to notice than a failed run. — *Phase 8 ✅*
- `GOOGLE_SHEETS_EXPORT_ENABLED` allows the pipeline to be switched off centrally. — *Phase 1 ✅*
- Operational requirement: the destination spreadsheet is restricted to named CBSOFT accounts, and
  analysis lives in a separate linked spreadsheet. — *documented, [`N8N-AUTOMATION.md`](./N8N-AUTOMATION.md) §9*
- The `sync-logs` dataset gives an audit trail of what left the system and when. — *Phase 8 ✅*

**Residual risk.** Sharing is outside application control, and the comment-summary dataset carries
AI-written prose about third-party comments. It carries no commenter identity — none is collected —
but a summary can still quote a distinctive complaint. The prompt instructs the model never to
expose a personal name; the sheet's access list is the remaining control.

---

## R9 — SQL injection and unsafe query construction (Medium)

**Threat.** Report filters (period, streamer, sort column) are user input reaching the database.

**Controls**

- Drizzle parameterises by default; raw SQL requires the explicit `sql` template, and every value
  inside one is a bound parameter. — *Phase 1 ✅*
- All API and Server Action input is parsed by Zod before use. — *Phase 3+ ✅*
- Sort keys are resolved against a per-table allow-list and then mapped through a
  `Record<SortKey, Column>` to a Drizzle column object. An unrecognised string cannot index into
  the map, so no query-string text ever becomes SQL. `tests/filters.test.ts` fires
  `encrypted_page_token`, `createdTime; drop table posts` and `(select 1)` at the resolver and
  asserts each falls back to the default. — *Phase 7 ✅*
- The automation exports accept no sort parameter at all — their ordering is fixed by the contract,
  because a stable order is what makes pagination safe. — *Phase 8 ✅*

---

## R10 — Dependency and supply-chain risk (Medium)

**Threat.** A compromised transitive package exfiltrates environment variables at build or runtime.

**Controls**

- `package-lock.json` is committed, so builds are reproducible. — *Phase 1 ✅*
- Minimal runtime dependency set; shadcn/ui components are vendored into the repo rather than
  pulled from a runtime package. — *Phase 1 ✅*
- Dependabot / `npm audit` in CI, and pinned Node version. — *Phase 10*

---

## R11 — Session and cookie handling (Medium)

**Threat.** Session fixation, XSS-driven token theft, or CSRF on state-changing routes.

**Controls**

- Supabase Auth cookies are `httpOnly`, `secure`, `sameSite=lax` via `@supabase/ssr`; the
  application never handles them directly. — *Phase 2 ✅*
- Every authorization decision calls `getUser()`, which revalidates the JWT with the Auth server,
  rather than `getSession()`, which merely decodes the cookie. — *Phase 2 ✅*
- Sign-out is a POST through a Server Action, not a GET link, so a third-party page cannot destroy
  a session by embedding an image. — *Phase 2 ✅*
- Server Actions carry framework CSRF protection; machine endpoints use bearer auth, not cookies,
  so they are not CSRF-reachable. — *Phase 2 ✅*
- Content Security Policy and security headers. — *Phase 10*

---

## R12 — Meta rate limiting and data integrity (Medium)

**Threat.** Aggressive syncing gets the app throttled or temporarily banned, leaving gaps that look
like real performance drops.

**Controls**

- Sync runs are recorded with per-Page outcomes so gaps are visible as failures, not as zeros. — *Phase 5*
- Exponential backoff, request budgeting, and snapshot-based storage so a failed run never
  overwrites good data with nulls. — *Phase 5*

---

## R13 — Comment data and privacy (Medium)

**Threat.** Viewer comments are third-party personal data. Sending them to an AI provider and
storing them indefinitely creates obligations under Meta platform terms and privacy law.

**Controls**

- Comments are stored with the minimum author identifier needed, and are excluded from Sheets
  exports by contract. — *Phase 1 ✅ (export contract), Phase 7 (storage)*
- Only aggregate summaries — not raw comment text — are surfaced in reports. — *Phase 7*
- Retention window with automatic deletion. — *Phase 7*

---

## R14 — Credential attacks on the login form (Medium)

**Threat.** Password spraying or brute force against `/login`, or enumeration of which addresses
have accounts.

**Controls**

- Uniform failure message — "Invalid email or password" — whatever actually went wrong, so the form
  is not an account-enumeration oracle. — *Phase 2 ✅*
- Failed attempts are written to `audit_logs` as `user.sign_in_failed` with the attempted address
  and never the password, so an attack is visible after the fact. — *Phase 2 ✅*
- Supabase Auth applies its own platform-level rate limiting. — *Phase 2, external*
- Application-level rate limiting per IP and per address, and MFA. — *Phase 10*

**Residual risk.** Nothing in the application throttles sign-in attempts yet. Supabase's own limits
are the only brake. Close this in Phase 10.

---

## R15 — Open redirect via the post-login bounce (Low)

**Threat.** `/login?next=https://evil.example.com` turns the trusted login page into a redirector,
useful for phishing.

**Controls**

- `sanitiseNextPath` accepts same-origin absolute paths only, rejecting protocol-relative `//host`,
  absolute URLs, `/\host` and anything containing `://`. — *Phase 2 ✅*
- Applied twice: when the page echoes the value into the form, and again in the Server Action
  before redirecting. — *Phase 2 ✅*
- Covered by tests. — *Phase 2 ✅*

---

## Current posture — end of Phase 10

**Added in Phase 10** — a nonce-based Content-Security-Policy with `strict-dynamic`, applied from
`src/proxy.ts` to every response including redirects and 401s, alongside HSTS, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`; two-budget login throttling
(per email address and per client address, both SHA-256 hashed before use as a map key) that
refuses an attempt *before* it reaches Supabase; a scheduled sweep at `/api/cron/daily-sync` with
its own machine secret, an overlap guard and a frequency gap; six operational ceilings promoted to
validated environment variables; and an AI kill switch that short-circuits summarisation without
failing a sync.

**Verified, not merely asserted.** 713 tests across 25 files, including the real migrations applied
to a real Postgres via PGlite, and a bundle scan that reads the bytes Next actually emitted into
`.next/static` and fails on any server env key by name or value, any `EAA…` Meta token, any
ciphertext envelope, any Postgres URL, and any Supabase hostname at all. The last of those is a
positive finding rather than an absence: the browser never calls Supabase, which is what lets
`connect-src` stay at `'self'` in production.

**Known gaps, still open and deliberately so:**

| Gap | Risk | Why it is still open |
|-----|------|----------------------|
| No MFA | R14 | Not in the Phase 10 scope. Login throttling raises the cost of a brute-force attempt by orders of magnitude but is not a substitute. Supabase Auth supports TOTP enrolment when this is wanted. |
| No password reset flow in the application | — | Reset is performed from the Supabase dashboard. A self-service flow needs an email sender configured first. |
| No replay protection or idempotency key on the automation endpoints | R4 | A replayed export is a read and harmless; a replayed sync is absorbed by the in-flight guard and by upsert idempotence, so the practical exposure is low. A true idempotency key needs a shared store. |
| Rate-limit and throttle counters are per process, not global | R4, R14 | On a serverless platform the effective ceiling is `limit × instances`. Needs Redis or equivalent; see R4. |
| Leaked-password protection disabled | R14 | A dashboard setting, not a migration. See the advisory table below. |

---

## Historical posture — end of Phase 2

**Enforced in code and verified by tests:**

*From Phase 1* — `server-only` boundaries around tokens, Graph and database access; ESLint import
restrictions; AES-256-GCM token encryption with a versioned envelope and validated key length;
constant-time bearer auth with two separate machine secrets; export schemas that structurally
cannot carry a secret; env validation that reports key names and never values; no Facebook SDK and
no Google credential anywhere in the codebase.

*Added in Phase 2* — Supabase Auth with revalidated sessions; four-layer authorization with
deny-by-default routing; RLS on all four tables; column-level denial of the Page token to every
client role; self-promotion and last-admin-demotion blocked in both the transaction and the RLS
policy; append-only audit trail enforced by trigger; open-redirect protection on the login bounce;
uniform sign-in failure messaging. 89 tests, including the real migrations applied to a real
Postgres.

**The Phase 1 deployment restriction is lifted.** Authentication and role enforcement now exist, so
the application may be deployed with real credentials.

**Known gaps, deliberately deferred:**

| Gap | Risk | Closes in |
|-----|------|-----------|
| No application-level login rate limiting | R14 | Phase 10 |
| No MFA | R14 | Phase 10 |
| No password reset flow (use the Supabase dashboard) | — | Phase 9 |
| No CSP or security headers | R11 | Phase 10 |
| No replay protection or idempotency key on the automation endpoints | R4 | Phase 10 |
| Rate-limit counters are per process, not global | R4 | Needs a shared store; see R4 |

---

## Live database advisory status

Supabase's database linter, re-run against project `okwphbplckrxwveqqqrl` at the end of Phase 10
with all 13 migrations applied: **0 errors, 2 warnings** — the same two, unchanged. Phases 3–10
introduced no new advisory.

| Warning | Disposition |
|---------|-------------|
| `is_admin()` executable by `authenticated` via `/rest/v1/rpc/is_admin` | **Accepted.** The RLS policies call it, and a policy is evaluated as the querying role, so revoking the grant would break every admin policy. It returns a single boolean about the caller's own role and discloses nothing else. `anon` has been revoked. |
| Leaked-password protection disabled | **Open — needs a dashboard change.** Enable at Authentication → Policies → Password Protection so Supabase checks new passwords against HaveIBeenPwned. Cannot be set from SQL or a migration. |

Migration `0002_phase2_hardening.sql` closed four warnings that migration 0001 had introduced:
mutable `search_path` on `set_updated_at` and `reject_audit_log_mutation`, and RPC-exposure of
`handle_new_auth_user`, `set_updated_at` and `reject_audit_log_mutation`.

> **Worth remembering.** `REVOKE ... FROM PUBLIC` does not remove a role's access to a function in
> Supabase: `anon` and `authenticated` hold their own explicit `EXECUTE` grants from Supabase's
> default privileges, so they must be named directly in the `REVOKE`. This is the same class of
> mistake as the table-versus-column grant issue in R1.
