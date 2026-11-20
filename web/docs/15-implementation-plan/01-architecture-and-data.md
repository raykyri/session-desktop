# 01 — Architecture and data

Status: draft. This file plans the server half of the Session spaces client:
the Node web server over one SQLite database, the tables and migrations, the
two packages `AGENTS.md` schedules next (`@session/mutators` and
`@session/sync`), replication tiers, the HTTP surface, and the changes the
members mockup (`docs/mockups/session-web-members.html`) makes to the spaces
contract (`web/packages/shared/src/schemas/spaces.ts`). Runs, models, tokens
and device runs are in `03-agents-and-research.md`; invites, roles and
moderation policy in `04-membership-moderation-security.md`.

Authority, as in `00-overview.md`: `AGENTS.md` ("Planned: desktop client and
sync core") and ADR-19 to ADR-22 win over the mockup, except where the
overview records an explicit product decision. Each conflict below says which
side wins.

Work items have ids (`S`, `D`, `M`, `Y`, `R`, `A`, `C`) so that
`05-delivery.md` can schedule them.

## 1. Server process

The server stays one Node 22 process (Hono, ADR-2) on one Fly machine with
one SQLite file on the volume (ADR-4, ADR-13). better-sqlite3 transactions
are synchronous, which matches the synchronous `tx` that `@session/mutators`
requires: a mutator's `run` executes inside one `db.transaction()` with no
`await` between the permission check and the commit.

**S1. Request pipeline for sync routes.** Add a Hono sub-app
`web/packages/server/src/sync/` mounted at `/api/sync`. Middleware order:
request id, CORS for the desktop origin, protocol version check,
authentication (cookie or bearer device token; optional on `snapshot` and
`pull`, see R5), rate limit, handler. The same version check runs on
`/api/runs/*` and on tRPC requests that carry the header; from the cutover
(M8 in `05-delivery.md`) the header is required on tRPC too.
Acceptance: a request without the `Session-Protocol` header, or below
`SESSION_MIN_PROTOCOL`, answers `426` with `{ code: "UPGRADE_REQUIRED" }`;
one test per refusal (version, authentication `401`, rate limit `429`) and
one asserting that a foreign origin gets no CORS headers.

**S2. Desktop authentication.** A bearer device token (random 256-bit value,
stored hashed in `device_tokens`, held in the macOS Keychain by the desktop)
authenticates `/api/sync/*`, `/api/runs/*` and the tRPC account procedures.
Issued by a signed-in web session through a one-time pairing code; revocable
from the account menu. Cookie sessions (ADR-5) continue for the web client.
The CORS allowlist admits only the desktop origin (`tauri://localhost` and the
dev origin in development); the web client is same-origin and needs none.
Bearer requests skip the cookie CSRF checks, because a browser never attaches
the token by itself. Acceptance: a token from a revoked device answers `401`,
and an SSE stream opened with it ends within 60 seconds; a request from an
origin outside the allowlist gets no CORS headers; the CSRF rules of
`03-api-and-events.md` §1 still apply to cookie requests.

**S3. Configuration.** New settings in `web/packages/server/src/config.ts`,
validated at boot like the existing ones: `SESSION_MIN_PROTOCOL`,
`SESSION_CURSOR_KEY`, `SESSION_CURSOR_KEY_PREVIOUS` (accepted 30 days after a
rotation, then removed), `SESSION_SECRET_KEY` (API key encryption, see 03),
`SESSION_DESKTOP_ORIGINS` (S2's allowlist, exact origins),
`SESSION_DEVICE_ANSWER_MAX_BYTES` (200 KB), `SESSION_DEVICE_RUNS_PER_HOUR`
(100), and the run and allowance settings of `03-agents-and-research.md`
(`SESSION_WEEKLY_TOKENS`, …). Acceptance: boot refuses a cursor key that is
not 32 bytes of base64 and an origin list containing `*`; `web/.env.example`
documents every new variable.

**S4. Effect worker.** A loop in the server process that takes rows from
`effects` (D2) in `next_at` order, runs them (notifications, run jobs, key
checks), and on failure backs off 1 s, 2 s, 4 s up to 10 minutes, moving the
row to the dead-letter state after 10 attempts (the constants in
`replica-proto/src/server.ts`). Effects carry ids, never text. Acceptance: the
replica-proto effect model (`test/effect-model.ts`) passes against it; the
count of dead-lettered effects is a gauge on `/metrics`.

**S5. Drain and boot.** On `SIGTERM`: answer every later envelope
`SERVICE_UNAVAILABLE` (unrecorded, so outboxes retry), close SSE streams,
then run the existing run drain (`05-run-lifecycle-and-streaming.md` §7).
Commits are synchronous, so no transaction is open across the signal. On
boot: migrate, check the restore marker (D6), then start the effect worker
and the run dispatcher. Acceptance: a test sends `SIGTERM` during a batch
`apply`; envelopes after the signal answer `SERVICE_UNAVAILABLE`; after a
restart the client resends them and each mutation id is applied exactly once.

## 2. Database

The database keeps `users`, `sessions`, `oauth_states`, `invites`,
`signup_attempts`, `user_limits`, `usage_events`, `user_preferences` and
`backfills` from `web/packages/db/src/schema/`. The research tables (`trees`,
`nodes`, `run_turns`, `run_attempts`, `node_messages`, `node_summaries`,
`response_snapshots`, `tree_*`, `folders`, `workspaces`, `highlights`,
`feed_items`, `research_drafts`, `interface_drafts`, `widget_*`,
`research_images`, `image_refs`, `notifications`, `followup_queue`,
`run_queue`, `collapsed_*`) are dropped: `AGENTS.md` says existing web data is
dropped at the cutover. `embed_assets` and `tweet_cache` are caches; they stay
while answers render embeds (`02-client-app.md` open question 7).

### 2.1 Record storage: one table, typed at the boundary

**D1. `records`.** Replicated records live in one table, as in the prototype
(`replica-proto/src/records.ts`), because the change log, tombstones, the id
registry, read filtering and erasure all work per key:

| column | type | notes |
|---|---|---|
| `key` | text PK | `thread:<id>`, `member:<space>:<user>`, … (`keyOf`) |
| `kind` | text | record kind |
| `sp` | text null | space id; the read-scope column |
| `th` | text null | thread id for thread-scoped kinds |
| `u` | text null | owner or author handle; user-log routing |
| `body` | text JSON | the stored shape, validated with the record's zod schema on read and write |
| `rev` | integer | per-record version, from the registry |
| `created_v` | integer | log version of the creating commit (stable list order) |
| `created_at`, `updated_at` | integer ms | server times |

Indexes: `(kind, sp, created_v)`, `(kind, th, created_v)`, `(kind, u)`.
Acceptance: the store's `put`/`create`/`del` are the only functions that
write `records` (a grep test over `web/packages/db/src/sync/`); a property
test writes random records and reads them back equal; a migration test
confirms the indexes exist.

Typed per-kind tables were considered. They give column types and simpler ad
hoc queries, but every new kind then needs its own log, tombstone and erasure
code. The single table keeps those generic; record shape changes are handled
by D7.

**D2. Sync bookkeeping tables.**

- `change_log(log, key, op, version)`: `log` is `space:<id>` or `user:<id>`;
  `op` is `put` or `del`; rows hold no record content (AGENTS.md). PK
  `(log, key)`: a write replaces the key's row, as in the prototype, so the
  table grows with keys, not with writes. Index `(log, version)`.
- `server_head(version)`: one row; versions come from one sequence for the
  whole server and never leave it (Y6).
- `log_epochs(log, epoch, start_version)`: a row only for a log whose history
  was replaced (D6).
- `registry(name, last_rev)`: every id and record key ever written, with its
  last rev; ids are never reused, and a record written again at a deleted key
  continues from its last rev.
- `tombstones(key, kind, sp, th, u, deleted_at)`: audience fields only, no
  text; the rev is in `registry`; pruned after 30 days.
- `clients(client_id, user_id, last_seq, created_at, last_used_at)`: expires
  after 90 days idle; at most 20 registrations per user per day.
- `answers(user_id, mutation_id, client_id, seq, digest, answer_json,
  created_at)`: recorded answers, kept 7 days. `digest` hashes the name and
  canonical input, so a reused mutation id with another payload is detected.
  An answer for a malformed or reused mutation id is stored under
  `(client_id, seq)` only. A reminted envelope stores its answer under every
  mutation id it replaces, in the same commit.
- `effects(id, type, payload_json, attempts, next_at, state)`: ids only;
  `state` is `queued` or `dead`.

Acceptance: a commit writes the record rows, the log rows, the registry, the
recorded answer, the client's `last_seq` and the queued effects in one
transaction (AGENTS.md). A test injects a failure into the `effects` insert
and finds no record, log, registry, answer or `last_seq` change, and an
`INTERNAL_SERVER_ERROR` answer that a resend replaces.

**D3. Non-replicated server tables.** New: `device_tokens`, `api_keys`
(encrypted value, provider, mask, status, last used), `run_leases` (device
runs: run id, attempt, device id, lease expiry, last heartbeat), `run_live`
(in-flight checkpoint text per run and attempt, deleted at finish). Changed:
`usage_events` (03), `invites` and `users` (C8). Acceptance: no row of these
tables appears in any `snapshot` or `pull` (a test lists every served record
kind and checks it against D1's kinds).

**D4. Erasure at rest.** Set `PRAGMA secure_delete = ON` so deleted rows are
overwritten in the file, and run `erase` paths as deletes of the affected
`records` rows plus tombstones. Acceptance: the replica-proto storage scan
(`inv6-removed-content.test.ts`) is ported to scan the bytes of the SQLite
file and its WAL, after a checkpoint, for a removed thread's marker text and
finds none. Litestream generations still hold the text until their retention
expires; see open question 3.

### 2.2 Migrations

**D5. Migration sequence.** Following `02-domain-model-and-database.md` §4:
a generated migration (`0001_*`) adds D1-D3 and the C8 columns; a second
(`0002_*`) drops the research tables once the new client has replaced the old
one in production. Because
existing web data is dropped, a database reset (`runbooks/reset-database.md`)
is an acceptable alternative to `0002`; the choice is recorded in
`05-delivery.md`. Acceptance: `db:generate` produces no diff in CI;
`migrations.test.ts` opens a fresh database and a database at `0000` and
migrates both.

**D6. Log epochs and restores.** A log's epoch increments when its history
is replaced: a space's visibility changes (prototype test "a space that
becomes closed resyncs every reader") or the database is restored from
Litestream. Cursors older than 30 days resync through `servedAt` (Y5), not
through the epoch. Visibility is fixed at creation in v1 (C11), so in
production only a restore bumps epochs; the visibility path stays because the
prototype suite tests it. A restore is detected at boot by a `restore_marker` row
that the restore runbook writes; on a mismatch every log's epoch is
incremented, so every cursor issued before the restore resyncs instead of
pulling from a version the restored database has reused. Acceptance: a test restores an
older copy of the database file, boots, and finds that a pre-restore cursor
answers `resync`. `runbooks/restore.md` gets the marker step.

**D7. Record shape versions.** A record kind's stored shape changes through a
versioned backfill in `web/packages/db/src/backfills/` that rewrites `body`
and bumps `rev`, so that every replica pulls the new shape. Acceptance: a
test backfill that adds a field to one kind writes a log row for every
rewritten key, and a replica that pulls afterwards holds the new shape.

## 3. `@session/mutators`

New package `web/packages/mutators` (name `@session/mutators`), depending only
on `@session/shared` and `zod`. It replaces the mock's procedures and
generalizes `replica-proto/src/mutators.ts`.

**M1. Definition shape.** Port `MutatorDef` from the prototype: `input` (the
shared zod schema, strict), `who`, `space`, `ids`, `online`, and three stages:

1. `pre(ctx, input)`: server only, synchronous; may refuse; makes server
   values (invite codes, the payer of a run, limit checks). Its clock and
   random source come from `ctx` (`now`, `random()`, as in the prototype's
   `PreCtx`). Never run on the client.
2. `run(tx, input, values)`: deterministic over a synchronous `tx`. Reads
   `tx.now`, never a clock, random source, `Intl` or `Date` formatting. Makes
   no ids: the first id is in the input, later ones come from
   `tx.id(ordinal)`, derived from the mutation id.
3. `post(input, result)`: post-commit effects (ids only).

On the server the order is the prototype's: ban check, `who`, `can`, `pre`,
`run`, all inside one transaction (Y4), so `pre` never runs for a caller the
permission checks refuse. Work that needs the network (key checks, model
calls) is an effect, not `pre`.

Acceptance: the prototype test "mutators read no clock, no random source and
no Intl while the server applies them" runs over every mutator in the
package; an ESLint rule bans `Date`, `Math.random`, `crypto` and `Intl` in
the whole package.

**M2. Indexed reads in `tx`.** The prototype's `tx.find(kind, predicate)`
scans every record of a kind, which is acceptable in memory and not on a
large SQLite table. Replace it with declared lookups: `tx.byKey(key)`,
`tx.list(kind, { sp } | { th } | { u })` and `tx.count(kind, index)`, each
mapping to an index of D1. Predicates run only over those bounded lists.
Acceptance: an explain-plan test asserts every lookup uses an index; the
client replica implements the same interface and returns `unknown` for a
lookup outside its working set, which stops prediction (AGENTS.md).

**M3. Stored shape and derived fields.** Mutators write the stored shape.
Counts (`saves`, `r`) are stored fields in the counts record, written by the
mutators that change them. Per-viewer fields (`saved`, `mine`) are computed on
the client and never stored or served. Acceptance: a test parses every record
a mutator writes with its stored schema and finds no `mine`, `saved` or
`liked` field.

**M4. Stale intent.** `shown`, `approve`, reopen and `setRole` carry
`base.rev` of the target and answer `STALE` on a mismatch; `hidden`,
`removed`, `decline` and `members.ban` act on the record as it is;
`members.remove` compares the admission id (AGENTS.md). Acceptance: the
replica-proto review-r1/r2 tests for these cases pass.

**M5. The mutator set.** One file per area under `src/`: `spaces`,
`members`, `threads`, `nodes` (asks, branches, look-ups; see 03), `comments`,
`replies`, `saves`, `reports`, `moderation`, `invites`, `notifications`,
`prefs`, `runs` (cancel, retry). The set is the mock's procedures minus the
surfaces C10 defers, with the changes in section 7. The prototype ports 19 of
them; the others (`replies.*`, `comments.*`, `nodes.*`, `reports.resolve`,
`members.unban`, `invites.revoke`, `notifications.*`, `prefs.set`, `runs.*`)
are covered only once the read and write oracles have rules for them (M6).
Acceptance: a table test lists every mutator with its `who`, its
stale-intent rule and whether it is `online`; space creation is
`online: true` (AGENTS.md); the write oracle has a rule for every listed
name.

**M6. Update the acceptance suite first.** The replica-proto suite exercises
`likes.set` (56 lines in `test/`), space rules, `rulesRev` and the
`listed`/`unlisted` visibilities, which section 7 removes, and its strict
envelope lacks `queuedAt` and `replaces`, which AGENTS.md requires. Before
porting, change `replica-proto` itself to the revised contract:
- records and mutators: `likes.set` replaced by counted saves (C1); rules
  dropped (C6); `vis: "open" | "private"`, no `policy` or `qs` (C9);
  `spaces.update { id, desc }` (C11); the `followup` kind renamed `node` with
  C3's fields; `comment` (C4) and `modlog` (C12) kinds;
- protocol: `queuedAt` and `replaces` in the envelope (Y1), an oversized
  envelope answering `TOO_LARGE` instead of `BAD_REQUEST`, and
  `PROTOCOL_VERSION` raised to 4;
- the read oracle (`test/oracle.ts`), the write oracle
  (`test/write-oracle.ts`) and the effect model, which are written apart from
  `src/` and must change with it, and the patterns in
  `test/mutations/mutate.ts`.
Keeping the prototype as the single acceptance suite is cheaper than
maintaining a diverging copy. Acceptance: `npm test` passes, `npm run mutate
-- --check` finds every pattern once, and `npm run mutate` exits 0 on the
updated prototype.

## 4. `@session/sync`

New package `web/packages/sync` (`@session/sync`) with two entry points,
`@session/sync/client` and `@session/sync/server`, each with its own tests.
It depends on `@session/mutators`; the server half defines a `ServerStore`
interface that `@session/db` implements over SQLite (`web/packages/db/src/sync/`),
so `@session/sync` itself has no database driver.

### 4.1 Wire

**Y1. Envelope.** `{ clientId, seq, mutationId, replaces?, name, input,
protocolVersion, clientTime, queuedAt }`. The prototype names the device time
`clientTime` and is tested with it; ADR-19 calls it `deviceNow`. Keep
`clientTime` and correct ADR-19's text. `seq` is assigned at send time from
the last acknowledged seq; `replaces` lists the mutation ids a reminted
envelope supersedes. Envelopes over 256 KB as JSON answer `TOO_LARGE`, and
input nested deeper than 32 answers `BAD_REQUEST`, both unrecorded and
checked before the input is parsed or hashed. Acceptance: the prototype's envelope tests (extra fields
refused, unknown names refused, depth and size limits) pass with M6's
changes.

**Y2. Answers.** Every answer carries `serverTime`. Recorded (they use up
the `seq`): applied results and refusals of the write itself (`FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `STALE`, `EXPIRED`, `BAD_REQUEST` for the input or
the mutation id, …). Not recorded: `TOO_MANY_REQUESTS`,
`SERVICE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`, `CLOCK_SKEW`, `OUT_OF_ORDER`
(carries `expectedSeq`), `WRONG_CLIENT`, `UNAUTHORIZED`, `UPGRADE_REQUIRED`,
`TOO_LARGE`, and `BAD_REQUEST` for a malformed envelope (it has no usable
`seq`). The sync codes (`STALE`, `CLOCK_SKEW`, `EXPIRED`, `OUT_OF_ORDER`,
`WRONG_CLIENT`, `UPGRADE_REQUIRED`, `TOO_LARGE`) are not in the shared
`spaceErrorCodeSchema` today and are added to it. Acceptance:
`inv5-idempotency-per-user` and review-r1 `R7b` pass.

### 4.2 Server half

**Y3. `register`.** Issues a client id bound to the caller. The 21st
registration in a day answers `TOO_MANY_REQUESTS`; a `waiting` account (C8)
gets `FORBIDDEN` and reads through R5. Acceptance: a client id of another
user, or idle for 90 days, answers `WRONG_CLIENT`; one test per refusal.

**Y4. `apply`.** For each envelope, in the prototype's order (the comment at
the top of `replica-proto/src/server.ts`; the protocol steps of
`test/write-oracle.ts`):
1. size and depth; protocol version; strict envelope shape; signed in;
   client id is the caller's and not expired (all unrecorded);
2. a recorded answer for `(user, mutationId)` with the same digest is
   returned under any client id or seq, using no seq; else a recorded answer
   for `(clientId, seq)` with the same mutation id and payload;
3. `seq === last_seq + 1`, else `OUT_OF_ORDER`;
4. the mutation id is a ULID not used with another payload, else
   `BAD_REQUEST`, recorded under `(clientId, seq)`;
5. `clientTime` within 1 minute of server time, else `CLOCK_SKEW`;
6. measured on the device clock (`clientTime`): the mutation id and
   `queuedAt` from 4 days old to 1 minute ahead, else `EXPIRED`; the mutator
   name and strict input schema, else `BAD_REQUEST`; every new id in the
   input in the same window, and an online-only write's mutation id at most
   1 minute old, else `EXPIRED`;
7. one transaction: ban check, `who`, `can`, `pre`, `run`; commit records,
   log rows, registry, the answer (under `mutationId` and each id in
   `replaces`), `last_seq` and effects.

ID collisions answer the same `CONFLICT` whether or not the caller can read
the holder. Acceptance: `inv1`, `inv2`, `inv4`, `inv5`, review-r2 `Q1` and
the convergence suite pass with the SQLite store; a test applies a reminted
envelope and then the delayed original, and the original gets the recorded
answer.

**Y5. `snapshot(log, tier)` and `pull(log, cursor)`.** Read records as they
are now, filtered by the reader's scope at read time (`replica-proto/src/access.ts`);
hidden text goes to its author and the space's staff only. Snapshot records
come in `createdAt`, then `created_v`, order. `pull` returns the keys changed
after the cursor's version, each as the current record or a `del`
(tombstone, or a record the reader may no longer read), plus `lastSeq` when
the request names a client id of the caller. `pull` answers `resync` for a
token not sealed by this server (current or previous key), sealed for
another reader, log or epoch, served more than 30 days ago, or when the
reader's scope changed since (their membership or role in the space; for a
user log, in any space, or a space opening or closing that a row is about).
Pulls are not tiered, as in the prototype (R2). Acceptance:
`inv3-scoped-reads` (including "a signed-out caller can tell neither how
many writes happened nor when"), `inv6` (tombstones and the 30-day
boundary), `inv7-replica-per-user` and the read oracle pass.

**Y6. Cursor tokens.** AES-256-GCM with a random IV per token, over `{ log,
reader, epoch, version, server head, servedAt }`, sealed with
`SESSION_CURSOR_KEY`; `SESSION_CURSOR_KEY_PREVIOUS` is accepted for 30 days
after a rotation. Token length depends only on the lengths of the log id and
the reader's handle. Acceptance: inv3 "a forged cursor resyncs" and "a read
carries no version…", review-r2 `T1`, and a test that a token sealed with
the previous key pulls, and resyncs once that key is removed.

**Y7. SSE.** `GET /api/sync/events` streams `text/event-stream`, read by the
client with `fetch` (so it can send the bearer token and protocol header; an
`EventSource` cannot). Each `changes` event carries pull batches for one or
more logs; its event id is an encrypted map `{ log: cursorToken }`, so a
reconnect with `Last-Event-ID` resumes every log. Run deltas travel on the
same stream as ephemeral events without ids (ADR-22; 03 §5). After a commit
the server wakes subscribers of the affected logs and runs each
subscriber's pull under that subscriber's own scope, coalesced to at most one
batch per 100 ms per connection. A connection whose queue exceeds 2,048
events is closed, as in `server/src/events/bus.ts`. The stream requires a
registered client id; signed-out and `waiting` readers pull instead (R5).
Acceptance: two readers with different scopes on one space receive different
batches for the same commit; a reconnect with the last event id loses no
change; a member removed while connected gets `resync` for the space log and
no record written after the removal.

**Y8. Retention jobs.** Hourly: prune tombstones over 30 days, recorded
answers over 7 days, clients idle 90 days, and `modlog` entries and resolved
reports over 180 days (C12; replicated deletes). `registry` is never pruned.
Acceptance: one test per table with an injected clock, at the boundary
millisecond (as inv6 "a delete committed in the same millisecond as a
cursor…").

### 4.3 Client half

**Y9. Replica and storage adapter.** The replica keeps a working set in
memory; a `StorageAdapter` loads and persists it (SQLite on the desktop
through Tauri, in-memory on the web, a React Native SQLite binding on the
Phone). Acceptance: the same client test suite runs against the memory
adapter and a SQLite adapter (better-sqlite3 in tests, in place of the
Tauri binding).

**Y10. Outbox.** One global order across logs. Desktop keeps writes 3 days in
server time; the web client holds a write only while its request is in flight
(AGENTS.md, ADR-20). Transient answers pause the outbox with backoff (1 s to
10 minutes); a write that fails 5 times is shown to the person and the rest of
the outbox continues; a write dropped at 3 days is reported. After
`CLOCK_SKEW` the client corrects its clock offset and remints the writes it
has not sent (new mutation id and new client-made ids, as `remint` in
`replica-proto/src/client.ts`); a sent write keeps its mutation id, and a
reminted envelope lists the ids it replaces in `replaces`. Acceptance: review-r2's client
tests for backoff, failure and drop pass with the `@session/sync` client in
place of `src/client.ts`.

**Y11. Rebase.** Confirmed changes are applied to the confirmed state, then
pending writes are re-run on top with their mutators. A pending write whose
prediction read `unknown` is shown as pending without a predicted effect.
Acceptance: the convergence suite's replicas equal the server projection
after every interleaving it generates.

**Y12. Reactive queries.** `useQuery(selector)` for React and React Native,
re-evaluated when keys the selector read change. Acceptance: a component test
re-renders once per confirming batch, not once per record.

### 4.4 Server-originated writes

**Y13. `serverApply`.** Runs and effects write records without an envelope
(`03-agents-and-research.md` E1): `serverApply(fn)` in `@session/sync/server`
runs `fn` over the same `tx` and commits record rows, log rows, registry and
tombstones in one transaction, with no answer and no seq. The run fence
(current attempt, thread not removed) is the caller's, in 03. Acceptance: a
run turn written this way reaches a reader's `pull` and SSE stream; a write
whose `fn` refuses commits nothing.

## 5. Replication tiers

**R1. Full and summary tiers.** Per space the client holds full records for
the last 90 days or the newest 500 threads, whichever covers more, capped at
5,000; plus every thread the user wrote or saved and every thread opened in
the past 14 days. Every other readable thread is a summary: the thread record
and its counts record, without ask nodes, turns, comments or replies. Past
5,000 threads a space's summaries cover only the past 2 years. Phone: 30 days
or 200 threads. (AGENTS.md "Replication".)

**R2. Who computes the window.** The server computes the full set from the
space log and the user's saves and authorship; the client adds the threads it
opened in the past 14 days as an explicit list (at most 500 ids) in the
snapshot request body, filtered by scope like everything else. Opens stay on
the device; the server does not record them. Pulls are not tiered (Y5): the
client applies changes to summary records and drops node, run, turn, answer
and comment changes of threads outside its full set; a thread that leaves
the window is demoted at the next snapshot. Acceptance: a snapshot test
checks each of the four inclusion rules, the 5,000 cap and the 2-year
summary bound; a client test drops a turn change for a summary-tier thread.

**R3. Promotion.** Opening a summary-tier thread fetches its full records
through `snapshot(log, { threads: [id] })` and keeps them for 14 days.
Acceptance: an offline desktop opening a summary-tier thread shows the
summary and an "available when online" state.

**R4. Closed spaces.** A device replicates the closed spaces its user belongs
to and nothing else of any closed space (AGENTS.md). A removed member's
device keeps a frozen copy and may still delete their own threads there
(prototype test). Acceptance: `inv7` and the frozen-copy test pass.

**R5. Open spaces the user has not joined, and signed-out readers.** The
"All" scope (C7) lists open channels the user has not joined. Their threads
are read with a summary-tier snapshot, plus a full snapshot of a thread when
it is opened, into an ephemeral, unpersisted replica that is dropped when the
user leaves the channel view and refreshed by `pull` on navigation and every
60 seconds (no SSE). Joining converts it to a replicated log. Signed-out
readers and `waiting` accounts use the same path; it is the public read path
of `02-client-app.md` §9.5. `snapshot` and `pull` accept an unauthenticated
caller, as the prototype does ("a signed-out caller gets open spaces and the
landings of closed ones"). Acceptance: browsing ten unjoined channels on the
desktop writes nothing to the local database; a signed-out `snapshot` of a
private channel returns its landing only.

## 6. API surface

Replicated data uses only the sync routes. Online-only account calls stay tRPC
procedures (ADR-19). Run execution by devices has its own routes (`03-agents-and-research.md` §4).

| Route | Kind | Purpose |
|---|---|---|
| `POST /api/sync/register` | sync | client id |
| `POST /api/sync/apply` | sync | a batch of envelopes, answered in order |
| `POST /api/sync/snapshot` | sync | records now, scope-filtered; body `{ log, tier, threads? }` (500 ids do not fit a URL) |
| `GET /api/sync/pull?log&cursor&clientId` | sync | changes since a cursor |
| `GET /api/sync/events` | SSE via fetch | pull batches and run deltas |
| `POST /api/runs/claim`, `/heartbeat`, `/turn`, `/finish` | device runs | ADR-21; `03-agents-and-research.md` §4 |
| `GET /api/runs/:id/live` | read | in-flight checkpoint of a run after a gap (ADR-22) |
| tRPC `account.*`, `devices.*` | online | profile, settings, device pairing and revocation |
| tRPC `apiKeys.*`, `usage.*` | online | keys, allowance, recent runs (`03-agents-and-research.md` §6) |
| tRPC `accountInvites.*`, `members.tree` | online | Session invites and the invite tree (C8) |
| tRPC `spaces.directory` | online | the "All" list of open channels (C7) |
| `GET /healthz`, `/auth/*` | Hono | unchanged |

**A1.** Implement the sync routes over `@session/sync/server` (S1, Y3-Y7).
Acceptance: `web/packages/server/test/conformance/` implements replica-proto's
`ServerFactory` over HTTP against a server on a temp SQLite file with an
injected clock. The `TestServer` hooks (`dump`, `jobs`, `work`, the storage
scan, clock and random-source control) are served by a route mounted only
when `NODE_ENV=test`. Every replica-proto test file passes against it
unchanged, the oracles and effect model included. The mutation runner
mutates the prototype's `src/` only; the server's own mutation set is
`05-delivery.md` M3.

**A2.** Remove the old `research.*`, `workspaces.*`, `feed.*`, `sharing.*`,
`drafts.*` routers from `web/packages/server/src/trpc/routers/` with the
old client. Acceptance: `npm run check` passes with the routers gone.

**A3.** Rate limits: `apply` counts envelopes against the 60 writes per
minute per user of `06-auth-and-users.md` §8 (a batch of 20 counts 20);
`snapshot` 30 per minute per user; one SSE connection per client id.
Acceptance: middleware tests.

## 7. Contract changes from the mockup

Each item compares the mockup's behaviour with `spaces.ts` and the mock API
(`docs/mockups/session-web-spaces-mock-api.js`) and says what changes and in
which places: the shared schema, `replica-proto` (M6), `@session/mutators`.

**C1. Likes removed; saves counted.** The mockup shows no likes on threads,
replies or branch comments (`card()` comment: "no likes on threads; the
bookmark carries how many people saved it"; `likeBtn` is defined but never
called). The schema has `likes`, `liked`, `likesBase`, `likes.toggle`,
`likes.toggleReply`, `GET /api/me/likes` and `rpLiked`; the prototype's
counts record holds `likes`, and `LikeRec` sits in the user log.
Change: remove every like field, procedure and record kind; the counts record
becomes `{ th, s, saves, r }`; `saved.set` (the prototype's form of the
schema's `saved.toggle`; threads only) writes the save
record in the user log and increments or decrements `saves`. Who saved a
thread is not served; only the count is. The overview decided "there are no
likes", so the product decision wins and no ADR conflicts.

**C2. Save counts and the Saved count.** The thread footer shows the save
count (`saves` from C1). The app bar's Saved button (`savedBtn()`) shows how
many threads the user has saved, computed on the client from save records in
the user log. Saves of threads the user may no longer read are not served
(AGENTS.md "User logs follow current access"), so the count drops when access
ends. `saved.toggle`'s `ask` and `source` kinds are dropped with C10.

**C3. Ask nodes gain kinds, quotes and look-ups.** The mockup stores on a
branch node a `quote` (the passage of "Branch here") and `look` (the Look up
phrase), and Look up's prompt is kept on the node and not shown (`addLookup`).
The mockup matches a branch to its passage by word overlap (`groupsFor`),
which `02-client-app.md` §4.4 does not ship. `researchNodeSchema` has none of
these; `forkNodeInputSchema` takes `parent`, `q`, `uses`. Change: ask nodes
get `kind: "ask" | "lookup"`, optional `quote` (at most 2,000 characters),
optional `block` (index of the top-level block of the parent's answer that
holds the quote, used to shade the passage) and, for look-ups, `look` (1-4
words, at most 80 characters). Look-up input carries `look` and no `q`; the mutator builds the
prompt from a versioned template in `@session/mutators` and stores it in `q`,
so the client cannot place hidden text on a node. The stored prompt is served
like any node text; the client renders `look` instead. Details in 03 §2.

**C4. Branch comments.** The mockup's Comment action (`branchActs`, `BRP`)
adds a discussion under any branch node without a run, nested like post
replies. The schema has replies only for posts (`rp` keyed by thread). Change:
a `comment` record kind `{ id, th, s, node, parent, u, t, createdAt, mod }`,
`comments.create`, `comments.update`, `comments.delete`, moderation key
`c:<thread>:<comment>`. Comments are full-tier records and are erased with
their thread.

**C5. Counts shown on the footer.** The ask footer shows the number of
branches in the whole tree (`T.count`), and the post footer the number of
replies at every depth (`replyCount`). The schema documents `r` as first-level
follow-ups. Change: `r` counts every ask node under the root (asks and
look-ups, not comments) for an ask thread, and every reply for a post; it
decreases when a node or reply is erased.

**C6. Channel rules removed.** The overview records that rules were tried and
removed; the mockup's `chInfoDlg` has none. Change: drop `rules`, `rulesPrev`,
`rulesAt`, `rulesBy`, the rules variant of `editConflictCurrentSchema`,
`rulesAccepted` in `spaces.join` and `joinRequests.create`, and `rules` in
`spaceSettingsSchema` and `createSpaceInputSchema`; the prototype's
`rulesRev` and its CONFLICT path go. The sign-up checkbox "I have read the
community rules" refers to Session-wide rules, not channel rules (`04-membership-moderation-security.md`).

**C7. The "All" scope.** The scope picker (`SCOPES()`) offers Joined,
Channels you manage, and All; All lists every open channel and every private
channel the user belongs to, with a join control. Joined and Channels you
manage are filters over member records already in the replica (role `owner`
for the second). All needs open channels the user has not joined:
`spaces.directory` (tRPC, paged, open channels only) returns their space
records, and their feeds use R5. `threads.feed`'s `all` scope maps to this;
`public` is dropped.

**C8. Session invites and the invite tree.** The mockup's invite tree
(`treeA`, `invSection`) is Session-wide: Session is invite-only, each active
member may hold at most 3 open links, a link admits one person, and a slot
frees when a link is used or revoked. Members without an invite can read open
channels and cannot write (`canWrite()`). The schema's invites are per space
(`threadInviteSchema` has `sp`). Change: keep space invite links for private
channels, and add account invites, built on the existing `invites` table and
`users.invited_by` in `web/packages/db/src/schema/users.ts`: a ULID `id`
replaces `code` as the key, the code is stored only as `code_hash`,
`revoked_at` is added, and `users.invites_remaining` is dropped in favour of
the 3-open-links rule, checked inside the `accountInvites.create`
transaction. `users` gains `status: "waiting" | "active"`, `handle` and
`display_name` (rules in `04-membership-moderation-security.md` §3.1). A
`waiting` account registers no sync client (Y3) and reads through R5.
Account invites and the tree are online-only tRPC (`accountInvites.*`,
`members.tree`), not replicated records; tree visibility is decided in 04
§3.3.

**C9. Visibility: open or private.** The mockup creates a channel as Open
("Anyone can read and join") or Private ("Only people you add can read or
post"); private channels are not listed to non-members (`allVisible`). The
schema has `vis: open | listed | unlisted` with `policy: request | invite` and
request questions. Change: the wire carries `vis: "open" | "private"`; private
means closed, unlisted and invite-only; `policy` and `qs` are dropped. Join
requests and request questions are deferred (C10). The prototype's closed-space rules apply to private
channels unchanged.

**C10. Surfaces deferred.** The mockup has no pages, skills, space sources
library, source reports, FAQ topics, domains, archive, mutes, blocks, join
requests or inbox. Their procedures, collections and record kinds are left out
of `@session/mutators` v1 and moved to a `spaces.deferred.ts` section of the
shared schema, so that the mock keeps validating. The prototype's join-request
mutators stay in the acceptance suite because their stale-intent rules (M4)
are the tested form of `approve`, `decline` and `reopen`.

**C11. Owner-only About edit.** `chInfoDlg` offers Edit to the owner only, and
the editor (`chEditDlg`) changes only the description, at most 300
characters. The schema's `spaces.update` lets admins change every setting.
Change: `spaces.update` takes `{ id, desc }`, `who: "owner"`; name and
visibility are set at creation; no `base` is needed, because only one person
edits. Admin and moderator roles stay in the role enum and in the prototype
(their suites cover `setRole`), but no v1 screen grants them; see open
question 5.

**C12. Remove and report with a free-text reason; the moderation log.**
`rmDlg` takes an optional reason for both. A removal's reason is shown to
readers on the placeholder ("Removed by @x", "Reason: …"); a report's text
goes to the owner, and the author is not told who reported. `modLogDlg` lists
open reports, removals and dismissals. The schema's `reports.create` requires
a `why` category plus an optional `note`, and `moderation.decide` has no
reason. Change:
- `reports.create { item, note? }` (note at most 500 characters); `why` goes.
- `moderation.decide { item, decision, note?, base? }`; the thread placeholder
  keeps `mod`, `modBy` and `modNote` and nothing else of the removed content.
- A `modlog` record kind in the space log, readable by staff only: `{ id, sp,
  kind: "report" | "remove" | "dismiss" | "ban" | "unban", item, by, author,
  note, at }`; for `ban` and `unban`, `item` is null and `author` names the
  banned person (04 §6.5). `reports.resolve` with `dismissed` writes a
  `dismiss` entry; a removal closes the item's open reports. A person holds
  at most one open report per item (`CONFLICT` otherwise). Entries and
  resolved reports are pruned after 180 days (Y8).
- Conflict: `modLogDlg` quotes the removed thread's question. AGENTS.md wins:
  removed content is erased and never served again, so the log shows the
  item's kind, author and channel, and no text of a removed item. Open
  reports on items still present link to the item.

**C13. The layout toggle as a per-user preference.** `layoutBtn()` switches
between a centred main column and a wider one. ADR-20 keeps layout in
Zustand; the overview lists the toggle as an app bar feature without saying
where it persists. Change: a `prefs` record in the user log (`{ layout:
"centred" | "wide" }`, `prefs.set`), so it follows the person to other
devices and works offline; Zustand applies it. `user_preferences` (tRPC) is
not used for it because it would make an app bar control depend on being
online.

**C14. Space ids.** The mockup and the schema use slug space ids (`public`,
`sp-<name>`). AGENTS.md wins: space ids are ULIDs and creating a space is
online-only. Names stay unique slugs (`[a-z0-9][a-z0-9-]{1,29}`, from
`createSpace`) and URLs use the name. The cost recorded in AGENTS.md (an
unlisted name can be probed through CONFLICT) applies to private channels.

**C15. Deleting a thread.** The mockup offers Delete only while nobody else
has responded (`moreMenu`). AGENTS.md keeps the server rule: a thread deleted
while it had replies stays as an empty shell. The client may hide Delete
under the mockup's condition; the server does not enforce it.

**C16. Mentions.** Posts, replies and comments notify mentioned members
(`notify` in the submit handler). The schema's notification types have no
mention. Change: a `mention` notification type, written by a post-commit
effect to the mentioned person's user log, only if that person can read the
item at effect time.

**C17. Runs streamed.** The mock API's note "Answers are not streamed" is
superseded by ADR-22; the `spaceRunSchema` record becomes the run record of
03 §1.

## 8. Dependencies

```
M6 (update replica-proto) ─► M1-M5 (@session/mutators)
D1-D3 ─► Y3-Y6, Y13 (server half) ─► A1 (HTTP) ─► Y7 (SSE)
M1-M5 ─► Y9-Y12 (client half)
S1-S3 ─► A1
Y13 ─► the run jobs of 03 (E1)
D6 needs Y6 (epoch in cursors) and the restore runbook change
R1-R5 need Y5 and C7
C1-C17 land in spaces.ts and replica-proto before M5
S4 (effects) before C16 and the run jobs of 03
```

The shared-schema changes (section 7) come first because the mutators, the
prototype and the mockup's validator test (`test/spacesMock.test.ts`) all read
them.

## 9. Open questions

1. **Record table or typed tables.** D1 chooses one `records` table with JSON
   bodies. If feed queries (C7, R5) need indexes on fields inside `body`,
   generated columns are added per field; is that acceptable, or should
   threads and nodes get typed tables now?
2. **Who sees save counts.** C1 serves the count to every reader of the
   space. In a private channel with few members a count of 1 can identify the
   saver. Show save counts only above a threshold, or only to the author?
3. **Erasure and backups.** D4 erases from the live file, but Litestream
   generations and the nightly archive keep removed text until retention
   expires. Set Litestream retention to a fixed bound (for example 72 hours)
   and state it in the privacy copy, or re-snapshot after removals?
4. **Restore marker.** D6 relies on the restore runbook to write a marker. Is
   a boot-time check of the Litestream generation id more reliable than a
   manual step?
5. **Admin and moderator roles.** C11 keeps them in the contract with no
   screen. Drop them from v1 (simpler permissions, but the prototype suites
   for `setRole` then test dead code), or add a "Make moderator" control?
6. **Join requests.** C9 defers them, so a private channel admits only
   through links. Is that the intended product, or did the mockup leave them
   out only for space?
7. **Snapshot cost on the web.** The web client keeps an in-memory replica
   and snapshots on every load. At 5,000 full threads per space this is
   megabytes per tab; should the web client use a smaller window than the
   desktop? Untiered pulls (R2) add the same cost in busy spaces.
