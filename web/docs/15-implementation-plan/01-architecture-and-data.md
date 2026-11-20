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
request id, protocol version check, authentication (cookie or bearer device
token), CORS for the desktop origin, rate limit, handler.
Acceptance: a request without the `Session-Protocol` header, or below
`SESSION_MIN_PROTOCOL`, answers `426` with `{ code: "UPGRADE_REQUIRED" }` and
the client shows "Update Session"; a test covers each of the four
middleware refusals.

**S2. Desktop authentication.** A bearer device token (random 256-bit value,
stored hashed in `device_tokens`, held in the macOS Keychain by the desktop)
authenticates `/api/sync/*`, `/api/runs/*` and the tRPC account procedures.
Issued by a signed-in web session through a one-time pairing code; revocable
from the account menu. Cookie sessions (ADR-5) continue for the web client.
The CORS allowlist admits only the desktop origin (`tauri://localhost` and the
dev origin in development); the web client is same-origin and needs none.
Acceptance: a token from a revoked device answers `401`; a request from an
origin outside the allowlist gets no CORS headers; CSRF rules of
`03-api-and-events.md` §1 still apply to cookie requests.

**S3. Configuration.** New settings in `web/packages/server/src/config.ts`,
validated at boot like the existing ones: `SESSION_MIN_PROTOCOL`,
`SESSION_CURSOR_KEY`, `SESSION_CURSOR_KEY_PREVIOUS` (accepted 30 days after a
rotation, then removed), `SESSION_SECRET_KEY` (API key encryption, see 03),
`SESSION_DEVICE_ANSWER_MAX_BYTES` (200 KB), `SESSION_DEVICE_RUNS_PER_HOUR`
(100), `SESSION_WEEKLY_TOKENS`. Acceptance: boot refuses a cursor key that is
not 32 bytes of base64, and `web/.env.example` documents every new variable.

**S4. Effect worker.** A loop in the server process that takes rows from
`effects` (D3) in `next_at` order, runs them (notifications, run jobs, key
checks), and on failure backs off 1 s, 2 s, 4 s up to 10 minutes, moving the
row to the dead-letter state after 10 attempts (the constants in
`replica-proto/src/server.ts`). Effects carry ids, never text. Acceptance: the
replica-proto effect model tests (`test/effect-model.ts`) pass against it; a
dead-lettered effect is visible in `/api/admin` metrics.

**S5. Drain and boot.** On `SIGTERM`: stop accepting writes (answer
`SERVICE_UNAVAILABLE`, unrecorded, so outboxes retry), finish the open
transaction, close SSE streams, then run the existing run drain
(`05-run-lifecycle-and-streaming.md` §7). On boot: migrate, compare the log
epoch marker (D6) with the restore marker, then start the effect worker and
the run dispatcher. Acceptance: a deploy during an outbox flush loses no
write and applies none twice (covered by the idempotency tests, Y8).

## 2. Database

The database keeps `users`, `sessions`, `oauth_states`, `invites`,
`signup_attempts`, `user_limits`, `usage_events`, `user_preferences` and
`backfills` from `web/packages/db/src/schema/`. The research tables (`trees`,
`nodes`, `run_turns`, `run_attempts`, `node_messages`, `node_summaries`,
`response_snapshots`, `tree_*`, `folders`, `workspaces`, `highlights`,
`feed_items`, `research_drafts`, `interface_drafts`, `widget_*`,
`research_images`, `image_refs`, `notifications`, `followup_queue`,
`run_queue`, `collapsed_*`) are dropped: `AGENTS.md` says existing web data is
dropped at the cutover.

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
Acceptance: every write goes through the store's `put`/`create`/`del`; a
property test writes random records and reads them back equal; a migration
test confirms the indexes exist.

Typed per-kind tables were considered. They give column types and simpler ad
hoc queries, but every new kind then needs its own log, tombstone and erasure
code. The single table keeps those generic; record shape changes are handled
by D7.

**D2. Sync bookkeeping tables.**

- `change_log(log, version, key, op)`: `log` is `space:<id>` or `user:<id>`;
  `op` is `put` or `del`; rows hold no record content (AGENTS.md). PK
  `(log, version, key)`.
- `log_versions(log, version, epoch, epoch_start)`: the head of each log.
- `id_registry(id, kind, last_rev)`: every id ever used; ids are never reused.
- `tombstones(key, kind, sp, th, u, rev, deleted_at)`: audience fields and rev
  only, no text; pruned after 30 days.
- `clients(client_id, user_id, last_seq, created_at, last_used_at)`: expires
  after 90 days idle; at most 20 registrations per user per day.
