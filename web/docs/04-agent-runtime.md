# Agent runtime

The desktop app executed research turns by spawning coding-agent CLIs
(Claude Code, Codex, Grok) and parsing their JSONL output
(`src-tauri/src/research_runtime.rs`, `claude_sdk.rs`, `headless_process.rs`).
The web app does not run any CLI. It runs the agent loop itself, in the web
server process, against provider APIs through the Vercel AI SDK, with tools
the app owns. This document specifies that runtime; where runs execute and
how clients observe them is `05-run-lifecycle-and-streaming.md`.

What carries over from the desktop is the research *product* behavior:
read-only tools, the linking instruction that produces wikilinks, the launch
prompt assembly, response-boundary rules, the `Turn`/`TurnBlock` durable
format and its timeline projection, recap and title generation, encyclopedia
pages, tweet attachments.

## 1. Models

Registered in code (`packages/shared/src/models/registry.ts`, which also
carries per-model prices per million tokens used for
`usage_events.cost_estimate_micros`: Gemini 0.75/3.75, DeepSeek 0.15/0.60,
Luna 0.20/1.20, Fable 10/50) and exposed by `system.runtimeConfig`:

| id | Model | Route | AI SDK provider | Access | Search |
| --- | --- | --- | --- | --- | --- |
| `gemini-flash` | Gemini 3.8 Flash | Vertex AI, service account | `@ai-sdk/google-vertex` | all users, default | owned tools |
| `gemini-flash-google` | Gemini 3.8 Flash with Google Search grounding | Vertex AI | `@ai-sdk/google-vertex` with the `google_search` provider tool | all users | native grounding (§6.2) |
| `deepseek-flash` | DeepSeek V4.1 Flash | OpenRouter `deepseek/deepseek-v4.1-flash`, `provider: { zdr: true, data_collection: "deny" }` | `@openrouter/ai-sdk-provider` | all users | owned tools |
| `gpt-luna` | GPT-5.6 Luna | OpenRouter `~openai/gpt-luna-latest` (falls back to `openai/gpt-5.6-luna` if the alias is absent), `provider: { zdr: true, data_collection: "deny" }` | `@openrouter/ai-sdk-provider` | all users | owned tools |
| `claude-fable` | Claude Fable 5.1 (`claude-fable-5-1`) | Anthropic API | `@ai-sdk/anthropic`, `@anthropic-ai/sdk` escape hatch (§7) | admin only | owned tools |

Metadata runs (titles, recaps, encyclopedia pages) always use
`gemini-flash` (§9). GPT-6 Astra is not included in this iteration.

OpenRouter routing: both OpenRouter models require zero-data-retention,
no-collection endpoints. `zdr: true` and `data_collection: "deny"` are set
on every request and mirrored as account-wide privacy settings on the
OpenRouter account, so a request with no eligible provider fails rather than
routing to a logging provider; that failure is classified `provider_unavailable`
and shown to the user. Provider pins (`order`, `allow_fallbacks: false`) are
added if routing proves unstable.

The server enforces access on `research.createTree`, `research.forkNode`,
and `research.retryNode`; the client hides gated models for non-admins.
`users.is_admin` is set manually in the database (`06-auth-and-users.md` §3).

Reasoning effort is fixed at medium for every model and is not exposed in
the UI. Mapping: Anthropic `providerOptions.anthropic.effort: "medium"`
(thinking is always on for Fable 5.1 and controlled only by effort);
OpenRouter `reasoning: { effort: "medium" }` for both `gpt-luna` and
`deepseek-flash`; Gemini medium thinking level. The desktop's per-model
effort option lists (`src/lib/launcherModels.ts`) are not ported.

Model switching: a follow-up may choose any model the user may access. The
thread's message history is provider-neutral (§4), so a fork onto another
model replays the same messages; provider-specific reasoning blocks are
dropped in that case, which is accepted.

## 2. Module layout

```
packages/server/src/runs/
  admission.ts        run_queue claim loop, per-user and per-provider limits, pools
  loop.ts             one attempt: build messages → streamText → persist → events
  providers.ts        AI SDK provider construction (Vertex service account, keys), model registry binding
  messages.ts         canonical message store ↔ AI SDK ModelMessage conversion; document parts
  mapper.ts           AI SDK stream parts → Turn/TurnBlock (durable format) and turn deltas
  tools/
    webSearch.ts      owned search tool (vendor client, result normalization, caching)
    webFetch.ts       owned fetch tool (SSRF guard, readability extraction, size caps)
    documentRead.ts   read an attached document's text by id (for models without file input)
  prompts.ts          launch prompt assembly (uses shared/research/prompts)
  snapshots.ts        two-guard snapshot commit, revision
  metadata.ts         title, recap, encyclopedia page via generateText + Output.object on gemini-flash
  documents.ts        upload storage, text extraction, provider part building
  usage.ts            token usage and cost recording per attempt
  tweets.ts           syndication fetch, normalization (shared), cache
  fixtures/           recorded provider streams for tests (12-testing-linting-ci.md)
```

