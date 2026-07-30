# Authentication and Authorization

How a request proves who it is, and how the system decides what it may do. Implemented in Phase 2.

---

## 1. Roles

Two, and only two.

| Role | Can |
|------|-----|
| **Admin** | Everything: manage streamers, manage Page tokens, trigger synchronisation, view sync errors, manage users and settings, read the audit log. |
| **Viewer** | View dashboards and reports, see the streamer roster. Cannot manage streamers or tokens, cannot trigger administrative actions. |

Defined once in [`src/lib/auth/roles.ts`](../src/lib/auth/roles.ts) as a permission matrix rather
than as scattered `role === "admin"` comparisons. A capability absent from `ROLE_PERMISSIONS` is
denied to everyone, so a half-finished feature fails closed.

**Every new account is a viewer.** The `on_auth_user_created` database trigger inserts the profile
with `role = 'viewer'`. There is no signup path that yields administrative access.

---

## 2. The four layers

Authorization is checked four times, in four different places, on purpose. Each layer can be
defeated by a different kind of mistake, and no single one of them is trusted.

```
  request
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. src/proxy.ts        — optimistic gate at the edge        │
│    Refreshes the session cookie, redirects the obvious      │
│    cases. Bypassable by a matcher change, so never final.   │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. requireUser() / requireAdmin()  — in layout or page      │
│    Runs during render. Cannot be bypassed by a rewrite.     │
│    (app)/layout.tsx and (app)/admin/layout.tsx both call it.│
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. assertAdmin()       — first line of every Server Action  │
│    Server Actions are ordinary POST endpoints. Anyone who   │
│    can reach the app can invoke one directly, so the check  │
│    has to be inside the action, not in the component that   │
│    renders the button.                                      │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Row Level Security + column grants  — in Postgres        │
│    Protects the PostgREST surface, which the browser can    │
│    reach directly with the anon key and a valid session.    │
└─────────────────────────────────────────────────────────────┘
```

The sidebar also filters links by permission. **That is not a layer.** It is presentation, and it
is documented as such in `src/components/layout/sidebar-nav.tsx`.

---

## 3. Sessions and cookies

Supabase Auth issues an `httpOnly`, `secure`, `sameSite=lax` cookie pair, handled by
`@supabase/ssr`. The application never reads or writes those cookies by hand.

Two details that matter:

**`getUser()`, never `getSession()`.** `getSession()` decodes whatever is in the cookie and trusts
it. `getUser()` revalidates the JWT against the Auth server. Every authorization decision in this
codebase uses `getUser()` — in `src/lib/auth/session.ts` and in `src/lib/supabase/middleware.ts`.

**Refreshed cookies must reach the browser.** `readSessionFromRequest` rebuilds the `NextResponse`
whenever Supabase rotates the token, and `proxy.ts` returns that response — including on the
redirect path, where the refreshed cookies are copied across. Dropping them silently signs users
out mid-session.

`getSession()` in `src/lib/auth/session.ts` is wrapped in `React.cache`, so several guards in one
render share a single Auth round trip.

---

## 4. Route policy

[`src/lib/auth/route-policy.ts`](../src/lib/auth/route-policy.ts) is a pure module with no
framework imports, so the whole policy is unit-testable.

| Access | Routes |
|--------|--------|
| `machine` | `/api/n8n/*`, `/api/cron/*` — bearer secret, session layer skipped entirely |
| `public` | `/`, `/login`, `/auth/*`, `/unauthorized`, `/api/health` |
| `admin` | `/admin/*` |
| `authenticated` | `/dashboard`, `/posts`, `/videos`, `/comment-analysis`, `/streamers`, `/reports`, `/settings`, `/api/posts/*`, `/api/export/*`, **and everything else** |

**Deny by default.** `resolveRouteAccess` returns `authenticated` for any path it does not
recognise, so a new page is protected the moment it exists. Opening a route requires consciously
adding it to the public list. The opposite default is how routes get accidentally exposed.

`/unauthorized` is public so a signed-out visitor sees the page instead of bouncing between it and
`/login`. It reveals nothing beyond the viewer's own role.

---

## 5. Open redirect protection

