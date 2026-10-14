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
