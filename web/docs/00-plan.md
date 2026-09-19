# Session Web — master plan

## 1. Purpose

Build a web application at `https://session.dev` that mirrors the Session
desktop application: a research workspace where a user launches long-running
investigations with AI models, reads answers as documents, branches with
follow-ups anchored to highlighted passages, keeps journal links and X posts
in a Home feed, grows an encyclopedia from wikilinks, and organizes
everything into workspaces and folders.

The desktop app is a Tauri shell: a Rust backend (`src-tauri/src`) and a
React frontend (`src/`, one 12k-line `App.tsx` plus ~90 library modules).
The desktop ran research by spawning coding-agent CLIs. The web app replaces
that with its own agent loop over provider APIs (Vercel AI SDK) and owned
web-search and web-fetch tools, replaces the Rust backend with a Node web
server over SQLite, and replaces Tauri IPC with tRPC and Server-Sent Events.
The React frontend is ported, not rewritten.

This is a hard cutover. The web app does not import desktop data and is free
to change identifiers, statuses, and wire shapes where that produces a better
service.

The existing `web/` directory holds a server-rendered marketing landing page
deployed to a Fly app on a different domain. It is removed and its references
updated (`14-legacy-inventory.md`).

## 2. Goals and non-goals

Goals

- Functional parity for the research product: Home / Bookmarks / Highlights,
  research documents with streaming answers, follow-ups (inline and branching),
  highlight-anchored asks, retry/cancel, recaps, titles, encyclopedia,
  journal links and X posts, workspaces and folders, report import, settings,
  keyboard shortcuts, command palette, notifications.
- Models: Gemini 3.8 Flash (default; also a Google-Search-grounded
  variant), DeepSeek V4.1 Flash and GPT-5.6 Luna via OpenRouter on
  zero-retention providers, for every user; Claude Fable 5.1 for admin users.
  Medium reasoning effort everywhere. Documents (PDF, text, images)
  attachable as context.
- The system supports multiple users with open GitHub sign-up. Per-account
  daily token and run limits, along with sign-up throttling by IP, GitHub
  account age, and invite codes, will be added later using the initial schema.
- Durable state is server-authoritative in SQLite. Runs outlive tabs, devices,
  and deployments; output is persisted while streaming, and any client can
  rejoin an active stream from a snapshot.
- One Fly app; reproducible `Dockerfile` and `fly.toml`.
- Type-safe end to end, linted, tested with recorded provider fixtures so
  the runtime is testable without credentials.

Non-goals

- Importing desktop data; running agent CLIs; user-supplied provider keys.
- Terminal panes, remote hosts, the native browser overlay, the updater,
  global hotkeys, and every other terminal-era subsystem
  (`14-legacy-inventory.md`).
- Collaborative editing.

## 3. Architecture at a glance

```
web/
  package.json                npm workspaces root
  packages/
    shared/                   domain types, zod schemas, model registry, pure logic
    db/                       Drizzle schema, migrations, repositories (no HTTP, no React)
    server/                   Hono app: tRPC, SSE, auth, agent loop + tools, documents, artifacts
    client/                   React 19 + Vite + Tailwind v4 + TanStack Router/Query + Zustand
  docs/
  Dockerfile  fly.toml  .dockerignore
```

Production: Fly app `session-dev` serving `session.dev` (and
`artifacts.session.dev`), one machine, SQLite and documents on a volume at
`/data`. The agent loop runs in the same process against Vertex AI (service
account), OpenRouter (zero-retention providers only), and Anthropic.