## 3. The agent loop (`loop.ts`)

One attempt of one node:

1. Load the node, its ancestors' canonical messages (§4), attached
   documents, and the user's research instruction.
2. Build `messages`: system prompt (§5) + ancestor messages + the new user
   message (launch prompt text plus document parts).
3. `streamText({ model, system, messages, tools: { web_search, web_fetch,
   document_read }, stopWhen: stepCountIs(MAX_STEPS), abortSignal,
   providerOptions })`. `MAX_STEPS = 25`; wall-clock cap 15 minutes
   (`SESSION_RUN_TIMEOUT_SECONDS`); per-run tool caps 20 searches and 20
   fetches, enforced inside the tools (a capped tool returns an error result
   telling the model the budget is spent, which it handles gracefully).
4. Consume `fullStream`: `text-delta` → mapper `pushTextDelta` → coalesced
   `research.turn.delta`; `reasoning-delta` → dropped from the durable format
   (desktop parity: reasoning was never shown), but a "thinking" activity
   indicator is emitted while reasoning streams; `tool-call` → `toolUse`
   block; `tool-result` → `toolResult` block; `step-finish` → commit the
   assistant turn (and the tool-result user turn) → `research.turn.committed`
   and `run_turns` insert; `finish` → outcome and usage; `error` → failure.
5. On finish: append the assistant and tool messages to the node's canonical
   message store (§4), commit the durable snapshot with the two-guard rule
   (`05-run-lifecycle-and-streaming.md` §5), set `complete`, record usage,
   schedule title and recap.
6. Errors: provider errors are classified (`rate_limited`, `auth`,
   `content_filter`/refusal, `context_too_long`, `network`, `unknown`) with
   user-facing copy; `rate_limited` re-queues the node with backoff up to 3
   times before failing. A Fable 5.1 `refusal` stop reason is surfaced as
   `failed` with the refusal category; the Anthropic server-side `fallbacks`
   parameter is not used (falling back to a non-Fable model would cross the
   admin gate silently).
7. Cancel: `AbortController.abort()`; partial text stays in `run_turns` for
   display under `cancelled`.

The loop is provider-neutral. Provider quirks live in `providers.ts`
(construction, `providerOptions`, retention and safety settings) and in the
mapper (reasoning block shapes, tool-call id formats).

## 4. Canonical message store

The desktop delegated conversation state to each CLI's session files and
forked with `--resume --fork-session`. The web app owns the conversation.

`node_messages` (`02-domain-model-and-database.md` §3.3): the ordered AI SDK
`ModelMessage[]` produced by one node's attempt, stored as JSON, including
tool calls and tool results, with provider-specific reasoning metadata kept
in `providerMetadata` where the SDK preserves it. A node's context is the
concatenation of its ancestors' messages along the tree path plus its own.
Forking is a data operation: a child node's context starts from its parent's
messages; nothing is copied until the child completes, when its own
messages are appended under its id.

Rules
- Append-only. Messages of a completed node are never edited (Fable 5.1
  invalidates thinking blocks on edited history; other providers do not
  care, but one rule is simpler).
- Same-model forks keep reasoning metadata; cross-model forks drop it (the
  SDK and providers ignore foreign reasoning blocks).
- Context budget: before a request, if the estimated token count of the
  ancestor messages exceeds `CONTEXT_BUDGET_TOKENS` (default 200k), tool
  results older than the last two nodes are replaced by a one-line
  placeholder ("[tool result elided]") and, if still over budget, the oldest
  nodes' exchanges are replaced by a summary generated once by `gemini-flash`
  and cached on the node (`node_summaries`). The displayed document is
  unaffected; this only shapes what the model sees.
- `document` parents (imported reports) have no messages; their markdown is
  embedded in the child's prompt as the desktop did (`research.rs:2054`).

## 5. Prompts

