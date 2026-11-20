# 05 — Delivery

Status: draft. This file orders the work from the finished phase 0 prototype
(`web/packages/replica-proto`) to the hard cutover, in dependency order. For
each milestone it states the scope (as item ids from 01-04), the exit criteria
as commands or named tests, then covers deployment and cutover, observability,
risks and the open questions of the whole plan. The designs it schedules are
in `01-architecture-and-data.md` (server half, data, mutators, sync, contract
changes), `02-client-app.md` (client), `03-agents-and-research.md` (runs) and
`04-membership-moderation-security.md` (membership, moderation, security).
Rules come from `AGENTS.md` ("Planned: desktop client and sync core") and
ADR-19 to ADR-22; where this file restates one, the source wins.

Naming: milestones are `M0`-`M8` with letter suffixes. Item ids of other files
are always prefixed with the file number ("`01` U6", "`04` O2"). 01's mutator
items are `U1`-`U6`, so an unprefixed `M` id is always a milestone. Ids per
file: 01 `S`, `D`, `U`, `Y`, `R`, `A`, `C`; 02 `W` (and `N` for its
dependencies); 03 `G`, `E`, `V`, `T`, `K`, `L`; 04 `I`, `B`, `O`, `P`, `Z`.

## 1. Milestones at a glance

| Id | Milestone | Depends on | Can overlap with |
|---|---|---|---|
| M0 | Phase 0: `replica-proto` (done) | — | — |
| M1a | Contract revision in `spaces.ts` and `replica-proto` | M0 | — |
| M1b | `@session/mutators` | M1a | M2 (interfaces) |
| M2 | `@session/sync` library (client half, server half over an in-memory store) | M1b | M4 (fixture replica) |
| M3 | Server half on SQLite passing replica-proto's suites; staging app | M2 | M4 |
| M4 | Client shell, feed, posts, replies, channels, signed-out reading | M1b (fixture replica); M2, M3 for e2e | M3, M5a |
| M5a | Owned runs: asks, branches, look-ups, comments, streaming | M3, M4 | M6 |
| M5b | Weekly allowance, payer, API keys, Usage page | M5a, ADR-23 accepted | M6, M7a |
| M6 | Membership and moderation | M3, M4 | M5a, M5b, M7a |
| M7a | Desktop shell: Tauri wrapper, SQLite adapter, device token | M4 | M5b, M6 |
| M7b | Device runs | M5a, M7a | M6 |
| M8a | Cutover preparation | M5b, M6, M7b | — |
| M8b | Data reset and hard cutover | M8a | — |
| M8c | Removal of the old code | M8b | — |

Each milestone ends with a merge to `main` whose checks pass on their own;
none depends on a later one to be verified. Until M8b, the current web app and
the current Tauri app stay in production with their rules (`AGENTS.md`); how
`main` keeps building while production does not change is in §3.1.

### 1.1 Commands referred to below

- Repository root: `npm run check` (desktop type checks, unused-module check,
  `cargo fmt --check`), `npm test` (`test:unit` and `cargo test` in
  `src-tauri`), `npm run preflight` (both). Required whenever
  `web/packages/shared` changes, because the desktop imports it (`AGENTS.md`,
  ADR-1).
- `web/`: `npm run check` (`tsc -b`, ESLint, Prettier, `drizzle-kit check`),
  `npm test` (AVA in every package), `npm test --workspace <pkg> -- <files>`
  for one package, `npm run test:e2e` (Playwright, Chromium, fixture
  providers; specs in `web/e2e`) (`12-testing-linting-ci.md` §1, §4).
- `web/packages/replica-proto`: `npm test` (`inv1`-`inv7`, `review-r1`,
  `review-r2`, `convergence`, the read oracle `oracle.ts`, the write oracle
  `write-oracle.ts`, the effect model `effect-model.ts`) and `npm run mutate`
  (`test/mutations/mutate.ts`; about 45 minutes on 4 cores; exits non-zero
  when a mutation survives; `-- --check` only checks that every pattern
  matches once; `-- X1 N2` runs a subset).
- `web/packages/db`: migration tests in `test/migrations.test.ts`, run with
  `cd web && npm test --workspace @session/db -- test/migrations.test.ts`.

### 1.2 Traceability