- `mutations(user_id, mutation_id, answer_json, created_at)`: recorded answers
  for idempotency, kept 7 days; a reminted envelope stores the same answer
  under every mutation id it replaces, in the same commit.
- `effects(id, type, payload_json, attempts, next_at, state)`: ids only.

Acceptance: a commit writes the record rows, the log rows, the registry, the
recorded answer, the client's `last_seq` and the queued effects in one
transaction (AGENTS.md), proved by a test that kills the process between
statements with a failing `effects` insert and finds nothing written.

**D3. Non-replicated server tables.** `device_tokens`, `api_keys` (encrypted
value, provider, mask, status, last used), `run_leases` (device runs: run id,
attempt, device id, lease expiry, last heartbeat), `run_live` (in-flight
checkpoint text per run and attempt, deleted at finish), `usage_events`
(extended in 03), `account_invites` (C8). Acceptance: none of these appear in
any `snapshot` or `pull` (a test scans every served record kind).

**D4. Erasure at rest.** Set `PRAGMA secure_delete = ON` so deleted rows are
overwritten in the file, and run `erase` paths as deletes of the affected
`records` rows plus tombstones. Acceptance: the replica-proto storage scan
(`scanStorage`, `inv6-removed-content.test.ts`) is ported to scan the SQLite
file's bytes for a removed thread's marker text after a removal and finds
none. Litestream generations still hold the text until their retention
expires; see open question 3.

### 2.2 Migrations

**D5. Migration sequence.** Following `02-domain-model-and-database.md` §4:
`0001_spaces.sql` adds D1-D3; `0002_drop_research.sql` drops the research
tables once the new client has replaced the old one in production. Because
existing web data is dropped, a database reset (`runbooks/reset-database.md`)
is an acceptable alternative to `0002`; the choice is recorded in
`05-delivery.md`. Acceptance: `db:generate` produces no diff in CI;
`migrations.test.ts` opens a fresh database and a database at `0000` and
migrates both.

