This is Session, a shared research workspace: members ask questions that an
agent researches and answers, branch from any passage of an answer, and post
to channels. Product copy, packages, CLI commands, storage paths,
configuration, persisted formats and internal event names use
Session/session/SESSION_*.

For commit messages, include a short description followed by a
paragraph or bullet-point list of details about what was committed.
Use multiple -m arguments instead of \n to break lines in commits.

The application is the web build in `web/` (npm workspaces). The build plan
is `web/docs/15-implementation-plan/` (00-overview.md first); the product
surface is `docs/mockups/session-web-members.html`. Run `cd web && npm run
check` and `npm test` before committing.

## Sync core

- Contract: `web/packages/shared/src/schemas/spaces.ts` (types: `import type
  { Spaces } from "@session/shared"`) as revised by the plan (`01` §7). Users
  see "channels"; code and wire keep `space`.
- Architecture: the server is the single authority. The web client keeps an
  in-memory replica of what its user may read, loaded by a snapshot on each
  page load, and applies its own writes optimistically; the server confirms
  or refuses them in order. No CRDT replication of spaces.
- Phase 0 (done): `web/packages/replica-proto` is a prototype server half
  with an adversarial suite, a read oracle, a write oracle, an effect model
  (its prediction of the records a write changes) and a mutation suite
  (`npm run mutate`). It is the acceptance suite the real server half must
  pass, and nothing in the app imports it. Invariants: the server applies
  mutator inputs and never accepts client state; permissions are checked at
  apply time; every read is filtered by the reader's current scope; the
  server owns uniqueness, stored times and server-made values; idempotency is
  scoped per user; removed content is erased and never served again; a
  replica belongs to one user.
- Rules added by the phase 0 reviews and the plan:
  - Stale intent: `shown` and reopen carry `base.rev` of their target and
    answer STALE when it differs; `hidden`, `removed` and `members.ban` apply
    to the record as it is; `members.remove` compares the member's admission
    id. Follow-up and save counts live in a counts record, not on the thread.
    There are no likes.
  - A channel has one owner; everyone else is a member. Only the owner
    removes threads, bans, removes members of a private channel, makes
    channel invite links and edits About. There is no reporting and no
    Session-wide suspension.
  - A ban stops every write in its space, the author's own included.
  - Hidden text is served to its author and the space's owner only.
    Removing a thread erases it and everything under it from storage. A
    thread its author deleted while it had replies stays as an empty shell,
    and the author may still delete a thread the owner removed.
  - User logs follow current access: saves and notifications are served only
    while the person may read their space.
  - No version reaches a client: cursors and SSE ids are encrypted tokens
    (AEAD) holding log, reader, version, serve time and epoch.
  - Tombstones keep key, kind, audience fields and rev, no text. The id
    registry keeps every id with its last rev; ids are never reused.
  - Writes carry a registered client id and a per-client seq assigned at
    send time; every answer that uses a seq is recorded; TOO_MANY_REQUESTS,
    SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR and CLOCK_SKEW are not. A sent
    write keeps its mutation id. Envelopes carry the device's time; an id
    more than 4 days old on the device's clock answers EXPIRED (recorded).
    Envelopes also carry `queuedAt`, which the server checks like an id's
    age, and every answer carries `serverTime`. A reminted envelope lists the
    mutation ids it replaces, and the server stores its answer under each of
    them in the same commit. An oversized envelope answers TOO_LARGE,
    unrecorded. `base` is optional on decisions that do not compare it.
  - A web tab keeps its client id across reloads (sessionStorage, guarded by
    a Web Lock); `register` re-attaches an existing id.
  - The cursor token key is configured, not per process; the previous key
    is accepted for 30 days after a rotation.
  - In open spaces a removal is STALE once the person leaves and joins
    again, by design; the UI offers ban as the tool there.
  - Record changes, the stored answer, the seq and the notifications a write
    causes commit together in one transaction. There is no queue of
    follow-up jobs: an ask's run is a `run` record in status `queued`, which
    the dispatcher claims with a compare-and-set; API keys are checked
    during the request that saves them.
  - Space names are unique across all spaces, so a private space's name can
    be probed through CONFLICT.
- Packages:
  - `@session/mutators`: shared mutator definitions run by the client
    (prediction) and the server (authority), in three stages: server-only
    pre-checks that may refuse (invite codes, limits, the payer of a run), a
    deterministic `run` over a synchronous `tx`, and a server-only `notify`
    stage inside the same transaction that writes notification records.
    `run` never reads the clock (use `tx.now`), a random source or
    `Intl`/`Date` formatting, and never makes ids: the first id comes in the
    input, later ones derive from the mutation id and an ordinal. Versions
    are integer `rev`s. Mutators write the stored shape; counts are stored
    fields, and per-viewer fields (`mine`) are computed on the client. A read
    the replica cannot answer returns `unknown` and stops prediction.
  - `@session/sync`: client half (in-memory replica; outbox in one global
    order that holds a write only while its request is in flight; rebase; a
    cursor token per log; reactive queries for React) and server half (one
    change-log table, one log per space and one per user, rows holding key,
    operation and version only; `snapshot` and `pull` that read records as
    they are now, filtered by read scope; tombstones kept 30 days; the
    client's last processed seq returned with every batch; idempotent apply
    by (user, mutation id), kept 7 days; a log epoch; SSE read with fetch,
    with a map of cursor tokens as the event id).
- Ids: clients generate ULIDs. The server accepts a timestamp from 4 days in
  the past to 1 minute in the future, rejects an id that already exists, and
  answers a collision with the same CONFLICT whether or not the caller can
  read the existing record. Space ids are ULIDs, and creating a space is
  online-only.
- Replication (web): full records for the last 30 days or the newest 100
  threads per space, capped at 500, plus threads the user wrote or saved in
  the past 90 days and threads opened in the tab; summaries for other
  readable threads of the past 2 years.
- Server: one SQLite database on one Fly machine. Requests carry a protocol
  version header; a client below the minimum reloads. Sign-in is GitHub or X
  OAuth with cookie sessions; no CORS headers. ADR-19 to ADR-22 in
  `web/docs/01-architecture-decisions.md` supersede ADR-3 (for spaces),
  ADR-6 and ADR-11, and amend ADR-10; where they assume a desktop client,
  phone client or device runs, those parts are out of scope.
- Runs: every run is owned by the server and paid with included tokens (2M a
  week per member) or the member's own API key. Usage is recorded while a
  provider call streams, so an interrupted or aborted call is still billed.
