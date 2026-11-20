# 05 — Delivery

Status: draft. This file orders the work from the finished phase 0 prototype
(`web/packages/replica-proto`) to the hard cutover, in dependency order. For
each milestone it states the scope, the exit criteria and the tests that prove
them, then covers deployment, observability, risks and the open questions of
the whole plan. The designs it schedules are in `01-architecture-and-data.md`
(server half, data, mutators, sync, contract changes), `02-client-app.md`
(client), `03-agents-and-research.md` (runs) and
`04-membership-moderation-security.md` (membership, moderation, security).
Rules come from `AGENTS.md` ("Planned: desktop client and sync core") and
ADR-19 to ADR-22; where this file restates one, the source wins.

## 1. Milestones at a glance

| Id | Milestone | Depends on | Can overlap with |
|---|---|---|---|
| M0 | Phase 0: `replica-proto` (done) | — | — |
| M1 | `@session/mutators` | M0 | M2 (interfaces) |
| M2 | `@session/sync` | M1 | M4 (in-memory server) |
| M3 | Server half passing replica-proto's suites | M1, M2 | M4 |
| M4 | Client shell and feed | M2 (M3 for e2e) | M3, M5 |
| M5 | Runs | M3, M4 | M6 |
| M6 | Membership and moderation | M3, M4 | M5, M7 |
| M7 | Desktop (Tauri) wrapper and device runs | M4, M5 | M6 |
| M8 | Data reset and hard cutover | all | — |

Until M8, the current web app stays deployed and the current Tauri app and
its rules stay as they are (`AGENTS.md`). The new server and client run on a
staging app (§3.2) from M3.

### Test commands referred to below

- Repository root: `npm run check` (desktop type checks, unused-module check,
  format) and `npm test`; `npm run preflight` runs both. Required whenever
  `web/packages/shared` changes, because the desktop imports it (`AGENTS.md`,
  ADR-1).
- `web/`: `npm run check` (`tsc -b`, ESLint, Prettier, `drizzle-kit check`),
  `npm test` (AVA in every package), `npm run test:e2e` (Playwright, Chromium,
  fixture providers) (`12-testing-linting-ci.md`).
- `web/packages/replica-proto`: `npm test` (the adversarial suite, read and
  write oracles, effect model, convergence) and `npm run mutate` (about 45
  minutes on 4 cores; exits 1 when a mutation survives).

## 2. Milestones

### M0 — Phase 0 (done)

`web/packages/replica-proto`: prototype server half (`src/server.ts`), access
rules (`src/access.ts`), mutators ported from the mock backend
(`src/mutators.ts`), a minimal replica client (`src/client.ts`), and the
suites `inv1` to `inv7`, `review-r1`, `review-r2`, `convergence`, the read
oracle, the write oracle, the effect model and the mutation runner (X1–X31,
N2–N34, R2-1 on). Nothing in the app imports it. It is the acceptance suite
for M1–M3.

### M1 — `@session/mutators`

Scope:
- New package `web/packages/mutators` (npm workspace, AVA, `tsc -b`
  reference), depending on `@session/shared` and `zod` only.
- The three stages from `AGENTS.md`: server-only pre-checks that may refuse
  (invite codes, limits), a deterministic `run` over a synchronous `tx`
  (`tx.now`, ids from the input and from the mutation id plus an ordinal, no
  clock, no random source, no `Intl`/`Date` formatting), and post-commit
  effects that carry ids, not text.
- Every write in the contract that the client uses, ported from
  `replica-proto/src/mutators.ts` and the mock API, plus the contract changes
  listed in `01-architecture-and-data.md` and in
  `04-membership-moderation-security.md` §11 (report `why` optional, removal
  `reason`, `modlog` records, no default channel rules).
- Shared validators used by both client forms and mutators: channel name,
  handle, text bounds.
- The `unknown` answer for reads the replica cannot answer, which stops
  prediction.

Exit criteria:
- `replica-proto` imports its mutators from `@session/mutators` instead of
  `src/mutators.ts` (its `server.ts` and harness unchanged otherwise), and
  every replica-proto test passes.
- `npm run mutate` in replica-proto reports no `SURVIVED`, with patterns that
  pointed into `src/mutators.ts` moved to the package and the faults kept the
  same (the runner's README rule).
- The mutator package's own tests: one test file per namespace (`spaces`,
  `members`, `invites`, `reports`, `moderation`, `research`, `replies`,
  `followups`, `notifications`), plus the determinism test of `inv1`
  ("mutators read no clock, no random source and no Intl") run over every
  mutator in the package.
