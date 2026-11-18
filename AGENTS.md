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
  replaced by spaces; existing web data is dropped.
- Architecture: the server is the single authority. Each client keeps a
  replica of what its user may read and applies its own writes optimistically
  from an outbox; the server confirms or refuses them in order. No CRDT
  replication of spaces. A device replicates the closed spaces its user
  belongs to, and nothing else of any closed space.
- Phase 0, before the API is fixed: an adversarial client suite against a
  prototype of the server's apply and pull must show these invariants hold:
  the server applies mutator inputs and never accepts client state;
  permissions are checked at apply time; every pull is filtered by the
  reader's current scope; the server owns uniqueness, stored times and
  server-made values; idempotency is scoped per user; removed content is never
  served again; a replica on disk belongs to one user.
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
    kept for 3 days, stopping only on transient errors; rebase; a cursor per
    log; reactive queries for React and React Native screens; replication
    tiers) and server half (one change-log table, one log per space and one
    per user, rows holding key, operation and version only; `snapshot` and
    `pull` that read records as they are now, filtered by read scope;
    tombstones kept 30 days; the client's last applied mutation id returned
    with every batch; idempotent apply by (user, mutation id), kept 7 days;
    a log epoch id; SSE read with fetch, with a cursor map as the event id).
- Ids: clients generate ULIDs. The server accepts a timestamp from 3 days in
  the past to 1 minute in the future, rejects an id that already exists, and
  answers a collision with the same CONFLICT whether or not the caller can
  read the existing record. Space ids are ULIDs, and creating a space is
  online-only.
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
  allowlist admits the desktop origin only. ADR-3, ADR-6, ADR-10 and ADR-11
  are to be superseded by new ADRs before phase 1.
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
  and 100 device runs per hour per user (server settings).
- Cutover: hard. No desktop research is imported and no desktop node features
  (documents, highlights, anchored branches, folders) carry over.
