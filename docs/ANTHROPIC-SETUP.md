# Anthropic setup

Comment summarisation is the only AI feature. It reads the comments already
synced for a post or video and produces a short summary with recurring themes
and concerns.

**It is currently off in production.** `ANTHROPIC_API_KEY` is not set on any
Vercel target, and `AI_SUMMARIZATION_ENABLED` is false. Everything else — sync,
insights, exports, the dashboard — works without it.

## Turning it on

1. Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Vercel → **Settings → Environment Variables**:
   - `ANTHROPIC_API_KEY` = the key, **Production** (and Preview if you want it
     there), type *Sensitive*.
   - `AI_SUMMARIZATION_ENABLED` = `true`.
3. **Redeploy.** A running deployment keeps the environment it was built with.
4. Confirm: open any post with comments and use **Regenerate summary**.

The two variables are coupled on purpose. `src/config/env.ts` requires the key
only when the flag is true:

```ts
if (env.AI_SUMMARIZATION_ENABLED && !env.ANTHROPIC_API_KEY) { … }
```

so the app fails loudly at startup with an explicit message rather than at
2am on the first summary attempt. Turning the feature off requires no key.

## Model

`ANTHROPIC_MODEL` selects it; the provider abstraction lives in `src/lib/ai`.
Changing models is an environment variable, not a code change.

## What gets sent

Comment text and the content it belongs to. Nothing else — no Page token, no
database identifier that means anything outside this system, no user account
data.

Comments are public Facebook content, but they are written by real people. Two
consequences worth being deliberate about:

- Comment text leaves your infrastructure for Anthropic's API. That is a data
  flow to declare in whatever privacy notice covers this system.
- `MAX_COMMENTS_PER_CONTENT` bounds how much is sent per item, which caps both
  cost and exposure.

## Why summaries do not regenerate

Summarisation is gated on a deterministic hash of the comment set. Re-running a
sync over unchanged comments produces no new summary and no new API call. That
is the intended behaviour and the main cost control — without it, every
six-hourly sweep would re-summarise everything.

`Regenerate summary` forces one regardless of the hash.

So "the summary did not update" usually means the comments did not change. If
they did change and the summary still did not, check the flag and key first.

## Cost and failure

Cost scales with comments summarised, not with sync frequency, because of the
hash gate. A busy Page with many new comments costs more than a quiet one swept
just as often.

An AI failure is contained: the summary is skipped, the sync run records it,
and posts, insights, videos and exports all complete normally. Comment
summaries are the only thing that degrades.

## Rotating the key

Lowest-risk rotation in the system. Create a new key, set it in Vercel,
redeploy, delete the old one. A wrong key affects summaries only. See
[ROLLBACK.md](./ROLLBACK.md).