- `web/` `npm run check` and the root `npm run check` pass.

### M2 — `@session/sync`

Scope (design in `01-architecture-and-data.md`):
- Package `web/packages/sync` with two entry points, `client` and `server`.
- Client half: replica behind a storage adapter (used only to load and persist
  behind a working set), an in-memory adapter for the web, an adapter
  interface the desktop's SQLite adapter implements in M7; the outbox in one
  global order, kept 3 days in server time, pausing with backoff on transient
  answers; registered client id and per-client seq; reminted envelopes listing
  replaced mutation ids; rebase of pending writes on confirmed changes; a
  cursor token per log; replication tiers (full and summary records, the
  windows in `AGENTS.md`); reactive queries for React and React Native.
- Server half as a library over a storage interface: one change-log table, one
  log per space and one per user (rows hold key, operation and version);
  `snapshot` and `pull` reading records as they are now, filtered by the
  reader's scope; tombstones for 30 days; the last processed seq per client
  with every batch; idempotent apply by (user, mutation id) for 7 days; the log
  epoch; AEAD cursor tokens with a configured key and a 30-day previous key;
  an SSE reader over `fetch` with a map of cursor tokens as the event id.

Exit criteria:
- `replica-proto`'s `convergence.test.ts` runs with the `@session/sync` client
  in place of `src/client.ts` against the prototype server and passes.
- Client-half tests: outbox order and backoff; a write failing 5 times shown
  while later writes continue (`Q3`); the 3-day drop reported; `EXPIRED`,
  `CLOCK_SKEW`, `TOO_LARGE` handling; rebase after a refusal; rollback with
  draft restoration (`04` §9); resync on a token the server rejects; tier
  promotion when a thread is opened.
- Server-half tests against an in-memory store reproduce `inv3`, `inv5`,
  `inv6` and `T1` with the library's own code.
- `web/` `npm run check` passes.

### M3 — Server half passing replica-proto's suites

Scope:
- In `web/packages/db`: Drizzle tables for records, the change log, the id
  registry (every id with its last rev, never reused), idempotency answers,
  registered clients (90-day idle expiry, 20 registrations a day), the effect
  queue with dead letters, tombstones, cursor epochs. Migrations generated
  with `drizzle-kit`.
- In `web/packages/server`: the apply, snapshot, pull and SSE endpoints over
  the `@session/sync` server library and SQLite; the commit that writes record
  changes, the stored answer, the seq and queued effects together; the effect
  worker with backoff; the protocol version header and the minimum-version
  answer; cookie authentication per `06-auth-and-users.md` and the
  device-token path (`04` §12); request-level rate limits.
- A conformance adapter: replica-proto's harness (`test/harness.ts`) gains a
  target interface (apply, snapshot, pull, register, clock control, random
  source fault injection, storage scan). The prototype implements it in
  process; `web/packages/server/test/conformance/` implements it over HTTP
  against a server on a temp SQLite file with an injected clock. A test
  importing replica-proto is test code, not app code, so `AGENTS.md`'s "nothing
  in the app imports it" holds.

Exit criteria:
- Every replica-proto test file passes against the conformance target, with
  the same assertions: `inv1`–`inv7`, `review-r1`, `review-r2`, the read and
  write oracles, the effect model and `convergence`.
- The storage scan (`R5`) runs over the SQLite file, the WAL included, after a
  checkpoint: removed text appears in no table.
- A server mutation set: the X, N and R faults that apply to server-half code
  are re-expressed against `web/packages/server` and `web/packages/sync`, run
  by a copy of the mutation runner, and none survive. Faults that have no
  counterpart in the real code are listed with the reason.
- Restart test: a server killed between commit and response answers the
  replayed envelope from the stored answer after boot.
- Load check on the staging machine size (`shared-cpu-2x`, 2 GB): 200 SSE
  clients and 20 writes per second for 10 minutes, apply p95 under 50 ms,
  pull p95 under 100 ms, no growth in resident memory after the first minute.
- `web/` `npm run check` and `npm test` pass; CI's `docker` job builds.

### M4 — Client shell and feed

Scope (`02-client-app.md`): the app shell (app bar with the scope picker,
channel strip, usage ring, Saved count, layout toggle, account menu), the feed
rows with branches in the side column, thread view, the composer (Ask and
Post), channel pages, Browse, the signed-out reading mode, and the replica
wiring (reactive queries, outbox state shown on items). Old web screens for
trees, workspaces and folders are removed from the client package.

