# Session naming cutover

The desktop binary is `session`. The standalone CLI is `session-cli`, and the
shared Rust wire-types crate is `session-proto`. App-owned environment
variables use `SESSION_*`, the desktop event channel is `session-event`, and
frontend APIs use names such as `SessionEvent` and `useSessionEvents`.

## Restart and configuration

This is a coordinated software cutover: restart the app so commands, event
listeners, and environment variables come from the same build. Old executable and
environment aliases are not supported.

Rename app-owned `QMUX_*` settings to `SESSION_*` in local build configuration,
external scripts, and deployment secrets. Examples include `SESSION_CONFIG` and
`SESSION_BUILD_TARGET`. `SESSION_PUBLIC_ORIGIN` now configures the web
application at `https://session.dev` (`web/.env.example`), not a landing page.
The CLI (`session send|ping|--version`, or the same commands through
`session-cli`) finds the control socket through
`SESSION_SOCK`, the configured `socketPath`, or the default runtime location, and
authenticates as a same-user socket peer; it takes no token.

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
  Session names. Generated plugin files and browser automation profiles also use
  Session prefixes.
  No legacy values or paths are read or migrated.
- The updater public/private key identity remains a separate deployment contract.
  The updater endpoint, release download URLs, and release script use
  `aka-com/session`. Existing builds continue to request the endpoint embedded in
  those builds. The former `qmux.app` landing-page origin and its Fly app name are
  no longer deployment contracts: the landing site is removed and the web
  application in `web/` is deployed on its own Fly app, `session-dev`, serving
  `https://session.dev` and `https://artifacts.session.dev`
  (`web/docs/13-deployment-fly.md`). It shares no build, no release channel,
  and no data with the desktop app; `fly deploy web -c web/fly.toml` is its
  whole deployment, and the desktop updater is unaffected by it.

## Native support after terminal removal

Session no longer builds or links Ghostty. `native_support.rs` and the Swift
support files in `src-tauri/swift-native-support` retain browser, AppKit shortcut,
completion-sound, and interface recovery behavior. The package is dependency-free
and exports only the current Session native ABI.
The Apple bundle and Keychain service use the new Session identities.

Session has no terminal panes, PTYs, or remote terminals; research runs use the
providers' SDK/JSONL interfaces. A state file from a build with panes loads
without its panes, queued turns, composer text, and artifact tray, and the next
save omits them. Startup deletes `.session/terminal` (pane scrollback) and
`.session/remote-files` (artifact uploads).

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
research agent. Tab titles, and the OpenRouter provider they could use, were
removed with terminal tabs; a stored OpenRouter key is dropped from
`preferences.json` on its next update.