**D6. Log epochs and restores.** Each log's epoch increments when its history
is replaced: a space that becomes closed (prototype test "a space that becomes
closed resyncs every reader"), a tombstone horizon passed, or a restore from
Litestream. A restore is detected at boot by a `restore_marker` row that the
restore runbook writes; on a mismatch every log's epoch is incremented, so
every cursor issued before the restore resyncs instead of pulling from a
version the restored database has reused. Acceptance: a test restores an
older copy of the database file, boots, and finds that a pre-restore cursor
answers `resync`. `runbooks/restore.md` gets the marker step.

**D7. Record shape versions.** A record kind's stored shape changes through a
versioned backfill in `web/packages/db/src/backfills/` that rewrites `body`
and bumps `rev`, so that every replica pulls the new shape. Acceptance: one
backfill (C3's `kind` field on ask nodes) is written this way with a test.

## 3. `@session/mutators`

New package `web/packages/mutators` (name `@session/mutators`), depending only
on `@session/shared` and `zod`. It replaces the mock's procedures and
generalizes `replica-proto/src/mutators.ts`.

**M1. Definition shape.** Port `MutatorDef` from the prototype: `input` (the
shared zod schema, strict), `who`, `space`, `ids`, `online`, and three stages:

1. `pre(ctx, input)`: server only; may refuse; makes server values (invite
   codes, the payer of a run, limit checks). Never run on the client.
2. `run(tx, input, values)`: deterministic over a synchronous `tx`. Reads
   `tx.now`, never a clock, random source, `Intl` or `Date` formatting. Makes
   no ids: the first id is in the input, later ones come from
   `tx.id(ordinal)`, derived from the mutation id.
3. `post(input, result)`: post-commit effects (ids only).

Acceptance: the prototype test "mutators read no clock, no random source and
no Intl while the server applies them" runs over every mutator in the
package; an ESLint rule bans `Date`, `Math.random`, `crypto` and `Intl`
under `src/run/`.

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
`replies`, `saves`, `moderation`, `invites`, `prefs`, `runs` (cancel, retry).
The set is the mock's procedures minus the surfaces C10 defers, with the
changes in section 7. Acceptance: a table test lists every mutator with its
`who`, its stale-intent rule and whether it is `online`; space creation is
`online: true` (AGENTS.md).

**M6. Update the acceptance suite first.** The replica-proto suite exercises
`likes.set` (56 call sites), space rules and `rulesAccepted`, which section 7
removes. Before porting, change `replica-proto` itself to the revised
contract: replace `likes.set` with counted saves, drop rules, add the comment
and ask-node kinds, then rerun `npm test` and `npm run mutate` and record that
no mutation survives. Keeping the prototype as the single acceptance suite is
cheaper than maintaining a diverging copy. Acceptance: `npm run mutate` exits
0 on the updated prototype.

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
envelope supersedes. Envelopes over 256 KB answer `TOO_LARGE`, unrecorded.
Acceptance: the prototype's envelope tests (extra fields refused, unknown
names refused, depth 32 and size limits) pass.

**Y2. Answers.** Every answer carries `serverTime`. Recorded: applied results,
refusals (`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `STALE`, `EXPIRED`,
`BAD_REQUEST`, …). Not recorded: `TOO_MANY_REQUESTS`,
`SERVICE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`, `CLOCK_SKEW` (carries
`serverTime`), `OUT_OF_ORDER` (carries `expectedSeq`), `WRONG_CLIENT`,
`UPGRADE_REQUIRED`, `TOO_LARGE`. Acceptance: `inv5-idempotency-per-user`
passes.

### 4.2 Server half

**Y3. `register`.** Issues a client id bound to the caller. Acceptance: a
client id used by another user answers `WRONG_CLIENT`.

**Y4. `apply`.** For each envelope: validate; check `seq === last_seq + 1`;
look up `(user, mutationId)` and return a recorded answer if present; check
ages (mutation id and new ids from 4 days old to 1 minute ahead on the device
clock, `queuedAt` likewise, online-only writes at most 1 minute old); run
`pre`; open the transaction; `authorize` (ban check, `who`, `can`); `run`;
commit records, log rows, registry, answer, `last_seq` and effects. ID
collisions answer the same `CONFLICT` whether or not the caller can read the
holder. Acceptance: `inv1`, `inv2`, `inv4`, `inv5` and the convergence suite
pass with the SQLite store.

**Y5. `snapshot(log, tier)` and `pull(log, cursor)`.** Read records as they
are now, filtered by the reader's scope at read time (`replica-proto/src/access.ts`).
`pull` returns the keys changed after the cursor's version, each as the
current record or a `del` (tombstone, or a record the reader may no longer
read), plus `lastSeq` for the reading client. A cursor older than the
tombstone horizon, of another reader, log, epoch or server key answers
`resync`. Acceptance: `inv3-scoped-reads` (including "a signed-out caller can
tell neither how many writes happened nor when") and `inv7-replica-per-user`
pass.

**Y6. Cursor tokens.** AES-256-GCM over `{ log, reader, version, servedAt,
epoch }` with `SESSION_CURSOR_KEY`; the previous key is accepted for 30 days.
Token length does not vary with the version. Acceptance: the prototype's
cursor tests ("a forged cursor resyncs", "a token of another reader…") pass,
plus a key-rotation test.

**Y7. SSE.** `GET /api/sync/events` streams `text/event-stream`, read by the
client with `fetch` (so it can send the bearer token and protocol header; an
`EventSource` cannot). Each `changes` event carries pull batches for one or
more logs; its event id is an encrypted map `{ log: cursorToken }`, so a
reconnect with `Last-Event-ID` resumes every log. Run deltas travel on the
same stream as ephemeral events without ids (ADR-22; 03 §5). After a commit
the server wakes subscribers of the affected logs and runs each
subscriber's pull under that subscriber's own scope, coalesced to at most one
batch per 100 ms per connection. A connection whose queue exceeds 2,048
events is closed, as in `server/src/events/bus.ts`. Acceptance: two readers
with different scopes on one space receive different batches for the same
commit; a reconnect with the last event id loses no change.

**Y8. Retention jobs.** Hourly: prune tombstones over 30 days, recorded
answers over 7 days, clients idle 90 days. Acceptance: tests with an injected
clock.

### 4.3 Client half

**Y9. Replica and storage adapter.** The replica keeps a working set in
memory; a `StorageAdapter` loads and persists it (SQLite on the desktop
through Tauri, in-memory on the web, a React Native SQLite binding on the
Phone). Acceptance: the same client test suite runs against the memory
adapter and a SQLite adapter.

**Y10. Outbox.** One global order across logs. Desktop keeps writes 3 days in
server time; the web client holds a write only while its request is in flight
(AGENTS.md, ADR-20). Transient answers pause the outbox with backoff (1 s to
10 minutes); a write that fails 5 times is shown to the person and the rest of
the outbox continues; a write dropped at 3 days is reported. Acceptance: the
prototype client tests for backoff, failure and drop pass.

**Y11. Rebase.** Confirmed changes are applied to the confirmed state, then
pending writes are re-run on top with their mutators. A pending write whose
prediction read `unknown` is shown as pending without a predicted effect.
Acceptance: the convergence suite's replicas equal the server projection
after every interleaving it generates.

**Y12. Reactive queries.** `useQuery(selector)` for React and React Native,
re-evaluated when keys the selector read change. Acceptance: a component test
re-renders once per confirming batch, not once per record.

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
snapshot request, filtered by scope like everything else. Opens stay on the
device; the server does not record them. Acceptance: a snapshot test checks
each of the four inclusion rules and the 5,000 cap.

**R3. Promotion.** Opening a summary-tier thread fetches its full records
through `snapshot(log, { threads: [id] })` and keeps them for 14 days.
Acceptance: an offline desktop opening a summary-tier thread shows the
summary and an "available when online" state.

**R4. Closed spaces.** A device replicates the closed spaces its user belongs
to and nothing else of any closed space (AGENTS.md). A removed member's
device keeps a frozen copy and may still delete their own threads there
(prototype test). Acceptance: `inv7` and the frozen-copy test pass.

**R5. Open spaces the user has not joined.** The "All" scope (C7) lists open
channels the user has not joined. Their threads are read with a summary-tier
snapshot into an ephemeral, unpersisted replica that is dropped when the user
leaves the channel view. Joining converts it to a replicated log. Acceptance:
browsing ten unjoined channels on the desktop writes nothing to the local
database.

## 6. API surface

Replicated data uses only the sync routes. Online-only account calls stay tRPC
procedures (ADR-19). Run execution by devices has its own routes (03 §4).

| Route | Kind | Purpose |
|---|---|---|
| `POST /api/sync/register` | sync | client id |
| `POST /api/sync/apply` | sync | a batch of envelopes, answered in order |
| `GET /api/sync/snapshot?log&tier&threads` | sync | records now, scope-filtered |
| `GET /api/sync/pull?log&cursor` | sync | changes since a cursor |
| `GET /api/sync/events` | SSE via fetch | pull batches and run deltas |
| `POST /api/runs/claim`, `/heartbeat`, `/turn`, `/finish` | device runs | ADR-21; 03 §4 |
| `GET /api/runs/:id/live` | read | in-flight checkpoint of a run after a gap (ADR-22) |
| tRPC `account.*`, `devices.*` | online | profile, settings, device pairing and revocation |
| tRPC `apiKeys.*`, `usage.*` | online | keys, allowance, recent runs (03 §6) |
| tRPC `accountInvites.*`, `members.tree` | online | Session invites and the invite tree (C8) |
| tRPC `spaces.directory` | online | the "All" list of open channels (C7) |
| `GET /healthz`, `/auth/*` | Hono | unchanged |

**A1.** Implement the sync routes over `@session/sync/server` (S1, Y3-Y7).
Acceptance: the replica-proto `ServerFactory` is implemented by an HTTP
adapter, and the whole suite passes over HTTP against a temp SQLite file.

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
becomes `{ th, s, saves, r }`; `saved.set` (thread only) writes the save
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
`researchNodeSchema` has neither; `forkNodeInputSchema` takes `parent`, `q`,
`uses`. Change: ask nodes get `kind: "ask" | "lookup"`, optional `quote`
(at most 2,000 characters) and, for look-ups, `look` (1-4 words, at most 80
characters). Look-up input carries `look` and no `q`; the mutator builds the
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
community rules" refers to Session-wide rules, not channel rules (04).

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
`users.invited_by` in `web/packages/db/src/schema/users.ts`: add
`revoked_at`, a ULID id, and drop `users.invites_remaining` in favour of the
3-open-links rule checked in the `pre` stage. The user record gains
`status: "waiting" | "active"`. The invite tree is served by `members.tree`
(online-only). Whether the whole tree is visible to every member is a privacy
decision for 04.

**C9. Visibility: open or private.** The mockup creates a channel as Open
("Anyone can read and join") or Private ("Only people you add can read or
post"); private channels are not listed to non-members (`allVisible`). The
schema has `vis: open | listed | unlisted` with `policy: request | invite` and
request questions. Change: the wire carries `vis: "open" | "private"`; private
means closed, unlisted and invite-only. Join requests and request questions
are deferred (C10). The prototype's closed-space rules apply to private
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
  kind: "report" | "remove" | "dismiss", item, by, author, note, at }`.
  `reports.resolve` with `dismissed` writes a `dismiss` entry; a removal
  closes the item's open reports.
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
D1-D3 ─► Y3-Y6 (server half) ─► A1 (HTTP) ─► Y7 (SSE)
M1-M5 ─► Y9-Y12 (client half)
S1-S3 ─► A1
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
   desktop?
