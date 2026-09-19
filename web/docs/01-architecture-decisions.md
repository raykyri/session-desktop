# Architecture decisions

Each decision records the requirement it serves, the options weighed, the
choice, and consequences. Decisions are numbered for reference from other
documents (ADR-n).

## ADR-1 Repository layout: npm workspaces inside `web/`

Requirement: the web app lives in `web/`, uses npm, and keeps ORM/database code
isolated from HTTP and UI code.

Options
1. One package with `src/client`, `src/server`, `src/shared` directories and
   several tsconfigs.
2. npm workspaces with separate packages.
3. A separate repository.

Choice: option 2. `web/package.json` is a workspaces root with
`packages/shared`, `packages/db`, `packages/server`, `packages/client`.

Why: Strict dependency isolation is required here. `better-sqlite3` is a native module
that must never be resolved by the client bundle; React must never be a server
dependency; the database package must have no HTTP or React imports so it can
be reused by the migration CLI. Workspaces enforce this through
`package.json` boundaries and per-package `tsconfig` with project references.
Option 3 was rejected because the migration requires access to the desktop's
`src/lib/*` and `tests/*`, and the root `package.json` already defines the
desktop workspace. Both applications share one repository until the desktop
is retired.

Consequences: `web/` is self-contained. The repo root keeps the desktop's
`package.json`; `cd web && npm install` is the web entry point. The root
`scripts/check-unused-modules.mjs` stops scanning `web/`.

Package dependency graph (arrows mean "may import"):

```
client ──► shared
server ──► shared, db
db     ──► shared
shared ──► (nothing internal)
```

## ADR-2 Server framework: Hono on Node 22

Requirement: serve static assets, tRPC, SSE, authenticated file routes, OAuth
callbacks; small, typed, testable without sockets.

Options: Express 5, Fastify 5, Hono, Nest, plain `node:http` (as the landing
server does).

Choice: Hono with `@hono/node-server`.

