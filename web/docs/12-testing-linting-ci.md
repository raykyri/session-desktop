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

`test:e2e` pins the project because the Chromium browser is the only one CI
installs and the only one carrying visual baselines; a machine with WebKit can
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

Every module ported from `src/lib/` brings its `tests/*.test.ts` file,
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
- `slug.test.ts`, `wikilinks.test.ts` parity with `wikilinks.rs` tests.
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
server, `document_read` chunking, context budget elision and summary
insertion, cross-model fork dropping reasoning metadata, medium-effort
`providerOptions` per provider, Google grounding metadata mapped to
synthetic `google_search` tool blocks with Search Suggestions preserved,
usage recording including grounding query counts, daily-limit admission
holds, and the Anthropic escape hatch adapter producing the same stream
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
filtering, upload limits and extraction, tweet proxy validation and caching,
artifact token expiry.

### 3.5 Client

Testing Library component tests: timeline projection and the live → durable
swap (same DOM), sequence gap handling in the `liveTurns` store, `interrupted`
rendering with Retry/Resume, highlight selection snapping on a fixture DOM,
sidebar reorder and folder state, feed pagination and undo, composer keyboard
behavior, shortcuts dispatcher, escape stack, settings theming attributes on
`<html>`, and the style contract tests (`08-design-system-and-styling.md`
§6). The SSE bridge is tested with a fake subscription emitting event
batches and asserting cache and store state.

### 3.6 E2E (Playwright)

One real server per run, with fixture providers, a temp data directory wiped
before the run, and the test-only `/auth/test-login` route
(`SESSION_TEST_AUTH=1`). The server serves a client build through its own
static middleware — the deployment's arrangement rather than Vite's — and the
build is part of the web-server command, so `npm run test:e2e` is one step. One
worker, because the specs share the server and the run queue is per user. Each
spec signs in as its own login so the accounts, and therefore the feeds, stay
apart.

Fixture scenarios are chosen by a `fixture:<scenario>` marker in the prompt
(`packages/server/src/runs/fixtureProvider.ts`). Unmarked prompts replay
`success-with-tools`, which is the default; the suite also names
`paced-answer` (deltas stretched over seconds, so "mid-stream" is a state a
browser can be in) and `long-answer` (past `MIN_RECAP_CHARS`, so a run
schedules a recap). Nothing in the suite reaches the network: the fixture
providers answer for the models, `web_search` is unregistered because no
search key is set, and `web_fetch` reads the fixture's page in process
(`fixturePageFetch`).

| Spec | What it drives |
| --- | --- |
| `research.spec.ts` | Launch and stream; the Sources footer; the durable read after a reload equals the streamed text; a reload mid-stream plus a second tab on the same run; select → Highlight → the Highlights feed; Ask docked to the passage, a branch card in the rail, then an inline follow-up on a different model; the recap dialog generating and applying; the sign-in gate |
| `library.spec.ts` | Bookmark → Home and Bookmarks; archive from the sidebar row menu and the archived filter; Markdown report import; a wikilink opening its encyclopedia page; the appearance and theme pickers surviving a reload |
| `artifacts.spec.ts` | Attach a Markdown document, open its chip into the preview panel, framed from the artifact origin with the expected `sandbox`; Reload, Shift-Cmd-E, Escape |
| `admin.spec.ts` | `claude-fable` offered in the composer's model menu to an admin and absent for everyone else |
| `visual.spec.ts` | Screenshots of Home and a finished document in all four theme × appearance combinations. Tagged `@visual`, Chromium only, baselines committed per platform under `e2e/__screenshots__/{platform}/`; a platform without a set skips rather than fails |

## 4. CI (GitHub Actions, `.github/workflows/web.yml`)

Triggers on pushes and PRs touching `web/**`. Jobs:

1. `check`: `npm ci`, `npm run check` (`tsc -b`, ESLint, Prettier,
   `drizzle-kit check`).
2. `test`: `npm ci`, `npm test` — AVA in every package. Node 22.
3. `e2e`: `npm ci`, `npx playwright install --with-deps chromium`, then
   `npm run test:e2e`, which builds the client and starts the server itself.
   `web/test-results` and `web/playwright-report` are uploaded on failure.
   Only Chromium is installed, so the `@visual` test skips itself for want of
   Linux baselines; to add them, run `npm run test:e2e:update-snapshots` on
   that image and commit `web/e2e/__screenshots__/linux/`.
4. `docker`: build `web/Dockerfile` with the Buildx GitHub cache and never
   push it, so a Dockerfile change cannot break a deploy unnoticed.
5. `deploy`: on a push to `main` only, needs all four, and runs
   `flyctl deploy web --remote-only -c web/fly.toml` in the `production`
   environment, whose reviewers hold `FLY_API_TOKEN`.

The desktop's root `npm run preflight` is unaffected except that
`test:integration` (the landing server test) is removed.

## 5. Coverage targets

Intended: `shared` ≥ 90% lines, `db` ≥ 85%, `server/runs` ≥ 80% with fixture
providers, rest of `server` ≥ 75%; client components covered by behavior tests
rather than a line target.

Not yet wired: no coverage reporter runs in CI, so these are targets to aim a
later change at rather than numbers anything enforces today.