Exit criteria:
- New e2e specs replace `research.spec.ts`, `library.spec.ts`,
  `live.spec.ts` and `collaboration.spec.ts`: `feed.spec.ts` (post, reply,
  save, the Saved count, a second context seeing the post without a reload,
  signed-out reading of an open channel), `offline.spec.ts` for the web's
  in-flight-only rule (a request that fails is shown, nothing is kept after a
  reload).
- `visual.spec.ts` baselines regenerated by CI's `update-visual-baselines`
  run for the new Home and thread views.
- Client component tests for every screen listed in `02-client-app.md`.
- Accessibility: `eslint-plugin-jsx-a11y` clean; keyboard paths through the
  feed, dialogs and menus covered by component tests.

### M5 — Runs

Scope (`03-agents-and-research.md`): Ask, branch and look-up as runs on the
owned agent loop; committed turns and run state as records in the space log;
in-flight text as ephemeral events on the sync SSE connection keyed by run,
attempt and per-attempt sequence (ADR-22); gap refetch; the weekly allowance,
the usage page and API keys; cancellation on thread removal.

Exit criteria:
- `runs.spec.ts`: ask with the `paced-answer` fixture, a reload mid-stream and
  a second tab on the same run, a branch from a selected answer, Look up on a
  1–4 word selection, Stop, Run again creating a new attempt.
- Server tests: sequence continuity and auto-resume across a simulated restart
  (the `05-run-lifecycle-and-streaming.md` scenario re-expressed for records);
  allowance admission; a removal during a run ends it with nothing written
  after the removal.
- Fixture providers only; nothing reaches the network in CI.

### M6 — Membership and moderation

Scope: everything in `04-membership-moderation-security.md`: account invites,
the members page and invite tree, the "Join with invite?" step and pending
sign-ups, channels with open and private visibility, roles, channel info and
About editing, channel invite links, report, remove with reason, ban, the
moderation log, frozen copies, abuse limits.

Exit criteria:
- `e2e/invites.spec.ts` and `e2e/moderation.spec.ts` as specified in `04`
  §3.4, §5 and §6.6.
- Server tests for the account-invite slot rule, concurrency and pending
  sign-ups; the conformance suites still pass after the contract changes.
- A privacy check run by hand on staging before M8: after a removal, the text
  is absent from the SQLite file, from pull and snapshot answers for every
  role, and from the effect queue.

### M7 — Desktop (Tauri) wrapper and device runs

Scope:
- A new Tauri shell that loads the M4 client build (one client codebase;
  macOS only). The current `src/` React app and its Rust commands are not
  used by it.
- A SQLite storage adapter for `@session/sync` on the Rust side, exposed to
  the client through a narrow command set (load working set, persist batch,
  wipe), so the outbox survives restarts for 3 days.
- Device-token sign-in through the system browser and the app's URL scheme;
  the token in the Keychain; sign-out wipes the replica and outbox.
- Device runs (`03-agents-and-research.md`, ADR-21): a run executor that
  claims runs with `runs.claim`, spawns Claude Code or Codex in an empty
  working directory, reports `runs.turn` and `runs.finish` with the attempt
  number, keeps a heartbeat lease separate from progress, and caps an answer
  at 200 KB. No CLI session resume.
- The updater keeps its existing key and endpoint (`docs/releasing.md`).

Exit criteria:
- `cargo test` in `src-tauri` covers the storage adapter (persist, load,
  wipe, a crash between persist and acknowledge), token storage through a
  Keychain abstraction, and the device-run executor against a fake CLI binary
  that emits recorded JSONL (claim, turns, finish, lease loss ending
  `interrupted`).
- The root `npm run check` and `npm test` pass; the desktop workflow's
  `frontend`, `rust` and `native` jobs pass.
- A manual macOS checklist (kept in `web/docs/runbooks/desktop-release.md`):
  sign in, offline post queued and sent on reconnect after an app restart,
  removed-member frozen channel, device run end to end with each CLI, sign-out
  wipe, "Update Session" shown for a protocol below the minimum.

### M8 — Data reset and hard cutover

Scope (`AGENTS.md` "Cutover"; `docs/session-cutover.md` for the naming and
storage contracts that stay):
- Reset migration on the production database: drop the trees, nodes,
  workspaces, folders, highlights, recaps, drafts, thread invitations,
  notifications and their files under `/data/documents`; keep `users` (GitHub
  identity, `is_admin`, `invited_by`), `sessions`, `user_limits`, and
  `invites` in its extended form. Existing accounts become active members and
  roots of the invite tree where `invited_by` is null.
- Before the migration: a Litestream snapshot, verified by a restore to a
  scratch machine, kept for the 30-day retention; an announcement to existing
  web users that their threads will be removed, with a date.
