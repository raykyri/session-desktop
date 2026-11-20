# 05 — Delivery

Status: draft. This file orders the work from the finished phase 0 prototype
(`web/packages/replica-proto`) to the web launch, in dependency order. For
each milestone it states the scope (as item ids from 01-04), the exit criteria
as commands or named tests, then covers the repository and branch,
deployment and launch, observability, risks and the open questions of the
whole plan. The designs it schedules are in `01-architecture-and-data.md`
(server half, data, mutators, sync, contract changes), `02-client-app.md`
(client), `03-agents-and-research.md` (runs) and
`04-membership-moderation-security.md` (membership, moderation, security).
Rules come from `AGENTS.md` ("Planned: desktop client and sync core") and
ADR-19 to ADR-22; where this file restates one, the source wins.

Scope: this build is web only (`00-overview.md`, "Scope of this build"). No
desktop (Tauri) client, no device runs, no device tokens, no desktop storage
adapter or CORS origin, no "Update Session" desktop prompt, no macOS testing
and no phone app. The desktop app was never in production, so there is no
desktop cutover. The launch replaces the current web app and wipes all of
its data, accounts included (§3.5). Milestones, items, risks and questions
that existed only for the desktop, device runs or the phone are marked
"(removed: web-only build)" and keep their ids.

Naming: milestones are `M0`-`M8` with letter suffixes. Item ids of other files
are always prefixed with the file number ("`01` U6", "`04` O2"). 01's mutator
items are `U1`-`U6`, so an unprefixed `M` id is always a milestone. Ids per
file: 01 `S`, `D`, `U`, `Y`, `R`, `A`, `C`; 02 `W` (and `N` for its
dependencies); 03 `G`, `E`, `V`, `T`, `K`, `L`; 04 `I`, `B`, `O`, `P`, `Z`.
Questions in §6 are `P`, `E`, `S` (from review) and `Q` (raised by the
web-only scope).

## 1. Milestones at a glance

| Id | Milestone | Depends on | Can overlap with |
|---|---|---|---|
| M0 | Phase 0: `replica-proto` (done) | — | — |
| M1a | Build branch and carry-over (§3.0); contract revision in `spaces.ts` and `replica-proto` | M0 | — |
| M1b | `@session/mutators` | M1a | M2 (interfaces) |
| M2 | `@session/sync` library (client half, server half over an in-memory store) | M1b | M4 (fixture replica) |
| M3 | Server half on SQLite passing replica-proto's suites; staging app | M2 | M4 |
| M4 | Client shell, feed, posts, replies, channels, signed-out reading | M1b (fixture replica); M2, M3 for e2e | M3, M5a |
| M5a | Owned runs: asks, branches, look-ups, comments, streaming, ledger at spend time | M3, M4 | — |
| M5b | Weekly allowance, payer, API keys, Usage page, Site Admin settings | M5a, ADR-23 accepted | M6 |
| M6 | Membership, sign-in with GitHub and X, moderation, notifications | M3, M4, M5a | M5b |
| M7a | (removed: web-only build) Desktop shell | — | — |
| M7b | (removed: web-only build) Device runs | — | — |
| M8a | Launch preparation | M5b, M6 | — |
| M8b | Data wipe and launch | M8a | — |
| M8c | After launch: branch and documents | M8b | — |

Each milestone ends with a merge to the build branch (§3.0) whose checks pass
on their own; none depends on a later one to be verified. Until M8b, the
current web app (not in use) stays in production, deployed from the existing
`main` of `session-desktop` with its rules (`AGENTS.md`); the build branch,
`session-web`, deploys only to staging (§3.1).

### 1.1 Commands referred to below

The build branch has no desktop and no root `package.json`; every command runs
in `web/` (`12-testing-linting-ci.md` §1, §4). The root `npm run check`,
`npm test`, `npm run preflight` and `cargo test` of `session-desktop` do not
exist there (removed: web-only build).

- `web/`: `npm run check` (`tsc -b`, ESLint, Prettier, `drizzle-kit check`),
  `npm test` (AVA in every package), `npm test --workspace <pkg> -- <files>`
  for one package, `npm run test:e2e` (Playwright, Chromium, fixture
  providers; specs in `web/e2e`).
- `web/packages/replica-proto`: `npm test` (`inv1`-`inv7`, `review-r1`,
  `review-r2`, `convergence`, the read oracle `oracle.ts`, the write oracle
  `write-oracle.ts` with its effect model `effect-model.ts`, which M1a
  rewrites to predict notifications as part of the write, `01` U6) and
  `npm run mutate`
  (`test/mutations/mutate.ts`; about 45 minutes on 4 cores; exits non-zero
  when a mutation survives; `-- --check` only checks that every pattern
  matches once; `-- X1 N2` runs a subset).
- `web/packages/db`: migration tests in `test/migrations.test.ts`, run with
  `cd web && npm test --workspace @session/db -- test/migrations.test.ts`.

### 1.2 Traceability