| Concern | Decision |
| --- | --- |
| Layout | npm workspaces, four packages |
| Server | Hono on Node 22; tRPC v11; SSE subscription for events |
| Database | SQLite via `better-sqlite3`, WAL; Drizzle ORM; drizzle-kit migrations |
| Auth | GitHub OAuth (PKCE) via `arctic`; DB sessions; `users.is_admin` set manually |
| Agents | Vercel AI SDK `streamText` loop with owned `web_search`, `web_fetch`, `document_read` tools; `@anthropic-ai/sdk` escape hatch if needed; app owns conversation history |
| Models | `gemini-flash` (default, Google Search grounding), `deepseek-flash` and `gpt-luna` via OpenRouter ZDR/no-collection routing, all users; `claude-fable` admin only; effort fixed at medium; metadata runs on `gemini-flash` |
| Streaming | Snapshot + per-node ordered deltas; durable checkpoints; `interrupted` with auto-resume on deploy |
| Client state | TanStack Query (event-patched) + Zustand; TanStack Router |
| Styling / components | Tailwind v4 over the preserved `tokens.css`; Base UI primitives; lucide-react; TanStack Virtual |
| Markdown | Same pipeline: react-markdown, remark/rehype math (lazy), mermaid and viz (lazy), DOMPurify, wikilinks |
| Testing / lint | AVA everywhere (jsdom for client), Playwright e2e with fixture providers; ESLint 9, Prettier, `tsc -b` |
| Deployment | One Fly machine + volume; Litestream backups; `/healthz` |

## 4. Sequencing rationale

Two seams in the desktop code drive the order: `src/lib/api.ts` and
`useSessionEvents.ts` are the only frontend touch points with Rust, and the
Rust research core is pure logic that ports to TypeScript with fixtures.
Order: shared domain → database → server API → agent loop → client
foundation → client features → artifacts → deployment → parity check.
Client and server overlap from Phase 5 once the API contract
(`03-api-and-events.md`) is frozen.

## 5. Phases

### Phase 0 — Repository preparation (small)
- Remove the landing site and every reference (`14-legacy-inventory.md` §3).
- Scaffold `web/` workspaces, tsconfig references, ESLint, Prettier, AVA, CI.
- Create Fly app `session-dev`, volume, certificates for `session.dev` and
  `artifacts.session.dev`, the Vertex service account, the OpenRouter account
  (account-wide ZDR and no-collection settings), the Anthropic key, and
  Parallel and/or Tavily keys. `web/.env.example` lists every variable.
- Exit: `npm run check` and `npm test` pass on placeholders; root `preflight`
  passes.

### Phase 1 — Shared domain package (medium)
Spec: `02-domain-model-and-database.md` §2, `07-client-architecture.md` §7.
- Research types with zod schemas; the model registry; the ported pure
  modules from `src/lib/` (list in `07` §7); Rust logic ported with fixtures:
  revision hashing, prompt assembly and neutralization, document follow-up
  prompt, highlight-anchored prompt, preview/title truncation, recap source
  extraction, anchor validation, slug and title split, tweet extraction and
  normalization, feed cursor.
- Exit: no React/Node/DOM dependency beyond `Intl`; ported tests green.

### Phase 2 — Database (medium)
Spec: `02-domain-model-and-database.md`.
- Schema, migrations, repositories with invariants as transactions: admit
  root/child, reorder, folders, document update, highlights, recaps, feeds,
  encyclopedia, `run_turns`/`run_seq`, `node_messages`, documents, usage,
  boot reconciliation.
- Exit: repository tests cover every invariant in `02` §5.

### Phase 3 — Server core (large)
Spec: `03-api-and-events.md`, `06-auth-and-users.md`.
- Hono app, security headers, CSP; GitHub OAuth, sessions, admin flag; the
  tRPC router; event fan-out with interest sets; tweet proxy; document
  upload route; settings.
- Exit: integration suite drives create → (fixture) stream → highlight →
  follow-up → recap → archive over tRPC and SSE.

### Phase 4 — Agent loop (large)
Spec: `04-agent-runtime.md`, `05-run-lifecycle-and-streaming.md`.
- Providers (Vertex service account, OpenRouter with ZDR routing,
  Anthropic), model registry binding and gating, Google Search grounding
  variant, `streamText` loop, mapper to `Turn`, owned
  tools, canonical message store and forks, context budget, documents as
  parts, snapshots, `interrupted` auto-resume, admission and per-provider
  caps, usage recording, metadata runs on `gemini-flash`, fixture providers.
- Spike first: Fable 5.1 through `@ai-sdk/anthropic` (effort, refusal,
  append-only history, long turns); decide the escape hatch.
- Exit: Phase 3 suite passes against fixture providers; kill and restart the
  server mid-run and see it resume; a manual run on each real provider
  produces a document with wikilinks, sources, a recap, and a title.