- Deploy the spaces server build to production (`fly deploy web -c
  web/fly.toml`), then publish the desktop release (`docs/releasing.md`).
  The new desktop build imports no local research and reads none of the old
  app's storage; it leaves the old files in place.
- After cutover: remove the old desktop frontend (`src/`), its Rust commands
  and tests that no longer apply, the web client's tree and workspace code,
  and replica-proto's prototype server if the conformance target replaces it
  (the suites stay). Update `AGENTS.md`: move the "Planned" section to current
  rules and drop "until the cutover".

Exit criteria:
- The restore rehearsal (`web/docs/runbooks/restore.md`) run against the
  pre-reset snapshot and against a post-reset snapshot, including the log
  epoch bump (§3.3).
- Production smoke on the deployed build: sign in on web and desktop, post,
  ask with included tokens, a device run, report and remove, invite link
  redemption.
- The root `npm run preflight` and the web CI jobs green on the cutover
  commit.

## 3. Deployment

### 3.1 Pipeline

Unchanged from `13-deployment-fly.md` and `12` §4: CI's `check`, `test`,
`e2e` and `docker` jobs gate `deploy` on a push to `main`; one Fly app, one
machine, one volume, `strategy = "immediate"`. Added to CI from M1: a job that
runs replica-proto's `npm test`; from M3, the conformance suite inside the
server's `npm test`. `npm run mutate` is too slow for every push; it runs
nightly and on pull requests that touch `web/packages/mutators`,
`web/packages/sync` or the server's sync code, and a surviving mutation fails
that run.

### 3.2 Staging

From M3 to M8 the new server runs on a separate Fly app (`session-staging`
proposed) with its own volume, Litestream bucket prefix, OAuth app and
secrets, `SESSION_REQUIRE_INVITE=1` and fixture providers optional. Production
keeps the current web app until M8. Whether a second app is acceptable is an
open question (§6).

### 3.3 Litestream and restore

- Replication as in `13` §6. The change log, idempotency answers and effect
  queue add write volume; WAL checkpoints are monitored (§4).
- A restore moves the database back in time. Clients may hold cursors and
  confirmed answers from after the restored point. The restore runbook adds:
  bump the log epoch before the server accepts traffic, so every cursor
  resyncs, and record the restore time. Writes confirmed after the restored
  point and before the failure are lost: their idempotency answers are gone,
  and clients have dropped them from their outboxes. With Litestream's
  seconds of lag this is a small window; the runbook states it.
- `SESSION_CURSOR_KEY` and `SESSION_CURSOR_KEY_PREVIOUS` are Fly secrets; a
  rotation runbook covers the 30-day overlap.

### 3.4 Protocol version and "Update Session"

- Every sync and tRPC request carries the protocol version header (name fixed
  in `01-architecture-and-data.md`). The server accepts `[SESSION_MIN_PROTOCOL,
  current]`; below the minimum it answers the minimum-version error and the
  client shows "Update Session" (desktop: the updater; web: reload).
- Additive changes (a new optional input field, a new mutator, a new record
  kind that old clients ignore) do not bump the version. A change to an
  existing mutator's input or `run` semantics bumps it, because client
  prediction and server authority must run the same definition.
- Deploy order for a bump: deploy the server accepting both versions, publish
  the desktop release, then raise the minimum after 7 days or at once for a
  security fix. The web client is always current after a reload; a tab that
  stays open across a deploy receives the minimum-version answer and reloads.

### 3.5 Configuration added

`SESSION_CURSOR_KEY`, `SESSION_CURSOR_KEY_PREVIOUS`, `SESSION_MIN_PROTOCOL`,
`SESSION_DESKTOP_ORIGINS` (CORS allowlist), the device-run limits
(`SESSION_DEVICE_RUNS_PER_HOUR=100`, `SESSION_DEVICE_ANSWER_BYTES=204800`) and
the abuse limits in `04` §10, all listed in `web/.env.example`.

## 4. Observability

Additions to `13` §7, all in `/metrics` and the JSON logs. Logs carry ids and
answer codes, never record text.

