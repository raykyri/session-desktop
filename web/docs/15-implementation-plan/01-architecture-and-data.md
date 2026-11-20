# 01 — Architecture and data

Status: draft. This file plans the server half of the Session spaces client:
the Node web server over one SQLite database, the tables and migrations, the
two packages `AGENTS.md` schedules next (`@session/mutators` and
`@session/sync`), replication tiers, the HTTP surface, and the changes the
members mockup (`docs/mockups/session-web-members.html`) makes to the spaces
contract (`web/packages/shared/src/schemas/spaces.ts`). Runs, models and
tokens are in `03-agents-and-research.md`; invites, channel ownership and
moderation policy in `04-membership-moderation-security.md`.

Authority, as in `00-overview.md`: `AGENTS.md` ("Planned: desktop client and
sync core") and ADR-19 to ADR-22 win over the mockup, except where the
overview records an explicit product decision. Each conflict below says which
side wins.

Scope: this build is web only (`00-overview.md`, "Scope of this build"). The
parts of `AGENTS.md` and ADR-19 to ADR-22 that assume a desktop client, a
phone client or device runs (bearer device tokens, the desktop CORS origin,
a persistent SQLite replica, the 3-day offline outbox of a client, the
Phone window, device-run routes and leases) are not built. The sync core is
kept: server authority, the outbox, replicas, shared mutators, and the web
client's in-memory replica. Items that existed only for those parts are
marked "(removed: web-only build)" and keep their ids.

Work items have ids (`S`, `D`, `U`, `Y`, `R`, `A`, `C`) so that
`05-delivery.md` can schedule them. The mutator items use `U` because
`05-delivery.md` uses `M0`-`M8` for milestones and replica-proto's mutation
runner uses `X` for its fault ids.

## 1. Server process

The server stays one Node 22 process (Hono, ADR-2) on one Fly machine with
one SQLite file on the volume (ADR-4, ADR-13). better-sqlite3 transactions
are synchronous, which matches the synchronous `tx` that `@session/mutators`
requires: a mutator's `run` executes inside one `db.transaction()` with no
`await` between the permission check and the commit.

**S1. Request pipeline for sync routes.** Add a Hono sub-app
`web/packages/server/src/sync/` mounted at `/api/sync`. Middleware order:
request id, protocol version check, authentication (session cookie, ADR-5;
optional on `snapshot` and `pull`, see R5), rate limit, handler. The same
version check runs on `/api/runs/:id/live` and on tRPC. The web client is
same-origin, so the server sends no CORS headers at all. On
`426 UPGRADE_REQUIRED` the web client reloads the page once (`05` §3.4).
Acceptance: a request without the `Session-Protocol` header, or below
`SESSION_MIN_PROTOCOL`, answers `426` with `{ code: "UPGRADE_REQUIRED" }`;
one test per refusal (version, authentication `401`, rate limit `429`) and
one asserting that a foreign origin gets no CORS headers.

**S2. Desktop authentication (removed: web-only build).** Not built: no
`device_tokens` table, no bearer authentication, no pairing, no CORS
allowlist. The web client authenticates with the session cookie of ADR-5
and the CSRF rules of `03-api-and-events.md` §1. The original text, kept
for a later desktop build: a bearer device token (random 256-bit value,
stored hashed in `device_tokens`, held in the macOS Keychain by the desktop)
authenticates `/api/sync/*`, `/api/runs/*` and the tRPC account procedures.
Issued by a signed-in web session through a one-time pairing code; revocable
from the account menu. The token never reaches the webview's JavaScript: the
Tauri (Rust) side holds it and adds the `Authorization` header to requests
for the server origin (04 Z3). Cookie sessions (ADR-5) continue for the web client.
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
rotation, then removed), `SESSION_SECRET_KEY` (API key and invite code
encryption, see 03 and C8), the X OAuth client settings (04 Z2), the web
replication window of R1, and the run and allowance settings of
`03-agents-and-research.md`: `SESSION_WEEKLY_TOKENS` (2,000,000),
`SESSION_RUN_MAX_TOKENS` (400,000), `SESSION_OVERDRAFT_TOKENS` (200,000
per member per week, shared by all of the member's included-token runs, 03
K9) and `SESSION_QUEUED_PER_USER` (20); the abuse limits of 04 Z1. The
default model and the default effort are not configuration: a site admin
sets them at runtime (03 K15). The abuse address of the site footer,
`abuse@<host>`, is derived from the hostname of `SESSION_PUBLIC_ORIGIN`
and is not a separate setting; the mailbox must exist before launch (a
launch prerequisite in 05).
`SESSION_DESKTOP_ORIGINS`, `SESSION_DEVICE_ANSWER_MAX_BYTES` and
`SESSION_DEVICE_RUNS_PER_HOUR` are not added (removed: web-only build).
Acceptance: boot refuses a cursor key that is not 32 bytes of base64;
`web/.env.example` documents every new variable.

**S4. Effect worker (removed: no effect queue).** Not built: there is no
`effects` table, no effect worker, no dead letters and no dead-letter
gauge. Notifications are written in the transaction of the write that
causes them (U1 `notify`, C16); a run is queued as its `run` record with
status `queued` and claimed by the run dispatcher (03 E2); a new thread's
title and summary are the run's final steps; an API key is checked during
the `apiKeys.set` request (§6, 03 K4). Scheduled maintenance (the hourly
retention jobs of Y8, the 90-day waiting-account sweep of 04 I1) stays; it
is not an effect.

**S5. Drain and boot.** On `SIGTERM`: answer every later envelope
`SERVICE_UNAVAILABLE` (unrecorded, so outboxes retry), close SSE streams,
then run the existing run drain (`05-run-lifecycle-and-streaming.md` §7),
which closes the `usage_events` row of every call it ends (03 K1).
Commits are synchronous, so no transaction is open across the signal. On
boot: migrate, check the restore marker (D6), close `usage_events` rows
still `open` with their last checkpoint (03 K1), mark runs still `running`
as `interrupted` (03 E2), then start the run dispatcher and the scheduled
maintenance jobs (Y8). Acceptance: a test sends `SIGTERM` during a batch
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
`run_queue`, `collapsed_*`) are dropped. `embed_assets` and `tweet_cache`
(with the files under `/data/embeds/`) serve only research content and are
dropped with them. At launch the production database is replaced by an
empty one: every row, accounts included, is wiped (`05-delivery.md` §3.5,
decision P19), so no migration has to carry data from the current schema.
`users` changes for sign-in with GitHub or X (04 I1).

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
- `clients(client_id, user_id, last_seq, created_at, last_used_at)`: a web
  client id is kept across reloads of its tab (Y3) and expires after 7 days
  idle; at most 50 new ids per user per day, re-attaches not counted.
