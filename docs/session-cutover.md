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
`SESSION_BUILD_TARGET` and `SESSION_PUBLIC_ORIGIN`. The app supplies fresh
`SESSION_SOCK`, `SESSION_TOKEN`, `SESSION_CLI`, and pane/agent variables to children;
do not copy credentials from an old process. Inherited Session context is cleared
before fresh pane credentials are installed.

The Codex adapter now supplies `SESSION_WORKTREE_ROOT` and matching developer
instructions. An already-running agent's older launcher instructions still apply
until that process is relaunched; an external launcher must update its producers
and instructions together.

Remote configuration exposes only `sessionCli`; the legacy field is ignored.
Managed helpers live at `~/.session/bin/session-cli`. Custom CLI paths are never
overwritten: their owners must install a matching helper. Remote provisioning
still requires a bundled helper for the remote architecture; this change does not add remote support to
builds that omit those artifacts.

## Current identity and compatibility contracts

- Apple identity uses bundle ID `dev.session.desktop`. Signing continues to use
  the configured Developer ID identity.
- Native support uses the `SessionNativeSupport` Swift package, product, target,
  and archive; `session_native_*` C ABI symbols; and `SESSION_NATIVE_BRIDGE_STAMP`.
  No old bridge exports are retained.
- `session.config.json`, `.session/` directories, the macOS
  `~/Library/Application Support/session` data root, Linux data/runtime roots,
  and `session.*` browser storage keys are the only current storage locations.
- Persisted workspace/participant fields, `sessionToolActivity`,
  `session_instruction`, and `session-file:` links use
  Session names. Generated hooks, profiles, plugin files, remote tmux identities,
  SSH control paths, and browser automation profiles also use Session prefixes.
  No legacy values or paths are read or migrated.
- The updater public/private key identity, `qmux.app`, the Fly app name, updater
  endpoints,
  and release download URLs. Hosting and update delivery need a separate
  deployment cutover. Existing clients still request their embedded old endpoint.

The landing page's source link points to `raykyri/session`. The release script
currently chooses its repository through `gh` while updater URLs still name
`raykyri/qmux`; resolve that deployment mismatch before publishing a release.
Moving domains or release delivery is not part of this source-code change.

## Native support after terminal removal

Session no longer builds or links Ghostty. `native_support.rs` and the Swift
support files in `src-tauri/swift-native-support` retain browser, AppKit shortcut,
completion-sound, and interface recovery behavior. The package is dependency-free
and exports only the current Session native ABI.
The Apple bundle and Keychain service use the new Session identities.

`pane.read --source viewport` now returns an explicit invalid-argument error.
Use `--source terminal` for stored process output. Research SDK/JSONL execution,
PTY input ordering, remote recovery, and process cleanup remain available.

Settings use the `session.settings.v1` key. The app reads legacy `fontSize` as
`textSize` to preserve research typography; obsolete terminal themes, fonts,
cursor and scroll settings no longer control the app. Browser loading appearance
uses the application palette, including a native startup fallback.

## Control socket filename

The default control socket is `session.sock` in the Session runtime directory.
The checked-in development configuration uses `~/.session/run/session.sock`. Both
app and CLI discovery use the new filename; explicit `socketPath` and
`SESSION_SOCK` overrides remain supported. Restart Session and update any external
configuration that explicitly points to the old socket when cutting over.

## Title generation after Foundation Models removal

The Apple Foundation Models provider, Swift title bridge, native title command,
and release-build requirement have been removed. Swift is still required for the
AppKit/WebKit support bridge. Research titles and recaps continue to use the
research agent. Optional tab titles still support OpenRouter when explicitly
selected; existing Foundation Models selections and new installations default
to disabled. Stored OpenRouter selections, keys, and models are preserved.