### Phase 5 — Client foundation (medium)
Spec: `07-client-architecture.md`, `08-design-system-and-styling.md`.
- Vite + Tailwind over `tokens.css`; Base UI wrappers; router; query client;
  SSE bridge; `liveTurns` with sequence handling; stores; Settings and Login
  pages.
- Exit: sign in, empty sidebar, theme switching, live connection status.

### Phase 6 — Client features (very large)
Spec: `09-research-document-view.md`, `10-home-feed-journal-encyclopedia.md`.
- Sidebar, folders, encyclopedia section; Home feed with composer (model
  picker, document attach), cards, pagination, undo, import; research
  document view with streaming, `interrupted`, queue position, highlights,
  asks, inline and branch follow-ups with model choice, recap dialog, DOM
  search, sources footer, document chips; encyclopedia page; highlights and
  bookmarks feeds; shortcuts and palette; admin user list.
- Exit: parity checklist §8 green except Phase 7 items.

### Phase 7 — Artifacts and document preview (small)
Spec: `11-artifacts-and-browser.md`.
- Token-scoped routes on `artifacts.session.dev` serving attached documents;
  sandboxed preview panel; link context menu.
- Exit: documents open in the preview panel, and every route requires a valid token.

### Phase 8 — Deployment and operations (medium)
Spec: `13-deployment-fly.md`.
- Dockerfile, `fly.toml`, volume, secrets, migrations on boot, graceful
  shutdown with resume, Litestream, logs, metrics.
- Exit: `fly deploy` during an active run pauses and resumes it, and the restore
  procedure has been rehearsed and verified.

### Phase 9 — Parity verification and cutover (small)
- Walk §8; update `README.md` and `docs/`; announce.

## 6. Cross-cutting principles

- Server is authoritative; clients patch caches from events and refetch on
  reconnect.
- Every active node is renderable from one `getNodeContent` call.
- Every mutation is a transaction; snapshot commits use `synchronous=FULL`.
- The app owns conversation history; it is append-only.
- Terminal status transitions are irreversible; response revision hashes serve as concurrency tokens.
- Pure logic lives in `shared` with fixtures.
- One toolset for every model so the UI and evaluation are uniform.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Research quality below the desktop's tuned CLI agents | Eval set of real questions before Phase 4 exit; tool descriptions and system prompt iterated against it; model comparison built in |
| Four heterogeneous providers behind one SDK | Fixture-driven loop tests per provider; Fable-specific spike; Anthropic escape hatch |
| Cost: app pays for all tokens, Fable at $10/$50 per MTok | Admin-only gating for Fable; usage recorded per attempt; daily token and run limits per account on the same schema |
| OpenRouter ZDR routing leaves a model with no eligible provider | Account-wide and per-request enforcement; `provider_unavailable` surfaced; provider pins if needed |
| Provider rate limits and outages | Per-provider concurrency caps; 429 re-queue with backoff; tool errors degrade gracefully |
| Search vendor cost and quotas | Two vendors (Parallel, Tavily) with fallback; caching by query and URL; per-run caps; runs degrade to fetch-only without keys |
| Deploys interrupting runs | Persisted context and auto-resume (`05` §7) |
| `App.tsx` coupling | Port by view; state into query cache and stores |
| Style contract tests are textual | Re-expressed over compiled CSS (`08` §6) |
| SQLite single writer | One process, WAL, short transactions, coalesced checkpoints |

## 8. Parity checklist

Walked against the implemented code and the test suites at the end of Phase 9.
A line is **verified** when every clause in it is implemented *and* named by a
test; **partial** when it is implemented but some clause has no direct
coverage, or a clause is incomplete; **missing** when it is not built. Counts:
14 verified, 4 partial, 0 missing.

Client tests are AVA files under `packages/client/test/`, server tests under
`packages/server/test/`, shared under `packages/shared/test/`, and end-to-end
specs under `e2e/`.

### Home and feeds

