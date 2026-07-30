<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# CBSOFT Streamer Performance Dashboard

Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) before changing anything structural.

## Rules that must never be broken

1. Supabase PostgreSQL is the primary database.
2. Google Sheets is an export destination. Never read from it. Never add a Sheets client dependency
   to this project — that is n8n's job.
3. n8n reaches the system only through authenticated `/api/n8n/*` endpoints. It gets no database,
   Supabase or Meta credentials.
4. Facebook Page tokens are stored as AES-256-GCM ciphertext, via `src/lib/crypto/tokens.ts`.
5. A Page token never reaches the browser, Google Sheets, or n8n. If a change makes a token
   reachable from any of those, the change is wrong.
6. Every Meta Graph call happens on the server. Never add a browser-side Facebook SDK.
7. Facebook Pages only. Never add support for personal profiles.

## Authorization (Phase 2)

- Two roles only: `admin` and `viewer`. Defined in `src/lib/auth/roles.ts`.
- Every new capability goes in `PERMISSIONS` and is granted explicitly. Unlisted means denied.
- Route protection is layered and all three layers are required:
  1. `src/proxy.ts` — optimistic gate at the edge (Next 16 renamed `middleware` to `proxy`).
  2. `requireUser()` / `requireAdmin()` in the page or layout.
  3. `assertAdmin()` inside every Server Action, before any mutation.
- Never authorise from a prop, a header, a search param or a hidden form field. Only from
  `getSession()`.
- `resolveRouteAccess` denies by default. Do not add a route to `PUBLIC_ROUTES` without a reason.
- Role changes must be written to `audit_logs` in the same transaction that applies them.

## Conventions

- `src/lib/{crypto,meta,db,security,ai,google-sheets}` and `src/config/env.ts` import
  `server-only`. Do not remove that import to "fix" a build error — the error means a Client
  Component is reaching for a secret.
- The only browser-visible env values live in `src/config/public-env.ts`. Nothing else.
- Anything leaving the server toward n8n or Sheets must be described by a Zod schema in
  `src/lib/google-sheets/export-contract.ts` first.
- No mock or seeded data in application code. Placeholder screens say they are placeholders.
- A Drizzle migration ships in the same phase as the code that reads and writes it.

## Verification

```bash
npm run verify
```

Runs `typecheck` → `lint` → `build`. All three must pass before a phase is considered done.