| Signal | What it shows | Alert |
|---|---|---|
| `session_sync_apply_total{mutator,answer}` | Writes by answer code (`OK`, `FORBIDDEN`, `STALE`, `CONFLICT`, `EXPIRED`, `CLOCK_SKEW`, `TOO_MANY_REQUESTS`, …) | `INTERNAL_SERVER_ERROR` above 1% for 10 min |
| `session_sync_apply_seconds` | Apply latency histogram | p95 above 100 ms |
| `session_sync_pull_seconds`, `session_sync_snapshot_bytes` | Read cost per log | p95 pull above 250 ms |
| `session_sync_resync_total{reason}` | Resyncs by reason (forged, expired, epoch, scope change) | sudden rise after a deploy |
| `session_sync_clients`, `session_sse_clients` | Registered and connected clients | — |
| `session_effects_queue_depth`, `session_effects_dead_letters` | Effect worker health | any dead letter |
| `session_changelog_rows`, `session_tombstones`, `session_idempotency_rows` | Table growth and pruning | growth past the 30- and 7-day bounds |
| `session_protocol_requests{version}` | Old clients in use | share below minimum after a bump |
| `session_rate_limited_total{bucket}` | Abuse limits hit | — |
| `session_invite_checks_total{outcome}` | Invite code checks | failed checks above 100/hour |
| `session_reports_total`, `session_removals_total` | Moderation volume | — |
| `session_device_runs_active`, `session_device_leases_expired_total` | Device runs | lease expiries above 20% of claims |
| `session_wal_bytes` | WAL size between checkpoints | above 512 MB |

The client sends, with each sync request, its outbox length and the age of
its oldest entry; the server logs them per client id to diagnose stuck
outboxes.

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The real server half diverges from the prototype in ways the suites do not cover | Medium | High | Conformance target runs every replica-proto file unchanged; server mutation set (M3); the write oracle and convergence run in CI |
| The mutation run is too slow to keep in the loop | High | Medium | Nightly and path-filtered runs; `--slots`; a name filter per change |
| SQLite single writer saturates with the change log, idempotency and effect writes | Low | High | One commit per apply; short transactions; load check in M3; machine size raised before limits |
| Erased text survives somewhere (WAL, effect payloads, logs, backups) | Medium | High | Effects carry ids; logs carry no text; storage scan over the file and WAL; backup retention stated in the privacy page |
| A restore loses confirmed writes | Low | Medium | Epoch bump; runbook statement; Litestream lag alert |
| Client prediction and server disagree across versions | Medium | Medium | Protocol version bump rule; rebase on confirmed changes; `unknown` stops prediction |
| Cursor key mishandled (lost or rotated without overlap) | Low | Medium | Configured key with 30-day previous key; rotation runbook; a lost key causes resyncs, not data loss |
| Desktop UI cannot be driven by Playwright (tauri-driver has no macOS support) | High | Medium | Client logic tested in the browser; Rust adapter and executor tests; manual macOS checklist |
| Device runs leak local files through CLI read tools | Medium | Medium | Empty working directory; read-only tools only; local-read lockdown deferred and tracked (`03`) |
| Invite tree slows growth or concentrates invites in admins | Medium | Low | Admin exemption from slots; metrics on redemptions |
| Spam or abuse in open channels | Medium | Medium | Invite-only accounts; reports, removal and ban; per-user limits; the invite tree to find the inviter of an abusive account |
| Existing web users object to the data reset | Medium | Low | Announcement with a date; accounts kept |
| Scope from the mockup grows past the contract (rules, hide, requests) | Medium | Medium | `04` §1 decisions; contract changes only through `01` |

## 6. Open questions

Membership, moderation and security (details in `04` §15):

1. Does the removed placeholder show the author's handle (needs the author
   kept after erasure)?
2. How long does a removal placeholder stay: 30 days, 90 days or for good?
3. Account invite code format: 30-bit `SESS-XXXX-XX` or 50-bit
   `SESS-XXXXX-XXXXX`.
4. Can members see their open codes again after creation?
5. Does the desktop keep a frozen copy after a voluntary Leave?
6. Site-wide moderators, or only `users.is_admin`?
7. Sign in with X in addition to or instead of GitHub.
8. Pending sign-up lifetime and throttling.
9. Report and remove follow-ups and replies individually at launch?
10. Offer Hide to staff?

Delivery:

11. Is a separate staging Fly app acceptable, or should the spaces server run
    behind a flag in the production app until M8?
12. How long does the server accept the previous protocol version after a
    desktop release (proposed 7 days)?
13. Does replica-proto's prototype server stay after M3 as the reference
    implementation, or is it removed once the conformance target exists?
14. Which faults in the server mutation set are required for M3's exit, and
    which may be listed as not applicable?
15. Is a manual macOS checklist enough for desktop releases, or is a UI
    automation route (for example an in-app test harness) needed before M8?
16. Does the new desktop build delete the old app's local data, offer to, or
    leave it (proposed: leave it)?
17. Cutover date and the notice period for existing web users.
18. Does the Phone (React Native) client need any milestone before M8, or is
    it scheduled after the cutover?
