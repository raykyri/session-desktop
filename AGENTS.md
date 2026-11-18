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
  of the write definitions.
- Architecture: the server is the single authority. Each client keeps a
  replica of what its user may read and applies its own writes optimistically
  from an outbox; the server confirms or refuses them in order. No CRDT
  replication of spaces.
- Two isolated packages, each with its own tests, are written first:
  - `@session/mutators`: shared mutator definitions `{ name, input, can, run }`
    over a `tx` interface, run by the client (prediction) and the server
    (authority). Mutators are deterministic: no clock (use `tx.now`), no
    random source, no id generation. Server-only work (notifying others,
    starting jobs, limits) is returned as effects the server runs.
  - `@session/sync`: client half (replica behind a storage adapter, outbox in
    one global order kept for 90 days, rebase, a cursor per log, re-sync of a
    space on a scope change, replication tiers) and server half (change logs
    as one table, one log per space and one per user; pull filtered by read
    scope; idempotent apply by client mutation id; SSE with Last-Event-ID).
- Ids: clients generate ULIDs; the server checks them.
- Replication: full records for the last 90 days or the newest 500 threads
  per space, whichever covers more, plus every thread the user wrote or saved
  and any thread opened in the past 14 days; summaries for every other
  readable thread. The
  web client uses an in-memory adapter (no IndexedDB); the Phone app is React
  Native.
- Server: one SQLite database on one Fly machine; requests carry a protocol
  version header, and clients below the minimum show "Update Session".
- Desktop: macOS only. The web client runs in Tauri. Device runs use the
  user's Claude Code or Codex login (Grok is dropped); included tokens are the
  default executor. Runs get an empty working directory and never read the
  user's folders; attachments are deferred. Device runs report no usage and
  count toward no limit; the server caps their results at 200 KB per answer
  and 100 device runs per hour per user (server settings).
- Cutover: hard. No desktop research is imported and no desktop node features
  (documents, highlights, anchored branches, folders) carry over.
