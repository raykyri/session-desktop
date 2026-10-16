# Testing, linting, CI

## 1. Tooling

| Concern | Tool | Notes |
| --- | --- | --- |
| Type checking | `tsc -b` with project references | `noUnusedLocals`, `noUnusedParameters`, `strict`, `exactOptionalPropertyTypes` in `shared` and `db` |
| Lint | ESLint 9 flat config | `typescript-eslint` recommended-type-checked, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-plugin-import-x` (package boundaries per ADR-1 and `no-unused-modules` for `shared` and `db`), custom rule banning color literals in `className`/`style` |
| Format | Prettier + `prettier-plugin-tailwindcss` | `printWidth 100`, checked in CI |
| Unit and integration | AVA | one `ava.config.mjs` per package; TypeScript through `--import=tsx`; `client` registers `global-jsdom` and the SVG stub loader in a setup file |
| E2E | Playwright | Chromium by default (`--project=chromium`), WebKit opt-in; one real server started with fixture providers (`SESSION_FIXTURE_PROVIDERS=1`), the test-only sign-in route, and a temp data directory |
| Schema drift | `drizzle-kit check` + generate-and-diff | fails CI when a schema change lacks a migration |
| Security | `npm audit --omit=dev` (report), dependency review action | |

Root scripts (`web/package.json`):

```
dev                       concurrently: server (tsx watch) + client (vite)
build                     tsc -b && npm run build --workspaces --if-present
                          (vite build for the client, esbuild bundle for the server)
