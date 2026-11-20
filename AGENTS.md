This is Session, a research workspace for long-running agent investigations.
Product copy, Rust packages, CLI commands, storage paths, configuration files,
persisted formats, generated integrations, and internal event names use
Session/session/SESSION_*.

For commit messages, include a short description followed by a
paragraph or bullet-point list of details about what was committed.
Use multiple -m arguments instead of \n to break lines in commits.
Don't ask to re-run 'cargo test' if there is a test that fails because
of your sandboxing permissions, unless your work involves that test.

The Swift package in src-tauri/swift-native-support contains only AppKit/WebKit
support. Its SessionNativeSupport archive and session_native_* C ABI names are
current native identities; do not reintroduce a terminal renderer dependency.
Keep research process infrastructure intact.

The desktop app imports the research wire model and pure research logic from
web/packages/shared/src through the @session/shared/* alias (tsconfig.json
paths, vite.config.ts resolve.alias). wire/ holds the types that src/types.ts
re-exports; lib/ holds modules moved from src/lib under their desktop names;
markdown/mathDelimiters, markdown/wikilinks, markdown/sessionWidgets,
app/taggedInstructions, research/snapshots and util/tokenEstimate are shared
with the web unchanged. Their tests stay in tests/. Modules the desktop imports
must not use the DOM or import packages the desktop lacks, and must pass the
web checks (cd web && npm run check). See web/docs/01-architecture-decisions.md,
ADR-1.

## Planned: desktop client and sync core (not built yet)

The current Tauri app is to be replaced by a new desktop client backed by
shared spaces on the web server. Until the cutover, the current app and the
rules above stay as they are. Decisions for the new client:

- Contract: the spaces API in docs/mockups/session-web-spaces*.{html,js} and
  web/packages/shared/src/schemas/spaces.ts (types: `import type { Spaces }
  from "@session/shared"`). The mock backend's procedures are the first draft
  of the write definitions. The current web client's trees and workspaces are
  replaced by spaces; existing web data is dropped. The web client's
  features that the mockup does not have (journal and tweet embeds, widgets
  and artifacts, highlights, folders, recaps) are dropped too.
- Architecture: the server is the single authority. Each client keeps a
  replica of what its user may read and applies its own writes optimistically
  from an outbox; the server confirms or refuses them in order. No CRDT
  replication of spaces. A device replicates the closed spaces its user
  belongs to, and nothing else of any closed space.
- Phase 0 (done): `web/packages/replica-proto` is a prototype server half
  with an adversarial suite, a read oracle, a write oracle, an effect model
  and a mutation suite (`npm run mutate`, about 50 minutes: run it in
  full once at the end of a phase or review round; while working, run only
  the mutations for changed files, and `npm test` after each change). It is the acceptance suite the
  real server half must pass, and nothing in the app imports it. Invariants:
  the server applies mutator inputs and never accepts client state;
  permissions are checked at apply time; every read is filtered by the
  reader's current scope; the server owns uniqueness, stored times and
  server-made values; idempotency is scoped per user; removed content is
  erased and never served again; a replica belongs to one user.
- Rules added by the phase 0 reviews:
  - Stale intent: `shown`, `approve`, reopen and `setRole` carry `base.rev`
    of their target and answer STALE when it differs; `hidden`, `removed`,
    `decline` and `members.ban` apply to the record as it is;
    `members.remove` compares the member's admission id. Like and follow-up
    counts live in a counts record, not on the thread.
  - A ban stops every write in its space, the author's own included.
  - Hidden text is served to its author and the space's moderators only.
    An ask's `model` and `skill` count as its text (review round 2 of
    phase 1): `model` is a model id and `skill` a skill of the space by
    id, never free text, and both are blanked with the ask (its runs'
    `model` too) when hidden, removed or deleted.
    Removing a thread erases it and everything under it from storage. Hiding
    a thread blanks only that thread's text. A thread its author deleted
    while it had replies stays as an empty shell, as in the mock, and the
    author may still delete a thread a moderator removed.
  - A removed member of a closed space keeps a frozen copy on the device;
    the server serves them nothing of that space, but they can still delete
    their own threads there. A voluntary leave keeps no frozen copy: an
    `exit` record in the user log (`ended`: `left` or `removed`) tells
    every device of the person how the membership ended.
  - User logs follow current access: likes, saves, reports, source reports
    and notifications are served only while the person may read their
    space, report notifications only while they are staff; requests stay
    with their person.
  - No version reaches a client: cursors and SSE ids are encrypted tokens
    (AEAD) holding log, reader, version, serve time, epoch and the
    database's instance id. An SSE stream pokes once for a token that does
    not open and drops that log.
  - Tombstones keep key, kind, audience fields and rev, no text. The id
    registry keeps every id with its last rev; ids are never reused.
  - Writes carry a registered client id and a per-client seq assigned at
    send time; every answer that uses a seq is recorded; TOO_MANY_REQUESTS,
    SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR and CLOCK_SKEW are not. A sent
    write keeps its mutation id. Envelopes carry the device's time; an id
    more than 4 days old on the device's clock answers EXPIRED (recorded).
    A write that fails 5 times is shown to the person and the rest of the
    outbox continues; a write dropped at 3 days is reported. Envelopes also
    carry `queuedAt`, which the server checks like an id's age, and every
    answer carries `serverTime`. A reminted envelope lists the mutation ids
    it replaces, and the server stores its answer under each of them in the
    same commit, so a delayed copy of the old envelope cannot apply twice.
    An oversized envelope answers TOO_LARGE, unrecorded. `base` is optional
    on decisions that do not compare it.
  - Decided in review round 1 of phase 1 (client): a write that was ever
    sent keeps its input ids; after CLOCK_SKEW only unsent writes get new
    ids, and a sent write whose ids are ahead of the corrected clock waits
    for them (at most 10 minutes). When a replayed answer names other ids
    than the input, the client moves the write and the writes after it to
    the server's ids. `replaces` lists only ids whose outcome is unknown,
    never one with a recorded refusal: Send again after EXPIRED or a
    dropped write is a new write. The outbox and its remints are stored
    before each send. The 3-day drop counts from the server's time of an
    answer this session plus a monotonic clock. Reads answer
    `{ok: false, error}` (UNAUTHORIZED, UPDATE_REQUIRED) and never replace
    a log. Client storage is per person: a stored state that names another
    person, or none, is cleared. Online calls (`spaces.create`, `runs.*`,
    `devices.*` and the other `NOT_MUTATORS`) are sent directly, never
    queued or stored.
  - Decided in review round 2 of phase 1 (client): the first answer of a
    process sets the clock offset; a mutation id is made again only when
    the server's window would refuse it, and the ids it derives are mapped
    in the writes after it (a replay names the id it was recorded under,
    `recordedAs`). A write on the wire when the process ended is uncertain;
    CONFLICT on its own input id (the server's answer in place of EXPIRED
    when an input id exists) reads as applied, and EXPIRED as never
    applied. No response at all is not a try: the outbox
    pauses with backoff and the 3-day drop ends the write. A read carries
    the client id; one made as nobody (`lastSeq: null`) signs out and
    changes no log. A held write is sent by the next process. What a
    replica holds under a thread a pull marks as a summary is dropped.
    Client SQLite writes go through one driver `batch` (a transaction).
  - The web client runs the sync core with `persist: false`: no outbox
    across time, a transient failure shows Try again on its item, and
    nothing survives a reload. The desktop and phone apps keep the
    outbox.
  - The cursor token key is configured, not per process; the previous key
    is accepted for 30 days after a rotation.
  - In open spaces a removal is undone by joining again, and is STALE once
    the person has rejoined; the UI offers Remove and Ban.
  - Record changes, the stored answer, the seq and queued effects commit
    together; effects run from a worker with backoff and a dead-letter
    state, and carry ids, not text. A job starts after the worker's
    commit, at least once. Housekeeping commits in its own transaction and
    also runs on a timer.
  - Space names are unique across all spaces, so an unlisted space's name
    can be probed through CONFLICT. An invite link works again once its
    maker regains the right to make links. A link a moderator revoked is
    restored only by someone with that role or a higher one.
- Two isolated packages, each with its own tests, are written next:
  - `@session/mutators`: shared mutator definitions run by the client
    (prediction) and the server (authority), in three stages: server-only
    pre-checks that may refuse (invite codes, limits), a deterministic `run`
    over a synchronous `tx`, and post-commit server effects (notifications,
    jobs). `run` never reads the clock (use `tx.now`), a random source or
    `Intl`/`Date` formatting, and never makes ids: the first id comes in the
    input, later ones derive from the mutation id and an ordinal. Versions
    are integer `rev`s. Mutators write the stored shape; counts are stored
    fields, and per-viewer fields (`liked`, `mine`) are computed on the
    client. A read the replica cannot answer returns `unknown` and stops
    prediction.
  - `@session/sync`: client half (replica behind a storage adapter, used only
    to load and persist behind a working set; outbox in one global order,
    kept for 3 days in server time, pausing with backoff on transient
    errors; rebase; a cursor token per
    log; reactive queries for React and React Native screens; replication
    tiers) and server half (one change-log table, one log per space and one
    per user, rows holding key, operation and version only; `snapshot` and
    `pull` that read records as they are now, filtered by read scope;
    tombstones kept 30 days; the client's last processed seq returned with
    every batch; idempotent apply by (user, mutation id), kept 7 days;
    a log epoch; SSE read with fetch, with a map of cursor tokens as the
    event id).
- Phase 1a (done): `web/packages/mutators` holds the mutators (`MUTATORS`)
  and lists the mock's online-only procedures with reasons (`NOT_MUTATORS`:
  API keys, settings, usage, `research.cancelNode`/`retryNode`, `runs.*`,
  `devices.*`). `test/mock.test.ts` keeps the mock and the mutators equal
  over a history of every procedure; `DIFFERENCES` lists the few rows where
  the mock must differ, each with a reason. Decisions from phase 1a:
  - Follow-up asks, `research.forkNode` and `followups.update` with `run`
    write a run with a derived id and a `job` effect, as `threads.create`.
  - API key records (id, name, provider, status, never the raw key) are in
    their person's user log, so the payer check is in `can`.
  - Skills and pages are addressed by id; a reorder sends the whole order
    with the list's rev (STALE when it changed); a taken page slug answers
    CONFLICT.
  - Catalog sources are in a public `catalog` log. A source waiting for
    review has one audience; its fields are redacted for readers who are
    neither staff nor the person who added it.
  - Promoting a branch copies only the actor's own follow-ups. Every report
    reopen carries `base`. A space's staff read its invite requests.
  - A replica treats ids it minted, and ids derived from its own unanswered
    mutation ids, as unused (`withOwnIds`); any other id it lacks is unknown.
  - Reply likes are counted in the counts record.
  - `members.remove` works in open and closed spaces (in an open space
    joining again undoes it); bans have no duration.
  - `runs.*` and `devices.*` are online calls: a run's lease (holder,
    expiry, attempt) and a device token exist only on the server. Leases
    last 90 s; an attempt that lost its lease ends `interrupted`; an answer
    over 200 KB ends `too_large`. Review round 1 of phase 1: a run's calls
    are checked at call time like a write in its space; a run whose person
    lost that, or whose device was revoked, ends (`access`); `runs.claim`
    serves the turns as the person reads them; an answer lands only on its
    ask's current attempt, and a later run of an ask cancels the earlier
    ones; a served run record has no lease, and its device only for its
    person; sign-ins are approved from a browser, and the device is made
    when the app takes its token. Review round 2 of phase 1: in-flight
    text goes only to readers of the run's thread or follow-up as stored
    (not hidden for them); an answer written to a hidden item, and a run
    again, count as an edit of it (`shown` with an older rev is STALE); an
    `access` end reads as `interrupted` to everyone but the run's person;
    run calls come from the device's token only, answer
    PRECONDITION_FAILED in an archived space, and archiving a space ends
    its device runs (`interrupted`); a turn is at most 64 KB and an online
    call's input 1 MB (TOO_LARGE); a run whose job is a dead letter ends;
    the approver may deny an approved sign-in until its token is taken; a
    revoked device's streams close.
  - Decided for phase 1b: device records (no token) are in their person's
    user log; moderation state is a separate record, so a hide does not
    change the item's rev; STALE answers carry `current` (redacted for the
    reader) and `changes`; skills are records of their own; invite
    notifications carry the link.
- The mockup's mock backend follows the mutators and serves the sync
  protocol (`POST /api/sync/register`, `POST /api/sync/write` with the
  envelope, recorded answers and the refusal codes), devices and device
  runs; its sync endpoints are the contract the real server follows.
- Sync-state UI (owner decisions; the mockup's default Variants are the
  choices, and its other options are kept only for comparison):
  - Outbox failures (retry, failed after 5, EXPIRED, dropped) and refused
    writes (STALE, FORBIDDEN) are shown as toasts; a STALE decision is not
    reapplied in place. Unsent changes open from a header badge with a
    popover. Offline is a bar on Desktop and a pill on the Phone app.
  - Update Session is a dialog.
  - A removed member's frozen copy is greyed with one short notice. Removal
    from a space and the loss of a role show no notice.
  - Device sign-in is approved in the browser with one click, then a toast.
    Devices lists device tokens only (not browsers), in the Phone app's
    Account page; the web has no Devices UI for now.
  - A device answer is labelled "<handle>'s desktop". After an interrupt,
    Run again is offered only on the device that ran it; the web offers
    "Run with included tokens".
  - Included tokens are one weekly allowance per person, from Monday
    00:00 UTC to the next Monday (`SESSION_INCLUDED_TOKENS`, with a
    per-person override an admin sets); there are no daily limits. API
    key limits stay monthly, and the Usage page's totals are this month's.
  - The remove dialog says "The user will not be notified." Bans are
    permanent, with Unban; Ban on the Phone app is deferred.
- Phase 2a (done): `web/packages/server` serves spaces from `@session/sync`
  over one SQLite database (drizzle's migration `0000_initial.sql`, then
  the package's own migrations on the same connection). Routes parse the
  request, authenticate and call the package; a rule lives in the package,
  never in a route.
  - Sync routes: `POST /api/sync/register`, `write`, `snapshot`, `pull` and
    `GET /api/sync/events`; online calls at `POST /api/rpc/<name>`; account
    reads at `/api/me*`, `/api/users` and `usage.listAsks`, in the mock's
    shapes. `POST /api/admin/reset-time` calls `SyncServer.resetTime()`.
  - A request authenticates with the session cookie (CSRF-guarded) or with
    `Authorization: Bearer <device token>` (no cookie, no CSRF check). CORS
    admits `SESSION_DESKTOP_ORIGINS` for bearer requests only.
  - `users.handle` (the lower-case login) is the sync actor's `u`.
  - Runs: a `job` effect queues the run in `run_queue`; the loop builds the
    context from the branch's exchanges and the stored turns, stores each
    committed turn as a `turn:<run>:<n>` record (its `body` redacted with
    its node, deleted with its run), and writes the answer and the run's
    end as server writes. In-flight text is an `event: run` frame on the
    sync stream, sent only to readers who read the run's node unredacted;
    a stream pulls only for commits its reader may read. The payer is the
    ask's `pay`, else the included tokens, else the asker's default API
    key; a key is stored encrypted and pays only for its own provider's
    models. A run interrupted by a restart resumes at most twice, after its
    stored turns, then ends `interrupted`.
  - Test-only routes (`/api/test/*`, `/mockups/*`) exist only with
    `SESSION_TEST_AUTH` outside production; `@session/server/test-server`
    starts the app over a temp database, and replica-proto runs its whole
    suite over HTTP (`npm run test:http`).
- Ids: clients generate ULIDs. The server accepts a timestamp from 4 days in
  the past to 1 minute in the future (the outbox keeps writes 3 days), rejects an id that already exists, and
  answers a collision with the same CONFLICT whether or not the caller can
  read the existing record. A write whose id or mutation id is out of the
  window answers CONFLICT in place of EXPIRED when an input id exists
  (review round 2 of phase 1): to the client that minted it, the write
  applied. Space ids are ULIDs, and creating a space is online-only.
- Replication: full records for the last 90 days or the newest 500 threads
  per space, whichever covers more, capped at 5,000, plus every thread the
  user wrote or saved and any thread opened in the past 14 days; summaries
  for every other readable thread (past 2 years only once a space passes
  5,000 threads). The Phone window is 30 days or 200 threads. The web client
  uses an in-memory adapter (no IndexedDB) and holds a write only while its
  request is in flight; the Phone app is React Native.
- Server: one SQLite database on one Fly machine. Requests carry a protocol
  version header, and clients below the minimum show "Update Session". The
  desktop authenticates with a bearer device token (Keychain); a CORS
  allowlist admits the desktop origin only. ADR-19 to ADR-22 in
  `web/docs/01-architecture-decisions.md` supersede ADR-3 (for spaces),
  ADR-6 and ADR-11, and amend ADR-10. Server time never goes back; after
  the machine's clock jumped ahead and was corrected, an operator calls
  `SyncServer.resetTime()` (phase 2 exposes it). Housekeeping faults are
  counted and passed to the server's `onError` hook.
- Desktop: macOS only, one client codebase with the web (the web client runs
  in Tauri). Device runs are a new run executor kind, a CLI process on the
  user's device: Claude Code or Codex (Grok is dropped). Included tokens are
  the default executor. Runs get an empty working directory; the CLIs keep
  their read-only tools for now (locking down local reads is deferred), and
  there are no local-file attachments. Leases use a heartbeat separate from
  progress, and `runs.turn`/`runs.finish` carry the attempt number. No CLI
  session resume: every run rebuilds context from the thread's stored turns.
  Device answers carry a light-text label in their meta line, report no
  usage, and count toward no limit; the server caps them at 200 KB per answer
  and 100 device runs per hour per user (server settings), counted from the
  server's record of starts, not from run records.
- Cutover: hard. No desktop research is imported and no desktop node features
  (documents, highlights, anchored branches, folders) carry over.
