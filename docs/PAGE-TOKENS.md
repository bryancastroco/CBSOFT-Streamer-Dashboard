# Facebook Page Tokens

How a Page access token enters the system, where it is allowed to travel, and how its health is
judged. Implemented in Phase 3.

---

## 1. Lifecycle

```
  admin pastes token
          │
          ▼
  ┌───────────────────────────────────────────────┐
  │ 1. VALIDATE (before anything is written)      │
  │    GET /{version}/me?fields=id,name           │  ← does it authenticate?
  │    GET /debug_token                           │  ← expiry and scopes
  │    Page ID must equal the entered Page ID     │
  └───────────────────────────────────────────────┘
          │
          ▼  status = invalid → REFUSED, nothing stored
          │
  ┌───────────────────────────────────────────────┐
  │ 2. ENCRYPT — AES-256-GCM, TOKEN_ENCRYPTION_KEY│
  │    v1.<iv>.<authTag>.<ciphertext>             │
  └───────────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────────┐
  │ 3. STORE                                      │
  │    encrypted_page_token   ← ciphertext        │
  │    page_token_last_four   ← last 4 chars      │
  │    token_status           ← health verdict    │
  │    plaintext DISCARDED                        │
  └───────────────────────────────────────────────┘
```

The plaintext exists only as a function argument, for the duration of one request. It is never
written to disk, never returned in a response, never logged, and never re-displayed.

---

## 2. Where a token may travel

| Destination | Allowed | Enforced by |
|---|---|---|
| Meta Graph API, server-side | ✅ | `src/lib/meta/graph.ts` (`server-only`) |
| `streamers.encrypted_page_token` as ciphertext | ✅ | AES-256-GCM + a check constraint requiring the `v<n>.` envelope |
| Browser | ❌ | Column-level `REVOKE`; `StreamerView` has no field for it; `server-only` |
| API responses | ❌ | Every route returns `StreamerView` |
| Logs | ❌ | `redactUrl()`; a test greps for token-bearing `console.*` calls |
| Google Sheets / n8n | ❌ | Export schemas have no field capable of holding one |
| Audit log | ❌ | Only `lastFour` and a status are recorded |

### The containment tests

`tests/token-containment.test.ts` reads the source tree and asserts:

- `encrypted_page_token` is referenced **only** in `schema.ts` and `repositories/streamers.ts`
- `decryptToken()` is called in **exactly one** file
- no `"use client"` file imports crypto, Graph, repository, db or env modules
- every secret-touching module imports `server-only`
- no `console.*` call mentions a token

These fail on the commit that widens the boundary, not whenever someone next thinks to check.

---

## 3. Validation

Two Graph calls, per the Phase 3 specification.

```
GET https://graph.facebook.com/{META_GRAPH_API_VERSION}/me
    ?fields=id,name
    &access_token={PAGE_ACCESS_TOKEN}
```

Proves the token authenticates and identifies the node it belongs to. **The returned `id` must
equal the entered Page ID.** This single comparison is also what keeps personal profiles out: a
user token resolves to a person here, which can never match a Page ID.

```
GET https://graph.facebook.com/debug_token
    ?input_token={PAGE_ACCESS_TOKEN}
    &access_token={META_APP_ID}|{META_APP_SECRET}
```

Reveals `expires_at`, `is_valid` and the granted `scopes` — none of which `/me` exposes. Note the
two token parameters are different things: the one being inspected goes in `input_token`, the app's
own credential in `access_token`. They are assembled inside `debugToken()` so a caller cannot swap
them.

The second call is skipped when the first has already disqualified the token.

### Permissions

| Scope | Requirement | Why |
|---|---|---|
| `pages_show_list` | **Required** | Enumerate the Page |
| `pages_read_engagement` | **Required** | Reactions, comments, shares |
| `read_insights` | **Required** | Reach, impressions, watch time |
| `pages_read_user_content` | Recommended | Comment ingestion (Phase 7) |