System prompt (per request): a fixed research system prompt (new; the CLIs
supplied their own), then the linking instruction, then the user's research
instruction wrapped and neutralized exactly as the desktop did
(`research.rs:2321-2453`, `<research-linking>`, `<research-instructions>`,
4 KiB cap). The user message is the bare question, plus a quoted passage for
highlight-anchored follow-ups (`research.rs:2293`), plus tweet reference
material (`tweets.rs`), plus document parts. The displayed `node.prompt`
remains the bare question. The response boundary is trivial now: the answer
is the assistant text of this node's attempt, so `response_boundary`
matching (`research.rs:1852`) is not ported.

Tool descriptions instruct the model to cite sources inline as Markdown
links, to prefer `web_fetch` on results it relies on, and to stop searching
once the question is answered.

## 6. Tools

Owned by the app so that every model has the same capabilities and the UI
renders the same activity and sources.

- `web_search({ query, recency? })` → `{ results: [{ title, url, snippet,
  publishedAt? }] }`. Vendor client behind one interface (§10 question);
  results cached 24 h by normalized query; 10 results per call.
- `web_fetch({ url })` → `{ url, title, text, truncated }`. Server-side
  fetch with SSRF guard (public IPs only, 3 redirects, 10 s, 5 MiB), HTML
  to readable text (readability + sanitization), PDF to text, 40k-character
  cap; cached 24 h by URL. Desktop artifact-preview CSP and path rules do not
  apply (nothing is written to disk).
- `document_read({ documentId, page? })` → extracted text of an attached
  document, chunked at 30k characters. Used by models without native file
  input or when a file exceeds the provider's inline limit.

Tool activity is rendered from `toolUse`/`toolResult` blocks by the existing
timeline (`TranscriptActivity`), with a new "Sources" footer listing the
distinct URLs from `web_search` and `web_fetch` results in the answer.

### 6.1 Search vendor

The `web_search` interface is vendor-neutral (`SearchVendor.search(query,
opts) → results`) with two implementations: Parallel (Search API, Fast
processor, excerpts) and Tavily (basic search with `include_raw_content:
"markdown"`). `SESSION_SEARCH_VENDOR` selects the primary when both keys are
present; the other is the fallback after a vendor error. With neither
`PARALLEL_API_KEY` nor `TAVILY_API_KEY` set, the tool is unavailable: runs
proceed with `web_fetch` and `document_read` only, `runtimeConfig.features.webSearch`
is false, and the composer shows "Web search unavailable";
`gemini-flash-google` keeps Google Search grounding. The comparison that
informed the choice:

| Vendor | Search price | Content | Notes |
| --- | --- | --- | --- |
| Exa | $7 / 1k standard searches (10 results); $12–15 deep | snippets plus optional full text, highlights, summaries at $1 / 1k pages each | one call can return full text, so `web_fetch` is rarely needed |
| Tavily | $8 / 1k credits; basic search 1 credit, advanced 2 | snippet per result; `include_raw_content` returns cleaned page text (async, sometimes null); extract 0.2 credits/URL | search + content in one call |
| Brave | $5 / 1k requests (Search plan) | Web Search: snippets; LLM Context endpoint: extracted passages ≤ 8k tokens, 20 sources | cheapest per query; ZDR offered |
| Parallel | $1 / 1k (Turbo/Fast) to $5 / 1k (Basic/Advanced) | compressed excerpts; Extract API $1 / 1k for full text | cheapest overall; excerpts are LLM-shaped |
| Google Search grounding (Gemini 3.x) | $14 / 1k search queries after 5,000 free per month | no page text: cited segments, redirect URIs, titles | only usable inside Gemini requests (§6.2) |

Whichever vendor is chosen, `web_fetch` remains for URLs the model wants to
read in full and for user-pasted links.

### 6.2 Google Search grounding (`gemini-flash-google`)

The `gemini-flash-google` model entry passes Vertex's `google_search` tool
instead of the owned `web_search`. Behavior differences the runtime handles:

- Grounding returns `groundingMetadata` (`webSearchQueries`,
  `groundingChunks` with title and a Google redirect URI,
  `groundingSupports` mapping answer segments to chunks, `searchEntryPoint`),
  not page text. The mapper turns each grounded step into a synthetic
  `toolUse`/`toolResult` pair named `google_search` so the timeline and the
  Sources footer render uniformly; the Sources footer shows chunk titles and
  resolves redirect URIs to their final host for display.
- Google's terms require displaying the Search Suggestions from
  `searchEntryPoint` when grounded results are shown; the document footer
  renders them for grounded answers.
