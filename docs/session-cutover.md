# Session naming cutover

The desktop binary is `session`. The standalone remote helper is `session-cli`,
and the shared Rust wire-types crate is `session-proto`. App-owned environment
variables use `SESSION_*`, the desktop event channel is `session-event`, and
frontend APIs use names such as `SessionEvent` and `useSessionEvents`.

## Restart and configuration

This is a coordinated software cutover: restart the app and relaunch agent/shell
processes so commands, generated hooks, event listeners, and environment variables
come from the same build. Old executable and environment aliases are not supported.

Rename app-owned `QMUX_*` settings to `SESSION_*` in local build configuration,
external scripts, and deployment secrets. Examples include `SESSION_CONFIG`,
`SESSION_BUILD_TARGET`, `SESSION_GITHUB_CLIENT_ID`, `SESSION_SHARE_BASE_URL`,
`SESSION_PUBLIC_ORIGIN`, and `SESSION_SESSION_SECRET`. The app supplies fresh
`SESSION_SOCK`, `SESSION_TOKEN`, `SESSION_CLI`, and pane/agent variables to children;
do not copy credentials from an old process. Both old and new inherited context
are cleared before fresh pane credentials are installed.

The Codex adapter now supplies `SESSION_WORKTREE_ROOT` and matching developer
instructions. An already-running agent's older launcher instructions still apply
until that process is relaunched; an external launcher must update its producers
and instructions together.

Remote configuration now exposes `sessionCli`. Existing `qmuxCli` fields still
load, including custom paths; subsequent serialization uses the new field. Old
managed `~/.qmux/bin/qmux-cli` paths are recognized for reprovisioning as
`~/.qmux/bin/session-cli`. Custom CLI paths are never overwritten: their owners
must install a matching helper. Remote provisioning still requires a bundled
helper for the remote architecture; this change does not add remote support to
builds that omit those artifacts.

## Preserved compatibility contracts

- Apple bundle ID `app.qmux.desktop`, GitHub Keychain service
  `app.qmux.github-oauth` and account `github`, signing configuration, and updater
  public/private key identity.
- Swift package/target names, Objective-C/native identifiers, `qmux_native_*` and
  Foundation Models bridge symbols for surviving functions. The native archive
  retains `QmuxNativeTerminal` and `QMUX_NATIVE_BRIDGE_STAMP`; renderer-only
  symbols, `QMUX_GHOSTTY_PACKAGE_PATH`, and `QMUX_NATIVE_DEBUG` are retired.
- `qmux.config.json`, `.qmux/` directories, the macOS
  `~/Library/Application Support/qmux` data root, Linux data/runtime roots,
  browser storage keys, and existing generated integration file paths.
  Existing data is read in place; no data directory is moved or deleted.
- Workspace/participant identity fields, `qmuxToolActivity`,
  `qmux_instruction`, publication proposal markers, and `qmux-file:` links.
  These names identify persisted content, not product branding.
- Existing remote tmux identities and SSH control paths, which allow recovery and
  cleanup of sessions created before this cutover.
- `qmux.app`, the Fly app name, web authentication cookies, updater endpoints,
  and release download URLs. Hosting and update delivery need a separate
  deployment cutover. Existing clients still request their embedded old endpoint.

The landing page's source link points to `raykyri/session`. The release script
currently chooses its repository through `gh` while updater URLs still name
`raykyri/qmux`; resolve that deployment mismatch before publishing a release.
Moving domains or release delivery is not part of this source-code change.

## Native support after terminal removal

Session no longer builds or links Ghostty. `native_support.rs` and the Swift
support files in `src-tauri/swift-terminal` retain browser, AppKit shortcut,
completion-sound, and interface recovery behavior. The package directory and
archive name remain for native compatibility; its dependency list is empty.
Foundation Models compilation and Apple identifiers are unchanged.

`pane.read --source viewport` now returns an explicit invalid-argument error.
Use `--source terminal` for stored process output. Research SDK/JSONL execution,
PTY input ordering, remote recovery, and process cleanup remain available.

Settings retain the `qmux.settings.v1` key. The app reads legacy `fontSize` as
`textSize` to preserve research typography; obsolete terminal themes, fonts,
cursor and scroll settings no longer control the app. Browser loading appearance
uses the application palette, including a native startup fallback.

## Control socket filename

The default control socket is now `session.sock` in the existing runtime directory.
The checked-in development configuration uses `~/.qmux/run/session.sock`. Both
app and CLI discovery use the new filename; explicit `socketPath` and
`SESSION_SOCK` overrides remain supported. Restart Session and update any external
configuration that explicitly points to the old socket when cutting over.