A missing **required** scope yields `missing_permission`. Missing recommended scopes are reported
in the message but do not fail the token — the specification lists these as permissions that "may
include", and refusing a token for a scope no current phase uses would be wrong.

**This table may not name a scope the connect flow does not request.** It used to list
`pages_manage_metadata`, for webhook subscriptions that were never built, and nothing asked for it
— so every connected Page showed a permission marked unsatisfied that no streamer could grant,
because it never reaches the consent dialog. Asking would also contradict the read-only promise the
connect page makes to an outside streamer, `manage` being a write permission. `tests/token-scopes
.test.ts` fails if `EXPECTED_SCOPES` and `CONNECT_SCOPES` diverge again.

---

## 4. Statuses

| Status | Meaning | Needs action |
|---|---|---|
| `valid` | Authenticates, matches the Page, all required scopes, not near expiry | — |
| `expiring` | Valid, but expires within 7 days | Replace soon |
| `expired` | Meta reports it expired, or `expires_at` has passed | **Yes** |
| `invalid` | Meta rejected it, or it belongs to a different Page | **Yes** |
| `missing_permission` | Works, but a required scope is absent | **Yes** |
| `unknown` | Could not be determined — network failure, or `debug_token` unavailable | Investigate |
| `missing` | No token has ever been stored | Add one |

`missing` is retained from Phase 2 and is **not** a health verdict — it is the "no token" state that
`streamers_token_consistency_check` keys on. It is unrelated to `missing_permission`.

### Precedence

The order in `deriveTokenStatus()` is deliberate:

1. **Unreachable** → `unknown`. Nothing else can be known.
2. **Failed to authenticate** → `expired` (OAuth subcodes 460/463/464/467) or `invalid`.
3. **Page ID mismatch** → `invalid`. Checked before scopes: the wrong Page's scopes are irrelevant.
4. **Expired** → beats `missing_permission`. An expired token's scope list is moot.
5. **Missing required scope** → `missing_permission`. Beats `expiring`; a token that cannot do the
   job is a bigger problem than one that will stop working next week.
6. **Near expiry** → `expiring`.
7. Otherwise → `valid`.

### `unknown` when the token works

If `/me` succeeds and the Page matches but `debug_token` fails, the result is `unknown`, not
`invalid`. The token demonstrably works — we simply cannot see its scopes. In practice this almost
always means `META_APP_ID` / `META_APP_SECRET` are unset, and the message says so.

---

## 5. Display

Only ever `••••••••••••ABCD` — twelve bullets and the last four characters.

`maskFromLastFour()` builds this from the **stored suffix**, not from a token. At render time the
server holds only `page_token_last_four`; it never decrypts a token in order to display one, so
there is no code path where a plaintext exists purely to be masked.

The first four characters are deliberately never shown — the `EAAB…` prefix identifies the app and
is the more sensitive half.

---

## 6. Audit trail

| Action | When |
|---|---|
| `token.added` | First token stored for a streamer |
| `token.replaced` | An existing token overwritten — records both old and new `lastFour` |
| `token.validated` | Re-check run, recording previous and new status |

Metadata carries the four-character suffix, the status and the missing scopes. Never a token, never
ciphertext. `audit_logs` is append-only by database trigger, so these entries cannot be rewritten.

---

## 7. Operations

**Rotating a token.** Admin → Streamers → *(streamer)* → Replace token. The new token is validated
before the old one is overwritten; a token for a different Page is refused with a message naming
both Page IDs. The old token is not recoverable.

**Rotating `TOKEN_ENCRYPTION_KEY`.** Every stored token must be re-encrypted. The `v1.` envelope
prefix exists for exactly this: a future version can decrypt-old / encrypt-new. There is no
shortcut — if the key is lost, every Page must be reconnected by hand.

**Deleting a streamer.** Soft delete clears the token outright rather than retaining a live
credential for a record no longer in the roster. The row and its sync history are kept.
