# Comment Collection and AI Analysis

How comments are gathered, what is deliberately not gathered, and when the AI is
allowed to cost money. Implemented in Phase 5 for posts; Phase 6 generalised the
same pipeline to videos.

> **One pipeline, two content types.** Phase 6 did not add a second comment
> implementation. Every function below takes a `ContentRef` — `{ type: "post" |
> "video", id }` — so pagination, deduplication, both hashes, the privacy rules
> and the summarisation gate are single implementations shared by posts and
> videos. That is deliberate: a parallel video implementation is exactly how a
> rule like "never request commenter identity" drifts out of sync between two
> code paths that nobody diffs.

---

## 1. Commenter identity is never collected

The Graph request asks for exactly five fields:

```
GET /{content-id}/comments?fields=id,message,created_time,like_count,comment_count
```

There is **no `from` field**. Meta returns author information only when asked
for, so not asking is the enforcement — there is no name to discard later, no
author column to accidentally populate, and nothing to redact.

Four independent checks hold the line:

| Layer | Guarantee |
|---|---|
| Request | `COMMENT_FIELDS` is a frozen constant; a test asserts its exact contents and that it contains no identity field |
| Schema | `comments` has no author column, and no `raw_json` column that could carry one in unparsed |
| Migration test | Asserts the live column list against an explicit allow-list |
| Prompt | Instructs the model never to expose a personal name — covering names written *inside* comment text, the only way one can reach it |

The UI shows the analysis, never the comments. Rendering third-party comment
text on screen adds nothing analytically and widens the exposure surface.

---

## 2. The two hashes

| Hash | Column | Question it answers |
|---|---|---|
| `commentContentHash` | `comments.content_hash` | Did **this comment** change? |
| `commentSourceHash` | `comment_summaries.source_hash` | Did **the comment set** change? |

Both cover only the comment id and message text. `like_count` and `reply_count`
drift constantly on a live post and say nothing about what was *said* —
including them would invalidate every summary on every sync for no analytical
gain.

The source hash sorts by comment id before hashing, so it depends on the content
of the set and not on the order Meta happened to paginate it in. Without the
sort, pagination reordering alone would look like a change and re-trigger the
model. An empty set hashes to the sentinel `empty`, so "no comments" is
distinguishable from "not yet computed".

---

## 3. When the AI is called

Exactly three conditions, all in `shouldRegenerateSummary()`:

| Condition | Reason recorded |
|---|---|
| No summary exists yet | `no_summary` |
| The source hash differs from the stored one | `comments_changed` |
| An admin pressed **Regenerate summary** | `forced` |

Plus one recovery case: an unchanged set whose last attempt ended `failed` or
`pending` retries as `previous_attempt_incomplete` — the input was unchanged,
but the *outcome* was absent.

Everything else returns `unchanged` and reuses the stored summary. **A nightly
re-sync over unchanged comments costs nothing**, which is the entire point of
the hash.

Two further cases skip the model outright:

- **No comments at all** → the deterministic "No readable comments found"
  analysis is produced locally.
- **No comment has any text** → same, without a request.

---

## 4. The provider abstraction

```
services/sync-comments.ts
        │  depends on the interface, never the SDK
        ▼
lib/ai/provider.ts        AiProvider, AiAnalysisResult      [pure types]
lib/ai/contract.ts        Zod schema · JSON Schema · prompt  [pure]
        ▲
lib/ai/anthropic.ts       the only file importing the SDK
```

Adding a second provider is a new file satisfying `AiProvider`; nothing in the
service layer changes. Failures are **returned, not thrown** — a summarisation
failure is a row status, not an exception that aborts a sync run.

### The Anthropic request

- **Model** `claude-opus-5`, overridable with `ANTHROPIC_MODEL`.
- **Structured outputs** (`output_config.format`) constrain generation to the
  analysis schema.
- **Zod validation** runs on the response anyway. This is not redundant:
  structured outputs shape a *successful* generation and say nothing about a
  refusal, a truncation, or a provider change. Zod is what turns anything else
  into a clean `failed` status instead of a malformed row.
- **`stop_reason === "refusal"` is checked before `content` is read.** Comment
  text is arbitrary user content and can trip a safety classifier; indexing
  `content[0]` unconditionally would throw on exactly the inputs most worth
  handling gracefully.
- **Server-side fallbacks** (`fallbacks: "default"`) re-run a declined request
  on Anthropic's recommended substitute, so one hostile thread does not block a
  whole report.

---

## 5. Statuses

| Status | Meaning |
|---|---|
| `pending` | A row exists but no attempt has run |
| `processing` | Written **before** the AI call, so a crashed run leaves this behind rather than a stale `completed` |
| `completed` | An analysis was produced and validated |
| `no_comments` | Nothing analysable — no comments, or all of them empty |
| `failed` | The attempt failed; `error_message` says why |

Two check constraints keep these honest: a `failed` row must carry an
`error_message`, and a `completed` row must carry a `summary`.

---

## 6. Placeholders

Set by the specification, stated verbatim in the prompt, and applied again in
code so a model that returns an empty list still renders correctly:

- **`No significant findings`** — a category with nothing worth reporting.
- **`No readable comments found`** — nothing analysable at all, paired with
  sentiment `no_comments`.

---

## 7. Endpoints

| Endpoint | Auth | Behaviour |
|---|---|---|
| `POST /api/admin/posts/{id}/sync-comments` | admin | Fetches from Meta, then summarises **only if the set changed** |
| `POST /api/admin/posts/{id}/regenerate-summary` | admin | Re-analyses the stored comments, bypassing the gate |
| `POST /api/admin/videos/{id}/sync-comments` | admin | Same, for a video |
| `POST /api/admin/videos/{id}/regenerate-summary` | admin | Same, for a video |

The video pair are thin wrappers: they resolve a `ContentRef` and call the same
service. The only difference between the two pairs is which table the id is
looked up in.

Regeneration deliberately does **not** re-fetch. Regenerating is about getting a
better analysis of the same evidence; a fresh fetch would change the input and
make the comparison meaningless. Use `sync-comments` to pull new comments.

Both are admin-only: they spend Meta quota and AI tokens.

---

## 8. Limits

`MAX_COMMENTS_PER_CONTENT` (default **500**) caps comments fetched per post or
video. Without it a viral post — or a long broadcast — could pull tens of
thousands of comments into one AI request. When the cap is hit the result reports `truncated: true` and the UI
says so — the analysis covers what was collected, not silently a subset.

Comments are requested in `chronological` order rather than Meta's default
`ranked`, because ranked order shifts between requests and would make
pagination non-deterministic — defeating the source hash.