- Whether `google_search` can be combined with function tools
  (`web_fetch`, `document_read`) in one Gemini 3.8 request is verified in
  the Phase 4 spike; if not, `gemini-flash-google` runs with grounding only
  and documents are inlined as text.
- Billing is per search query, several per prompt; usage is recorded as
  `search` events from `webSearchQueries.length`.

## 7. Anthropic escape hatch

`@ai-sdk/anthropic` is used by default. If a Fable 5.1 requirement is not
expressible through it, `providers.ts` swaps in a small adapter over
`@anthropic-ai/sdk` that exposes the same `streamText`-shaped result. Known
requirements to verify during the Phase 4 spike: thinking always on with
`output_config.effort`, `refusal` stop reason and `stop_details`, append-only
history replay of thinking blocks, 30-day retention configured on the
Anthropic org, streaming with `max_tokens` high enough for long answers, and
long turns (minutes) without client timeouts.

## 8. Documents as context

Users attach files to a question (`10-home-feed-journal-encyclopedia.md`
§1). Server side (`documents.ts`):

- Accepted: PDF, Markdown, plain text, CSV, JSON, DOCX (converted to text),
  PNG/JPEG/WebP images. 20 MiB per file, 10 files per question, 200 MiB per
  user (raise later).
- Storage: `/data/documents/<userId>/<sha256>` on the volume; metadata in
  `documents`; extracted text in `document_text` (per page for PDFs).
  Documents are kept indefinitely; there is no expiry job.
- Provider parts: Gemini and Claude receive PDFs and images as file parts
  (Claude via document blocks); Luna via OpenRouter receives PDFs as file
  input and images as image parts; DeepSeek receives extracted text inline
  (≤ 60k characters per document) and uses `document_read` beyond that. Text formats are
  inlined for every provider.
- Documents attached to a root question are part of that node's messages
  and therefore in context for every descendant; a follow-up may attach more.
- Documents are also artifacts: the preview panel opens them through the
  artifact route (`11-artifacts-and-browser.md`).

## 9. Metadata runs (`metadata.ts`)

Titles, recaps, and encyclopedia pages use `generateText` with
`Output.object` (zod schemas `{title}`, `{recap}`, `{page}`) on
`gemini-flash` regardless of the thread's model, with no tools and medium
effort. Desktop rules kept: recap scheduling predicate and dedupe
(`research_recap.rs:30-100`), `MIN_RECAP_CHARS` 800 and `MAX_SOURCE_BYTES`
80 KB for generated runs, imported reports exempt, reject > 1200 chars,
`research.recap.pending` on every exit path; title sanitization
(`sanitize_research_title`, 80 chars); encyclopedia page prompt with
`PAGE_LINKING_INSTRUCTION`, `split_title`, `normalize_page`, links recomputed
(`encyclopedia.rs`). The OpenRouter transport and the CLI metadata path are
dropped.

## 10. Usage and limits

Every attempt records `usage_json` (input, output, reasoning, cached tokens
as reported by the SDK) and an estimated cost from a per-model price table in
the registry. `usage_events` accumulates per user per day for the rate limits
that will be added later; the schema exists from day one. Admission
(`05-run-lifecycle-and-streaming.md` §8): 2 concurrent research runs per user,
per-provider global caps (`SESSION_RUNS_GEMINI`, `SESSION_RUNS_OPENROUTER`,
`SESSION_RUNS_ANTHROPIC`, defaults 8/8/2), metadata pool 4. Per-account
daily limits (tokens and runs) are enforced at admission from
`usage_events` and `user_limits` once enabled (`06-auth-and-users.md` §8).

## 11. Credentials and configuration

Deployment-level only; users supply nothing. Fly secrets:
`GOOGLE_APPLICATION_CREDENTIALS_JSON` (Vertex service account; written to a
file at boot) with `GOOGLE_VERTEX_PROJECT` and `GOOGLE_VERTEX_LOCATION`,
`OPENROUTER_API_KEY` (DeepSeek and Luna), `ANTHROPIC_API_KEY`,
`PARALLEL_API_KEY` and/or `TAVILY_API_KEY` for `web_search`. A model whose
credential is missing is reported `unavailable` in `runtimeConfig` and
hidden. `web/.env.example` documents every variable with comments.

## 12. Test fixtures

Recorded AI SDK stream-part sequences per provider (success, tool loop,
refusal, rate limit, context overflow, mid-stream error, abort) drive the
loop in tests through a fixture provider implementing the AI SDK provider
interface. Real-provider smoke tests run manually with credentials.