- `answers(user_id, mutation_id, client_id, seq, digest, answer_json,
  created_at)`: recorded answers, kept 7 days. `digest` hashes the name and
  canonical input, so a reused mutation id with another payload is detected.
  An answer for a malformed or reused mutation id is stored under
  `(client_id, seq)` only. A reminted envelope stores its answer under every
  mutation id it replaces, in the same commit.
- There is no `effects` table (S4 removed).

Acceptance: a commit writes the record rows (the notifications of U1's
`notify` stage included), the log rows, the registry, the recorded answer
and the client's `last_seq` in one transaction (AGENTS.md). A test injects
a failure into the notification write of `notify` and finds no record,
log, registry, answer or `last_seq` change, and an `INTERNAL_SERVER_ERROR`
answer that a resend replaces.

**D3. Non-replicated server tables.** New: `api_keys` (encrypted value,
provider, mask, status, last used), `run_live` (in-flight checkpoint text per
run and attempt, deleted at finish), `site_settings` (`default_model` and
`default_effort`, set by a site admin, 03 K15; no `model_settings` table),
`server_meta` (the Litestream generation id of D6), `save_counts` (thread
id and the true save count of a thread in a private channel, C1). Changed:
`usage_events` gains `run_id`, `attempt`, `payer`, `week` and `state`
(`open` | `closed`); one row per provider call is opened when the call
starts, checkpointed at most every 2 s and closed when the call ends, in
its own short transactions, never fenced (03 K1, E1); `invites` and
`users` (C8, 04 I1). `device_tokens` and `run_leases`
are not created (removed: web-only build). Acceptance: no row of these
tables appears in any `snapshot` or `pull` (a test lists every served record
kind and checks it against D1's kinds).

**D4. Erasure at rest.** Set `PRAGMA secure_delete = ON` so deleted rows are
overwritten in the file, and run `erase` paths as deletes of the affected
`records` rows plus tombstones. Acceptance: the replica-proto storage scan
(`inv6-removed-content.test.ts`) is ported to scan the bytes of the SQLite
file and its WAL, after a checkpoint, for a removed thread's marker text and
finds none. Litestream generations still hold the text until their retention
expires; there is no retention requirement for backups (§9 q3; 05 §6 S1).

### 2.2 Migrations

**D5. Migration sequence.** Following `02-domain-model-and-database.md` §4,
on the build branch (`05` §3.0): a generated migration `0001_spaces.sql`
adds D1-D3 in M3; `0002_accounts.sql` adds the C8 columns and the
provider columns of 04 I1 in M6 (`05` §1.2). Once the
research schema files are deleted (with A2 and `02` W1.1 in M4), the
migrations are squashed into one generated `0000_initial.sql` in M8a. No
database at an older migration has to be upgraded: production is wiped at
launch (decision P19) and staging is reset after the squash, both with
`runbooks/reset-database.md`. There is no `0002_drop_research.sql`.
Acceptance: `db:generate` produces no diff in CI; `migrations.test.ts`
migrates a fresh database, and after the squash finds no research table.

**D6. Log epochs and restores.** A log's epoch increments when its history
is replaced: a space's visibility changes (prototype test "a space that
becomes closed resyncs every reader") or the database is restored from
Litestream. Cursors older than 30 days resync through `servedAt` (Y5), not
through the epoch. Visibility is fixed at creation in v1 (C11), so in
production only a restore bumps epochs; the visibility path stays because the
prototype suite tests it. A restore is detected at boot (decision E6): the
server compares the Litestream generation id recorded in `server_meta` with
the generation Litestream reports for the file; a different id, or none
recorded, increments every log's epoch, so every cursor issued before the
restore resyncs instead of pulling from a version the restored database has
reused, and the current id is then recorded. Litestream also starts a new
generation without a restore (for example after losing its WAL position);
that bumps epochs needlessly and costs one resync per client. No manual
runbook step is needed. Acceptance: a test restores an older copy of the
database file with a different generation id, boots, and finds that a
pre-restore cursor answers `resync`; a boot with an unchanged id bumps
nothing. `runbooks/restore.md` states that the check runs at boot.

**D7. Record shape versions.** A record kind's stored shape changes through a
versioned backfill in `web/packages/db/src/backfills/` that rewrites `body`
and bumps `rev`, so that every replica pulls the new shape. Acceptance: a
test backfill that adds a field to one kind writes a log row for every
rewritten key, and a replica that pulls afterwards holds the new shape.

## 3. `@session/mutators`

New package `web/packages/mutators` (name `@session/mutators`), depending only
on `@session/shared` and `zod`. It replaces the mock's procedures and
generalizes `replica-proto/src/mutators.ts`.

**U1. Definition shape.** Port `MutatorDef` from the prototype: `input` (the
shared zod schema, strict), `who`, `space`, `ids`, `online`, and three stages:

1. `pre(ctx, input)`: server only, synchronous; may refuse; makes server
   values (invite codes, the payer of a run, limit checks). Its clock and
   random source come from `ctx` (`now`, `random()`, as in the prototype's
   `PreCtx`). Never run on the client.
2. `run(tx, input, values)`: deterministic over a synchronous `tx`. Reads
   `tx.now`, never a clock, random source, `Intl` or `Date` formatting. Makes
   no ids: the first id is in the input, later ones come from
   `tx.id(ordinal)`, derived from the mutation id.
3. `notify(tx, input, result)`: server only, inside the transaction after
   `run`; writes the notification records the write causes (C16, with its
   coalescing). Never run on the client. Notifications are exactly once
   because they commit with the write. This replaces the prototype's
   `post` stage (post-commit effects); there is no effect queue (S4
   removed).

On the server the order is the prototype's, with `notify` added: ban check,
`who`, `can`, `pre`, `run`, `notify`, all inside one transaction (Y4), so
`pre` never runs for a caller the permission checks refuse. No stage does
network work: model calls run in the run loop (03), and an API key is
checked in the `apiKeys.set` request (§6).

Acceptance: the prototype test "mutators read no clock, no random source and
no Intl while the server applies them" runs over every mutator in the
package; an ESLint rule bans `Date`, `Math.random`, `crypto` and `Intl` in
the whole package; a test refuses a write in `run` and finds no
notification committed.

**U2. Indexed reads in `tx`.** The prototype's `tx.find(kind, predicate)`
scans every record of a kind, which is acceptable in memory and not on a
large SQLite table. Replace it with declared lookups: `tx.byKey(key)`,
`tx.list(kind, { sp } | { th } | { u })` and `tx.count(kind, index)`, each
mapping to an index of D1. Predicates run only over those bounded lists.
Acceptance: an explain-plan test asserts every lookup uses an index; the
client replica implements the same interface and returns `unknown` for a
lookup outside its working set, which stops prediction (AGENTS.md).

**U3. Stored shape and derived fields.** Mutators write the stored shape.
Counts (`saves`, `r`) are stored fields in the counts record, written by the
mutators that change them. Per-viewer fields (`saved`, `mine`) are computed on
the client and never stored or served. Acceptance: a test parses every record
a mutator writes with its stored schema and finds no `mine`, `saved` or
`liked` field.

**U4. Stale intent.** `shown` carries `base.rev` of the target and answers
`STALE` on a mismatch; `members.setRole` and its rule are removed with the
admin and moderator roles (C18); `hidden`, `removed` and `members.ban` act
on the record as it is; `members.remove` compares the admission id
(AGENTS.md). Join requests are not built (C9, C10), so `approve`,
`decline` and reopen are not in `@session/mutators`; their rules stay
tested only in the prototype suite. Acceptance: the replica-proto
review-r1/r2 tests for these cases pass.

**U5. The mutator set.** Mutator names are the procedure names of
`spaces.ts`; this plan adds only `comments.*` (C4) and `prefs.set` (C13),
renames `saved.toggle` to `saved.set` (C1), and removes `members.setRole`
(C18). One file per area under `src/`:
- `spaces`, `members`, `threads`, `saves`, `moderation`, `invites`,
  `notifications` (no `reports`: there is no reporting, C12);
- `nodes`: `research.forkNode` (Continue, Branch, Branch here and Look up,
  with `kind: "ask" | "lookup"`), `followups.update`, `followups.delete`,
  `research.cancelNode`, `research.retryNode` (03 §2);
- `replies`: `research.createPostFollowUp`, `replies.update`,
  `replies.delete`;
- `comments`: `comments.create`, `comments.update`, `comments.delete` (C4);
- `prefs`: `prefs.set` (C13).

The set is the mock's procedures minus the surfaces C10 defers, with the
changes in section 7. `members` holds `members.remove`, `members.ban` and
`members.unban`, all `who: "owner"` (C18). `followups.ask` (an ask with no parent) is not used:
every ask under a thread goes through `research.forkNode` (03 §2.1). The
prototype ports 19 mock procedures, `members.setRole` among them until U6
removes it; the others (`research.createPostFollowUp`,
`replies.*`, `comments.*`, `research.forkNode`, `followups.update`,
`followups.delete`, `research.cancelNode`, `research.retryNode`,
`members.unban`, `invites.revoke`, `notifications.*`, `prefs.set`) are
covered only once the read and write oracles have rules for them (U6).
`reports.create` and `reports.resolve` are removed from the contract (C12).
Acceptance: a table test lists every mutator with its `who`, its
stale-intent rule and whether it is `online`; space creation is
`online: true` (AGENTS.md); the write oracle has a rule for every listed
name.

**U6. Update the acceptance suite first.** The replica-proto suite exercises
`likes.set` (56 lines in `test/`), space rules, `rulesRev` and the
`listed`/`unlisted` visibilities, which section 7 removes, and its strict
envelope lacks `queuedAt` and `replaces`, which AGENTS.md requires. Before
porting, change `replica-proto` itself to the revised contract:
- records and mutators: `likes.set` replaced by counted saves (C1); rules
  dropped (C6); `vis: "open" | "private"`, no `policy` or `qs` (C9);
  `spaces.update { id, desc }` (C11); the `followup` kind renamed `node` with
  C3's fields; `comment` (C4) and `modlog` (C12) kinds; `erase` also deletes
  the removed thread's saves, comments and mention notifications (04 §6.2);
- roles (C18): `SpaceRole` becomes `"owner" | "member"`; `members.setRole`,
  `RANK`, the rank comparison in `actsOn`, `isModOf`, the space's `invite`
  setting and its `mods` list go (`owner` replaces `mods`); `who:
  "moderator"` and `who: "admin"` become `who: "owner"`; the `report`
  notification effect is removed with reporting (below). The `cast` fixture in
  `test/harness.ts` no longer calls `setRole`: mona (#lounge, #lab) and ada
  (#lab) are plain members, and every test in which they act as staff
  (removals, bans, decisions, `spaces.update`) acts as the owner olga
  instead. Removed, because they test only roles:
  `inv2` "a moderator's hide, queued before a demotion, is refused after it",
  `inv2` "an admin's role change, queued before losing admin, is refused",
  `inv2` "an invite link works only while its maker may still make links" and
  "a link that stopped working when its maker lost the right works again once
  the maker has it back" (the maker is the owner, who keeps the right; a
  frozen channel's links are covered by the server test of 04 §4.5),
  `inv6` "a demoted moderator stops getting hidden text, and a promoted member
  starts", `review-r1` "an ownership transfer leaves exactly one owner, and
  the old owner an admin", `review-r1` `R4c` "report notifications leave a
  moderator's user log when the moderator leaves the closed space" (the
  owner cannot leave) and `review-r2` `H2` "report notifications are served
  only while their person is staff of the space". Rewritten: `inv1` "a
  write the actor's role forbids is refused and changes nothing" (owner-only
  writes by a member instead of `setRole`); `inv2` "a queued role change,
  show, or edit acts only on the state it was made from" (drops the role
  change and is renamed "a queued show or edit …"); `inv3` "a non-member of a
  closed space gets its landing, the staff list and their own request, not
  their threads" and "a plain member gets no moderator-only records, in
  snapshots or pulls" (`owner` for `mods`, owner-only records); `inv6`
  "after a hide, its author and the space's moderators get the text;
  everyone else the placeholder" and "hidden follow-ups and replies lose
  their text for readers who are not their author or staff" (the owner for
  moderators); `review-r1` `R1b` (drops ada's queued `setRole` and its
  STALE answer); `inv5` "a replay
  with a different name or input is refused, and the stored result stays",
  `review-r2` `S1`, `Q2`, both `E1` tests and `R1` "a record written again at
  a deleted key continues from its last rev, after the tombstone is pruned
  too", which use `setRole` as a sample write and take another mutator;
  `convergence.test.ts` drops `members.setRole` from its generated writes
  and its setup. The write oracle drops `RANK`, its `actsOn` and its
  `members.setRole` rule; the effect model drops its `RANK` ordering and its
  `members.setRole` case. Mutation patterns: X9 ("an ownership transfer
  keeps the old owner"), N13 (a link's maker reads it after leaving), N14
  (the `invite` setting) and R2-5 (report notifications served to people
  who are not staff, an equivalent mutant once only the owner is notified)
  are removed; the N22 control is rewritten for `owner` (N22:
  "spaces.update needs only a member"); X11 goes with reporting (below);
- reporting (C12): `reports.create`, `reports.resolve`, the `report` record
  kind and the `report` and `report_resolved` notification types are
  removed. Tests whose subject is reporting are removed, among them
  `review-r1` "a report notifies the space's owner, admins and moderators,
  and nobody else" (no longer rewritten), `R4c` and `H2` (already removed
  above); tests that use `reports.create` as a sample write (in
  `convergence`, `inv2`, `inv3`, `inv4`) take another mutator. Mutation
  pattern X11 (no longer rewritten) and the N24 control ("one report in 32
  notifies nobody") are removed or re-pointed at a notification written by
  `notify`, and `npm run mutate -- --check` lists the result;
- effects (S4 removed; product owner decision): the `Effect` type, the
  `post` stage, the effect queue, the effect worker (`work`),
  `EFFECT_MAX_ATTEMPTS` and the dead letters are removed from `src/`.
  Notifications are written in the transaction by a `notify` stage (U1);
  the `job` effect that `threads.create` queues for an ask is dropped,
  because the `run` record it writes with status `queued` is the queue, and
  the
  `jobs()` test hook lists queued run records instead. The effect model
  (`test/effect-model.ts`, the write oracle's prediction of the records a
  write changes) leaves notifications out today because the worker wrote
  them later; it now predicts them as part of the write. The tests that
  call `work()` or `jobs()` (in `convergence`, `inv4`, `review-r1` and
  `review-r2`) are rewritten to read the notification and run records
  committed with the write, or removed where their subject is retry,
  backoff or dead letters. Mutation patterns that target the effect queue
  are removed. This departs
  from `AGENTS.md` ("queued effects commit together; effects run from a
  worker"); the web-only `AGENTS.md` (05 §6 Q1) records the change;
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
refused, unknown names refused, depth and size limits) pass with U6's
changes.

**Y2. Answers.** Every answer carries `serverTime`. Recorded (they use up
the `seq`): applied results and refusals of the write itself (`FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `STALE`, `EXPIRED`, `BAD_REQUEST` for the input or
the mutation id, `PRECONDITION_FAILED`, …). The queue-full refusal is one of
these: beyond 20 queued runs per user (`SESSION_QUEUED_PER_USER`, 03 L1)
the `pre` stage answers `PRECONDITION_FAILED` with `reason: "queue_full"`,
recorded and using the seq; the client pre-checks its own queued runs from
the replica and, on the refusal, rolls back, restores the text to the
composer and shows a toast (02 §9.2). Not recorded: `TOO_MANY_REQUESTS`
(reserved for transport rate limits, A3 and Y3; no mutator answers it),
`SERVICE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`, `CLOCK_SKEW`, `OUT_OF_ORDER`
(carries `expectedSeq`), `WRONG_CLIENT`, `UNAUTHORIZED`, `UPGRADE_REQUIRED`,
`TOO_LARGE`, and `BAD_REQUEST` for a malformed envelope (it has no usable
`seq`). The sync codes (`STALE`, `CLOCK_SKEW`, `EXPIRED`, `OUT_OF_ORDER`,
`WRONG_CLIENT`, `UPGRADE_REQUIRED`, `TOO_LARGE`) are not in the shared
`spaceErrorCodeSchema` today and are added to it. Acceptance:
`inv5-idempotency-per-user` and review-r1 `R7b` pass; a 21st queued run is
refused with a recorded `PRECONDITION_FAILED` (`reason: "queue_full"`), and
its resend returns the recorded answer.

### 4.2 Server half

**Y3. `register`.** Client ids are kept across reloads, per tab. The web
client stores `{clientId, userId}` in sessionStorage, which survives a
reload of the same tab, is per tab, and is cleared when the tab closes. On
load the tab takes an exclusive Web Lock named `session-client:<clientId>`
with `ifAvailable`; a duplicated tab inherits the copied sessionStorage,
fails to get the lock and registers a new id. `register` either issues a
new client id bound to the caller or, given an existing id of the caller,
re-attaches it and returns its `lastSeq`. Only new ids count against the
limit: the 51st new id of a user in a day answers `TOO_MANY_REQUESTS`; a
re-attach is not counted. Web client ids expire after 7 days idle; they
hold no outbox across reloads (Y10), so nothing is lost. Sign-out clears
the stored id. A stored id of another user, or an expired one, answers
`WRONG_CLIENT` and the client registers anew. A `waiting` account (C8)
gets `FORBIDDEN` and reads through R5. Acceptance: 100 reloads of one tab
register one id; a duplicated tab gets a new id; a client id of another
user, or idle for 7 days, answers `WRONG_CLIENT`; one test per refusal.

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
7. one transaction: ban check, `who`, `can`, `pre`, `run`, `notify`;
   commit records (notifications included), log rows, registry, the answer
   (under `mutationId` and each id in `replaces`) and `last_seq`.

ID collisions answer the same `CONFLICT` whether or not the caller can read
the holder. Acceptance: `inv1`, `inv2`, `inv4`, `inv5`, review-r2 `Q1` and
the convergence suite pass with the SQLite store; a test applies a reminted
envelope and then the delayed original, and the original gets the recorded
answer.

**Y5. `snapshot(log, tier)` and `pull(log, cursor)`.** Read records as they
are now, filtered by the reader's scope at read time (`replica-proto/src/access.ts`);
hidden text goes to its author and the space's owner only. Snapshot records
come in `createdAt`, then `created_v`, order. `pull` returns the keys changed
after the cursor's version, each as the current record or a `del`
(tombstone, or a record the reader may no longer read), plus `lastSeq` when
the request names a client id of the caller. `pull` answers `resync` for a
token not sealed by this server (current or previous key), sealed for
another reader, log or epoch, served more than 30 days ago, or when the
reader's scope changed since (their membership in the space; for a
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
client with `fetch` (so it can send the protocol header; an `EventSource`
cannot). Each `changes` event carries pull batches for one or
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
answers over 7 days, clients idle 7 days, and `modlog` entries over 180
days (C12; replicated deletes). `registry` is never pruned. These are
scheduled maintenance in the server process, not effects (S4 removed).
Acceptance: one test per table with an injected clock, at the boundary
millisecond (as inv6 "a delete committed in the same millisecond as a
cursor…").

### 4.3 Client half

**Y9. Replica and storage adapter.** The replica keeps a working set in
memory behind a `StorageAdapter` interface. This build ships the in-memory
adapter only (the web client, no IndexedDB); the SQLite adapters for the
desktop and the phone are not built (removed: web-only build). The interface
stays so that a persistent adapter can be added without changing the
replica. Acceptance: the client test suite runs against the memory
adapter.

**Y10. Outbox.** One global order across logs. The web client holds a write
only while its request is in flight (AGENTS.md, ADR-20); a write whose
request fails is shown as "Not sent" with Retry (same mutation id) and
Discard (02 §9.2), and nothing is kept across a reload. The library keeps
the queue rules the replica-proto suites drive (3 days in server time,
backoff on transient answers from 1 s to 10 minutes, a write that fails 5
times shown while the rest continues, a write dropped at 3 days reported),
as a policy the web client does not enable. After
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

**Y12. Reactive queries.** `useQuery(selector)` for React,
re-evaluated when keys the selector read change. Acceptance: a component test
re-renders once per confirming batch, not once per record.

### 4.4 Server-originated writes

**Y13. `serverApply`.** Runs and the account-invite procedures write
records without an envelope (`03-agents-and-research.md` E1; the
`invite_used` notification of C16): `serverApply(fn)` in
`@session/sync/server` runs `fn` over the same `tx` and commits record
rows, log rows, registry and tombstones in one transaction, with no answer
and no seq; a tRPC procedure that calls it inside its own transaction
commits its table changes and the records together. The run fence (current
attempt, thread not removed) is the caller's, in 03, and applies to record
writes only: ledger writes (`usage_events`) do not go through
`serverApply`, are written at spend time, are never fenced and commit in
their own short transactions (03 K1, E1). Acceptance: a run turn written this way
reaches a reader's `pull` and SSE stream; a write whose `fn` refuses
commits nothing.

## 5. Replication tiers

**R1. Full and summary tiers.** `AGENTS.md` "Replication" sets the desktop
window (90 days or the newest 500 threads, capped at 5,000) and a Phone
window; neither client is built. The web client's in-memory replica is
loaded by a snapshot on every page load, so its window is smaller (decision
E7): per space, full records for the last 30 days or the newest 100 threads,
whichever covers more, capped at 500; plus every thread the user wrote or
saved in the past 90 days and every thread opened in the current tab. Every
other readable thread is a summary: the thread record and its counts record,
without ask nodes, turns, comments or replies, for the past 2 years. The
numbers are server settings (`SESSION_WEB_WINDOW_DAYS`,
`SESSION_WEB_WINDOW_THREADS`, `SESSION_WEB_WINDOW_CAP`) so that M3's load
check can change them.

**R2. Who computes the window.** The server computes the full set from the
space log and the user's saves and authorship; the client adds the threads it
opened in the current tab as an explicit list (at most 500 ids) in the
snapshot request body, filtered by scope like everything else. Opens stay in
the tab; the server does not record them. Pulls are not tiered (Y5): the
client applies changes to summary records and drops node, run, turn, answer
and comment changes of threads outside its full set; a thread that leaves
the window is demoted at the next snapshot. Acceptance: a snapshot test
checks each of the four inclusion rules, the cap and the 2-year summary
bound; a client test drops a turn change for a summary-tier thread.

**R3. Promotion.** Opening a summary-tier thread fetches its full records
through `snapshot(log, { threads: [id] })` and keeps them for the life of the
tab. Acceptance: a client opening a summary-tier thread while offline shows
the summary and an "Available when online" state.

**R4. Closed spaces.** A client replicates the closed spaces its user belongs
to and nothing else of any closed space (AGENTS.md). The server keeps the
prototype's rule that a removed member may still delete their own threads in
a closed space (the frozen-copy test). The web client persists nothing, so
it keeps no frozen copy: on the resync that follows a removal or ban it drops
the channel's records and shows "You are no longer a member of #name." (02
W6.10; decision P8 for a voluntary Leave). Acceptance: `inv7` and the
frozen-copy test pass against the server.

**R5. Open spaces the user has not joined, and signed-out readers.** The
"All" scope (C7) lists open channels the user has not joined. Their threads
are read with a summary-tier snapshot, plus a full snapshot of a thread when
it is opened, into an ephemeral, unpersisted replica that is dropped when the
user leaves the channel view and refreshed by `pull` on navigation and every
60 seconds (no SSE). Joining converts it to a replicated log. Signed-out
readers and `waiting` accounts use the same path; it is the public read path
of `02-client-app.md` §9.5. `snapshot` and `pull` accept an unauthenticated
caller, as the prototype does ("a signed-out caller gets open spaces and the
landings of closed ones"). Acceptance: browsing ten unjoined channels leaves
the replica's joined logs unchanged and drops each ephemeral replica when
its view closes; a signed-out `snapshot` of a private channel returns its
landing only.

## 6. API surface

Replicated data uses only the sync routes. Online-only account calls stay tRPC
procedures (ADR-19). The device-run routes of ADR-21 are not built (removed:
web-only build).

| Route | Kind | Purpose |
|---|---|---|
| `POST /api/sync/register` | sync | a new client id, or re-attach of the caller's existing id with its `lastSeq` (Y3) |
| `POST /api/sync/apply` | sync | a batch of envelopes, answered in order |
| `POST /api/sync/snapshot` | sync | records now, scope-filtered; body `{ log, tier, threads? }` (500 ids do not fit a URL) |
| `GET /api/sync/pull?log&cursor&clientId` | sync | changes since a cursor |
| `GET /api/sync/events` | SSE via fetch | pull batches and run deltas |
| `POST /api/runs/claim`, `/heartbeat`, `/turn`, `/finish` | — | removed: web-only build (ADR-21 device runs) |
| `GET /api/runs/:id/live` | read | in-flight checkpoint of a run after a gap (ADR-22) |
| tRPC `account.*` | online | profile and account settings; `devices.*` is not built (removed: web-only build) |
| tRPC `apiKeys.*`, `usage.*` | online | keys, allowance, recent runs (`03-agents-and-research.md` §6); `apiKeys.set` checks the key against the provider's model list during the request (10 s timeout) and saves it only if the provider accepts it: a rejected key answers `BAD_REQUEST` ("That key was rejected by <Provider>."), an unreachable provider `BAD_GATEWAY` ("Couldn't reach <Provider> to check the key. Try again."); neither saves the key (03 K4) |
| tRPC `models.list` | online | every registry model, the default model and the default effort (03 K15) |
| tRPC `admin.models.*` | online, site admins | default model and default effort (03 K15); there is no `admin.suspend` (no suspension, 04 I6 removed) |
| tRPC `accountInvites.*`, `members.tree` | online | Session invites and the invite tree (C8) |
| tRPC `spaces.directory` | online | the "All" list of open channels (C7) |
| `GET /healthz`, `/auth/*` | Hono | `/auth/github/*` and the new `/auth/x/*` (04 Z2) |

**A1.** Implement the sync routes over `@session/sync/server` (S1, Y3-Y7).
Acceptance: `web/packages/server/test/conformance/` implements replica-proto's
`ServerFactory` over HTTP against a server on a temp SQLite file with an
injected clock. The `TestServer` hooks as U6 leaves them (`dump`, `jobs`
over queued run records, the storage scan, clock and random-source
control; `work` is removed with the effect worker) are served by a route
mounted only when `NODE_ENV=test`. Every replica-proto test file passes
against it unchanged, the oracles and effect model included. The mutation runner
mutates the prototype's `src/` only; the server's own mutation set is
`05-delivery.md` M3.

**A2.** Remove the old `research.*`, `workspaces.*`, `feed.*`, `sharing.*`,
`drafts.*` routers from `web/packages/server/src/trpc/routers/` with the
old client. Acceptance: `npm run check` passes with the routers gone.

**A3.** Rate limits: `apply` counts envelopes against the 60 writes per
minute per user of `06-auth-and-users.md` §8 (a batch of 20 counts 20);
`snapshot` 30 per minute per user; one SSE connection per client id; limits
keyed by IP (04 Z1) use the /64 prefix for IPv6. These answer
`TOO_MANY_REQUESTS`, unrecorded (Y2). Acceptance: middleware tests.

## 7. Contract changes from the mockup

Each item compares the mockup's behaviour with `spaces.ts` and the mock API
(`docs/mockups/session-web-spaces-mock-api.js`) and says what changes and in
which places: the shared schema, `replica-proto` (U6), `@session/mutators`.

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
likes", so the product decision wins and no ADR conflicts. In a private
channel a save count below 3 is not served (decision S6). The replicated
counts record stores the served value: in a private channel `saves` is 0
until the true count reaches 3, and the true count is kept in the
non-replicated server column `save_counts.saves` (D3). A save that leaves
the true count below 3 therefore changes no counts record and writes no
change-log row for it; crossing 3 in either direction writes the counts
record. The true count is a server-only lookup that reads `unknown` on the
client (U2), so the client predicts the user's save record but not a
private channel's count, and draws no count below 3 there. Open channels
store and show every count in the counts record.

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
these; `forkNodeInputSchema` takes `parent`, `q`, `uses`, `pay`. Change, with
the full field list in 03 §1:
- ask nodes get `kind: "ask" | "lookup"`, optional `quote` (at most 2,000
  characters), optional `b` (passage index: the top-level block of the
  parent's answer that holds the quote, used to place the branch tree and
  shade the passage; absent for asks from the footer) and, for look-ups,
  `look` (1-4 words, at most 80 characters) and `tpl` (template version);
- every node records `model` and `effort` (03 K12); every new run carries
  an explicit effort. Both are stored on node and run records and shown
  nowhere in the UI (the mockup's ask card has no byline and no "model ·
  effort" tooltip); `executor` and `agent` are not added (every run is an
  owned run);
- optional `promoted`: the id of the thread the node was opened as (03 G5);
- `pay` and `uses` are dropped from the node and from `forkNodeInputSchema`
  (the payer is a server value, 03 K8); `forkNodeInputSchema` becomes a
  union on `kind`;
- the node's `html` gives way to the `answer` record of 03 §1, stored as
  Markdown; streamed deltas are Markdown too, and the client renders both
  through its Markdown pipeline (`02-client-app.md` §4.4).

Look-up input carries `look` and no `q`; the mutator builds the prompt from a
versioned template in `@session/mutators` and stores it in `q`, so the client
cannot place hidden text on a node. The stored prompt is served like any node
text; the client renders `look` instead. Details in 03 §2.

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
`spaceSettingsSchema` and `createSpaceInputSchema`; `spaces.create` stores no
default rules; the prototype's `rulesRev` and its CONFLICT path go. Sign-up has no rules checkbox: there is
no Session-wide community guidelines page (`05` §6, Q10).

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
replaces `code` as the key, the code is stored as `code_hash` for lookup and
as `code_enc` (AES-256-GCM under `SESSION_SECRET_KEY`, readable only by the
link's creator, nulled when the link is used or revoked), `revoked_at` is
added, `created_by` is nullable (null for the root invites printed by
`npm run db:admin -- --invite`, 04 I1), and `users.invites_remaining` is
dropped in favour of the 3-open-links rule, checked inside the `accountInvites.create` transaction.
`auth.checkInvite` answers `open` or one `unusable` answer for used, revoked
and unknown codes. `users` gains `status: "waiting" | "active"`, `handle`
and `display_name` (rules in `04-membership-moderation-security.md` §3.1);
there is no `suspended` status (no suspension, 04 I6 removed). A `waiting`
account registers no sync client for writing (Y3) and reads through R5.
Account deletion (operator job, 04) deletes the provider identity
(`provider`, `provider_user_id`); the handle stays reserved, and the person
can sign in again as a new waiting identity.
Account invites and the tree are online-only tRPC (`accountInvites.*`,
`members.tree`), not replicated records; tree visibility is decided in 04
§3.3.

**C9. Visibility: open or private.** The mockup creates a channel as Open
("Anyone can read and join") or Private ("Only people you add can read or
post"); private channels are not listed to non-members (`allVisible`). The
schema has `vis: open | listed | unlisted` with `policy: request | invite` and
request questions. Change: the wire carries `vis: "open" | "private"`; private
means closed, unlisted and invite-only; `policy` and `qs` are dropped. A
private channel admits only through channel invite links; join requests and
request questions are not part of this build (C10; decision P4). The prototype's closed-space rules apply to private
channels unchanged.

**C10. Surfaces deferred.** The mockup has no pages, skills, space sources
library, source reports, FAQ topics, domains, archive, mutes, blocks, join
requests or inbox. Their procedures, collections and record kinds are left out
of `@session/mutators` v1 and moved to a `spaces.deferred.ts` section of the
shared schema, so that the mock keeps validating. The prototype's join-request
mutators stay in the acceptance suite because their stale-intent rules (U4)
are the tested form of `approve`, `decline` and `reopen`.

**C11. Owner-only About edit.** `chInfoDlg` offers Edit to the owner only, and
the editor (`chEditDlg`) changes only the description, at most 300
characters. The schema's `spaces.update` lets admins change every setting.
Change: `spaces.update` takes `{ id, desc }`, `who: "owner"`; name and
visibility are set at creation; no `base` is needed, because only one person
edits. Admin and moderator roles are removed (C18).

**C12. Remove with a free-text reason; the moderation log; no reporting.**
`rmDlg` takes an optional reason. A removal's reason is shown to readers on
the placeholder ("Removed by @x", "Reason: …"). There is no reporting at
all (05 §6 P6); the mockup's moderation log ("Moderation log") lists only
the owner's removals and bans. The schema's `reports.create` requires a
`why` category plus an optional `note`, and `moderation.decide` has no
reason. Change:
- `reports.create`, `reports.resolve`, the `report` record kind, the
  `report` and `report_resolved` notification types and the report rate
  limit are removed from `spaces.ts` (moved to `spaces.deferred.ts`, C10) and
  from replica-proto (U6).
- `moderation.decide { item, decision, note?, base? }`; the thread placeholder
  keeps `id`, `s`, its kind (ask or post), `u` (author), `createdAt`, `mod`,
  `modBy` and `modNote`, and nothing else of the removed content. `u` is
  served to the author only; every other reader gets `u: null` and the client
  prints "[deleted]" (product decision; the stored and served table is in
  04 §6.2). This is a change to replica-proto's `erase`/`redact` (U6).
- A `modlog` record kind in the space log, readable by the owner only: `{ id, sp,
  kind: "remove" | "ban" | "unban", item, by, author, note, at }`; for `ban`
  and `unban`, `item` is null and `author` names the banned person (04
  §6.5). The log lists the owner's removals and bans. Entries are pruned
  after 180 days (Y8).
- The removal of a thread also writes a `removed` notification to the
  author in the same transaction (C16; 04 O2), with the owner's note and no
  text of the removed item.
- Conflict: `modLogDlg` quotes the removed thread's question. AGENTS.md wins:
  removed content is erased and never served again, so the log shows the
  item's kind, author and channel, and no text of a removed item.

**C13. The layout toggle as a per-user preference.** `layoutBtn()` switches
between a centred main column and a wider one. ADR-20 keeps layout in
Zustand; the overview lists the toggle as an app bar feature without saying
where it persists. Change: a `prefs` record in the user log (`{ layout:
"centred" | "wide" }`, `prefs.set`), so it follows the person to other
browsers and sessions; Zustand applies it. `user_preferences` (tRPC) is
not used for it because it would make an app bar control depend on being
online. This supersedes ADR-20's "layout stays in Zustand" for this one
preference: the persisted value is the `prefs` record, and Zustand holds only
the applied value for the first paint; ADR-20 gets a note.

**C14. Space ids.** The mockup and the schema use slug space ids (`public`,
`sp-<name>`). AGENTS.md wins: space ids are ULIDs and creating a space is
online-only. Names stay unique slugs (`[a-z0-9][a-z0-9-]{1,29}`, from
`createSpace`) and URLs use the name: a channel is `/c/<name>`, and a channel
invite link is `<SESSION_PUBLIC_ORIGIN>/c/<name>#<code>` (04 §5). The cost recorded in AGENTS.md (an
unlisted name can be probed through CONFLICT) applies to private channels.

**C15. Deleting a thread.** The mockup offers Delete only while nobody else
has responded (`moreMenu`). AGENTS.md keeps the server rule: a thread deleted
while it had replies stays as an empty shell. The client may hide Delete
under the mockup's condition; the server does not enforce it.

**C16. Notifications.** Posts, replies and comments notify mentioned
members (`notify` in the submit handler); the schema's notification types
have no mention. 05 §6 P10 sets the kinds; each is a `notification` record
in the recipient's user log, written in the same transaction as the write
that causes it: by the mutator's `notify` stage (U1), or by `serverApply`
(Y13) inside the account-invite procedure for the invite case. Notifications
are exactly once because they commit with the write; there is no effect
queue (S4 removed). Each carries ids and no item text and is served only
while the recipient can read the item (AGENTS.md "User logs follow current
access"). Nobody is notified of their own action.

| `type` | Written when | To | Payload |
|---|---|---|---|
| `mention` | a post, reply or comment mentions `@handle` | the mentioned member, if they can read the item when the write commits | `sp`, `th`, item key, actor |
| `reply` | a reply to a post (`research.createPostFollowUp`) | the post's author | `sp`, `th`, reply id, actor |
| `branch` | `research.forkNode` (an ask or look-up) under a node | the author of the parent node | `sp`, `th`, node id, actor |
| `comment` | `comments.create` on a node | the author of that node | `sp`, `th`, comment id, actor |
| `removed` | `moderation.decide { decision: "removed" }` on a thread | the thread's author | `sp`, `th`, `modNote`; no thread text |
| `invite_used` | an account invite is redeemed (`account.create`, `accountInvites.redeem`, 04 I4) | the invite's creator | the new member's handle |

`reply`, `branch` and `comment` notifications coalesce: at most one unread
notification per (recipient, type, thread), with a count. The `removed`
notification survives the erasure of the thread (it holds no text), while
mention notifications about the removed thread are erased with it (04 §6.2).
Only a thread's removal notifies (04 O2). There are no report
notifications (C12). The client lists notifications on a notifications page
reached from the account menu, and an unread dot on the account avatar
(`02-client-app.md` W2.6; decision P10). Acceptance: one mutator test per
row that finds the notification committed with the write, including "not
notified of one's own action" and the coalescing rule; a test that a
`removed` notification holds no thread text.

**C17. Runs streamed.** The mock API's note "Answers are not streamed" is
superseded by ADR-22; the `spaceRunSchema` record becomes the run record of
03 §1, with `model`, `effort` and an optional `note` (the stop note of
a run that ends `complete` early, such as "Stopped: this week's included
tokens ran out.", 03 E5). The run record with status `queued` is the run
queue; the dispatcher claims it with a compare-and-set (03 E2).

**C18. Channel roles: owner and member.** Product decision (00, "Decisions
recorded after review"): a channel has exactly one owner, ownership is not
transferable, and everyone else is a member; there are no admins,
moderators or other staff. The mockup agrees (`isMod` is the owner only).
The schema defines four space roles and
replica-proto ranks them (`RANK = { member: 1, mod: 2, admin: 3, owner: 4 }`
in `src/access.ts`), lets a person act on members ranked below them
(`actsOn` in `src/mutators.ts`) and changes roles with `members.setRole`
(`who: "admin"`, `base.rev`, STALE on a changed member record; giving
`owner` transfers ownership and makes the previous owner `admin`). Change,
in `web/packages/shared/src/schemas/spaces.ts`:
- `spaceMemberRoleSchema` becomes `z.enum(["member", "owner"])` and
  `spaceRoleSchema` (`/api/me/roles`, `roles0`) becomes
  `z.enum(["Owner", "Member"])`;
- the `members.setRole` procedure is removed;
- the space record's `mods` (`[handle, role][]`, "the owner, admins and
  moderators") is replaced by `owner: spaceHandleSchema`, written by
  `spaces.create` and never changed;
- `invite: "mods" | "members"` is removed from `spaceSchema`,
  `spaceSettingsSchema` and `createSpaceInputSchema`: only the owner makes
  channel invite links;
- `frozen: z.boolean().optional()` is added to the space record (04 §4.5);
- the header comment ("space roles (owner, admin, moderator, member)") and
  the comments that name admins or moderators (`spaceSettingsSchema`, the
  invite and decline-note comments) are updated.

In `@session/mutators`: `who` is `user`, `member`, `author` or `owner`.
`who: "owner"` covers `spaces.update` (C11), `moderation.decide`,
`members.remove`, `members.ban`, `members.unban`,
`invites.create`, `invites.revoke` and `invites.restore` (and the deferred
`joinRequests.decide`, which stays in the prototype suite, C10). `actsOn`
reduces to "the actor is the owner and the target is someone else". The
owner cannot leave (`spaces.leave` answers `PRECONDITION_FAILED`). Records
that replica-proto serves to staff (`modlog`, `ban`, `invite` link records,
hidden text) are served to the owner, and where they are today also to the
link's maker or the author; the `report` records and notifications are
removed (C12). Site admins (`users.is_admin`) get no channel rights from the role
model; the channel-level actions a site admin already has in this plan stay:
deleting a channel by operator job (04 §1) and deleting an account by
operator job, which freezes the channels it owned (04 B6, §4.5). There is
no suspension (04 I6 removed). `AGENTS.md` ("Stale intent:
`shown`, `approve`, reopen and `setRole` carry `base.rev`", and the two
lines that name "the space's moderators" for hidden text and "a moderator"
for removal) is updated in the same change as C18; this plan does not edit
it. The replica-proto impact is listed in U6.

## 8. Dependencies

```
U6 (update replica-proto) ─► U1-U5 (@session/mutators)
D1-D3 ─► Y3-Y6, Y13 (server half) ─► A1 (HTTP) ─► Y7 (SSE)
U1-U5 ─► Y9-Y12 (client half)
S1-S3 ─► A1
Y13 ─► the runs of 03 (E1, E2) and the invite_used notification (C16)
D6 needs Y6 (epoch in cursors) and the restore runbook change
R1-R5 need Y5 and C7
C1-C18 land in spaces.ts and replica-proto before U5
U1 (the notify stage) and Y4 before C16
```

The shared-schema changes (section 7) come first because the mutators, the
prototype and the mockup's validator test (`test/spacesMock.test.ts`) all read
them.

## 9. Open questions

1. **Record table or typed tables.** Decided (E3): one `records` table with
   JSON bodies (D1). Where feed queries (C7, R5) need indexes on fields
   inside `body`, generated columns are added per field; threads and nodes
   get no typed tables.
2. **Who sees save counts.** Decided (S6): in a private channel a count
   below 3 is neither served nor shown, because with few members a count of
   1 can identify the saver. The counts record stores the served value (0
   until the true count reaches 3), and the true count is kept in a
   non-replicated server column, so a hidden save writes no change-log row
   (C1, D3). Open channels serve every count.
3. **Erasure and backups.** Decided: no retention requirement. D4 erases
   from the live file; Litestream generations and the nightly archive may keep
   removed text for as long as they are retained, and the retention period is
   set for recovery, not for erasure. A restore must still repeat the
   removals applied after its restore point (05 §3.3).
4. **Restore marker.** Decided (E6): a boot-time check of the Litestream
   generation id (D6), not a runbook-written marker.
5. **Admin and moderator roles.** Decided: channels have only an owner and
   members; admin and moderator roles, `members.setRole` and ownership
   transfer are removed from the contract and the prototype (C18, U6).
6. **Join requests.** Decided (P4): a private channel admits only through
   channel invite links (C9).
7. **Snapshot cost on the web.** Decided (E7): the web window of R1 (30 days
   or the newest 100 threads, capped at 500 per space). Untiered pulls (R2)
   still cost in busy spaces; M3's load check measures both.
