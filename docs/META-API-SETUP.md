# Meta Graph API setup

Facebook **Pages** only. Personal profiles are not supported and will not be —
the data model, the permissions and the insight metrics are all Page concepts.

## The app

| | |
| --- | --- |
| App ID | `META_APP_ID` (not secret; identifies the app) |
| App Secret | `META_APP_SECRET` (secret; server-only) |
| Graph version | `META_GRAPH_API_VERSION`, currently v25.0 |

Every Graph call happens on the server, in `src/lib/meta`. There is no
browser-side Facebook SDK and adding one would defeat the token model entirely.

## Page permissions

Whoever issues the token must be an admin of the Page and grant:

| Permission | Needed for |
| --- | --- |
| `pages_read_engagement` | Posts, videos, reactions, shares |
| `pages_read_user_content` | Comments |
| `read_insights` | Post and video insight metrics |
| `pages_show_list` | Confirming the token belongs to the expected Page |

`read_insights` is the one most often missed. Without it the sync succeeds and
every insight comes back empty, which looks like a bug in this application
rather than a missing grant.

## Getting a Page token

1. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) →
   select the app → **User Token** with the permissions above.
2. `GET /me/accounts` → find the Page → copy its `access_token`. That is a
   **Page** token, which is what this system stores. A User token is not
   interchangeable.
3. Exchange it for a long-lived token — short-lived tokens expire in about an
   hour:

   ```
   GET /oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={app-id}
     &client_secret={app-secret}
     &fb_exchange_token={short-lived-token}
   ```

   A long-lived Page token derived from a long-lived User token does not carry
   an expiry, but it is still revoked by a password change, a permission
   change, or an app-secret reset.

## Registering a streamer

**Admin → Streamers → Add streamer.** Paste the Page token there.

On save the application validates it against Graph, confirms the Page id
matches, records `token_status`, and stores the token as AES-256-GCM ciphertext
in the `v1.<iv>.<tag>.<ciphertext>` envelope.

Never put a Page token in a Vercel environment variable, a `.env` file, an
issue, or a chat message. It belongs in exactly one place: the encrypted column.

## How tokens are protected

- Encrypted at rest with `TOKEN_ENCRYPTION_KEY` (`src/lib/crypto/tokens.ts`).
- Decrypted only inside the server-side Graph client, per request.
- Never sent to the browser, to n8n, or to Google Sheets. The export contracts
  in `src/lib/google-sheets/export-contract.ts` have no field that could carry
  one.
- Masked wherever a token is displayed — last four characters only.
- Scrubbed from logs by `redact()`, which strips anything matching `EAA…`
  regardless of the field it appears in.

If a change would make a token reachable from a browser, an export or a log,
the change is wrong.

## Validation and health

**Admin → Streamers** shows each streamer's `token_status`. Re-check one at any
time with **Validate token**; the roster sweep also updates status as it runs.

Invalid or expired tokens do not stop a sweep. That streamer is recorded as
failed and the rest continue — the run ends `completed_with_errors`, which is
a distinct status precisely so it is not mistaken for success.

## Limitations that are Meta's, not ours

- **Post insights require explicit metrics.** As of v25 an insights call with no
  `metric` parameter returns `code 3001`. Of the fourteen metrics probed during
  development, six are valid for Page posts; the rest error or return nothing.
- **Video permalinks are relative.** Graph returns `/reel/…`; the sync makes
  them absolute before storing, or the export contract rejects them.
- **Rate limits are per app, not per Page.** Two concurrent sweeps do not run
  twice as fast — they degrade each other. Hence the single-sweep lock.
- **Missing is not zero.** Meta omits a metric it will not report. The pipeline
  keeps that distinction all the way to the spreadsheet: an absent metric leaves
  an empty cell, a real zero writes `0`. Conflating them silently corrupts every
  average computed downstream.
- **Insights lag.** Metrics for a very recent post may be absent for hours. An
  empty result on fresh content is usually timing, not failure.

## Rotating the app secret

Resetting `META_APP_SECRET` invalidates outstanding Page tokens, so every
streamer needs a fresh token afterwards. Plan the two together — see
[ROLLBACK.md](./ROLLBACK.md).