test                      npm run test --workspaces --if-present   (AVA per package)
test:e2e                  playwright test --project=chromium
test:e2e:webkit           playwright test --project=webkit
test:e2e:update-snapshots playwright test --project=chromium --update-snapshots
lint                      eslint . && prettier --check .
check                     tsc -b && lint && db:check
db:check                  drizzle-kit check
db:generate               drizzle-kit generate
db:migrate                tsx packages/db/bin/migrate.ts
db:studio                 drizzle-kit studio
db:admin                  tsx packages/db/bin/admin.ts <github login>   (sets users.is_admin)
```

`test:e2e` pins the project because Chromium is the only browser CI runs
and the only one with visual baselines; a machine with WebKit can
run the same behavioral specs through `test:e2e:webkit`. The Playwright web
server command builds the client itself, so `test:e2e` needs no prior build.

## 2. AVA configuration

Per package `ava.config.mjs`:

```js
export default {
  files: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  extensions: ["ts", "tsx"],                 // AVA 8 takes an array; tsx handles ESM
  nodeArguments: ["--import=tsx"],           // client adds "--import=./test/setup.ts"
  environmentVariables: { TSX_TSCONFIG_PATH: "tsconfig.test.json" },
  timeout: "60s",
  workerThreads: false                       // better-sqlite3 and fixture providers prefer real processes
};
```

`client/test/setup.ts` registers `global-jsdom` (with `pretendToBeVisual`),
polyfills `Range.getClientRects`/`caretPositionFromPoint` minimally, and
registers `svgStubLoader.mjs` (carried over from the desktop's
`tests/svgStubLoader.mjs`) through `node:module`'s `register`. Testing
Library's `@testing-library/react` is used with `cleanup` in `test.afterEach`.

Conventions: `test("name", t => { ... })`, `t.is`, `t.deepEqual`,
`t.throws`, `t.true`; `test.serial` for tests that share a temp directory;
`test.before` to open a temp SQLite file and `test.after.always` to remove
it. Snapshot assertions (`t.snapshot`) are used for turn-mapper output and
prompt assembly against recorded fixtures.

## 3. Test layers

### 3.1 Shared (pure)

Every module ported from `src/lib/` retains its corresponding `tests/*.test.ts` file,
converted from `node:test` (`describe/it` + `node:assert`) to AVA. The
conversion is mechanical: `it(...)` → `test(...)`, `assert.equal` → `t.is`,
`assert.deepEqual` → `t.deepEqual`. New fixture-based tests for logic ported
from Rust:

- `revision.test.ts`: canonical JSON and sha256 stability across turn
  shapes.
- `prompts.test.ts`: system prompt assembly, instruction neutralization,
  highlight-anchored follow-up, imported-document follow-up context, tweet
  reference block cap.
- `models.test.ts`: registry, admin gating predicate, effort mapping per
  provider, OpenRouter provider preferences (`zdr`, `data_collection`).
- `researchRecap.test.ts`: source extraction after last tool activity, raw-block
  reset, `Summary:` stripping, 1200-char rejection.
- `wikilinks.test.ts` compatibility parity with `wikilinks.rs` tests.
- `tweets.test.ts`: URL extraction from markdown, 4-cap, placement, failure
  taxonomy, normalization against `tests/fixtures/journal/*.json`.
- `feedCursor.test.ts`: `(occurredAt, sourceRank, id)` ordering.

### 3.2 Database

Repository tests on a temp file (WAL): every invariant in
`02-domain-model-and-database.md` §5, including the inline-slot unique index
message mapping, reorder rejections, the 4-way document check, highlight
revision mismatch, recap guards, feed pagination with ties, `run_turns`
checkpointing and `run_seq` monotonicity, boot reconciliation of orphaned
runs, and migrations applied sequentially from an empty DB.

### 3.3 Agent loop

Against fixture providers implementing the AI SDK provider interface and
replaying recorded stream parts per real provider (success with tool loop,
refusal, rate limit, context overflow, mid-stream error, abort): mapper
output snapshots (`Turn`/`TurnBlock`), `run_turns` and `run_seq`
persistence order, tool budget enforcement (21st search returns the budget
error), `web_fetch` SSRF guard and size caps against a local HTTP fixture
server, context budget elision and summary
insertion, cross-model fork dropping reasoning metadata, medium-effort
`providerOptions` per provider, Google grounding metadata mapped to
synthetic `google_search` tool blocks with Search Suggestions preserved,
usage recording including grounding query counts, daily-limit admission
holds, and the direct Anthropic adapter producing the same stream
shape as `@ai-sdk/anthropic`.

### 3.4 Server

Hono `app.request()` and a tRPC caller (`createCallerFactory`) with a test
context; SSE read as an async iterator. Scenarios: auth flow with a mocked
GitHub, admin gating (`claude-fable` launch by a non-admin is
`PRECONDITION_FAILED`), CSRF rejection, procedure inventory smoke, the
end-to-end research flow with fixture providers (create with documents →
started → thinking → deltas → committed → finished → snapshot → recap
pending/false → highlight → follow-up on another model → cancel → retry),
`seq` continuity and auto-resume across a simulated restart (SIGTERM
handler → `interrupted` + `resume_pending` → boot → re-queued → resumed with
the committed tool exchanges as context and no duplicate turns), admission
and per-provider caps with queue positions, 429 re-queue backoff, interest
filtering, tweet proxy validation and caching, the artifact host's
isolation, widget pages (both pages' CSP, the same-site rule, revisions and
per-user saved inputs, `widgets.test.ts`), the volume file sweep
(`storage.test.ts`). Collaboration: `tenancy.test.ts` is the role ×
procedure matrix (owner, commenter, viewer, a signed-in reader of a public
thread, a stranger to a private one, a guest; each cell on its own thread;
`FORBIDDEN` for a role too low, `NOT_FOUND` for a thread the caller may not
read, `UNAUTHORIZED` for a guest on a signed-in procedure) plus the
workspace-scoped refusals; `collaboration.test.ts` covers invitations, the
event audience (members, a public reader that declared the thread open,
per-user events), presence, notifications, asker-pays queueing and daily
limits, `CONFLICT` on stale edits, the owner's Trash hiding a thread from its
members, removing a member, and image access through the thread;
`events.test.ts` covers `emitToTree` and presence expiry with a fake clock.
In `packages/db`, `collaboration.test.ts` covers the same rules at the
repository level (roles, own-content rules, per-user Archive, Trash and
filing, invitations, payer, Follow, a stale chain order).
`e2e/widgets.spec.ts` runs a widget's script and checks
from inside the frame that cookies, storage, the parent's DOM, `fetch` to the
app and top-level navigation are refused, and that saved inputs survive a
reload.

### 3.5 Client

Testing Library component tests: timeline projection and the live → durable
swap (same DOM), sequence gap handling in the `liveTurns` store, `interrupted`
rendering with Retry/Resume, highlight selection snapping on a fixture DOM,
sidebar reorder and folder state, feed pagination and undo, composer keyboard
behavior, shortcuts dispatcher, escape stack, settings theming attributes on
`<html>`, and the style contract tests (`08-design-system-and-styling.md`
§6). The SSE bridge is tested with a fake subscription emitting event
batches and asserting cache and store state. `sharing.test.tsx` covers the
web-only collaboration UI: the permission rules, what a viewer, a commenter
and the owner are offered on the thread page, author chips and "Edited by",
the Share dialog for the owner and for a member, Notify me, presence and the
renewal of the open-thread declaration, partial tree events merged over the
cache, the stale-edit prompt, Shared with me, the owner's member sentences
in the delete and make-private confirmations, and the invitation routes
(`/invite` with a stored token, the fragment capture, the signed-out
redirect without the token, `/invite/$token` links of the earlier form).
`notifications.test.tsx` covers the inbox page (open marks read and
navigates, Mark all as read, paging) and the bridge refetching it with
toasts off. `test/helpers.tsx` responds to collaboration read procedures
(`sharing.listShared`, `invites.received`, `events.presence`,
`notifications.list`, …) with empty lists by default. Server and database:
`inbox.test.ts` in both packages (follow defaults, storing, paging, marking
read, retention).

### 3.6 E2E (Playwright)

One real server per run, with fixture providers, a temp data directory wiped
before the run, and the test-only `/auth/test-login` route
(`SESSION_TEST_AUTH=1`). The server serves a client build through its own
static middleware — the deployment's arrangement rather than Vite's — and the
build is part of the web-server command, so `npm run test:e2e` is one step. One
worker, because the specs share the server and the run queue is per user. Each
spec signs in as its own login so the accounts, and therefore the feeds, stay
apart, and every login carries the run's id and, on a retry, the attempt
number (`e2e/helpers.ts:e2eLogin`, the id set once in `playwright.config.ts`):
a retry or a second run against the same server starts from fresh accounts
instead of finding an earlier attempt's folders and threads. A spec that needs
a login itself (an invitation, a member list) reads it from `signIn`'s
result.

The port is `SESSION_E2E_PORT` (default 8788) and the data directory is per
port (`$TMPDIR/session-web-e2e-<port>`). Playwright starts its own server and
refuses a port that is already in use; `SESSION_E2E_REUSE_SERVER=1` runs
against a server already listening there (one started manually, for
iteration). The server binds `::` unless `SESSION_E2E_HOST` names
another address; on a machine or container without IPv6, set it to
`127.0.0.1` (Chromium tries the IPv4 loopback for `localhost` when `::1`
refuses, so the artifact origin still reaches the server). The queue spec does not depend on the root answer's timing past
its first Queue: the second item queues behind the first, which is itself a
paced answer, so Cancel always reaches it before it could be sent.

Fixture scenarios are chosen by a `fixture:<scenario>` marker in the prompt
(`packages/server/src/runs/fixtureProvider.ts`). Unmarked prompts replay
`success-with-tools`, which is the default; the suite also names
`paced-answer` (deltas stretched over seconds, so "mid-stream" is a state a
browser can be in) and `long-answer` (past `MIN_RECAP_CHARS`, so a run
schedules a recap). Nothing in the suite reaches the network: the fixture
providers answer for the models, `web_search` is unregistered because no
search key is set, and `web_fetch` reads the fixture's page in process
(`fixturePageFetch`). With fixture providers the server's own fetches (link
post hydration) also go to `fixturePageFetch`, which serves the X
syndication request for `FIXTURE_TWEET_ID` with a fixed post.

| Spec | What it drives |
| --- | --- |
| `research.spec.ts` | Launch and stream; the Sources footer; the durable read after a reload equals the streamed text; a reload mid-stream plus a second tab on the same run; select → Highlight → the Highlights feed (Refresh, Remove highlight); a follow-up queued while the answer streams, Cancel, and Edit question on a queued follow-up behind a stopped answer; Ask docked to the passage, a branch card in the rail, then an inline follow-up on a different model; the recap dialog generating and applying; the sign-in gate |
| `library.spec.ts` | Save a note and a link (the link's card shows its X post label); create a folder, drag a card into its tray and nest one card under another; Delete → Move to Trash, Restore, then Delete now and Empty Trash; Save draft → open from Drafts → Send; a finished thread on Home and Move to Archive; Markdown report import; the composer text and the appearance and theme pickers surviving a reload; Reduce motion and Require ⌘↵ to send taking effect and persisting |
| `live.spec.ts` | Changes by a thread's owner while others have it open, each user in their own context: a commenter made a viewer loses the ask box and their queued follow-up (held behind a stopped answer, so it cannot be sent first); Archive turns a member's ask box read-only while a public reader keeps reading, and Make private shows the reader the unavailable state while the member keeps the thread; Trash shows the unavailable state to a member and a public reader; a removed member gets the unavailable state and leaves the owner's presence avatars; presence avatars appear when a member opens the thread and go when they navigate away or close the tab; a public reader who left for Home and a guest each see, on going back, a question the owner asked meanwhile. Waits are on UI state: the owner's presence avatars confirm that a reader's open-thread declaration reached the server, or that it was withdrawn |
| `collaboration.spec.ts` | Accounts and a guest, each in its own browser context. Through the UI: the owner copies a commenter and a viewer invitation link (`/invite#<token>`) from the Share dialog; the commenter opens theirs, lands on the thread and asks (counted in their usage); the owner's open page shows the question live with the commenter's author chip and opens its answer; the viewer's page has no ask box and shows them as Viewer; a thread made Public in the dialog opens read-only for a guest; a stale note edit opens "This note changed", Reload keeps the text and the next save succeeds; signed out, an invitation link goes to `/login?redirect=/invite` with the token in no URL, and after signing in `/invite` accepts it; an `/invite/<token>` link of the earlier form still accepts; a member's question appears as an unread badge on the owner's Notifications row without a reload, the inbox entry opens the thread and is marked read, and the member clears their run notification with Mark all as read. Through the tRPC endpoint: invite by link and by login and accept; a viewer is `FORBIDDEN` to ask; a public thread opens for another account and a guest; a member's page shows the owner's new question without a reload; a stale note edit is `CONFLICT` |
| `admin.spec.ts` |
 `claude-fable` visible in the composer's model menu for administrators and hidden for other users |
| `visual.spec.ts` | Screenshots of Home and a finished document in all four theme × appearance combinations. Tagged `@visual`, Chromium only, baselines committed per platform under `e2e/__screenshots__/{platform}/`. The account name (it carries the run's id) and relative times are masked. The Linux set is rendered by CI's `e2e` job in Playwright's image (§4) and fails CI when missing; outside CI a platform without a set skips. Another Linux machine's browser build can render text a pixel apart, so run the suite there with `--grep-invert @visual`. The `darwin` set predates several UI changes and needs regenerating on a Mac (`npm run test:e2e:update-snapshots -- --grep @visual`) |

## 4. CI (GitHub Actions, `.github/workflows/web.yml`)

Triggers on pushes and PRs touching `web/**`. Jobs:

1. `check`: `npm ci`, `npm run check` (`tsc -b`, ESLint, Prettier,
   `drizzle-kit check`).
2. `test`: `npm ci`, `npm test` — AVA in every package. Node 22.
3. `e2e`: in the `mcr.microsoft.com/playwright:v<version>-noble` container,
   whose tag must equal the locked `@playwright/test` version (a step checks
   it; change both together). `npm ci`, then `npm run test:e2e`, which builds
   the client and starts the server itself on `127.0.0.1`
   (`SESSION_E2E_HOST`; the container has no IPv6). `web/test-results` and
   `web/playwright-report` are uploaded on failure. The image fixes the
   browser build, fonts and system libraries, so the `@visual` screenshots
   are the same on every run, and the Linux baselines are this job's own
   renders: screenshots taken elsewhere differ (a different Chromium build
   or FreeType moves glyph edges by a pixel across all text), so they are
   not used. To regenerate the set after an intended UI change or a
   Playwright upgrade: Actions → web → Run workflow on the branch with
   `update-visual-baselines` checked. The job then runs only `@visual` with
   `--update-snapshots=all` and uploads the `visual-baselines-linux`
   artifact; commit its PNGs to `web/e2e/__screenshots__/linux/`.
4. `docker`: build `web/Dockerfile` with the Buildx GitHub cache and never
   push it, so a Dockerfile change cannot break a deploy unnoticed.
5. `deploy`: on a push to `main` only, needs all four, and runs
   `flyctl deploy web --remote-only -c web/fly.toml` in the `production`
   environment, whose reviewers hold `FLY_API_TOKEN`.

The desktop's root `npm run preflight` is unaffected except that
`test:integration` (the landing server test) is removed.

The desktop has its own workflow, `.github/workflows/desktop.yml`, which also
runs when `web/packages/shared/**` changes, since the desktop imports it:
`frontend` (type checks of the app and the tests, the unused-module check,
`npm run test:unit`, the production build), `rust` on Linux (`cargo fmt
--check` and `cargo test --workspace` in `src-tauri`, with the WebKitGTK and
GTK development packages Tauri needs) and `native` on macOS (`cargo test`
again for the `cfg(target_os = "macos")` code, and the Swift package's
tests, which need AppKit). A Rust test that needs an installed agent CLI must
configure one itself, since the runners have none
(`test_config_with_installed_claude` in `src-tauri/src/state.rs`).

## 5. Coverage targets

Intended: `shared` ≥ 90% lines, `db` ≥ 85%, `server/runs` ≥ 80% with fixture
providers, rest of `server` ≥ 75%; client components covered by behavior tests
rather than a line target.

Not yet configured: CI does not currently execute a coverage reporter, so these figures serve as development targets rather than enforced quality gates.