- [x] **Verified** — Compose and launch with a model choice (Fable hidden for
      non-admins; Gemini grounded variant available) and attached documents;
      draft survives reload.
      `features/composer/ResearchQueryComposer.tsx`; `composer.test.tsx`
      ("Tab steps to the next launchable model and wraps", "the model list
      hides admin-only models from everyone else", "the draft keeps the
      prompt, the model and the attached document ids"); `admin.spec.ts` both
      tests; `artifacts.spec.ts` attaches through this composer;
      `library.spec.ts` "a half-written question survives a reload".
- [ ] **Partial** — Mixed activity feed with keyset pagination, load older,
      retry, refresh, new-activity button, restored scroll anchor.
      All implemented in `features/home/ActivityFeed.tsx` and
      `useActivityFeedState.ts`. Pagination is covered by `feed.test.tsx` "renders a
      pagination button for a cursor and fetches the next page on click",
      and the new-activity count by "only items that arrived above the
      reader's row are counted as new". The error-state Retry button, the
      Refresh button, the sticky new-activity button, and scroll-anchor
      restoration have no test that drives them through the DOM.
- [x] **Verified** — Query cards with children, recap, follow and bookmark,
      context menu with Generate summary.
      `features/home/ResearchQueryCard.tsx`; `feed.test.tsx` "a query card
      renders its recap and its follow-up questions" and "a card's menu writes
      the star it offers, and offers no folder row";
      `research.dialogs.test.tsx` covers the Generate summary row;
      `library.spec.ts` drives Bookmark and its two feeds.
- [x] **Verified** — Journal link and X post cards with hydration, menu
      rows (without shortcut badges: Base UI menus do not support letter shortcuts), undo delete; adding a
      link or X URL from the composer (web addition).
      `features/journal/JournalEntryCard.tsx`, `entryMenu.ts`,
      `server/trpc/routers/journal.ts`; `feed.test.tsx` "the journal menu
      displays only actions supported by the entry", "journal actions use a
      hydrated post's canonical permalink", "an entry with an invalid stored
      URL omits actions that require it", "removing a journal entry displays an
      undo action that restores the same row"; `composer.test.tsx` "a bare URL is saved to
      the journal instead of launching a run"; `packages/server/test/journal.test.ts`.
- [ ] **Partial** — Bookmarks tab; Highlights tab with day headers, refresh,
      and focus scroll.
      `routes/bookmarks.tsx`, `features/highlights/HighlightsFeed.tsx`;
      `highlights.test.tsx` "day headers are named in local time, not in UTC"
      and "grouping keeps the server's order and starts a section per day";
      `research.document.test.tsx` "?highlight= scrolls the passage into view
      and clears the param"; `research.spec.ts` and `library.spec.ts` for the
      two tabs. The Highlights Refresh button is implemented and untested.
- [x] **Verified** — Report import; no agent setup guide (models are always
      configured).
      `features/import/ReportImport.tsx`; `library.spec.ts` "a Markdown report
      is imported as a thread"; `packages/server/test/research.test.ts` for
      `importReport`. The desktop's `AgentSetupGuide` is omitted; unconfigured models are simply displayed as disabled in the list rather than prompting the user to complete setup.

### Research document

- [x] **Verified** — Streaming answer with tool activity, thinking indicator,
      collapsed-answer projection, sources footer, document chips; flash-free
      swap to the durable snapshot; reload and second tab agree.
      `features/research/{AnswerPane,ThreadSegment,TimelineItem,SourcesFooter,DocumentChips}.tsx`,
      `timeline.ts`; `research.timeline.test.ts` (collapsed-answer window and
      source extraction), `nodeContent.test.tsx` "a live run keeps its turns
      across the swap to the durable snapshot", `research.document.test.tsx`
      "the durable snapshot replaces the live buffer without remounting";
      `research.spec.ts` both streaming tests.
- [x] **Verified** — Queue position; `interrupted` with auto-resume; Retry on
      terminal states.
      `AnswerPane.tsx`, `server/runs/service.ts`, `server/main.ts`;
      `research.document.test.tsx` "a queued run shows its position in the
      queue", "hides the queue position after a worker claims the run",
      "displays an interruption notice and Retry button for an interrupted
      run"; `runs.failures.test.ts` "admission holds runs
      above the per-user cap and reports queue positions" and "drain
      interrupts open runs and boot resumes them without duplicate turns".
- [x] **Verified** — Follow-up composer with model choice, inline continuation
      (one slot), branching cards, highlight-anchored asks with connectors.
      `FollowupComposer.tsx`, `FollowupRail.tsx`, `layout.ts`;
      `research.document.test.tsx` "enables Send after the parent completes and
      submits an inline follow-up on Cmd-Enter", "Shift-Cmd-Enter submits a
      branch regardless of the selected mode", "opens a branch page with a
      breadcrumb back to the parent"; `research.layout.test.ts` for the connectors;
      `packages/server/test/research.test.ts` "a second inline follow-up is a
      conflict and a foreign id is not found"; `research.spec.ts` "a highlight
      anchors an ask, and the follow-up runs on another model".
- [x] **Verified** — Highlights create/remove/merge/focus; Ask and Expand.
      `ResearchPage.tsx`, `SelectionPopover.tsx`, `capture.ts`;
      `research.selection.test.ts` "a selection overlapping saved highlights
      offers the merged annotation" and "snapping expands a partial word to
      the whole word"; `packages/shared/test/researchNavigation.test.ts` for
      removal targeting; `research.spec.ts` for the whole gesture.
- [x] **Verified** — Retry, cancel, rename, delete branch, delete tree,
      archive/restore.
      `features/research/{treeMenu,DeleteBranchDialog}.tsx`;
      `research.dialogs.test.tsx` (rename, delete-branch naming, the
      in-flight refusals, archived-row menu); `packages/server/test/research.test.ts`
      "a research thread runs from launch to archive"; `library.spec.ts` for
      archiving from the sidebar row menu.
- [x] **Verified** — Recap dialog (generate and apply); title generation.
      `RecapDialog.tsx`, `server/runs/metadata.ts`;
      `research.dialogs.test.tsx` "the recap dialog generates a candidate and
      applies it", "editing recap instructions clears the generated candidate", "the
      recap dialog surfaces a refusal"; `runs.metadata.test.ts` "a recap
      candidate is generated, previewed, and applied" and "a title is
      generated, sanitized, and given to the thread"; `research.spec.ts` "the
      recap dialog generates a candidate and applies it".
- [ ] **Partial** — Node history; browser history across pages; DOM
      search; lightboxes; math; wikilinks to encyclopedia pages.
      All implemented. Node and cross-page history are covered by
      `packages/shared/test/researchHistory.test.ts`; math and wikilinks by
      `markdown.test.tsx`; the wikilink route end to end by `library.spec.ts`.
      Swipe is covered only as pure logic (`researchSwipeDirection`,
      `researchSwipeTailCapturesWheel`) and not as a wheel gesture on the page;
      `ui/DomSearchBar.tsx` has only a style-contract test, not a
      find-in-page behavior test; `ui/Lightboxes.tsx` has no test of its own.

### Sidebar and organization

- [x] **Verified** — Workspaces and folders as before; unseen badges;
      shortcuts.
      `features/sidebar/*`, `packages/shared/src/research/folders.ts`;
      `sidebar.test.tsx` ("a section reorder moves only its own rows", the
      folder-write rollback tests, "Cmd-click selects multiple items and applies menu actions to the
      selection", "creating a workspace names it and sends the name",
      "displays status badges for unread updates, failures, and active runs", "a mouse press on a row menu item stays with the menu", "a
      press on the row itself still arms the drag");
      `packages/shared/test/researchFolders.test.ts`; `shortcuts.test.tsx`.

### Encyclopedia

- [x] **Verified** — List, page view with Term line, backlinks, rewrite,
      delete; generated on `gemini-flash`.
      `features/encyclopedia/*`, `server/runs/metadata.ts`;
      `encyclopedia.test.tsx` ("the sidebar lists pages alphabetically once
      one exists", "a page names its term when the model titled it
      differently", the backlink labelling tests, "a failed page shows the
      error and offers a rewrite"); `runs.metadata.test.ts` "an encyclopedia
      page is generated, split, and linked" asserts `model: "gemini-flash"`;
      `procedures.test.ts` covers `encyclopedia.deletePage`, which has no
      client-side test of the confirm dialog.

### Settings and account

- [x] **Verified** — GitHub sign-in and sign-out; admin user list with model
      access shown.
      `routes/admin.tsx`, `app/layout/Sidebar.tsx`;
      `packages/server/test/auth.test.ts` ("the start route stores state and a
      verifier and redirects to GitHub", "the callback exchanges the code,
      creates the account, and sets the cookie", "signing out terminates the
      current session and leaves the account's other sessions active");
      `auth.test.tsx` "unauthenticated shell routes redirect to sign-in";
      `admin.test.tsx` "the token column counts only tokens included in the
      limit without double-counting" and "the model
      access column names the gated model only where it applies".
- [x] **Verified** — Appearance, theme, font, text size, hints, motion,
      Cmd-Enter, research instructions, notifications.
      `routes/settings.tsx`; `themeEffects.test.tsx` (the six attribute
      tests), `settingsSync.test.tsx` (server copy, debounce, failure),
      `stores.settings.test.ts`; `library.spec.ts` "the appearance settings
      survive a reload".

### Operations

- [ ] **Partial** — One Fly app with volume, backups, health check; deploy
      during a run resumes it.
      `fly.toml`, `Dockerfile`, `litestream.yml`, `scripts/entrypoint.sh`,
      `scripts/backup-documents.sh`, `docs/runbooks/restore.md`. The
      resume-across-a-deploy behavior is covered by
      `runs.failures.test.ts` "drain interrupts open runs and boot resumes
      them without duplicate turns", and `/healthz` by `app.test.ts`. Automated tests cannot replace actual infrastructure provisioning: creating the app, volume, and certificates, configuring secrets, deploying during an active run, and rehearsing a restore must still be validated manually by an operator.

### Cost and access controls

Enforcement is **on** in the shipped configuration. `web/fly.toml` sets
`SESSION_ENFORCE_LIMITS = "1"`, so the per-account daily token and run limits
refuse rather than merely record, and `SESSION_REQUIRE_INVITE = "1"`, so an
account is created only against a code an admin minted
(`06-auth-and-users.md` §3, §8). Both default to `0` in code and in
`web/.env.example`, so they are explicitly configured in the deployment file, ensuring any changes to these limits are tracked in source control.

`SESSION_QUEUED_PER_USER` (default 20) caps what one account may have waiting.
The concurrency cap limits only active executions, whereas queued runs represent committed resource expenditure and are capped regardless of the `SESSION_ENFORCE_LIMITS` setting.
Per-account overrides for the daily ceilings live in `user_limits` and are set
from `/admin`, so raising one account's limit is not the same as switching
enforcement off (`13-deployment-fly.md` §2).

### Not built, by decision

- `account.delete` (`06-auth-and-users.md` §7) — no `account` namespace and no
  client surface; removing an account is an operator job against the database.
  The only automated deletion path handled by the server is an abandoned sign-up with an unredeemed invite, which deletes both uploaded files from storage and associated database records (`uploads/storage.ts:removeUserDocuments`).
- The reader view for `http(s)` sources (`11-artifacts-and-browser.md` §4) —
  behind `SESSION_READER_VIEW`, and never part of this checklist.

## 9. Open questions

1. Resolved: Google Search grounding is on the only Gemini entry,
   `gemini-flash` (grounding costs $14 per 1k queries after the free tier).
2. Invite allotment policy. Because `SESSION_REQUIRE_INVITE` is enabled in `web/fly.toml` (§8), the remaining decision is the invite allocation policy per account rather than when to activate the requirement.

Decided since the first draft: search vendors are Parallel and Tavily, both
optional (search is unavailable without a key); daily defaults are 1M tokens
and 10 runs per account; attachments are kept indefinitely.

## 10. Parallelization

| Phase | Depends on | Can overlap with |
| --- | --- | --- |
| 0 | — | — |
| 1 shared | 0 | 2, 5 |
| 2 db | 1 | 5 |
| 3 server | 2 | 5, 6 (mocked client) |
| 4 agent loop | 3 | 6 (fixture providers) |
| 5 client foundation | 1 | 2, 3, 4 |
| 6 client features | 3, 5 | 4 |
| 7 artifacts | 3, 5 | 6, 8 |
| 8 deployment | 3, 4 | 6, 7 |
| 9 cutover | all | — |