Every work item of 01-04 is scheduled in exactly one milestone. Three items
are split and say so: `01` D5 (`0001_spaces.sql` in M3,
`0002_drop_research.sql` in M8b), `02` W2.4 (web in M4, the Tauri drag
region in M7a) and `02` W6.10 (refusal messages in M6, the desktop frozen
banner in M7a). The contract
items `01` C1-C17 are scheduled in M1a, where they change `spaces.ts` and
`replica-proto`; the server routes some of them need are built under the
items named in the M3, M4 and M6 rows (`01` S4 runs C16's effect, `01` R5 and
`spaces.directory` serve C7, `04` §3 builds C8's account invites).

| Milestone | 01 | 02 | 03 | 04 |
|---|---|---|---|---|
| M1a | C1-C17, U6 | — | — (ADR-23 drafted, §6) | §11 (contract requests) |
| M1b | U1-U5 | — | G1, G2, G4, G5, G6 (mutators) | — |
| M2 | Y1-Y6, Y8-Y13, R1-R4 | — | — | — |
| M3 | S1-S5, D1-D4, D5 (0001), D6, D7, Y7, A1, A3 | — | — | — |
| M4 | A2, R5 | W1.1, W1.2, W2.1-W2.3, W2.4 (web), W2.5, W3.1, W3.2, W4.3, W4.5, W5.1, W6.1-W6.3, W6.6, W6.7, W9.1-W9.3, §9.5, §9.6, §9.8, W10.1-W10.3, W11.1, W11.2 | — | I5, B1, B3, P1 (§4.1 visibility rules with C9) |
| M5a | — | W3.3, W4.1, W4.2, W4.4 | G3, G7, G8, E1-E5, T1-T4, K1, K2, K12, K13, L1, L2 | — |
| M5b | — | W8.1 | K3-K11, K14 | — |
| M6 | — | W2.6, W6.4, W6.5, W6.8, W6.9, W6.10 (messages), W7.1-W7.3 | — | I1-I4, I6, B2, B4, B5, O1-O5, P2, Z1, Z2, Z4, Z5; §13 mitigations |
| M7a | — | W2.4 (desktop), W6.10 (frozen banner), §12.3 | — | Z3 |
| M7b | — | — | V1-V7, T5, L3 | — |
| M8b | D5 (0002) | — | — | — |

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

### M1a — Contract revision

Scope:
- `web/packages/shared/src/schemas/spaces.ts`: the contract changes `01`
  C1-C17 (likes removed and saves counted, ask-node kinds with `quote` and
  `look`, comments, total counts, channel rules removed, the "All" scope,
  account invites and `users.status`, `vis: "open" | "private"`, deferred
  surfaces moved to `spaces.deferred.ts`, owner-only About, report and
  removal notes and the `modlog` kind, the `prefs` record, ULID space ids,
  mentions, the run record) and the additions `04` §11 requests (`ban` and
  `unban` `modlog` kinds, one open report per reporter and item,
  `auth.checkInvite` with one `unusable` answer, no default rules).
- `replica-proto` changed to the revised contract before anything is ported
  (`01` U6): `likes.set` replaced by counted saves, rules dropped, comment and
  ask-node kinds added, `erase` extended to saves, comments and mention
  notifications; mutation patterns that pointed at removed code are
  rewritten with the same faults.
- Documents: ADR-19's `deviceNow` corrected to `clientTime` (`01` Y1); ADR-23
  (user API keys, model payers, the weekly allowance; `03` §6) drafted for
  decision before M5b.

Exit criteria:
- `cd web/packages/replica-proto && npm test && npm run mutate` exits 0.
- `cd web && npm run check && npm test --workspace @session/shared` passes,
  including `test/spacesMock.test.ts` (the mockup's validator test).
- Root `npm run check` passes (the desktop imports `@session/shared`).

### M1b — `@session/mutators`

Scope (`01` §3):
- New package `web/packages/mutators` (npm workspace, AVA, `tsc -b`
  reference), depending on `@session/shared` and `zod` only.
- `01` U1-U5: the three stages (`pre`, deterministic `run` over a synchronous
  `tx` with `tx.now` and `tx.id(ordinal)`, `post` effects carrying ids),
  indexed reads (`tx.byKey`, `tx.list`, `tx.count`) returning `unknown`
  outside the working set, the stored shape with counts as stored fields,
  stale-intent rules, and one file per area.
- The run-starting and graph mutators of `03` G1, G2, G4, G5, G6
  (`threads.create`, `research.forkNode` for asks and for look-ups with
  `LOOKUP_PROMPT_V1`, `comments.create`, promotion with `from`,
  `followups.delete`, `research.cancelNode`, `research.retryNode`). Their
  `post` stage queues `job` effects that nothing consumes until M5a.
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
  mutator, and the `03` G1, G2, G4 tests.
- `cd web && npm run check` passes, including the ESLint rule banning `Date`,
  `Math.random`, `crypto` and `Intl` in the whole package (`01` U1).

### M2 — `@session/sync`

Scope (`01` §4, §5):
- Package `web/packages/sync` with entry points `@session/sync/client` and
  `@session/sync/server`; the server half defines `ServerStore`, which this
  milestone implements in memory only.
- Wire and server half: `01` Y1-Y6, Y8 and Y13 (envelope, answers,
  `register`, `apply`, `snapshot` and `pull`, AEAD cursor tokens with the
  previous key, retention jobs, `serverApply` for server-originated writes).
- Client half: `01` Y9-Y12 (replica behind a `StorageAdapter`, with the memory
  adapter and a better-sqlite3 test adapter; the outbox; rebase; reactive
  queries).
- Replication tiers `01` R1-R4 (full and summary tiers, the window computed by
  the server with the client's opened-thread list, promotion, closed spaces
  and frozen copies).

Exit criteria:
- `replica-proto`'s harness uses the `@session/sync` client in place of
  `src/client.ts`; `cd web/packages/replica-proto && npm test && npm run
  mutate` exits 0 (patterns into `src/client.ts` moved as in M1b).
- `cd web && npm test --workspace @session/sync` passes: the `01` Y1-Y13
  acceptance tests, including outbox backoff, a write failing 5 times shown
  while later writes continue, the 3-day drop reported, `EXPIRED`,
  `CLOCK_SKEW` and `TOO_LARGE` handling, rollback with draft text restored
  (`04` §9), resync on a rejected token, the R2 snapshot test of the four
  inclusion rules and the 5,000 cap, tier promotion (R3), and the same client
  suite over both adapters (Y9).
- Server-half tests on the in-memory store reproduce `inv3`, `inv5`, `inv6`
  and `inv7`.
- `cd web && npm run check` passes.

### M3 — Server half on SQLite

Scope:
- `web/packages/db`: `01` D1-D4 and `0001_spaces.sql` of D5 (records, sync
  bookkeeping, non-replicated server tables, `secure_delete`), D6 (log epochs
  and the restore marker, with the step added to `runbooks/restore.md`), D7
  (record shape backfills); `ServerStore` over SQLite in
  `web/packages/db/src/sync/`.
- `web/packages/server`: `01` S1-S5 (sync pipeline with `Session-Protocol` and
  `426 UPGRADE_REQUIRED`, device tokens and `devices.*` pairing, configuration,
  effect worker, drain and boot), Y7 (SSE over `fetch`), A1 (sync routes),
  A3 (rate limits). The bearer and CORS basics of `01` S1-S3 land here;
  `04`'s hardening of them (Z2, Z4) is M6 and the desktop side (Z3) is M7a.
- A conformance target: replica-proto's harness gains a target interface
  (apply, snapshot, pull, register, clock control, random-source fault
  injection, storage scan); `web/packages/server/test/conformance/`
  implements it over HTTP against a server on a temp SQLite file. A test
  importing replica-proto is test code, so "nothing in the app imports it"
  holds.
- Staging app and the `main` branch split (§3.1, §3.2).

Exit criteria:
- `cd web && npm test --workspace @session/server -- 'test/conformance/**'`
  runs every replica-proto test file against the HTTP target with the same
  assertions.
- `cd web && npm test --workspace @session/db` passes, including
  `migrations.test.ts` (fresh database and a database at `0000` both migrate),
  the D1 property test, the D2 kill-between-statements test, the D3 test that
  no server-only table reaches `snapshot` or `pull`, the D4 storage scan over
  the SQLite file and WAL after a checkpoint, and the D6 restore test (a
  pre-restore cursor answers `resync`).
- Server mutation set: the X, N and R faults that apply to server-half code,
  re-expressed against `web/packages/server` and `web/packages/sync` and run
  by a copy of the runner (`npm run mutate --workspace @session/server`,
  proposed), exits 0. Faults without a counterpart are listed with the
  reason (question E4 in §6).
- Restart test: a server killed between commit and response answers the
  replayed envelope from the stored answer after boot (`01` S5).
- `cd web && npm run check && npm test` pass; CI's `docker` job builds.
- Load check on staging (`shared-cpu-2x`, 2 GB, as production): 200 SSE
  clients and 20 writes per second for 10 minutes, apply p95 under 50 ms,
  pull p95 under 100 ms, resident memory flat after the first minute, and
  the snapshot size of a 5,000-thread space recorded for question E7.

### M4 — Client shell, feed, posts and channels

Scope (`02-client-app.md`; items in §1.2): the research client removed (`02`
W1.1, with `01` A2's routers); the app shell, routes, bar hiding, phone
widths; feed rows and cards; reply trees on posts; the composer (Post mode
end to end, Ask mode against the fixture replica); channel header, info
dialog, About editor, Browse, New channel; the replica wiring, outbox
states and per-viewer fields; signed-out reading (`02` §9.5, `04` §3.5) and
unjoined open channels (`01` R5 with `spaces.directory`, `04` I5); channel
names and About (`04` B1, B3); saves and the Saved count (`04` P1); the
fixture replica (`02` §9.6); accessibility and tokens.
The usage ring renders from the fixture until M5b provides `usage.get`.

Exit criteria:
- `cd web && npm run check && npm test` pass, including every `02` W
  acceptance test listed for this milestone and the `02` §9.8 `rg` check for
  scaffolding names.
- `cd web && npm run test:e2e -- spaces-shell spaces-feed spaces-replies
  spaces-channels spaces-signed-out spaces-keyboard` passes against the M3
  server, for the post, reply, save, join, create and About parts of those
  specs (`02` §12.2); `spaces-feed` also covers the web in-flight-only rule
  with `context.setOffline` (a failed request shows "Not sent", a reload
  keeps nothing).
- `research.spec.ts`, `library.spec.ts`, `collaboration.spec.ts`,
  `live.spec.ts` and `widgets.spec.ts` are deleted; `visual.spec.ts`
  baselines are regenerated by CI's `update-visual-baselines` run (`12` §4)
  for the views in `02` §12.2.
- `vite build` output contains no fixture strings (`02` §9.6).

### M5a — Owned runs

Scope (`03` §1-§5, §7): run, turn and answer records; context assembly and the
access check at start (G7, G8); the owned loop re-pointed at records through
`serverApply` with attempt fencing (E1-E4); progress steps; streaming as
ephemeral deltas with gap refetch from `run_live` (T1-T4); the usage ledger
and what counts (K1, K2) with every run paid as `included` and the existing
limits; failure handling (E5); model access per run and the Effort submenu
listing the chosen model's efforts (K12, K13); per-run limits (L1, L2); the
client's run states, branch tree, branch card and selection actions (`02`
W3.3, W4.1, W4.2, W4.4) and the look-up display (G3).

Exit criteria:
- `cd web && npm test --workspace @session/server --workspace @session/db`
  passes, including `runs.test.ts` and `runRecovery.test.ts` rewritten
  against the new records (E2), the E1 removal-during-run test, the E3
  fixture-provider tests, the E4 cancel-then-retry test, the E5 test per
  failure row (owned rows here, device rows in M7b), the T2 non-member
  delta test, the T4 change-log bound and the L2 look-up tool cap.
- `cd web && npm run test:e2e -- spaces-feed spaces-branches spaces-runs`
  passes: ask with the `paced-answer` fixture, a reload mid-stream and a
  second tab on the same run, Continue, Branch, Branch here, Look up on a
  1-4 word selection showing the phrase and not the prompt, Comment, Stop,
  Run again creating a new attempt, dot alignment (`02` W4.1).
  `spaces-runs.spec.ts` is new in this milestone.
- Fixture providers only; nothing reaches a model provider in CI.

### M5b — Allowance, payer, API keys, Usage page

Entry: ADR-23 accepted (`03` §6; open question P11).

Scope: the weekly allowance and its reset (K3), API keys encrypted under
`SESSION_SECRET_KEY` with the `keyCheck` effect (K4), `usage.get` and
`usage.listRuns` (K5), the meter (K6), the billing setting and the payer made
in `pre` (K7, K8), crossing the allowance during a run (K9), runs at the reset
(K10), model payers in the registry (K11), the key-run privacy note (K14); the
Usage page (`02` W8.1) and the app bar ring on live data.

Exit criteria:
- `cd web && npm test` passes, including the K3 reset-boundary tests with an
  injected clock, the K4 test that greps the database file for a stored raw
  key and finds nothing, the K5 removed-thread test, the K8 mutator tests for
  each payer and the convergence test of a write queued with tokens left and
  applied after they ran out, and the K9 boundary-crossing ledger test.
- `cd web && npm run test:e2e -- spaces-usage` passes (keys, billing setting,
  out-of-tokens refusal of Ask while Post sends).
- `06-auth-and-users.md` §8 and `fly.toml`'s comment on daily limits updated
  to the weekly allowance.

### M6 — Membership and moderation

Scope (`04` items in §1.2; `02` W2.6, W6.4, W6.5, W6.8, W6.9, W6.10,
W7.1-W7.3): account invites, `users.status` and handles, the invite tree,
the "Join with invite?" flows and waiting accounts (`04` I1-I4); suspension
(`04` I6); roles with the member list, Make moderator and Transfer ownership
(`04` B2, `02` W6.8); channel invite links (`04` B4, `02` W6.9); report,
remove with reason, ban with the Banned list, the moderation log (`04`
O1-O5); the notifications page (`02` W2.6); privacy rules (`04` P2); client
rendering of apply-time refusals (`04` B5); abuse limits (`04` Z1); cookie
CSRF, CORS and rendering hardening (`04` Z2, Z4, Z5); the threat notes'
mitigations (merged failure answer for `auth.checkInvite`, the cursor-key
rotation runbook in `web/docs/runbooks/`).

Exit criteria:
- `cd web && npm test --workspace @session/db -- test/invites.test.ts` passes
  (`04` §3.1: hash lookup, concurrent redemption, handle uniqueness, the
  waiting-account sweep), and the server tests of `04` §3.2 (3 open links, a
  4th refused, revoke and use freeing a slot, concurrent creates, the admin
  exemption).
- `cd web && npm run test:e2e -- spaces-membership spaces-channels` passes,
  covering the scenarios of `04` I4 (link, code, waiting account, used
  code), B3, B4 (private channel link, reused link refused) and §6.6
  (report, moderation log count without reload, removal with reason,
  dismissal, ban); spec names as in `02` §12.2.
- `04` I6 and Z1-Z5 server tests pass: a suspended user's queued envelope
  refused and its device token answering `401`; one middleware test per
  limit row; the cookie and bearer CSRF and CORS tests; the untrusted-text
  rendering test.
- The conformance suite (M3) and `cd web/packages/replica-proto && npm test`
  still pass after the M6 mutator changes; `npm run mutate` runs on the pull
  request (§3.1).
- Privacy check on staging, by script: after a removal, the removed text is
  absent from the SQLite file, from `pull` and `snapshot` answers for every
  role, and from the `effects` table (the D4 scan run with
  `fly ssh console -a session-staging`).

### M7a — Desktop shell

Scope:
- A Tauri shell that loads the M4 client build (macOS only; one client
  codebase). It is built from a separate directory so the current app keeps
  building and releasing from `src/` and `src-tauri` until M8b (question
  E10). It keeps bundle id `dev.session.desktop`, the Keychain service, the
  updater key and endpoint (`docs/session-cutover.md`, `docs/releasing.md`),
  so existing installs update into it.
- A SQLite `StorageAdapter` on the Rust side behind a narrow command set
  (load working set, persist batch, wipe), so the outbox survives restarts
  for 3 days.
- Device-token sign-in through a pairing code (`01` S2, `04` Z3), the token
  in the Keychain and held by the Rust side, never by the webview's
  JavaScript; sign-out and a `401` wiping replica and outbox; the
  frozen-channel banner (`04` P2, `02` W6.10); the drag region and
  traffic-light inset (`02` W2.4); "Update Session" through the updater on
  `426`.

Exit criteria:
- `cargo test` for the new shell covers the storage adapter (persist, load,
  wipe, a crash between persist and acknowledge), token storage through a
  Keychain abstraction, and the `04` Z3 test that no Tauri command returns
  the token; a pairing code fails after 10 minutes and after 5 wrong
  attempts.
- Root `npm run check && npm test` pass; `.github/workflows/desktop.yml`'s
  `frontend`, `rust` and `native` jobs pass.
- The manual macOS checklist in `web/docs/runbooks/desktop-release.md` (new):
  sign in, an offline reply queued and sent after an app restart (`02`
  §12.3), the frozen channel of a removed member, sign-out wipe, "Update
  Session" for a protocol below the minimum, window drag by the bar.

### M7b — Device runs

Scope (`03` V1-V7, T5, L3; ADR-21): CLI detection and the picker entries,
claim with the G8 check, lease and heartbeat every 10 s, the CLI spawned in
an empty temporary directory with no session resume, turn and finish
reporting with the attempt number, the 200 KB answer cap, 100 device runs per
hour, "Waiting for your Mac".

Exit criteria:
- `cd web && npm test --workspace @session/server` passes the V2 concurrent
  claim test, the V3 lease-expiry test (run `interrupted` within 40 s, late
  turn refused), the V5 stale-attempt, oversized-answer and no-turn tests, and
  the V6 101st-claim refusal.
- `cargo test` in the new shell passes the executor tests against the
  fake-CLI fixture of `03` V4 (recorded JSONL: claim, turns, finish, lease
  loss, a working directory that is empty at spawn).
- The macOS checklist gains a device run end to end with each CLI.
- The risk "device runs read local files" (§5) has a recorded decision
  (question S5).

### M8a — Cutover preparation

Scope, with production still on the current app:
- `web/docs/runbooks/cutover.md` (new): the steps of §3.6 with commands.
- On the `legacy-web` branch (§3.1), deployed to production: a banner with the
  cutover date and what is dropped (§3.5), and a handler that reloads the
  page on any `426`, so tabs open across the cutover load the new client.
- A migration rehearsal: restore production's latest Litestream generation to
  a scratch machine (`runbooks/restore.md` §2), run the cutover build against
  it, and record the time `0001` and `0002` take and the file size after.
- A restore rehearsal on staging including the epoch bump (`01` D6).
- Production secrets staged with `fly secrets set --stage -a session-dev`
  (§3.4); the desktop release built, signed and notarized, not published.

Exit criteria:
- `cd web && npm test --workspace @session/db -- test/migrations.test.ts`
  passes a test that migrates a populated `0000` database (fixture rows in
  every research table, users with and without `invited_by`) through `0002`
  and checks: kept tables keep their rows, dropped tables are gone, every
  existing user is `active`, and a byte scan of the file finds none of the
  fixture's research text.
- The migration rehearsal and the staging restore rehearsal are recorded in
  the cutover runbook with their times.
- The banner has been live for the notice period (question P17).

### M8b — Data reset and hard cutover

Scope: §3.5 and §3.6. Exit criteria:
- Root `npm run preflight` and the web CI jobs (`check`, `test`, `e2e`,
  `docker`) green on the cutover commit.
- Production smoke on the deployed build: `curl -fsS
  https://session.dev/healthz`; sign in on web and desktop; post; ask with
  included tokens; a device run; report and remove; invite link redemption;
  boot log shows `0001` and `0002` applied and Litestream replicating.
- A restore rehearsal against a post-cutover snapshot, including the epoch
  bump.

### M8c — Removal of the old code

Scope: delete the old desktop frontend (`src/`), its Rust commands and tests,
the web client's tree and workspace code still present, the `legacy-web`
branch; move the new shell into place if it was built separately; decide on
replica-proto's prototype server (question E5; the suites stay); restore the
production `deploy` job on `main`; update `AGENTS.md` (move "Planned" to
current rules, drop "until the cutover"). Exit: root `npm run preflight`,
`cd web && npm run check && npm test`, and both CI workflows green.

## 3. Deployment and cutover

### 3.1 Pipeline and branches

`13-deployment-fly.md` and `12` §4: CI's `check`, `test`, `e2e` and `docker`
jobs gate `deploy` on a push to `main`; one Fly app (`session-dev`), one
machine, one volume, `strategy = "immediate"`. Added:

- From M1a, a CI job runs replica-proto's `npm test`; from M3, the conformance
  suite runs inside the server's `npm test`.
- `npm run mutate` (replica-proto, and from M3 the server copy) is too slow
  for every push; it runs nightly and on pull requests that touch
  `web/packages/replica-proto`, `web/packages/mutators`, `web/packages/sync`
  or the server's sync code, and a surviving mutation fails that run.
- Before the first M3 merge, the merge that can change production behaviour
  (`0001_spaces.sql`, new routes), `main` stops deploying to production: the
  `deploy` job targets the staging app, and production deploys come from a
  `legacy-web` branch cut from `main` at that point, which takes only fixes
  and the M8a notice. M8b deploys `main` to production; M8c removes the
  branch. This keeps "until the cutover, the current app stays" true while
  M3-M7 land on `main` (question E1).

### 3.2 Staging

From M3 to M8b the new server runs on a separate Fly app (`session-staging`
proposed, `web/fly.staging.toml`) with its own volume, Litestream bucket
prefix, OAuth app, secrets and `SESSION_REQUIRE_INVITE=1`. Model calls use
fixture providers by default and real providers with low per-user limits when
a milestone needs them (M5a, M7b). A second Fly app departs from `13` §1's
single app (question E1); production keeps one database on one machine.

### 3.3 Litestream and restore

- Replication as in `13` §6: continuous, snapshot every 6 h, retention 30
  days. The change log, recorded answers and effect queue add write volume;
  WAL size is monitored (§4).
- A restore moves the database back in time while clients hold cursors and
  confirmed answers from after the restored point. `runbooks/restore.md`
  gains the `01` D6 step: write the restore marker before the server accepts
  traffic, so boot increments every log epoch and every cursor resyncs, and
  record the restore time. Writes confirmed after the restored point are
  lost: their recorded answers are gone and clients have dropped them from
  their outboxes. The runbook states this window (Litestream lag, seconds).
- Erased content stays in Litestream generations for as long as they are
  retained (`01` D4). Decided: backups have no retention requirement; the
  30-day retention is set for recovery.
- `SESSION_CURSOR_KEY` and `SESSION_CURSOR_KEY_PREVIOUS` are Fly secrets; a
  rotation runbook (M6) covers the 30-day overlap.

### 3.4 Protocol version, "Update Session" and configuration

- Every sync and tRPC request of the new clients carries `Session-Protocol`
  (`01` S1). The server accepts `[SESSION_MIN_PROTOCOL, current]`; below the
  minimum it answers `426 { code: "UPGRADE_REQUIRED" }` and the client shows
  "Update Session" (desktop: the updater; web: reload).
- Additive changes (a new optional input field, a new mutator, a record kind
  old clients ignore) do not bump the version. A change to an existing
  mutator's input or `run` semantics bumps it, because prediction and
  authority must run the same definition.
- Order for a bump: deploy the server accepting both versions, publish the
  desktop release, raise the minimum after 7 days (question E2), or at once
  for a security fix. The web client is current after a reload; an open tab
  receives `426` and reloads.
- Configuration added (`01` S3, `03` §6-§7, `04` §10): `SESSION_MIN_PROTOCOL`,
  `SESSION_CURSOR_KEY`, `SESSION_CURSOR_KEY_PREVIOUS`, `SESSION_SECRET_KEY`,
  `SESSION_DEVICE_ANSWER_MAX_BYTES`, `SESSION_DEVICE_RUNS_PER_HOUR`,
  `SESSION_WEEKLY_TOKENS`, `SESSION_RUN_MAX_TOKENS`,
  `SESSION_QUEUED_PER_USER`, `SESSION_DESKTOP_ORIGINS` (the CORS allowlist of
  desktop origins) and the abuse limits of `04` Z1. All are validated at boot and documented in
  `web/.env.example`; the keys are Fly secrets. Losing `SESSION_SECRET_KEY`
  makes stored API keys unreadable; it is backed up outside Fly.

### 3.5 Data reset: what is dropped, what is kept, how users are told

`AGENTS.md`: existing web data is dropped and no desktop research is
imported. `01` D5 leaves the choice between `0002_drop_research.sql` and a
full reset (`runbooks/reset-database.md`) to this file. Choice: the
migration, because a full reset also discards the accounts, admin flags and
`invited_by` edges the invite tree starts from (question P19 asks whether to
reset anyway).

Dropped by `0002` (with `secure_delete` on from `0001`, so freed pages are
overwritten):
- Research and collaboration tables: `trees`, `tree_*`, `nodes`,
  `node_messages`, `node_summaries`, `run_turns`, `run_attempts`, `run_queue`,
  `followup_queue`, `response_snapshots`, `folders`, `workspaces`,
  `highlights`, `feed_items`, `research_drafts`, `interface_drafts`,
  `widget_*`, `research_images`, `image_refs`, `notifications`,
  `collapsed_*` (`01` §2).
- `embed_assets` and `tweet_cache`, which serve only research content (`01`
  §2 drops them).
- Files: `/data/documents/*` (image attachments of `research_images`) and
  `/data/embeds/*`, removed by a cutover step (§3.6), as in
  `reset-database.md` §3.

Kept: `users` (GitHub identity, `is_admin`, `invited_by`; extended with
`status`, `handle`, `display_name` by `04` §3.1; every existing user becomes
`active`, users with no `invited_by` become roots of the invite tree, and
each chooses a handle at first sign-in before any write), `sessions` (no
sign-in needed), `oauth_states`, `invites` (extended by `01` C8; unused codes
stay redeemable), `signup_attempts`, `user_limits`, `usage_events` (rows from
before the cutover have no `week` and do not count toward an allowance),
`user_preferences`, `backfills`.

On the desktop: the new build imports no local research and reads none of
the old app's storage; the old files under `~/Library/Application
Support/session` stay in place (question P16).

Backups: the pre-cutover Litestream generation, which holds all dropped
content, is kept until the 30-day retention expires and then deleted; it is
the only rollback source (§3.6).

How users are told (`users` holds no email address, so notices reach only
people who open the app):
- From M8a, a banner in the current web app with the date, the sentence
  "Threads, workspaces and folders on the web are removed on <date>; your
  account and sign-in stay".
- After the cutover, the release notes of the desktop update and a one-time
  notice on first launch of the new build: local research is not imported
  and the old files remain on disk.
- Whether to offer an export before the date is question P20.

### 3.6 Cutover sequence (M8b)

1. Freeze: merge the cutover commit to `main`; CI green (`check`, `test`,
   `e2e`, `docker`).
2. Record the current Litestream generation and time as the rollback point;
   restore it to a scratch machine and run `PRAGMA integrity_check`
   (`runbooks/restore.md` §2).
3. Apply the staged secrets and deploy `main` to production (`fly deploy web
   -c web/fly.toml`; with `strategy = "immediate"` this is a short outage).
   Boot runs `0001` and `0002`, then starts the effect worker.
4. Remove `/data/documents/*`, `/data/embeds/*` and
   `/data/tmp/documents-backup.stamp` from a one-off machine with the volume
   (`reset-database.md` §3), so the next documents archive starts empty.
5. Smoke checks (M8b exit). On failure before step 6: `fly scale count 0`,
   restore the rollback point (`runbooks/restore.md`), deploy the
   `legacy-web` image, scale to 1. Nothing written to the new build is kept.
6. Publish the desktop release (`docs/releasing.md`). From here rollback
   would lose writes made through the new clients and is not planned; fixes
   go forward.
7. After 7 days: the `legacy-web` image and the rollback generation are no
   longer needed; the generation expires with Litestream retention.

## 4. Observability

Additions to `13` §7, all in `/metrics` and the JSON logs. Logs carry ids and
answer codes, never record text.

| Signal | What it shows | Alert |
|---|---|---|
| `session_sync_apply_total{mutator,answer}` | Writes by answer code (`OK`, `FORBIDDEN`, `STALE`, `CONFLICT`, `EXPIRED`, `CLOCK_SKEW`, `TOO_MANY_REQUESTS`, …) | `INTERNAL_SERVER_ERROR` above 1% for 10 min |
| `session_sync_apply_seconds` | Apply latency histogram | p95 above 100 ms |
| `session_sync_pull_seconds`, `session_sync_snapshot_bytes` | Read cost per log; snapshot size per tier | p95 pull above 250 ms; p95 snapshot above 5 MB |
| `session_sync_resync_total{reason}` | Resyncs by reason (forged, expired, epoch, scope change) | sudden rise after a deploy |
| `session_sync_clients`, `session_sse_clients` | Registered and connected clients | — |
| `session_effects_queue_depth`, `session_effects_dead_letters` | Effect worker health | any dead letter |
| `session_changelog_rows`, `session_tombstones`, `session_idempotency_rows` | Table growth and pruning | growth past the 30- and 7-day bounds |
| `session_protocol_requests{version}` | Old clients in use | share below minimum after a bump |
| `session_rate_limited_total{bucket}` | Abuse limits hit | — |
| `session_invite_checks_total{outcome}` | Invite code checks | failed checks above 100/hour |
| `session_reports_total`, `session_removals_total` | Moderation volume | — |
| `session_weekly_tokens{payer}`, `session_weekly_cost_usd{provider}` | Included-token spend against budget | weekly cost above the budget set in question P11 |
| `session_run_failures_total{cls}` | Owned-run failures by provider error class (`03` E5) | any `auth` (the deployment credential was rejected) |
| `session_device_runs_active`, `session_device_leases_expired_total` | Device runs | lease expiries above 20% of claims |
| `session_wal_bytes` | WAL size between checkpoints | above 512 MB |

The client sends, with each sync request, its outbox length and the age of
its oldest entry; the server logs them per client id to diagnose stuck
outboxes.

## 5. Risk register

Owner roles: Product, Server (server half, sync, runs), Client (web client),
Desktop (Tauri shell, device runs), Security, Operations (deploys, backups).

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| The real server half diverges from the prototype where the suites do not look | Medium | High | Conformance target runs every replica-proto file unchanged; server mutation set (M3); oracles and convergence in CI | Server |
| The mutation run is too slow to keep in the loop | High | Medium | Nightly and path-filtered runs; `--slots`; name filters per change | Server |
| SQLite's single writer saturates with change log, recorded answers and effects | Low | High | One commit per apply; short transactions; M3 load check; machine size raised before limits | Server |
| Erased text survives in WAL, effect payloads or logs | Medium | High | Effects carry ids; logs carry no text; storage scan over file and WAL (M3); staging scan (M6) | Security |
| A restore serves erased text again (backups keep it; no retention requirement, decided) | Medium | Medium | A restore to a point before a removal serves the removed content again; the restore runbook lists the removals applied after the restore point (from the JSON logs, which carry mutator names and item ids) and repeats them before traffic resumes | Security |
| Included-token spend exceeds budget: 2,000,000 tokens per member per week at the default model's price, cached context counted in full | Medium | High | `SESSION_WEEKLY_TOKENS` per user override; per-run cap `SESSION_RUN_MAX_TOKENS`; weekly cost alert (§4); model and allowance decided in ADR-23 before M5b (P11, P12) | Product |
| Device runs expose local files: channel content in the CLI prompt can direct read-only tools to read files outside the empty working directory and put them in an answer posted to a shared channel | Medium | High | Empty working directory; no attachments; answer size cap; decision before M7b exit on locking tools to web search and fetch or limiting device runs to private channels (S5) | Security |
| Device token theft or a stolen Mac | Low | High | Token hashed on the server, Keychain item bound to the signing identity, revocation ends streams within 60 s (`04` §12); local replica relies on FileVault | Security |
| Replica size on small devices: 5,000 full threads per space in a web tab's memory or on a phone | Medium | Medium | Snapshot size measured in M3 and alerted (§4); web window decided (E7); Phone window 30 days or 200 threads; Phone not scheduled before cutover (P18) | Server |
| Every deploy restarts the one machine and every SSE client reconnects and pulls at once | High | Low | Cursors resume with `pull`, not `snapshot`; client reconnect jitter; load check includes a reconnect of 200 clients | Server |
| A restore loses confirmed writes | Low | Medium | Epoch bump; runbook statement; Litestream lag monitored | Operations |
| Cutover migration takes too long or fails on production data | Low | High | Rehearsal on a restored copy (M8a) with timing; rollback point and `legacy-web` image (§3.6 step 5) | Operations |
| Client prediction and server disagree across versions | Medium | Medium | Protocol bump rule; rebase on confirmed changes; `unknown` stops prediction | Server |
| Cursor key or secret key lost, or rotated without overlap | Low | Medium | Configured keys with a 30-day previous cursor key; rotation runbook; keys backed up outside Fly; a lost cursor key causes resyncs, a lost secret key forces users to re-enter API keys | Operations |
| Desktop UI cannot be driven by Playwright (tauri-driver has no macOS support) | High | Medium | Client logic tested in the browser; Rust adapter and executor tests; manual macOS checklist | Desktop |
| Invite code enumeration through `auth.checkInvite` | Low | Medium | 50-bit codes (S2), one failure answer, per-IP limits, failed-check alert | Security |
| Invite tree slows growth or concentrates invites in admins | Medium | Low | Admin exemption from slots; redemption metrics | Product |
| Spam or abuse in open channels | Medium | Medium | Invite-only accounts; report, removal, ban; per-user limits; the invite tree to find an abusive account's inviter | Product |
| Existing web users lose research they wanted to keep | Medium | Medium | Banner with date (M8a); export decision (P20); accounts kept | Product |
| ADR-23 (user keys, models) is not accepted in time | Medium | Medium | Drafted in M1a; M5a ships on included tokens only; M5b waits on it | Product |
| Scope from the mockup grows past the contract (rules, hide, join requests, inbox) | Medium | Medium | `04` §1 decisions; contract changes only through `01` §7 | Product |

## 6. Open questions

One deduplicated list of the open questions of 01-05, grouped by who decides.
Each names its sources; the files' own lists stay as written. Ids are for
reference from this file.

### Product

- **P1. Sign-in provider.** X in addition to or instead of GitHub (ADR-5).
  `04` §1, §15 q7.
- **P2. Channel moderators in v1.** Grant `mod` through "Make moderator" (as
  `04` B2 and `02` W6.8 propose) or keep the owner as the only staff. `01` §9
  q5, `04` §1.
- **P3. Site-wide moderators** or only `users.is_admin`. `04` §15 q6.
- **P4. Admission to private channels.** Channel invite links only (`04` B4,
  `02` W6.9), or also join requests, which have no screen. `01` §9 q6.
- **P5. The removal placeholder.** Decided: the author shows as "[deleted]"
  (`04` §6.2). Open: whether it stays until the author deletes it or expires. The reason is
  moderator text and is shown (`01` C12). `02` §14 q4, `04` §15 q1, q2.
- **P6. Report and remove follow-ups and replies individually at launch.**
  `04` §15 q9.
- **P7. Offer Hide to staff.** `04` §15 q10.
- **P8. Frozen copy after a voluntary Leave** (proposed: no). `04` §15 q5.
- **P9. Thread addresses and a single-thread page** for notifications and
  shared links. `02` §14 q3.
- **P10. Notifications surface.** `01` C16 writes mention notifications and
  `04` O1-O2 report notifications; `02` W2.6 lists them on a page reached
  from the account menu (not in the mockup). Whether it needs an app bar
  control or desktop push notifications. `02` §14 q5.
- **P11. Models at launch and the allowance.** Default model for members,
  lifting ADR-16's Fable gate; the weekly budget for the cost alert. Decided:
  2,000,000 tokens a week per member. `03` §9 q1.
- **P12. Cached tokens** counted in full, at the discount ratio, or not at
  all. `03` §9 q2.
- **P13. Effort and the allowance.** The Effort submenu ships with the chosen
  model's efforts (`03` K12, `02` §5; ADR-23 records it against ADR-16).
  Open: show a cost estimate for high efforts, or cap effort on included
  tokens. `03` §9 q6.
- **P14. Who may promote a branch** and who is shown as its author. `03` §9 q4.
- **P15. "Run on this Mac"** in the out-of-tokens message. `03` §9 q5.
- **P16. Old desktop data** after the cutover: delete, offer to delete, or
  leave (proposed: leave). `05` §3.5.
- **P17. Cutover date and notice period.** `05` M8a.
- **P18. Phone client** before or after the cutover. `05` §5.
- **P19. Keep accounts through the data reset** (`0002`), or reset fully and
  re-seed admins. `05` §3.5.
- **P20. Export before the reset** for existing web users. `05` §3.5.
- **P21. Widgets and artifacts in answers.** `02` §14 q6.
- **P22. Typography** (Inter or the app's font; title and input sizes).
  `02` §14 q7.
- **P23. Settings entry** in the account menu. `02` §14 q8.

### Engineering

- **E1. Staging and the branch split.** A second Fly app and `main` deploying
  to it until M8b (§3.1, §3.2), or the spaces server behind a flag in the
  production app. `05` §3.
- **E2. Previous protocol version window** after a desktop release (proposed
  7 days). `05` §3.4.
- **E3. Record storage.** One `records` table with JSON bodies and generated
  columns as needed, or typed tables for threads and nodes now. `01` §9 q1.
- **E4. Server mutation set.** Which faults are required for M3's exit and
  which may be listed as not applicable. `05` M3.
- **E5. replica-proto's prototype server** after M3: kept as the reference or
  removed once the conformance target exists. `05` M8c.
- **E6. Restore detection.** A runbook-written marker or a boot-time check of
  the Litestream generation id. `01` §9 q4.
- **E7. Web replication window.** A smaller window for the in-memory web
  replica than the desktop's, given snapshot size per tab. `01` §9 q7.
- **E8. Device runs without a device.** How long a device run may stay
  queued, and a server-side wall clock for claimed runs. `03` §9 q3.
- **E9. Desktop test automation.** A manual macOS checklist, or a UI
  automation route before M8b. `05` M7a.
- **E10. Where the new desktop shell lives** until M8c (separate directory or
  in `src-tauri` behind a build switch). `05` M7a.

### Security

- **S1. Erasure and backups.** Decided: no retention requirement for backups;
  removed text may stay in Litestream generations and archives (`01` §9 q3).
- **S2. Account invite code length.** 30-bit `SESS-XXXX-XX` or 50-bit
  `SESS-XXXXX-XXXXX`. `04` §15 q3.
- **S3. Showing an open invite code again**, which needs reversible storage.
  `04` §15 q4.
- **S4. Waiting accounts.** Lifetime without a code (proposed 14 days) and
  their place in per-IP sign-up throttling. `04` §15 q8.
- **S5. Device-run local reads.** Whether locking the CLIs' read tools (or
  limiting device runs) must land before M8b, given answers are posted to
  shared channels. `AGENTS.md` "Desktop", `03` V4, `05` §5.
- **S6. Save counts in small private channels**, where a count of 1 can
  identify the saver. `01` §9 q2.

Settled elsewhere: `02` §14 q1 (passage index) by `01` C3 and `03` §1;
`02` §14 q2 (Stop) by `03` G6 and `02` §3.3; `02` §14 q9 (effort) by `03`
K12; branch comments by `01` C4; the removal reason by `01` C12.