Why: Hono's `app.request()` lets integration tests call handlers without
binding a port (the landing server's tests had to listen on a port). Its
streaming helpers (`streamSSE`) fit the event channel. It has first-class
tRPC and static-file adapters and a small surface. Fastify is a viable alternative if an extensive plugin ecosystem were required, but lightweight custom middleware in Hono adequately addresses this application's needs.

Consequences: middleware for security headers, request ids, session lookup,
CSRF origin checks, and logging is written in-house (~200 lines total).

## ADR-3 API style: tRPC v11 for procedures, SSE for events

Requirement: replace ~160 Tauri `invoke()` wrappers (of which ~60 are
research-relevant) with typed calls; replace the `session-event` channel with
push; keep `src/lib/api.ts` signatures so ported modules compile.

Options
1. REST with hand-written zod validators and an OpenAPI document.
2. Hono RPC (`hc`) typed client.
3. tRPC v11 with TanStack Query integration.
4. GraphQL.

Choice: option 3. Procedures mirror the Tauri command names in camelCase
(`research.createTree`, `research.forkNode`, `journal.fetchTweet`). The event
stream is a tRPC subscription (`events.subscribe`) transported over SSE using
tRPC's `httpSubscriptionLink`. Reconnection does not replay: run events carry
per-node sequence numbers and clients resynchronize from a snapshot
(`05-run-lifecycle-and-streaming.md` §4), so no server-side event buffer
exists.

Why: The desktop API is organized around remote procedure calls rather than RESTful resources; mapping it to REST endpoints would require introducing an unnecessary abstraction layer. tRPC gives end-to-end types from
the router, integrates with TanStack Query (mutations invalidate or patch
queries), and its SSE subscriptions replace the Tauri event listener with the
same "one connection, many event types" shape. Hono RPC was close but lacks
subscriptions and query-cache integration. GraphQL adds a schema layer the
team does not need.

Consequences: `packages/client/src/api/api.ts` re-exports functions with the
desktop's names (`createResearchTree`, `forkResearchNode`, …) implemented over
the tRPC client, so ported components keep their imports. Streaming of run
output is a set of event types, not a separate socket (`03-api-and-events.md`
§4). WebSockets are unnecessary because the client does not stream data to the server.

## ADR-4 Database: SQLite via better-sqlite3 with Drizzle ORM

Requirement: SQLite, Drizzle or another ORM, isolated ORM and DB management
code, migrations, deploy to Fly.

Options for driver: `better-sqlite3` (synchronous, mature, native),
`node:sqlite` (built into Node 22.5+, was still experimental when this plan
was written), `@libsql/client` (Turso/libsql, supports remote replicas).
Options for ORM: Drizzle, Prisma, Kysely.

Choice: `better-sqlite3` + Drizzle ORM + `drizzle-kit` migrations.

Why: `better-sqlite3` is the fastest and most battle-tested Node SQLite
binding; synchronous calls are correct for SQLite (one writer, sub-millisecond
statements) and make transactions trivial. Drizzle's schema-as-TypeScript
gives typed rows without codegen, its migration generator produces reviewable
SQL, and its SQLite dialect exposes `pragma`s and raw SQL where needed. Prisma's
engine adds a binary and its SQLite transaction model is weaker. The built-in `node:sqlite` module is a promising option because it requires no native dependencies; this should be revisited once it becomes stable in the pinned Node LTS release.

Settings applied on open: `journal_mode=WAL`, `synchronous=NORMAL` by default
and `FULL` inside the snapshot-commit transaction, `foreign_keys=ON`,
`busy_timeout=5000`, `temp_store=MEMORY`.

Consequences: single-process writer; the Fly deployment is one machine.
Response snapshots (up to 64 MiB) are stored as JSON text in SQLite; this is
within SQLite's limits and keeps the snapshot commit atomic with the node
status update. Backups use Litestream (WAL streaming) rather than file copies.

## ADR-5 Authentication: GitHub OAuth (PKCE) with DB-backed cookie sessions

Requirement: user management for a web app whose desktop predecessor was
single-user; GitHub identity already exists in the product.

Options: Auth.js, better-auth, Lucia-style hand-rolled sessions with `arctic`
for OAuth, Clerk/Auth0 (hosted).

Choice: hand-rolled sessions (`sessions` table, 32-byte random id, HttpOnly
Secure SameSite=Lax cookie, sliding expiry: 30 days idle, 90 days absolute) with `arctic` performing
the GitHub authorization-code + PKCE exchange. Sign-up is open to any GitHub account; `users.is_admin` is a
manually set database flag that gates the expensive models
(`06-auth-and-users.md` §3). Rate limits on sign-up and usage come later.

Why: the desktop uses the device flow so that no client secret ships with
the app (`github_auth.rs:1-7`); a web server can hold a secret, so the
standard code flow with PKCE applies. The required functionality (one provider,
sessions, and an allowlist) requires about 300 lines. Existing authentication
frameworks impose schemas that conflict with the Drizzle database design.
`better-auth` is the fallback if a second provider or passkeys are added.

Consequences: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` become Fly
secrets. The desktop's stored `githubToken` is not needed (it gated nothing).

## ADR-6 Client state: TanStack Query for server data, Zustand for UI state

Requirement: replace 108 `useState` + 150 mirror refs in `App.tsx`; support
event-driven patching, optimistic-concurrency tokens, streaming deltas for the
open node, persisted navigation and drafts, many independent slices.

Options considered
1. Redux Toolkit (+ RTK Query).
2. Zustand alone with hand-rolled fetch caching.
3. Jotai atoms.
4. TanStack Query for server state + Zustand for UI state.
5. XState stores.

Choice: option 4.

Why: the app's data is server-authoritative and event-patched. TanStack
Query models this directly: `queryClient.setQueryData` applies the existing
`researchEvents.ts` reducers (`patchTreeSummary`, `upsertActivityNode`, …) to
cached lists, and `invalidateQueries` implements the "authoritative refetch on
malformed event" rule. Mutations return the same detail objects the desktop
commands return and are written into the cache. UI state (navigation history,
selection, overlay stack, drafts, sidebar width, settings) is small,
synchronous, and benefits from Zustand's selector subscriptions and `persist`
middleware, which replaces the ad-hoc localStorage loaders. Redux would work
but its cache layer duplicates Query and its boilerplate is unjustified for a
one-team app. Jotai's atom graph fits derived UI state well but not
server-cache semantics (staleness, refetch, dedupe). Streaming deltas for the
active node go into a dedicated Zustand store keyed by node id, cleared when
the durable snapshot arrives; they never touch the query cache, so a stream at
30 events/s does not invalidate list queries.

Consequences: no component reads global state through refs; the SSE bridge is
the one place that writes cache patches; `useSessionEvents.ts`'s 16 ms
coalescing is preserved by batching patches with `queryClient` notifications
suppressed (`notifyManager.batch`).

## ADR-7 Routing: TanStack Router with URL-addressable views

Requirement: the desktop app has no URLs; the web app must support reload,
deep links, back/forward, multiple tabs.

Options: React Router 7, TanStack Router, hand-rolled history like today.

Choice: TanStack Router (code-based route tree, not file-based, to keep the
route list reviewable in one file).

Why: type-safe params and search params matter here because the desktop
persisted several view coordinates (visibility filter, folder scope, selected
node, focused highlight) that become search params. TanStack Router validates
search params with zod and integrates with TanStack Query loaders.

Routes (`07-client-architecture.md` §3): `/login`, `/` (Home),
`/bookmarks`, `/highlights`, `/r/$treeId` with `?node=&highlight=`,
`/e/$slug`, `/settings`, `/admin`. The workspace scope is `?ws=` on list
routes and is remembered server-side per user as the default.

Consequences: the desktop's `ResearchWorkspaceHistory` reducer is replaced by
browser history for cross-page navigation; the per-document node history
(`ResearchHistory`) stays as a store because it is intra-page.

## ADR-8 Styling: Tailwind v4 over the preserved token system

Requirement: use Tailwind; preserve the visual design (two color themes × two
appearances, semantic tokens, typography contracts).

Options
1. Rewrite all 12k lines of CSS as utilities.
2. Keep all CSS as-is and add Tailwind only for new code.
3. Keep `tokens.css` verbatim, map tokens into `@theme inline`, port component
   styles to utilities, keep prose and a few recipes as scoped CSS.

Choice: option 3.

Why: `tokens.css` defines the entire design system via CSS variables toggled by `data-color-theme` and `data-appearance` on `<html>`, which Tailwind v4 consumes natively. Markdown output cannot receive utility classes without
custom renderers for every element, so `.research-prose` and the code/table
rules stay as plain CSS in `@layer components`. Everything else (sidebar rows,
cards, dialogs, menus) becomes utilities on components, which is where the
12k lines shrink.

Naming: Tailwind's `--text-*` namespace is font size; the app's `--text-*`
tokens are colors. The mapping renames the color ramp under `--color-fg-*`
(`text-fg-primary`) and exposes the type scale as `--text-xs/sm/base/input`
pointing at `--fs-*`. `08-design-system-and-styling.md` §2 has the full table.

Consequences: the textual CSS contract tests are re-expressed
(`08-design-system-and-styling.md` §6). Fonts stay as `@font-face` blocks.

## ADR-9 Component primitives: Base UI

Requirement: dialogs, menus, context menus, popovers, listbox/select with a
custom row, tooltips; keyboard and focus behavior; a dismiss stack that fixes
the desktop's hand-ordered Escape dispatcher (`App.tsx:9094-9220`).

Options: Radix Primitives, Base UI (`@base-ui-components/react`), React Aria
Components, shadcn/ui (Radix + Tailwind copy-in), headless UI, keep native
`<dialog>` and hand-rolled menus.

Choice: Base UI, wrapped once per primitive in `packages/client/src/ui/`.

Why: unstyled, composable, Tailwind-friendly, portal and focus management,
nested dismissal handled by the library, `render` prop for custom elements
(the `LauncherSelect` submenu row), and active maintenance by the MUI team.
Radix is equivalent in capability and serves as a fallback if Base UI lacks a required primitive; the abstraction wrappers ensure any future replacement is isolated to a single module. shadcn/ui
was rejected because its copied components carry their own token scheme.
Native `<dialog>` is kept for the report-import and confirm dialogs where it
already works, wrapped in the same `Dialog` API.

Consequences: `CommandPalette`, `LinkContextMenu`, `LauncherSelect`,
`ResearchTreeMenu`, folder switcher, and every context menu are rebuilt on the
wrappers; the desktop's `clampContextMenuToViewport` and `placePanePopover`
math is replaced by the library's positioning.

## ADR-10 Agent execution: an owned agent loop over provider APIs

Requirement: run research turns with four models on a hosted service, with
uniform tooling, forking, resume, and cost control.

Options
1. Spawn the coding-agent CLIs the desktop used (Claude Code, Codex, Grok)
   as child processes and parse their JSONL protocols.
2. Own the agent loop: call provider APIs directly, supply the tools.
3. Anthropic Managed Agents or similar hosted agent runtimes per provider.

Choice: option 2, implemented with the Vercel AI SDK (`streamText`,
`stopWhen`, `tool()`, provider packages for Vertex, OpenRouter, Anthropic),
with `@anthropic-ai/sdk` as a per-provider escape hatch if a Fable
5.1 requirement is not expressible through the SDK (`04-agent-runtime.md`
§7).

Why: the CLIs brought tuned tools but also child processes, per-user HOME
directories, CLI version drift, argv limits, opaque session files, and a
provider set (Claude, Codex, Grok) that no longer matches the product's
model roster. Managing the agent loop directly allows conversation history to be persisted in SQLite, simplifying forking, multi-model threads, post-deployment resumption, and usage tracking into standard database queries. Option 3 does not cover Gemini or DeepSeek and
would fragment the loop. The cost is building and tuning `web_search` and
`web_fetch` ourselves.

Consequences: no runner service, no fake CLIs (fixture providers instead),
no user credentials; the app pays for tokens; admin gating for expensive
models; an eval set is required to keep research quality at the desktop's
level.

## ADR-11 Streaming: snapshot plus ordered deltas, durable while running

Requirement: stream answers, let any tab join or rejoin, keep output across
deploys.

Choice: every run event carries a per-node `seq`; `getNodeContent` returns
committed turns, the in-flight checkpoint, and the `seq` they reflect;
clients apply only `seq + 1`, drop replays, refetch on gaps, mount,
visibility, and reconnect. Committed turns persist immediately, in-flight
text at most one second stale. On deploy the server marks running nodes
`interrupted` and auto-resumes them on boot from the persisted conversation
(`05-run-lifecycle-and-streaming.md`). Alternatives rejected: a global
`Last-Event-ID` replay buffer; polling; WebSockets.

## ADR-12 Testing and quality tooling

Choice: AVA as the test runner for every package (`shared`, `db`, `server`
in plain Node; `client` with `global-jsdom` registered in a setup
file and Testing Library), Playwright for e2e against a real server with fixture
providers, ESLint 9 flat config with typescript-eslint (strict, type-checked),
`eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`,
`eslint-plugin-import-x` for package boundaries, Prettier with
`prettier-plugin-tailwindcss`, `tsc -b` for type checking.

Why AVA: the desktop's tests are plain `node:test` files with `node:assert`;
AVA keeps that flavor (isolated processes per file, no globals, `t.is`/`t.deepEqual`,
first-class TypeScript through `--import=tsx`) and its per-file process
isolation suits tests that open temp SQLite files and run fixture providers. The
desktop's `tests/svgStubLoader.mjs` loader hook carries over unchanged for
component tests. Vitest was considered for its Vite pipeline integration and
rejected by the owner's preference.

No unused-export tool is used; `tsc`'s `noUnusedLocals` and ESLint's
`import-x/no-unused-modules` (enabled for `shared` and `db`) cover unused
code.

## ADR-13 Deployment: one Fly app, one machine, volume, Litestream

Choice: Fly app `session-dev` at `https://session.dev` with
`artifacts.session.dev` as a second hostname, one region, one
`shared-cpu-2x` / 2 GB machine, a 20 GB volume at `/data` holding SQLite and
attached documents, `auto_stop_machines = "off"`, `min_machines_running = 1`,
Litestream replicating `/data/session.db` to object storage and a nightly
archive of `/data/documents`, `/healthz` for Fly checks.

Why: SQLite implies a single writer and Fly volumes are single-attach.
Agent runs are HTTPS streams, not processes, so they fit in the web process
and deploys are handled by resume rather than by a second app
(`05-run-lifecycle-and-streaming.md` §6).

## ADR-14 Identifiers, time, statuses

Ids are ULIDs (`[0-9A-HJKMNP-TV-Z]{26}`) for every row. Timestamps are integer
milliseconds since the Unix epoch. Node statuses are `queued | running |
complete | failed | cancelled | interrupted`; The `interrupted` status was added, and the legacy `starting` status was removed because processes are no longer spawned. No desktop identifier or file
format is accepted.

## ADR-15 What "workspace" means in the web app

The desktop's `GroupInfo` with `scope: research` is a workspace bound to a
user-chosen folder on disk; research folders are a client-authored grouping
over trees within a workspace. On the web, a workspace is a purely
server-side container owned by a user: a scope for trees, folders,
encyclopedia pages, and the feed filter. It has no associated directory, and
agents have no filesystem access. Native folder pickers, "reveal in Finder",
moving a workspace to another folder, and detached on-disk archives are
replaced by workspace creation, renaming, removal, reordering, and default
selection.

## ADR-16 Models, effort, and access

Choice: a code-level model registry: `gemini-flash` (Gemini 3.8 Flash on
Vertex AI via a service account with Google Search grounding; default; runs
every metadata job),
`deepseek-flash` (DeepSeek V4.1 Flash via OpenRouter) and `gpt-luna`
(GPT-5.6 Luna via OpenRouter, `~openai/gpt-luna-latest`), both restricted to
zero-data-retention, no-collection providers with `zdr: true` and
`data_collection: "deny"`; `claude-fable` (Claude Fable 5.1, Anthropic API)
for `is_admin = 1` users only, enforced server-side on every launch.
Reasoning effort is fixed at medium and not exposed. Users may pick a
different model on a follow-up; reasoning blocks are dropped on cross-model
forks. GPT-6 Astra is deferred.

Why: Gemini quota is readily available, and DeepSeek Flash and GPT-5.6 Luna have low inference costs; Claude Fable is expensive and restricted to admins until per-account usage limits are active. OpenRouter gives one integration and
one privacy control for both third-party models. One effort level removes a
per-model options matrix from the UI and the eval.

## ADR-17 Tools: owned web search and fetch for every model

Choice: `web_search` (vendor behind one interface, cached), `web_fetch`
(server-side fetch with SSRF guard and readable-text extraction, cached),
and `document_read` (attached documents), supplied to every model, plus one
native alternative: `gemini-flash` uses Google Search grounding
inside Gemini instead of the owned search tool, rendered through the same
activity and Sources UI.

Why: uniform activity and source rendering, one cache and cost meter, fair
comparison between models, and DeepSeek and Luna (through OpenRouter) have
no native web tool. Google grounding is included because Gemini is the
default and the team has the quota; comparing it against owned search is
part of the eval.

## ADR-18 Documents as context

Choice: users attach files to a question; files are stored on the volume,
text-extracted server-side, and passed to providers as native file or image
parts where supported and as text otherwise (`04-agent-runtime.md` §8).
Documents attached to a node are in context for its descendants and are
also served through the artifact preview.

Why: Local filesystem tools like Read and Grep cannot be used in a hosted web environment; user-uploaded documents provide the web equivalent for referencing local files.