After a bounce to `/login?next=…`, the `next` value is attacker-controlled. `sanitiseNextPath`
accepts same-origin absolute paths only, and rejects `//evil.example.com` (protocol-relative),
`https://…`, `/\evil…` and anything containing `://`. It is applied twice: when the login page
echoes the value into the form, and again in the Server Action before redirecting.

---

## 6. Guard reference

| Function | Use in | On failure |
|----------|--------|-----------|
| `requireUser()` | page / layout | redirect `/login` or `/unauthorized` |
| `requireRole(role)` | page / layout | redirect `/unauthorized` |
| `requireAdmin()` | page / layout | redirect `/unauthorized` |
| `requirePermission(p)` | page / layout | redirect `/unauthorized` |
| `assertUser()` | Server Action | throws `AuthorizationError` |
| `assertAdmin()` | Server Action | throws `AuthorizationError` |
| `assertPermission(p)` | Server Action | throws `AuthorizationError` |
| `requireApiAdmin()` | Route Handler | `401` / `403` JSON |
| `requireApiPermission(p)` | Route Handler | `401` / `403` JSON |

`requireApiPermission` exists for the CSV exports, which serve viewers as well as admins. They
authorise on a capability (`posts.view`, `videos.view`, `analysis.view`) rather than on a role, and
`can()` reads the same matrix as every page guard — so a capability nobody was granted is still
denied.

> **Viewer-facing screens and token material.** A viewer may open `/streamers` and
> `/streamers/{id}`, so those pages read through `listStreamerOptions` and `getStreamerIdentity`,
> whose select lists contain no token column at all. The roster's token-health column is rendered
> only when `isAdmin(user.role)`, and the Settings tab calls the token-bearing `getStreamerById`
> **inside** its admin-only branch — a viewer's request never reaches that query. See
> [`INTERFACE.md`](./INTERFACE.md) §4.

Pages redirect so the user lands somewhere sensible. Mutations throw, because a write that quietly
redirects can leave a half-finished operation.

**Failing closed.** A session that is valid in Supabase Auth but has no row in `public.users` is
treated as unauthorised, not as a default viewer. That is the `no_profile` case, and it is covered
by tests in both `route-policy.test.ts` and `guards.test.ts`.

---

## 7. Role changes and the audit trail

`changeUserRole` in `src/lib/repositories/users.ts` applies the change and writes the
`user.role_changed` audit entry **in one transaction**. If the audit insert fails, the role change
rolls back with it — an unlogged privilege change is worse than a failed one.

Two rules are enforced in the transaction, not in the UI:

1. **Nobody changes their own role.** Blocks self-promotion, and mirrors the
   `WITH CHECK (… AND id <> auth.uid())` clause on the `users_update_admin` policy, so the rule
   holds whether the request arrives through the server or through PostgREST.
2. **The last admin cannot be demoted.** The target row is locked `FOR UPDATE` first, so a
   concurrent demotion cannot race past the check and leave the workspace with zero admins,
   recoverable only by re-running the seed script against production.

---

## 8. Creating the first administrator

The seed script is the root of trust for the workspace. Run it once, against each environment.

```bash
npm run seed:admin -- --email you@cbsoft.example --name "Your Name"
```

It requires `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` in
`.env.local`, and it:

1. Creates the Supabase Auth user if the email is new, with a generated password and the email
   pre-confirmed — or finds the existing account and leaves its password alone.
2. Ensures the `public.users` profile exists.
3. Promotes it to `admin` and writes a `user.role_changed` audit entry, in one transaction.

The generated password is printed **once** and is stored nowhere. Change it after first sign-in.
Pass `--password` to choose your own instead.

Every subsequent admin is promoted through **Admin → Users** by an existing admin, which is
audited.

---

## 9. What Phase 2 does not do

- **No self-service signup.** Accounts are created by an admin or by the seed script. A public
  signup route would need its own rate limiting and email verification policy.
- **No password reset flow.** Use the Supabase dashboard until it is built.
- **No MFA.** Supabase supports it; wiring it is Phase 10 hardening.
- **No rate limiting on the login form.** Sign-in failures are audited, so the attempts are
  visible, but nothing throttles them yet. Tracked as R14 in [`SECURITY.md`](./SECURITY.md).
