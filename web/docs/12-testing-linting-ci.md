# Testing, linting, CI

## 1. Tooling

| Concern | Tool | Notes |
| --- | --- | --- |
| Type checking | `tsc -b` with project references | `noUnusedLocals`, `noUnusedParameters`, `strict`, `exactOptionalPropertyTypes` in `shared` and `db` |
| Lint | ESLint 9 flat config | `typescript-eslint` recommended-type-checked, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`, `eslint-plugin-import-x` (package boundaries per ADR-1 and `no-unused-modules` for `shared` and `db`), custom rule banning color literals in `className`/`style` |
| Format | Prettier + `prettier-plugin-tailwindcss` | `printWidth 100`, checked in CI |
| Unit and integration | AVA | one `ava.config.mjs` per package; TypeScript through `--import=tsx`; `client` registers `global-jsdom` and the SVG stub loader in a setup file |
| E2E | Playwright | Chromium and WebKit; server started with fixture providers (`SESSION_FIXTURE_PROVIDERS=1`) and a temp DB |
| Schema drift | `drizzle-kit check` + generate-and-diff | fails CI when a schema change lacks a migration |
| Security | `npm audit --omit=dev` (report), dependency review action | |

Root scripts (`web/package.json`):

```
dev              concurrently: server (tsx watch) + client (vite)
build            tsc -b && vite build (client) && esbuild bundle (server)
test             npm run test --workspaces --if-present   (AVA per package)
test:e2e         playwright test
lint             eslint . && prettier --check .
check            tsc -b && lint && drizzle-kit check
db:generate      drizzle-kit generate
db:migrate       node packages/db/bin/migrate.js
db:studio        drizzle-kit studio
db:admin         node packages/db/bin/admin.js <github login>   (sets users.is_admin)
```

## 2. AVA configuration

Per package `ava.config.mjs`:

```js
export default {
  files: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  extensions: { ts: "module", tsx: "module" },
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
- `recap.test.ts`: source extraction after last tool activity, raw-block
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

Against a real server with fixture providers, a temp DB, and a test-only
`/auth/test-login` route (`SESSION_TEST_AUTH=1`): sign in → attach a PDF and
create research → watch stream and sources → reload mid-stream and see the
same content → open a second tab and see it progress → highlight → ask →
inline follow-up on a different model → recap → bookmark → Home and
Bookmarks → archive → import report → encyclopedia page from a wikilink →
settings theme switch persists across reload → document preview opens in
the iframe → admin sees gated models, non-admin does not. Visual snapshots of Home and a document in all
four theme × appearance combinations.

## 4. CI (GitHub Actions, `.github/workflows/web.yml`)

Triggers on pushes and PRs touching `web/**`. Jobs:

1. `check`: `npm ci`, `npm run check`.
2. `test`: `npm test` per package with coverage (`c8`) upload; Node 22.
3. `e2e`: build, install Playwright browsers, run e2e, upload traces on
   failure.
4. `docker`: build the image (no push); on `main`, `flyctl deploy` with
   `FLY_API_TOKEN` behind a manual approval environment.

The desktop's root `npm run preflight` is unaffected except that
`test:integration` (the landing server test) is removed.

## 5. Coverage targets

`shared` ≥ 90% lines, `db` ≥ 85%, `server/runs` ≥ 80% with fixture
providers, rest of `server` ≥ 75%; client components covered by behavior tests rather than a line
target. Coverage is reported, not gating, except for `shared`.
