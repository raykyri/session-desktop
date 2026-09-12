# Dead-code cleanup and follow-up work

The initial pass used three Terra explorer agents to scan frontend reachability,
Rust call sites, and supporting scripts/assets. Removals were checked against
repository references and compiler diagnostics. The follow-up added permanent
checks and removed the additional orphan composer tree they identified.

## Removed

- Unreferenced notification-journal, prompt-library menu, and legacy composer
  components and their supporting helpers. Exclusive notification/artifact menu
  styles and tests were removed; live notification toasts and transcript artifact
  handling remain connected.
- Unused application callbacks, renderers, derived data, and state for old Home
  rails, pane-tab dragging, split controls, launcher options, and artifact actions.
- Frontend artifact/notification-history mirrors, unused prompt-palette loading,
  and unread shell-job/global-draft hydration and event updates. Per-agent queues,
  drafts, and terminal attachment sequencing remain supported.
- Uncalled frontend API wrappers, utility exports, and private helper cascades.
- Rust `PermissionAction` metadata, three uncalled Claude test shims, unused
  Cursor/Muse binding sweeps, and the dormant full-session respawn path. Explicit
  closed-pane restoration remains supported.

Backend command registration, persisted formats, notification/artifact storage,
Apple, hosted-service, and native compatibility identifiers, platform-specific code, vendor patches, examples,
and design mockups were retained. A missing frontend caller alone does not establish
that a registered backend command or persisted field can safely be removed.

## Implemented follow-ups

- **One release preflight:** `npm run preflight` runs strict frontend/server types,
  module reachability, Rust formatting, and the complete test suite. The release
  script now calls it instead of a nonexistent pane-split test command. Unit and
  server test discovery include every `*.test.ts` file in their directories.
- **Unused-code checks:** TypeScript's `noUnusedLocals` and `noUnusedParameters` are
  enabled. `check:unused` walks the desktop, website, and test
  entrypoints, including static/type imports, re-exports, literal dynamic imports,
  and import types. Tests cover disconnected cycles and independent entrypoints.
  Tests are deliberate roots; a tested helper is not automatically retired because
  the current UI no longer imports it. Unused exports inside reachable modules
  remain outside this check's scope.
- **Consistent JSX execution:** test commands and website development share
  `tsconfig.runtime.json`. The website no longer needs an otherwise unused React
  import to compensate for a different test transform.
- **Focused feature ownership:** research navigation preferences/history and live
  notification state now belong to dedicated hooks. The event hook's unused
  shell-job/draft/artifact/history handlers were removed. Research activation
  callbacks no longer accept ignored terminal-mode arguments.
- **Behavioral settings coverage:** the completion-sound control is a separate
  component. Tests verify saving before preview and previewing without changing
  the selection, replacing the stale source-layout assertion about removed settings.
- **Reliable Rust coverage:** the workspace test command includes the desktop,
  CLI, protocol, and integration suites. The control-socket descriptor-leak test
  runs in a child test process, so unrelated parallel tests cannot affect its
  process-wide descriptor count. Its original leak threshold is unchanged.
- **Formatting:** resolved the existing Rust import-wrapping difference so the
  shared formatting check can pass.

## Further architecture work

The remaining application controller still coordinates substantial research and
native integration logic. Future extractions should isolate startup hydration and
browser/native-surface ownership together with their lifecycle effects. Retiring
legacy terminal mode branches and Home history loading needs an end-to-end audit
of recovery, shortcuts, and native callbacks. Compiler warnings from Linux alone
are not evidence that macOS code is unused; the interface-health tracker is one
confirmed live example. No persisted-state or protocol migration is included here.

## Validation

- Strict frontend/server type checks, module reachability, and Rust formatting pass.
- Unit tests: 568 passed. Website integration tests: 23 passed.
- Rust workspace tests: 1,264 passed, 13 ignored, none failed. This includes the
  isolated descriptor-leak regression test.
- Frontend and website server production builds pass.
- Shell syntax and `git diff --check` pass.

Self-review checked extracted hook state and callback freshness, preserved research
storage keys, terminal attachment sequencing, the removal of unused event contracts,
and release/test wiring. The earlier stale settings assertion and descriptor test
isolation failure are fixed. Native desktop code was validated on Linux; this pass
did not include an interactive macOS smoke test.