Every work item of 01-04 that is not removed is scheduled in exactly one
milestone. One item is split and says so: `01` D5 (`0001_spaces.sql` in M3,
the squash to one `0000_initial.sql` in M8a). The contract items `01` C1-C18
are scheduled in M1a, where they change `spaces.ts` and `replica-proto`; the
server routes some of them need are built under the items named in the M3,
M4, M5b and M6 rows (C16's notifications are written by each mutator's
`notify` stage, `01` U1, in M1b and filled in by the M6 items; `01` R5 and
`spaces.directory` serve C7; `04` §3 builds C8's account invites). M6
depends on M5a because the branch and comment notifications of C16 come
from runs. `04` I1 (`users.status`, `handle`, `provider` and
`provider_user_id`, `invites.code_hash` and `code_enc`) is built whole in
M6 with its own generated migration, `0002_accounts.sql`; M3's
`0001_spaces.sql` does not add those columns, and the M8a squash folds both
into `0000_initial.sql`.

| Milestone | 01 | 02 | 03 | 04 |
|---|---|---|---|---|
| M1a | C1-C18, U6 | — | — (ADR-23 drafted, §6) | §11 (contract requests) |
| M1b | U1-U5 | — | G1, G2, G4, G5, G6 (mutators) | — |
| M2 | Y1-Y6, Y8-Y13, R1-R4 | — | — | — |
| M3 | S1, S3, S5, D1-D4, D5 (0001), D6, D7, Y7, A1, A3 | — | — | — |
| M4 | A2, R5 | W1.1, W1.2 (its replacement check), W2.1-W2.5, W2.7, W3.1, W3.2, W4.3, W4.5, W5.1, W6.1-W6.3, W6.6, W6.7, W9.1-W9.3, §9.5, §9.6, §9.8, W10.1-W10.3, W11.1, W11.2 | — | I5, B1, B3, P1 (§4.1 visibility rules with C9) |
| M5a | — | W3.3, W4.1, W4.2, W4.4 | G3, G7, G8, E1-E5, T1-T4, K1, K2, K12, K13, L1, L2 | — |
| M5b | — | W8.1, W8.2 | K3-K11, K14, K15 | — |
| M6 | — | W2.6, W6.4, W6.5, W6.8, W6.9, W6.10, W7.1-W7.3 | — | I1-I4, B2, B4, B5, B6, O2-O5, P2, Z1, Z2, Z4, Z5; §13 mitigations |
| M8a | D5 (squash) | — | — | — |

Removed and not scheduled (web-only build): `01` S2; `02` §12.3; `03` V1-V7,
T5, L3; `04` Z3. Removed and not scheduled (no reporting, P6): `04` O1.
Removed and not scheduled (no suspension, P3): `04` I6. Removed and not
scheduled (no effect queue): `01` S4. `01` S2's acceptance line on
foreign origins is kept under S1. `02` W2.4 (no Tauri part) and W6.10 (no desktop frozen copy) are now scheduled whole.

`03` L4 adds no work beyond `01` A3 (M3). `01` Y13 (`serverApply`) is built
in M2 and first used by `03` E1 in M5a. `02` §9.7 is a reference table, not
an item. `04` §1, §2, §11 and §14 record decisions, contract requests and
dependencies only.

## 2. Milestones

### M0 — Phase 0 (done)

`web/packages/replica-proto`: prototype server half (`src/server.ts`), access
rules (`src/access.ts`), mutators ported from the mock backend
(`src/mutators.ts`), a minimal replica client (`src/client.ts`), and the
suites listed in §1.1 with the mutation runner (faults X1-X31, N2-N34, R2-1
on). Nothing in the app imports it. It is the acceptance suite for M1a-M3.

### M1a — Build branch and contract revision

Entry: the build branch exists with the carry-over commit (§3.0), and its CI
(`check`, `test`, `e2e`, `docker` of `web.yml`) is green with no other change.

Scope:
- `web/packages/shared/src/schemas/spaces.ts`: the contract changes `01`
  C1-C18 (likes removed and saves counted, save counts below 3 not served in
  private channels, ask-node kinds with `quote` and `look` and without
  `executor` or `agent`, comments, total counts, channel rules removed, the
  "All" scope, account invites and `users.status`, `vis: "open" |
  "private"`, deferred surfaces and reporting moved to `spaces.deferred.ts`,
  owner-only About, removal notes and the `modlog` kind with `remove`, `ban`
  and `unban`, the notification kinds of C16, the `prefs` record, ULID space
  ids, mentions, the run record, space roles reduced to `owner` and `member`
  with `owner` and `frozen` on the space record) and the additions `04` §11
  requests (`auth.checkInvite` with one `unusable` answer, no default rules,
  `users.provider`).
- `replica-proto` changed to the revised contract before anything is ported
  (`01` U6): `likes.set` replaced by counted saves, rules dropped, comment and
  ask-node kinds added, `erase` extended to saves, comments and mention
  notifications; the admin and moderator roles, `members.setRole`, `RANK`
  and the `invite` setting removed; reporting removed; the effect queue
  removed (notifications written by the mutator's `notify` stage in the
  write's transaction; the `job` effect replaced by a `run` record with
  status `queued`; `work()`, the effect worker and dead letters removed;
  the write oracle's effect model `test/effect-model.ts` kept and rewritten
  to predict notifications as part of the write; tests that call `work()`
  or `jobs()` rewritten, or removed where their subject is retry, backoff
  or dead letters); with the tests and mutation patterns `01` U6 names
  removed or rewritten; mutation patterns that pointed at removed code are
  rewritten with the same faults.
- Documents: ADR-19's `deviceNow` corrected to `clientTime` (`01` Y1); a
  "Scope of this build" note on ADR-19 to ADR-22 naming the desktop, phone
  and device-run parts that are not built and the removal of the effect
  queue (question Q1); ADR-5 amended for
  X sign-in (`04` Z2); ADR-23 (user API keys, model payers, the weekly
  allowance, runtime model settings; `03` §6, K15) drafted for decision
  before M5b.

Exit criteria:
- `cd web/packages/replica-proto && npm test && npm run mutate` exits 0.
- `cd web && npm run check && npm test --workspace @session/shared` passes,
  including `test/spacesMock.test.ts` (the mockup's validator test, which
  reads `docs/mockups/session-web-spaces-*.js` at the same path as before).

### M1b — `@session/mutators`

Scope (`01` §3):
- New package `web/packages/mutators` (npm workspace, AVA, `tsc -b`
  reference), depending on `@session/shared` and `zod` only.
- `01` U1-U5: the three stages (`pre`, deterministic `run` over a synchronous
  `tx` with `tx.now` and `tx.id(ordinal)`, and the server-only
  `notify(tx, input, result)`, which writes notification records with C16's
  coalescing inside the write's transaction and never runs on the client),
  indexed reads (`tx.byKey`, `tx.list`, `tx.count`) returning `unknown`
  outside the working set, the stored shape with counts as stored fields,
  stale-intent rules, and one file per area.
- The run-starting and graph mutators of `03` G1, G2, G4, G5, G6
  (`threads.create`, `research.forkNode` for asks and for look-ups with
  `LOOKUP_PROMPT_V1`, `comments.create`, promotion with `from` for any reader
  of the branch, `followups.delete`, `research.cancelNode`,
  `research.retryNode`). They write the `run` record with status `queued`;
  that record is the queue, and nothing dispatches it until M5a.
- Shared validators used by forms and mutators: channel name, handle, text
  bounds (`04` §4.2, §3.1, §10).

Exit criteria:
- `replica-proto` imports its mutators from `@session/mutators` instead of
  `src/mutators.ts`; `cd web/packages/replica-proto && npm test && npm run
  mutate` exits 0, with patterns that pointed into `src/mutators.ts` moved to
  the package and the faults kept the same (the runner's README rule).
- `cd web && npm test --workspace @session/mutators` passes: one test file
  per area of `01` U5, the table test of `01` U5 (every mutator with `who`,
  stale-intent rule and `online`), `inv1`'s determinism test run over every
  mutator, a test per mutator with a `notify` stage that its notification
  records commit with the write and are absent after a refused or rolled
  back apply, and the `03` G1, G2, G4, G5 tests.
- `cd web && npm run check` passes, including the ESLint rule banning `Date`,
  `Math.random`, `crypto` and `Intl` in the whole package (`01` U1).

### M2 — `@session/sync`

Scope (`01` §4, §5):
- Package `web/packages/sync` with entry points `@session/sync/client` and
  `@session/sync/server`; the server half defines `ServerStore`, which this
  milestone implements in memory only.
- Wire and server half: `01` Y1-Y6, Y8 and Y13 (envelope, answers,
  `register` with re-attach of the caller's stored id, `apply`, `snapshot`
  and `pull`, AEAD cursor tokens with the
  previous key, retention jobs, `serverApply` for server-originated writes).
- Client half: `01` Y9-Y12 and the client part of Y3 (`{clientId, userId}`
  in `sessionStorage`, the `session-client:<clientId>` Web Lock taken with
  `ifAvailable`, the id cleared on sign-out; replica behind a
  `StorageAdapter` with the memory adapter only; the outbox with the web's in-flight-only policy and
  the queue policy the suites drive; rebase; reactive queries).
- Replication tiers `01` R1-R4 (the web window computed by the server with
  the tab's opened-thread list, summaries, promotion, closed spaces).

Exit criteria:
- `replica-proto`'s harness uses the `@session/sync` client in place of
  `src/client.ts`; `cd web/packages/replica-proto && npm test && npm run
  mutate` exits 0 (patterns into `src/client.ts` moved as in M1b).
- `cd web && npm test --workspace @session/sync` passes: the `01` Y1-Y13
  acceptance tests, including outbox backoff, a write failing 5 times shown
  while later writes continue, the 3-day drop reported (queue policy),
  the in-flight-only policy (a failed request leaves "Not sent" and nothing
  queued), `EXPIRED`, `CLOCK_SKEW` and `TOO_LARGE` handling, rollback with
  draft text restored (`04` §9), resync on a rejected token, the R2 snapshot
  test of the four inclusion rules and the cap, and tier promotion (R3),
  and the Y3 client id tests with a fake `sessionStorage` and lock manager:
  100 reloads of one tab register once and re-attach 99 times; a duplicated
  tab (copied storage, lock held) registers a new id; a stored id of
  another user answers `WRONG_CLIENT` and the client registers anew;
  re-attaches are not counted and the 51st new id of a user in a day is
  refused; an id idle for 7 days is not re-attached.
- Server-half tests on the in-memory store reproduce `inv3`, `inv5`, `inv6`
  and `inv7`.
- `cd web && npm run check` passes.

### M3 — Server half on SQLite

Scope:
- `web/packages/db`: `01` D1-D4 and `0001_spaces.sql` of D5 (records, sync
  bookkeeping, non-replicated server tables including `site_settings`,
  `server_meta` and `save_counts` (the true save count of a private-channel
  thread, while the replicated counts record serves 0 below 3, `01` C1),
  `secure_delete`), D6 (log epochs and the boot-time Litestream generation
  check), D7 (record shape backfills); `ServerStore` over SQLite in
  `web/packages/db/src/sync/`.
- `web/packages/server`: `01` S1 and S3-S5 (sync pipeline with
  `Session-Protocol` and `426 UPGRADE_REQUIRED`, cookie authentication, no
  CORS headers, configuration, drain and boot: on boot, after migration
  and the restore check, close `usage_events` rows still `open`, mark runs
  still `running` as `interrupted`, then start the run dispatcher and the
  maintenance jobs; `01` S4, the effect worker, is removed), Y7 (SSE over
  `fetch`), A1 (sync routes), A3 (rate limits). `04`'s hardening (Z2, Z4) is
  M6.
- A conformance target: replica-proto's harness gains a target interface
  (apply, snapshot, pull, register, clock control, random-source fault
  injection, storage scan); `web/packages/server/test/conformance/`
  implements it over HTTP against a server on a temp SQLite file. A test
  importing replica-proto is test code, so "nothing in the app imports it"
  holds.
- Staging app and the build branch's deploy job (§3.1, §3.2).

Exit criteria:
- `cd web && npm test --workspace @session/server -- 'test/conformance/**'`
  runs every replica-proto test file against the HTTP target with the same
  assertions.
- `cd web && npm test --workspace @session/db` passes, including
  `migrations.test.ts` (a fresh database migrates through `0001`), the D1
  property test, the D2 kill-between-statements test, the D3 test that no
  server-only table reaches `snapshot` or `pull` (with a save in a private
  channel whose true count stays below 3 writing no change-log row, `01`
  C1), the D4 storage scan over
  the SQLite file and WAL after a checkpoint, and the D6 restore test (a
  database with a different Litestream generation id boots with bumped
  epochs and a pre-restore cursor answers `resync`).
- Server mutation set: every X, N and R fault that applies to server-half
  code (decision E4), re-expressed against `web/packages/server` and
  `web/packages/sync` and run by a copy of the runner (`npm run mutate
  --workspace @session/server`, proposed), exits 0. A fault is listed as not
  applicable only when the code it mutates does not exist on the server
  (for example the prototype client's queue), with the reason.
- Restart test: a server killed between commit and response answers the
  replayed envelope from the stored answer after boot (`01` S5).
- Over HTTP against the SQLite server: the Y3 re-attach tests of M2 (a
  re-attach returns the stored `lastSeq` and is not counted; the 51st new id
  in a day refused; another user's id answers `WRONG_CLIENT`), and a test
  that a write with a `notify` stage leaves its notification records in the
  same commit, with none after a kill before commit.
- `cd web && npm run check && npm test` pass; CI's `docker` job builds.
- Load check on staging (`shared-cpu-2x`, 2 GB, as production): 200 SSE
  clients and 20 writes per second for 10 minutes, apply p95 under 50 ms,
  pull p95 under 100 ms, resident memory flat after the first minute, and
  the snapshot size of a space at the web window's cap (`01` R1: 500 full
  threads) recorded; above 5 MB the window settings are lowered before M4's
  e2e work.

### M4 — Client shell, feed, posts and channels

Scope (`02-client-app.md`; items in §1.2): the research client removed (`02`
W1.1, with `01` A2's routers, the research schema files of `web/packages/db`
and the desktop-shared modules of `web/packages/shared` that nothing imports
any more, §3.0); the app shell, routes with thread addresses (`02` §2.1,
P9), bar hiding, narrow widths; the site footer "Session · Report abuse:
abuse@<host>" on every feed and page (`02` W2.7, `05` §6 Q10); feed rows
and cards; reply trees on
posts; the composer (Post mode end to end, Ask mode against the fixture
replica); channel header, info dialog, About editor, Browse, New channel; the
replica wiring, outbox states, the `UPGRADE_REQUIRED` reload and per-viewer
fields; signed-out reading (`02` §9.5, `04` §3.5) and unjoined open channels
(`01` R5 with `spaces.directory`, `04` I5); channel names and About (`04`
B1, B3); saves and the Saved count (`04` P1); the fixture replica (`02`
§9.6); accessibility, tokens and the mockup's typography (`02` §11, P22).
The usage ring renders from the fixture until M5b provides `usage.get`.

Exit criteria:
- `cd web && npm run check && npm test` pass, including every `02` W
  acceptance test listed for this milestone, the `02` §9.8 `rg` check for
  scaffolding names and W1.2's `rg "@tauri-apps"` check.
- `cd web && npm run test:e2e -- spaces-shell spaces-feed spaces-replies
  spaces-channels spaces-signed-out spaces-keyboard` passes against the M3
  server, for the post, reply, save, join, create and About parts of those
  specs (`02` §12.2); `spaces-feed` also covers the in-flight-only rule with
  `context.setOffline` (a failed request shows "Not sent", a reload keeps
  nothing but the draft) and a `/c/<name>?t=<id>` link to a thread outside
  the loaded feed; `spaces-shell` checks that a reload keeps the tab's
  client id (one `register` call issues an id, later ones re-attach), that a
  duplicated tab registers a new id, and that the footer's link is
  `mailto:abuse@<host>` for the host of `SESSION_PUBLIC_ORIGIN` on a feed
  and on a page.
- `research.spec.ts`, `library.spec.ts`, `collaboration.spec.ts`,
  `live.spec.ts` and `widgets.spec.ts` are deleted; `visual.spec.ts`
  baselines are regenerated by CI's `update-visual-baselines` run (`12` §4)
  for the views in `02` §12.2.
- `vite build` output contains no fixture strings (`02` §9.6).

### M5a — Owned runs

Scope (`03` §1-§3, §5, §7): run, turn and answer records; context assembly
and the access check at start (G7, G8); the owned loop re-pointed at records
through `serverApply` with attempt fencing (E1-E4); the dispatcher, which
claims the oldest admissible `queued` run record with a compare-and-set in
one transaction (`queued` → `running` where `id`, `attempt` and `status =
'queued'` still match; there is no `job` effect), and the title and summary
of a new thread as the run's final steps (E2); progress steps;
streaming as ephemeral deltas with gap refetch from `run_live` (T1-T4); the
usage ledger written at spend time (one row per provider call, opened when
the call starts, checkpointed at most every 2 s, closed however the call
ends, unfenced and in its own transactions; open rows closed at boot) and
what counts, cached input at the discount ratio (K1, K2), with every run
paid as `included` and the existing limits; the queue limit's recorded
`queue_full` refusal (L1); failure handling (E5); the branch and comment
notifications of `01` C16, written in the transaction of the write that
causes them; model and effort per run checked in `pre` against the registry, with
ADR-16's `claude-fable` admin gate kept until the weekly allowance (K3)
removes it in M5b (K11), and the Effort submenu listing the
chosen model's efforts (K12, K13); per-run limits (L1, L2); the client's run
states, branch tree, branch card and selection actions (`02` W3.3, W4.1,
W4.2, W4.4) and the look-up display (G3).

Exit criteria:
- `cd web && npm test --workspace @session/server --workspace @session/db`
  passes, including `runs.test.ts` and `runRecovery.test.ts` rewritten
  against the new records (E2), the E1 removal-during-run test, the E3
  fixture-provider tests, the E4 cancel-then-retry test, the E5 test per
  failure row, the T2 non-member delta test, the T4 change-log bound, the K2
  cached-token test and the L2 look-up tool cap; the E2 claim test (two
  dispatchers racing for one queued run: one claims it, the other's
  compare-and-set changes nothing; a crash leaves it `running` and boot
  marks it `interrupted`); the K1 ledger tests (for each way a call ends
  that exists in M5a, finish, cancel, timeout, error, superseded and
  process kill, a closed row whose tokens match what the fixture provider streamed,
  within the 2 s checkpoint bound for the kill; rows left `open` by a kill
  closed at boot; the sum of a run's rows equal to the run record's `tok`);
  the L1 `queue_full` tests (the 21st queued ask refused and recorded, its
  answer replayed, the next seq following it, the client restoring the
  text).
- `cd web && npm run test:e2e -- spaces-feed spaces-branches spaces-runs`
  passes: ask with the `paced-answer` fixture, a reload mid-stream and a
  second tab on the same run, Continue, Branch, Branch here, Look up on a
  1-4 word selection showing the phrase and not the prompt, Comment, Stop,
  Run again creating a new attempt, dot alignment (`02` W4.1).
  `spaces-runs.spec.ts` is new in this milestone.
- Fixture providers only; nothing reaches a model provider in CI.

### M5b — Allowance, payer, API keys, Usage page, Site Admin settings

Entry: ADR-23 accepted (`03` §6, K15).

Scope: the weekly allowance and its reset (K3), with allowance checks
reading the ledger including open rows; API keys encrypted under
`SESSION_SECRET_KEY` and checked during `apiKeys.set` against the
provider's model list (10 s timeout; a rejected key or an unreachable
provider refuses the save; "Checking…" while it runs; no effect) (K4),
`usage.get` and `usage.listRuns` (K5), the meter (K6), the billing setting
and the payer made in `pre` (K7, K8), crossing the allowance during a run
and the per-member overdraft limit `SESSION_OVERDRAFT_TOKENS` (K9), runs at
the reset (K10), model payers in the registry (K11), the key-run privacy
note (K14), the default model and default effort set by a site admin with
`models.list` and `admin.models.*` (K15, P11); the Usage page (`02`
W8.1), the Site Admin settings (`02` W8.2) and the app bar ring on live data.

Exit criteria:
- `cd web && npm test` passes, including the K3 reset-boundary tests with an
  injected clock, the K4 test that greps the database file for a stored raw
  key and finds nothing, the K5 removed-thread test, the K8 mutator tests for
  each payer and the convergence test of a write queued with tokens left and
  applied after they ran out, the K9 boundary-crossing ledger test, the K9
  overdraft test (two concurrent fixture runs of one member together never
  exceed allowance plus `SESSION_OVERDRAFT_TOKENS` by more than one
  checkpoint interval of output, and both end `complete` with "Stopped:
  this week's included tokens ran out."), the K1 ledger test for the
  overdraft stop (a closed row matching what the fixture streamed), the K4
  key-check tests (a rejected key and an unreachable provider refused and
  not saved), and the K15 server tests (non-admin refused, key-only default
  refused, `xhigh` or any value outside low, medium, high and max refused as
  the default effort, `setDefault` leaving the default effort unchanged,
  every registry entry in `models.list`).
- `cd web && npm run test:e2e -- spaces-usage admin` passes (keys, billing
  setting, out-of-tokens refusal of Ask while Post sends; a site admin
  changes the default model and the default effort, and a member's composer
  starts on both after a reload).
- `06-auth-and-users.md` §8 and `fly.toml`'s comment on daily limits updated
  to the weekly allowance.

### M6 — Membership, sign-in, moderation and notifications

Scope (`04` items in §1.2; `02` W2.6, W6.4, W6.5, W6.8, W6.9, W6.10,
W7.1-W7.3): sign-in with GitHub and with X, both required at launch, each
account bound to one provider (`04` I1, I4, Z2; P1, Q8), with the staging X
app working before this milestone starts; account invites with 30-bit
codes, `users.status` (`waiting` or `active`; no suspension, `04` I6
removed) and handles, the provider columns and `0002_accounts.sql`, admin
seeding by handle with `db:admin`, the invite tree, the "Join with invite?"
flows and waiting accounts kept 90 days (`04` I1-I4); channel ownership and
the member list (`04` B2, `02` W6.8; no moderator or admin roles and no
ownership transfer, `01` C18); frozen channels of a deleted owner (`04`
B6); channel invite links, the only way into a private channel (`04` B4,
`02` W6.9); remove with reason, ban with the Banned list, the moderation
log of removals and bans (`04` O2-O5; no reporting); the remaining
notifications of `01` C16, each written by its mutator's `notify` stage in
the transaction of the write that causes it, and the notifications page
with the unread dot (`02` W2.6); privacy rules (`04` P2); client rendering
of apply-time refusals and the removed member's toast (`04` B5, `02` W6.10);
abuse limits (`04` Z1); cookie CSRF, no CORS and rendering hardening (`04`
Z2, Z4, Z5); the threat notes' mitigations (merged failure answer for
`auth.checkInvite`, the cursor-key rotation runbook in `web/docs/runbooks/`).

Exit criteria:
- `cd web && npm test --workspace @session/db -- test/invites.test.ts` passes
  (`04` §3.1: hash lookup, concurrent redemption, handle uniqueness, a
  deleted account's identity signing in again as a new waiting account,
  `db:admin -- <handle>` and root invites, the 90-day waiting-account
  sweep), and the server tests of `04` §3.2 (3 open
  links, a 4th refused, revoke and use freeing a slot, concurrent creates,
  the admin exemption).
- The X and GitHub callback tests of `04` Z2 and Z5 (new account, existing
  account, the other provider's identity staying a separate account) pass
  against fixture OAuth endpoints.
- `cd web && npm run test:e2e -- spaces-membership spaces-channels
  spaces-notifications` passes, covering the scenarios of `04` I4 (link,
  code, waiting account, used code), B3, B4 (private channel link, reused
  link refused), §6.6 (removal with reason, moderation log without reload,
  ban) and every notification kind of `01` C16 with the unread dot; spec
  names as in `02` §12.2.
- `04` B6, P2 and Z1, Z2, Z4, Z5 server tests pass: after the
  account-deletion operator job on an owner, the owner's channel refuses
  posts, joins and links while still served to its readers, the handle
  stays taken and `provider_user_id` is null; one middleware test per limit
  row, with IPv6 clients keyed on their /64 prefix; the cookie CSRF tests; a request with an `Authorization`
  header answering `400`; no `Access-Control-Allow-*` header on any
  response; the untrusted-text rendering test.
- The conformance suite (M3) and `cd web/packages/replica-proto && npm test`
  still pass after the M6 mutator changes; `npm run mutate` runs on the pull
  request (§3.1).
- Privacy check on staging, by script: after a removal, the removed text is
  absent from the SQLite file, from `pull` and `snapshot` answers for the
  owner, a member, a non-member and a signed-out reader, and from the
  author's `removed` notification (the D4 scan run with `fly ssh console -a
  session-staging`).

### M7a — Desktop shell (removed: web-only build)

Not built. The scope it held (a Tauri shell, a SQLite `StorageAdapter`,
device-token sign-in through pairing codes, the desktop frozen-copy banner,
the drag region, "Update Session" through the updater, the manual macOS
checklist) has no counterpart in this build.

### M7b — Device runs (removed: web-only build)

Not built: `03` V1-V7, T5 and L3 are removed, with the server routes, the
`run_leases` table and the device-run settings.

### M8a — Launch preparation

Scope, with production still on the current web app:
- `web/docs/runbooks/launch.md` (new): the steps of §3.6 with commands,
  including the admin seeding of §3.5.
- `01` D5's squash: with the research schema gone (M4), the migrations of the
  build branch are replaced by one generated `0000_initial.sql`; staging is
  reset with `runbooks/reset-database.md` and redeployed.
- A restore rehearsal on staging from a Litestream generation, checking the
  boot-time generation check bumps the epochs (`01` D6).
- Production secrets staged with `fly secrets set --stage -a session-dev`
  (§3.4), including the new `LITESTREAM_REPLICA_URL` prefix and the X OAuth
  client of the production X app.
- X access on the production X app confirmed with the access level Q8
  requires; this is a launch blocker, and there is no GitHub-only launch.
- The abuse mailbox, `abuse@<host>` for the host of `SESSION_PUBLIC_ORIGIN`
  (abuse@session.dev), exists and is read by the site admins (Q10); a
  launch blocker.
- The first site admins (each with the provider they sign in with and the
  handle they will choose) and the named first group of invite recipients
  listed in the launch runbook (question Q11). There is no
  launch date to announce and no notice period: the current web app is not
  in use.

Exit criteria:
- `cd web && npm test --workspace @session/db -- test/migrations.test.ts`
  passes: a fresh database migrates through `0000_initial.sql` alone and
  holds no research table.
- The staging reset and the staging restore rehearsal are recorded in the
  launch runbook with their times.
- A test message to the abuse address is received, and the production X
  app's access level and callback `https://session.dev/auth/x/callback`
  are confirmed; both are recorded in the launch runbook. X sign-in itself
  is first exercised by the M8b smoke test.

### M8b — Data wipe and launch

Scope: §3.5 and §3.6. Exit criteria:
- The build branch's web CI jobs (`check`, `test`, `e2e`, `docker`) green on
  the launch commit.
- Production smoke on the deployed build: `curl -fsS
  https://session.dev/healthz`; boot log shows `0000_initial.sql` applied on
  an empty database and Litestream replicating to the new prefix; a seeded
  site admin signs in with GitHub and another with X (both providers must
  work; neither is optional), sets the default model and the default
  effort, creates an invite; a second account redeems it and the inviter
  gets the `invite_used` notification; post; ask with included tokens;
  remove and ban; a channel invite link redemption; the site footer shows
  abuse@session.dev.
- A restore rehearsal against a post-launch snapshot, checking the epoch
  bump.

### M8c — After launch: branch and documents

Scope: `session-web` becomes the repository's default branch; the old
`main` is kept as it is, under its name and writable, with no change to its
files (question Q3); `AGENTS.md` on the build branch moves the sync core from
"Planned" to current rules; replica-proto's prototype server stays as the
reference (decision E5; the suites stay). There is no old desktop code to
remove on the build branch (§3.0). Exit: `cd web && npm run check && npm
test` and the web workflow green on the default branch.

## 3. Repository, deployment and launch

### 3.0 Repository and the build branch

The build happens on a new branch created from the repository's initial
commit, not on top of the `session-desktop` history (E1, Q2). The local
clone is shallow (`git rev-parse --is-shallow-repository` answers `true`), so
the initial commit is not visible here; it is confirmed with `git fetch
--unshallow` and `git rev-list --max-parents=0 HEAD` before the branch is
made; the carry-over commit deletes whatever the initial commit holds
outside the carried set (decided, Q2). The branch is named `session-web`
(decided, Q3).

Method: create the branch at the initial commit, then make one carry-over
commit that copies files, unchanged, from a recorded `session-desktop`
commit (`git checkout <source-sha> -- <paths>` for the carried paths, `git
rm` for anything the initial commit holds outside them, with the source
commit's hash in the commit message). History of the carried files stays on
`session-desktop`. Paths are kept as they are (`web/…`, `docs/mockups/…`), so
every path cited in 01-05 and in `web/docs` stays valid and `web.yml` keeps
its `working-directory: web`. Later commits make the changes the milestones
schedule; the carry-over commit changes nothing but `AGENTS.md` and
`README.md`. `web.yml`'s `deploy` job runs only on `refs/heads/main`, so on
`session-web` it deploys nothing until M3 points it at staging.

Carried over (what the build reuses):

| Path | Why | Later changes |
|---|---|---|
| `web/packages/replica-proto` | The phase 0 prototype and its suites: the acceptance suite of M1a-M3 | Contract revision (`01` U6, M1a); harness uses `@session/mutators` and `@session/sync` (M1b, M2); server kept as reference (E5) |
| `web/packages/shared` | `schemas/spaces.ts` (the contract), `models/registry.ts`, `markdown/` (the client's pipeline), `util/`, `types/` | Contract changes (M1a). The desktop-shared modules of ADR-1 (`lib/`, `wire/`, `research/`, `journal/`, `app/`) are deleted in M4 once nothing imports them |
| `web/packages/server` | Hono app, config, auth (GitHub OAuth, sessions, CSRF), middleware, metrics, health, the run loop and providers (`runs/`), tRPC base, backups | Sync routes (M3); research routers removed (`01` A2, M4); X sign-in (M6) |
| `web/packages/db` | Connection, migration tooling, the kept schema (`users`, `sessions`, `oauth_states`, `invites`, `signup_attempts`, `user_limits`, `usage_events`, `user_preferences`, `backfills`), backfills, `bin/admin.ts` | `0001_spaces.sql` (M3); research schema deleted (M4); squash (M8a) |
| `web/packages/client` | Build, providers, design-system layer (`ui/`, `styles/`), Markdown pipeline, stores, routes kept by `02` §1 | Research features deleted (`02` W1.1, M4); new features per 02 |
| `web/docs` (with `runbooks/` and this plan), `web/e2e`, `web/scripts`, `web/Dockerfile`, `web/fly.toml`, `web/litestream.yml`, `web/package.json`, `web/package-lock.json`, `web/tsconfig*.json`, `web/eslint.config.js`, `web/playwright.config.ts`, `web/SETUP.md` | ADRs, design documents, runbooks, CI, deployment | e2e specs replaced per `02` §12.2 |
| `docs/mockups/session-web-members.html`, `session-web-spaces.html`, `session-web-spaces-fixtures.js`, `-mock-api.js`, `-jobs.js`, `-scenarios.js` | The product surface and first write definitions; `spacesMock.test.ts` and the fixture replica load them by path | None |
| `.github/workflows/web.yml` | The web CI (`check`, `test`, `e2e`, `docker`, `deploy`) | Its `deploy` job targets staging until launch (§3.1) |
| `AGENTS.md`, `CLAUDE.md`, `LICENSE`, `README.md` | Repository instructions | `AGENTS.md` and `README.md` rewritten for the web build in the carry-over commit: the desktop paragraphs (Tauri, Swift support, desktop imports of `@session/shared`) are dropped, and "Planned" keeps the sync core without the desktop, phone and device-run parts (Q1) |

Left behind on `session-desktop`: `src/` (the desktop frontend), `src-tauri/`
(Rust, Swift native support, Tauri configuration), `tests/` (desktop tests),
`scripts/` (release, DMG, vendored wry, unused-module check), the root
`package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`,
`index.html`, `session.config.json`, `logo.png`, `session.png`,
`.github/workflows/desktop.yml`, `docs/releasing.md`,
`docs/session-cutover.md`, the other documents in `docs/`
(`agent-onboarding-gap-review.md`, `css-conventions.md`, `dead-code-audit.md`,
`ghostty-removal-plan.md`) and the other mockups in `docs/mockups/`
(including `session-web-artifacts-c.html`: widgets and artifacts are out of
scope, P21). No further work happens on the desktop branch.

### 3.1 Pipeline and branches

`13-deployment-fly.md` and `12` §4: CI's `check`, `test`, `e2e` and `docker`
jobs gate `deploy`; one production Fly app (`session-dev`), one machine, one
volume, `strategy = "immediate"`. With the build on its own branch:

- `main` is kept as it is (not renamed, archived or made read-only) and
  takes no launch changes; the current web app it deploys is not in use.
  Its `web.yml` `deploy` job deploys to production through the GitHub
  environment `production`. From launch (§3.6 step 1) that environment's
  deployment branch rule allows only `session-web`, so a push to `main`
  cannot redeploy the old app over the new one; `main`'s files are not
  changed for this.
- On `session-web`, `web.yml`'s `deploy` job runs on pushes to
  `session-web` and targets the staging app (`-c web/fly.staging.toml`)
  from M3; in M8b the same change that launches points it at production,
  which from then on deploys from `session-web` only. No
  `legacy-web` branch is needed.
- From M1a, a CI job runs replica-proto's `npm test`; from M3, the
  conformance suite runs inside the server's `npm test`.
- `npm run mutate` (replica-proto, and from M3 the server copy) is too slow
  for every push; it runs nightly and on pull requests that touch
  `web/packages/replica-proto`, `web/packages/mutators`, `web/packages/sync`
  or the server's sync code, and a surviving mutation fails that run.

### 3.2 Staging

Decided (E1): from M3 the new server runs on a separate Fly app
(`session-staging`, `web/fly.staging.toml`) with its own volume, Litestream
bucket prefix, GitHub and X OAuth apps, secrets and invite-only sign-in.
The staging X app works at the access level Q8 requires before M6 starts.
Model calls use fixture providers by default and real providers with low
per-user limits when a milestone needs them (M5a, M5b). The second app
departs from `13` §1's single app; production keeps one database on one
machine. Staging is reset after the M8a squash.

### 3.3 Litestream and restore

- Replication as in `13` §6: continuous, snapshot every 6 h, retention 30
  days. The change log, recorded answers, notifications and usage ledger
  checkpoints add write volume;
  WAL size is monitored (§4).
- A restore moves the database back in time while clients hold cursors and
  confirmed answers from after the restored point. Decided (E6): boot
  compares the Litestream generation id recorded in the database with the
  current one and bumps every log epoch on a difference (`01` D6), so every
  cursor resyncs; `runbooks/restore.md` states this and records the restore
  time. Writes confirmed after the restored point are lost: their recorded
  answers are gone. Web clients hold no outbox across a reload, so those
  writes are not resent. The runbook states this window (Litestream lag,
  seconds).
- Erased content stays in Litestream generations for as long as they are
  retained (`01` D4). Decided: backups have no retention requirement; the
  30-day retention is set for recovery. A restore to a point before a
  removal serves the removed content again; the runbook repeats the
  removals applied after the restore point (from the JSON logs).
- `SESSION_CURSOR_KEY` and `SESSION_CURSOR_KEY_PREVIOUS` are Fly secrets; a
  rotation runbook (M6) covers the 30-day overlap.

### 3.4 Protocol version and configuration

- Every sync and tRPC request of the web client carries `Session-Protocol`
  (`01` S1). The server accepts `[SESSION_MIN_PROTOCOL, current]`; below the
  minimum it answers `426 { code: "UPGRADE_REQUIRED" }`. There is no
  desktop "Update Session" prompt (removed: web-only build). The web client
  keeps unsent composer text in its drafts store and reloads once; a second
  `426` within 60 s shows "Session was updated. Reload to continue." (`02`
  §9.2). Keeping the header is decided (Q5).
- Additive changes (a new optional input field, a new mutator, a record kind
  old clients ignore) do not bump the version. A change to an existing
  mutator's input or `run` semantics bumps it, because prediction and
  authority must run the same definition.
- Order for a bump (decision E2, web behaviour): the deploy that changes a
  mutator raises the minimum and the current version together. Every open
  tab reconnects after the deploy restarts the machine, receives `426`, and
  reloads; the only loss is a write whose request was in flight during the
  restart, whose text stays in the draft. No previous-version window is
  kept.
- Configuration added (`01` S3, `03` §6-§7, `04` §10, Z2):
  `SESSION_MIN_PROTOCOL`, `SESSION_CURSOR_KEY`, `SESSION_CURSOR_KEY_PREVIOUS`,
  `SESSION_SECRET_KEY`, `SESSION_WEEKLY_TOKENS`, `SESSION_OVERDRAFT_TOKENS`
  (200,000 per member per week), `SESSION_RUN_MAX_TOKENS`,
  `SESSION_QUEUED_PER_USER`, the web window (`SESSION_WEB_WINDOW_DAYS`,
  `SESSION_WEB_WINDOW_THREADS`, `SESSION_WEB_WINDOW_CAP`),
  `SESSION_X_CLIENT_ID`, `SESSION_X_CLIENT_SECRET` and the abuse limits of
  `04` Z1. The abuse address in the site footer is not a setting: it is
  `abuse@` followed by the hostname of `SESSION_PUBLIC_ORIGIN` (Q10). `SESSION_DESKTOP_ORIGINS`, `SESSION_DEVICE_ANSWER_MAX_BYTES` and
  `SESSION_DEVICE_RUNS_PER_HOUR` are not added (removed: web-only build).
  The default model and the default effort are set by a site admin at
  runtime, not by configuration (`03` K15). All are validated at boot and
  documented in `web/.env.example`; the keys are Fly secrets. Losing
  `SESSION_SECRET_KEY` makes stored API keys and open invite codes
  unreadable; it is backed up outside Fly.

### 3.5 Data wipe: what is deleted and how site admins are seeded

Decided (P19): the launch is a hard reset. Every row of the current
production database is deleted, accounts included: `users`, `sessions`,
`invites`, `user_limits`, `usage_events`, `user_preferences` and every
research, collaboration, embed and tweet table. Files under
`/data/documents/*` and `/data/embeds/*` are deleted. Decided (P20): there
is no export. The production database is replaced by an empty one built from
`0000_initial.sql` with `runbooks/reset-database.md` (stop the app, point
`LITESTREAM_REPLICA_URL` at a new prefix, delete the database and the volume
directories, deploy).

Backups: the old Litestream prefix, which holds all deleted data, is kept for
30 days after launch as the only rollback source (§3.6 step 8), then deleted.

Site admins after the wipe (decided, Q6): admins are set by handle, which is
unique (the provider `login` is not, `04` I1). Through `fly ssh console`,
the operator runs `npm run db:admin -- --invite` once per person who runs
Session; it prints a root account invite (no `created_by`). Each of them
opens it, signs in with GitHub or X, chooses a handle at the profile step
and is active with no inviter. The operator then runs `npm run db:admin --
<handle>`, which sets `is_admin` on that account (`bin/admin.ts` changes
from `<github login>` to `<handle>` and gains `--invite`). Root invites are
not account invites of any member and do not count for the rollback
cut-off (§3.6 step 8). Admins are the roots of the invite
tree and are exempt from the 3-open-links limit (`04` I2); they set the
default model and the default effort (`03` K15) before inviting anyone,
then invite the named first group of the launch runbook, who then have 3
invites each (Q11).

The wipe needs no announcement: the current web app is not in use, so there
is no banner, launch date or notice period (decided, Q11). Nothing is
carried over; anyone who held an old account signs in as a new identity and
waits for an invite.

### 3.6 Launch sequence (M8b)

1. Freeze: merge the launch commit to the build branch; CI green (`check`,
   `test`, `e2e`, `docker`). Set the `production` environment's deployment
   branch rule to `session-web` only (§3.1) and point `session-web`'s
   `deploy` job at production.
2. Record the rollback point: the current image of `session-dev` and the old
   Litestream prefix and generation.
3. Apply the staged secrets (new `LITESTREAM_REPLICA_URL` prefix, cursor and
   secret keys, X OAuth, web window, limits).
4. `fly scale count 0 -a session-dev`; delete `/data/session.db` with its
   `-wal` and `-shm`, `/data/documents/*`, `/data/embeds/*` and
   `/data/tmp/documents-backup.stamp` from a one-off machine with the volume
   (`reset-database.md` §3).
5. Deploy the build branch to production (`fly deploy web -c web/fly.toml`)
   and scale to 1. Boot runs `0000_initial.sql` on the empty file, records
   the Litestream generation id, closes `usage_events` rows still `open`
   and marks runs still `running` as `interrupted` (none on an empty
   file), then starts the run dispatcher and the scheduled maintenance
   jobs (`01` S5).
6. Seed the site admins (§3.5); the admins set the default model and the
   default effort.
7. Smoke checks (M8b exit): sign-in with each provider, the default model
   and effort, post and ask first; the smoke test's invite redemption is
   the first invite used, and the checks after it are fixed forward.
8. On failure before the first invite is used (a member's account invite
   redeemed; the root invites of §3.5 do not count): `fly scale count 0`, restore
   the old prefix as `LITESTREAM_REPLICA_URL`, deploy the recorded old image,
   scale to 1, and set the `production` environment's branch rule back to
   `main`. Nothing written to the new
   build is kept. From the first invite used on, fixes go forward.
9. After 30 days: delete the old Litestream prefix and the old image.

## 4. Observability

Additions to `13` §7, all in `/metrics` and the JSON logs. Logs carry ids and
answer codes, never record text.

| Signal | What it shows | Alert |
|---|---|---|
| `session_sync_apply_total{mutator,answer}` | Writes by answer code (`OK`, `FORBIDDEN`, `STALE`, `CONFLICT`, `EXPIRED`, `CLOCK_SKEW`, `TOO_MANY_REQUESTS`, …) | `INTERNAL_SERVER_ERROR` above 1% for 10 min |
| `session_sync_apply_seconds` | Apply latency histogram | p95 above 100 ms |
| `session_sync_pull_seconds`, `session_sync_snapshot_bytes` | Read cost per log; snapshot size of the web window | p95 pull above 250 ms; p95 snapshot above 5 MB |
| `session_sync_resync_total{reason}` | Resyncs by reason (forged, expired, epoch, scope change) | sudden rise after a deploy |
| `session_sync_clients`, `session_sse_clients` | Registered and connected clients | — |
| `session_runs_queued`, `session_run_claim_conflicts_total` | Queued run records and dispatcher compare-and-set claims that matched nothing (there is no effect queue) | queued runs older than 10 min while capacity is free |
| `session_ledger_open_closed_at_boot_total` | `usage_events` rows still `open` after a crash, closed at boot with their last checkpoint (at most 2 s of output each unbilled, `03` K1) | any after a boot that was not preceded by a deploy or drain |
| `session_overdraft_stops_total` | Runs stopped at the per-member overdraft limit (`03` K9) | — |
| `session_changelog_rows`, `session_tombstones`, `session_idempotency_rows` | Table growth and pruning | growth past the 30- and 7-day bounds |
| `session_protocol_requests{version}`, `session_upgrade_required_total` | Clients by protocol version; `426` answers | `426` answers still rising 10 min after a deploy (a reload loop) |
| `session_rate_limited_total{bucket}` | Abuse limits hit | — |
| `session_invite_checks_total{outcome}` | Invite code checks | failed checks above 100/hour |
| `session_signins_total{provider,outcome}` | GitHub and X sign-ins | X failures above 20% for 1 h |
| `session_removals_total`, `session_bans_total` | Moderation volume (there are no reports) | — |
| `session_notifications_total{type}` | Notifications written by kind (`01` C16) | — |
| `session_weekly_tokens{payer}`, `session_weekly_cost_usd{provider}` | Included-token use by payer; spend by provider | — (no spend budget and no cost alert, Q12) |
| `session_run_failures_total{cls}` | Owned-run failures by provider error class (`03` E5) | any `auth` (the deployment credential was rejected) |
| `session_wal_bytes` | WAL size between checkpoints | above 512 MB |

`session_device_runs_active` and `session_device_leases_expired_total` are
not added, and `session_reports_total` is replaced by the moderation counters
above (removed: web-only build; no reporting).

The client sends, with each sync request, its outbox length and the age of
its oldest entry; the server logs them per client id to diagnose stuck
outboxes.

## 5. Risk register

Owner roles: Product, Server (server half, sync, runs), Client (web client),
Security, Operations (deploys, backups). The Desktop role is removed
(web-only build).

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| The real server half diverges from the prototype where the suites do not look | Medium | High | Conformance target runs every replica-proto file unchanged; the server mutation set with every applicable fault required (M3, E4); oracles and convergence in CI | Server |
| The mutation run is too slow to keep in the loop | High | Medium | Nightly and path-filtered runs; `--slots`; name filters per change | Server |
| The carry-over commit misses a file the web build needs, or carries a desktop dependency | Medium | Medium | Paths kept unchanged; M1a's entry requires the carried CI green before any other change; ADR-1's desktop-shared modules removed only when nothing imports them (M4) | Operations |
| SQLite's single writer saturates with change log, recorded answers, in-transaction notifications and ledger checkpoints (one update per open provider call every 2 s) | Low | High | One commit per apply; short transactions; M3 load check; machine size raised before limits | Server |
| Erased text survives in WAL, notifications or logs | Medium | High | Notifications carry ids (the `removed` notification only the owner's note); logs carry no text; storage scan over file and WAL (M3); staging scan (M6) | Security |
| A restore serves erased text again (backups keep it; no retention requirement, decided) | Medium | Medium | The restore runbook lists the removals applied after the restore point (from the JSON logs, which carry mutator names and item ids) and repeats them before traffic resumes | Security |
| Included-token spend exceeds budget: 2,000,000 tokens per member per week at the default model's price | Medium | High | Cached input counted at the discount ratio (P12); a site admin sets the default model and default effort at runtime and can switch to a cheaper default or a lower effort at once (K15); members may still pick any registry model; `SESSION_WEEKLY_TOKENS` per-user override; per-run cap `SESSION_RUN_MAX_TOKENS`; during testing the provider API keys are capped at the provider (Q12); no spend budget and no cost alert | Product |
| A site admin makes an expensive model or a high effort the default | Low | Medium | The default must be payable with included tokens and the default effort one of low, medium, high and max; a composer moves to the highest effort its model accepts not above it (K12, K15); changes are logged with the admin's id; during testing the provider API keys are capped at the provider (Q12) | Operations |
| Replica size in a browser tab: the in-memory replica is loaded by a snapshot on every page load | Medium | Medium | Web window of 30 days or 100 threads, capped at 500 per space (E7, `01` R1), as server settings; snapshot size measured in M3 and alerted (§4) | Server |
| Every deploy restarts the one machine and every SSE client reconnects and pulls at once | High | Low | Cursors resume with `pull`, not `snapshot`; client reconnect jitter; load check includes a reconnect of 200 clients | Server |
| A protocol bump makes open tabs reload in a loop | Low | Medium | One reload, then the "Reload to continue" message (`02` §9.2); `426` counter and alert (§4) | Client |
| Writes in flight are lost on a deploy or a network failure, since the web client keeps no outbox across a reload | Medium | Low | "Not sent" with Retry; composer text kept in the drafts store; deploys are short (`strategy = "immediate"`) | Client |
| A restore loses confirmed writes | Low | Medium | Generation-id epoch bump (E6); runbook statement; Litestream lag monitored | Operations |
| The launch wipe or deploy fails | Low | High | Staging reset and restore rehearsals (M8a); old Litestream prefix and image kept as the rollback point (§3.6 step 8); old `main` deploy disabled only in the launch step | Operations |
| Client prediction and server disagree across versions | Medium | Medium | Protocol bump rule; rebase on confirmed changes; `unknown` stops prediction | Server |
| Cursor key or secret key lost, or rotated without overlap | Low | Medium | Configured keys with a 30-day previous cursor key; rotation runbook; keys backed up outside Fly; a lost cursor key causes resyncs, a lost secret key forces users to re-enter API keys and invalidates open invite codes | Operations |
| Invite code enumeration through `auth.checkInvite` | Low | Medium | 30-bit codes (S2) with one failure answer, per-IP limits (about 36,000 IP-hours per hit at 3,000 open codes, `04` §13) and the failed-check alert | Security |
| Invite tree slows growth or concentrates invites in admins | Medium | Low | Admin exemption from slots; redemption metrics | Product |
| Spam or abuse in open channels | Medium | Medium | Invite-only accounts; the owner's removal and ban; per-user limits; account deletion by operator job; the invite tree to find an abusive account's inviter | Product |
| Abuse goes unnoticed because there is no reporting: an owner who does not watch a channel, or an abusive owner | Medium | Medium | The abuse address abuse@<host> in the site footer, a mailbox that exists before launch (Q10); site admins delete the account by operator job, which freezes its channels (`04` B6), or delete a channel; there is no suspension (P3) | Product |
| X sign-in is not ready for launch, breaks, or costs more than expected (API access level, rate limits, policy changes) | Medium | High | X access on staging before M6 and on production before launch is a launch blocker (Q8), with no GitHub-only launch; the M8b smoke test signs in with both providers; sign-in failure alert by provider (§4); after launch, GitHub sign-in keeps working while X is down, and existing X accounts cannot move to GitHub (no linking), which the risk accepts | Product |
| A person holds two accounts, one per provider | Medium | Low | Each needs its own invite; both appear in the invite tree under their inviters; owners' bans and account deletion act per account (`04` §13) | Product |
| A channel cannot be moderated because its only owner is absent or deleted (ownership is not transferable) | Medium | Medium | Deleting the owner's account freezes the owner's channels (`04` B6); a site admin deletes a channel by operator job; the abuse address (Q10); P24 | Product |
| Former web users lose their accounts and research at the wipe (no export, decided) | Low | Low | The current web app is not in use, so the wipe needs no announcement (Q11); invite-only re-entry | Product |
| ADR-23 (user keys, models) is not accepted in time | Medium | Medium | Drafted in M1a; M5a ships on included tokens only; M5b waits on it | Product |
| Scope from the mockup grows past the contract (rules, hide, join requests, reporting, widgets, model availability, per-member model overrides) | Medium | Medium | Decisions recorded in 00 and §6; contract changes only through `01` §7 | Product |

Removed (web-only build): "Device runs expose local files", "Device token
theft or a stolen Mac", "Desktop UI cannot be driven by Playwright", the
phone half of "Replica size on small devices", and "Cutover migration takes
too long or fails on production data" (no data is migrated; replaced by "The
launch wipe or deploy fails").

## 6. Open questions

One deduplicated list of the open questions of 01-05, grouped by who decides,
with the product owner's answers recorded as "Decided". Each names its
sources; the files record the same answers where the question was. Ids are
for reference from this file.

### Product

- **P1. Sign-in provider.** Decided: GitHub and X, both offered from launch
  (Q8). An account is created with one provider and stays bound to it; no linking of two providers, no
  merging of accounts (`04` §1, I1, I4, Z2). `04` §15 q7.
- **P2. Channel moderators in v1.** Decided: a channel has exactly one
  owner, ownership is not transferable, and there are no admins or
  moderators (`01` C18; `04` §4.3). `01` §9 q5, `04` §1.
- **P3. Site-wide moderators.** Decided: none; only `users.is_admin`, which
  marks the people who run Session. Site admins have no suspension: there
  is no `admin.suspend` and no `suspended` status (`04` I6 removed); their
  Session-wide tools are account deletion and channel deletion by operator
  job and the invite tree, and a channel is frozen only when its owner's
  account is deleted (`04` B6). `04` §15 q6.
- **P4. Admission to private channels.** Decided: channel invite links
  only, no join requests (`01` C9, C10; `04` B4). `01` §9 q6.
- **P5. The removal placeholder.** Decided: the author shows as "[deleted]"
  (`04` §6.2), and the placeholder stays until the author deletes it. The
  reason is owner-written text and is shown (`01` C12). `02` §14 q4, `04`
  §15 q1, q2.
- **P6. Report and remove follow-ups and replies individually at launch.**
  Decided: there is no reporting at all (no `reports.*`, no report
  notifications, no report part of the moderation log, no report limits;
  the mockup has none either), so reporting them is moot; the owner
  removes threads, not follow-ups or replies individually (`01` C12; `04`
  O1 removed). `04` §15 q9.
- **P7. Offer Hide to the owner.** Decided: no. `04` §15 q10.
- **P8. Frozen copy after a voluntary Leave.** Decided: no; the web client
  keeps no frozen copy at all (`01` R4, `04` P2). `04` §15 q5.
- **P9. Thread addresses and a single-thread page.** Decided: threads get an
  address, and a link opens the thread in its channel feed scrolled into
  view; no single-thread page (`02` §2.1). `02` §14 q3.
- **P10. Notifications surface.** Decided: a Notifications page in the
  account menu and an unread dot on the account avatar; kinds: mentions, a
  reply to your post, a branch or comment on your ask, your thread removed
  by the owner (with reason), your invite used (`01` C16, `02` W2.6). No
  push notifications. `02` §14 q5.
- **P11. Models at launch and the allowance.** Replaced: a site admin
  sets the default model and the default effort at runtime on the Site
  Admin page (`03` K15, `02` W8.2); every registry model is available to
  every member, with no availability setting; per-member overrides: no
  (Q9). Decided: 2,000,000 tokens a week per member. There is no weekly
  spend budget and no cost alert (Q12). `03` §9 q1.
- **P12. Cached tokens.** Decided: counted at the provider's discount
  ratio (`03` K2). `03` §9 q2.
- **P13. Effort and the allowance.** Decided: no cost hint for high
  effort and no effort cap (`03` K12). `03` §9 q6.
- **P14. Who may promote a branch** and who is shown as its author. Decided:
  anyone who can read the branch may open it as its own thread, shown with
  the branch's author (`03` G5). `03` §9 q4.
- **P15. "Run on this Mac"** in the out-of-tokens message. Decided: no;
  device runs are not built. `03` §9 q5.
- **P16. Old desktop data.** Moot: the desktop app was never in production
  and no desktop client ships. `05` §3.5.
- **P17. Cutover date and notice period.** Moot as a desktop cutover;
  there is no web launch date or notice period either (Q11). `05` M8a.
- **P18. Phone client.** Decided: no phone app in this build. `05` §5.
- **P19. Keep accounts through the data reset.** Decided: no; all
  existing web data is wiped, accounts included, and site admins are
  re-seeded (§3.5, Q6). `05` §3.5.
- **P20. Export before the reset.** Decided: no export. `05` §3.5.
- **P21. Widgets and artifacts in answers.** Decided: excluded; answers
  are plain Markdown; the mockup shows them only as options (`02` §1, §4.4;
  `03` §1). `02` §14 q6.
- **P22. Typography.** Decided: as in the mockup (Inter; title 16.5 px,
  input 15 px; `02` §11). `02` §14 q7.
- **P23. Settings entry** in the account menu. Decided: only once there are
  settings beyond Usage; none at launch (`02` §2.2). `02` §14 q8.
- **P24. A deleted owner's channels.** Decided: they stay frozen and
  readable indefinitely (`04` B6, §15 q11).

### Engineering

- **E1. Staging and the branch split.** Decided: a separate staging Fly app
  (§3.2). The branch split is replaced by the build branch (§3.0, §3.1).
  `05` §3.
- **E2. Previous protocol version window.** Moot for the desktop. Web
  behaviour: no window; the minimum is raised with the deploy that bumps the
  version, and open tabs reload on `426` (§3.4). `05` §3.4.
- **E3. Record storage.** Decided: one `records` table with JSON bodies,
  generated columns as needed (`01` D1). `01` §9 q1.
- **E4. Server mutation set.** Decided: every mutation fault that applies to
  the real server is required for M3's exit; only faults whose code has no
  server counterpart are listed, with the reason. `05` M3.
- **E5. replica-proto's prototype server** after M3. Decided: kept as the
  reference. `05` M8c.
- **E6. Restore detection.** Decided: a boot-time check of the Litestream
  generation id (`01` D6). `01` §9 q4.
- **E7. Web replication window.** Decided: smaller than the desktop's: per
  space, full records for 30 days or the newest 100 threads, capped at 500,
  plus the user's own and saved threads of 90 days and threads opened in the
  tab; summaries for 2 years (`01` R1). `01` §9 q7.
- **E8. Device runs without a device.** Moot: no device runs. `03` §9 q3.
- **E9. Desktop test automation.** Moot (web-only build). `05` M7a.
- **E10. Where the new desktop shell lives.** Moot (web-only build). `05`
  M7a.

### Security

- **S1. Erasure and backups.** Decided: no retention requirement for backups;
  removed text may stay in Litestream generations and archives (`01` §9 q3).
- **S2. Account invite code length.** Decided: 30-bit `SESS-XXXX-XX`
  (`04` I2, §13). `04` §15 q3.
- **S3. Showing an open invite code again.** Decided: yes, from encrypted
  storage readable only by its creator (`04` §3.1). `04` §15 q4.
- **S4. Waiting accounts.** Decided: kept 90 days without a code; 5 per
  IP per day (`04` I1). `04` §15 q8.
- **S5. Device-run local reads.** Moot: no device runs. `AGENTS.md`
  "Desktop", `03` V4.
- **S6. Save counts in small private channels.** Decided: counts below 3 are
  not served or shown in private channels (`01` C1). `01` §9 q2.

Settled elsewhere: `02` §14 q1 (passage index) by `01` C3 and `03` §1;
`02` §14 q2 (Stop) by `03` G6 and `02` §3.3; `02` §14 q9 (effort) by `03`
K12; branch comments by `01` C4; the removal reason by `01` C12.

### New questions from the web-only scope

The product owner's answers, each with its source.

- **Q1. Amend ADR-19 to ADR-22 and `AGENTS.md` now?** Decided: yes: the
  carry-over commit writes a web-only `AGENTS.md`, and M1a adds a "Scope of
  this build" note to each ADR naming the desktop, phone and device-run
  parts not built. Both also record that there is no effect queue:
  notifications are written in the write's transaction and a queued `run`
  record replaces the `job` effect, which departs from `AGENTS.md`'s
  "queued effects commit together; effects run from a worker" (`01` U6,
  S4). `00` "Scope of this build", `05` §3.0, M1a.
- **Q2. Branch point.** The clone is shallow, so the initial commit is
  unconfirmed. Decided: unshallow, confirm it with `git rev-list
  --max-parents=0 HEAD`, and let the carry-over commit delete whatever it
  holds outside the carried set. `05` §3.0.
- **Q3. Build branch name and the old `main` after launch.** Decided:
  `session-web`; production for the new app deploys from it, and it becomes
  the default branch in M8c. The old `main` is kept as it is: not renamed,
  not archived, not made read-only; the `production` environment's branch
  rule stops its `deploy` job from deploying (§3.1). `05` §3.0, §3.1, M8c.
- **Q4. Offline writes on the web.** Decided: in-flight only ("Not sent"
  with Retry, drafts in sessionStorage); no IndexedDB outbox or replica.
  `01` Y9, Y10; `02` §9.2.
- **Q5. Keep the protocol version header?** Decided: yes; it is cheap
  and makes open tabs reload after a mutator change instead of failing
  writes; one reload, then a Reload message. `01` S1, `05` §3.4.
- **Q6. Seeding site admins after the wipe.** Decided: by handle (handles
  are unique; provider logins are not). Each admin redeems a root invite
  printed by `npm run db:admin -- --invite`, chooses a handle, and is then
  promoted with `npm run db:admin -- <handle>` (no config list of
  identities). `04` I1, `05` §3.5.
- **Q7. Identity rules across providers.** Decided: store each account's
  email address from the provider and update it on every sign-in; emails
  are not deduplicated, merged or used to match accounts; the Session
  handle is the only unique name; one person may hold one account per
  provider, each needing an invite; the account-age minimum applies to X
  through `created_at`. `04` I1, Z2, §13.
- **Q8. X developer access.** Which X API access level the sign-in needs at
  the expected volume, and its cost. Decided: Session launches with both
  GitHub and X. X access ready on the staging X app before M6 and on the
  production X app before launch is a launch blocker; there is no
  GitHub-only fallback. The M8b smoke test signs in with both. `04` Z2,
  `05` M6, M8a, M8b, §5.
- **Q9. Per-member model overrides** (the mockup's third admin variant).
  Decided: no. The Site Admin page has only the default model and the
  default effort; there is no per-member override and no availability
  setting. `03` K15, `02` W8.2.
- **Q10. How members reach site admins about abuse, with no reporting.**
  Decided: the site footer on every feed and page reads "Session · Report
  abuse: abuse@<host>" (the mockup's copy), where `<host>` is the hostname
  of `SESSION_PUBLIC_ORIGIN` (abuse@session.dev in production); site admins
  read the mailbox, which must exist before launch (M8a). There is no
  community guidelines page and no rules checkbox at sign-up. `02` W2.7,
  `04` §13, `05` M4, §5.
- **Q11. Launch date, notice period and the first members.** Decided:
  no launch date, notice period or banner, because the current web app is
  not in use and the wipe needs no announcement; site admins invite a
  named first group, who then have 3 invites each. `05` M8a, §3.5.
- **Q12. Weekly cost budget for the alert** (left from P11). Decided: no
  weekly spend budget and no cost alerting; during testing the provider
  API keys are capped at the provider. `05` §4, §5.
