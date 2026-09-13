# Remove Ghostty from Session

Historical record: the subsequent Foundation Models removal supersedes this
plan’s instructions to retain the independent title bridge. See
[the current title-generation behavior](session-cutover.md#title-generation-after-foundation-models-removal).

Status: source implementation completed; macOS release/runtime validation pending.
Baseline: `02b832a`. The staged plan below records the source review before
implementation; paths to removed files refer to that baseline.

## Implementation record

- Extracted `native_support.rs`, `NativeSupportHost.swift`, and
  `NativeSupportBridge.swift`. Kept the then-current Swift package/archive and
  C ABI identities while removing Ghostty dependencies and renderer files. A later identity cutover renamed them
  to SessionNativeSupport and session_native_* respectively.
- Preserved native browser focus/history, serialized overlay state, sounds,
  lifecycle observers, and both interface recovery probes. The host binds to the
  app webview/window without a terminal container.
- PTYs use the direct ordered writer on every platform and record output from
  the first read. Remote handshake, history checkpoints, generations, cancellation,
  and child reaping remain intact. Compatibility attachment buffering remains;
  automatic approval review rejected further removal of that process bookkeeping.
  The >8 MiB no-attachment regression verifies output and idempotent attachment.
- Removed terminal settings, themes, native fonts, UI routing/events, viewport
  reads, the Ghostty patch, dependency lockfile, and submodule. Preserved web fonts,
  saved settings/data roots, Apple identities, and the independent title bridge.
- Self-review 1 corrected old native shortcut event names to match the current
  research frontend and added cross-platform classification coverage.
- Self-review 2 checked all 17 Swift exports/six Rust callbacks and unchanged
  Foundation Models build code, serialized native appearance updates, and fixed
  a dangling CSS selector left by renderer transparency removal.
- Linux preflight and frontend/server production builds passed. The universal
  command was attempted but failed in macOS Objective-C dependency compilation:
  the Linux compiler rejects `-arch` and `-mmacosx-version-min=13.0`.
- macOS Rust-to-Swift probes, new native host XCTest cases, UI smoke tests,
  universal linking/signing, architecture inspection, and incremental Swift
  relinking remain unexecuted. No signed macOS artifact was produced.

The final implementation is committed together after the two reviews. The
four-stage commit sequence below was not represented as separately validated
macOS commits on this Linux host.

## Objective and boundaries

Remove Ghostty and its terminal renderer without losing research execution or the
native behaviors currently housed in the terminal bridge. Keep Session buildable
and usable after each stage. Land stages in order; dependency deletion follows
runtime decoupling, not the other way around.

This stage preserved the then-current Apple and native identities. A later hard
cutover changed the bundle ID to `dev.session.desktop` and the surviving native
bridge to Session names. The storage and persisted formats also moved to Session names.
The later Foundation Models removal also deleted `src-tauri/swift/FoundationTitleGenerator.swift` and its Rust entry points. Retired renderer functions do not
need permanent dummy compatibility implementations once all callers are removed.

Do not combine this work with a hosting migration, data reset, wholesale adapter
removal, or removal of `portable-pty`. The supported Claude/Codex/Grok research
path is already pane-less. Preserve its SDK/JSONL execution rather than redesigning it. Backend control APIs, legacy
research fallback, and local/remote pane recovery still use PTYs; retain those
process contracts while removing their renderer dependence.

## Current dependency map

| Area | Evidence in this checkout | Intended disposition |
| --- | --- | --- |
| Native build | `src-tauri/build.rs::build_native_terminal_bridge` copies and patches the submodule, invokes SwiftPM, requires `libQmuxNativeTerminal.a` and `libghostty.a`, then links Ghostty and several frameworks. | Replace with a dependency-free native-support build. Preserve architecture isolation and relink tracking. |
| Dependency graph | `.gitmodules`, `vendor/libghostty-spm`, `swift-terminal/Package.swift`, and the patch under `swift-terminal/Patches/`. `Package.resolved` also pins `MSDisplayLink`. | Remove after all native consumers are independent. |
| Native host | `NativeTerminalHost.swift` combines terminal panes with weak WKWebView references, application/window observers, event monitors, browser routing, and recovery probes. | Split by behavior, not by filename. |
| Browser | `human_browser.rs` calls `set_human_browser_webview`, loading-background hooks, and native history inspection. `BrowserOverlay.tsx` also uses iframe shortcut and pointer coordination. | Retain browser behavior in native support; simplify coordination that exists only to protect Ghostty surfaces. |
| App lifecycle | `main.rs` initializes/shuts down the terminal host, resets routing during reload, and coordinates interface-health generations. `show_hide_shortcut.rs` asks the bridge whether the application is active. | Retain independently of terminal availability. |
| Recovery | Swift performs foreground-gated WKWebView snapshots; Rust owns the event-loop watchdog and a shared single-reload claim; `useSessionEvents.ts` acknowledges after animation frames. | Preserve both probes and their cancellation/generation rules. |
| Sounds | `NativeTerminalBridge.swift` implements NSSound playback used by `completion_sound_play`, `completion_sound_set`, and `state.rs`. | Move to native support. Keep notification/sound preferences and assets. |
| Renderer | `NativeTerminalPane`, `QmuxTerminalView`, theme/settings classes, annotation/session registries, and renderer pointer routing. | Remove after renderer consumers are disconnected. |
| Process coupling | `pty.rs` creates native surfaces on macOS, gates attach/replay on geometry, routes input through Ghostty, and consumes Swift write/resize/close callbacks. | Remove rendering dependence while keeping process ownership, ordered input, cancellation, logs, and required recovery. |
| Frontend | `App.tsx` still seeds native terminal settings, loads Ghostty themes, calculates keyboard ownership/backstop geometry, and handles terminal events. | Remove terminal-only paths; retain app/browser focus and document appearance. |
| CLI | `control.rs::pane_read` implements `source=viewport` through Ghostty; `source=terminal` reads stored output. | Retire viewport explicitly; preserve useful process-output reads. |

## Findings that change the implementation sequence

These are resolved code facts, not work deferred to a future inventory:

| Finding | Source | Consequence |
| --- | --- | --- |
| All three supported research adapters take the pane-less path. `bind_research_node_harness` explicitly sets `pane_id = None` and `runtime = Sdk`; the former pane fallback in `main.rs` has since been removed along with the terminal launcher. | [research_runtime.rs](../src-tauri/src/research_runtime.rs): `launch`; [state.rs](../src-tauri/src/state.rs): `bind_research_node_harness`; [main.rs](../src-tauri/src/main.rs): `launch_research_execution` | Keep SDK/JSONL launch, interruption, and result persistence intact. Limit PTY changes to the process paths that actually use them. |
| Non-rendering PTYs still start with `PaneBacklog.ready = false`. The reader buffers output and only calls `record_scrollback` on the live path; `attach_pane` performs the initial flush. | [state.rs](../src-tauri/src/state.rs): `PaneBacklog`; [pty.rs](../src-tauri/src/pty.rs): `start_reader_thread`, `attach_pane` | Simply setting `native_surface = false` leaves output waiting on frontend attachment. Backend-owned readiness and exactly-once logging must precede renderer removal. |
| Production macOS selects native rendering with `cfg!(all(target_os = "macos", not(test)))` in multiple launch/reattach paths. | [pty.rs](../src-tauri/src/pty.rs): shell launch, `spawn_pty`, `reattach_remote_pane` | Ordinary Rust tests do not exercise the production native branch, even on macOS. Validate the renderer-free production app as well as unit tests. |
| The host's `window` is `container?.window`; browser registration and overlay flags guard on container existence. | `src-tauri/swift-terminal/Sources/QmuxNativeTerminal/NativeTerminalHost.swift`: `window`, `attach`, `setHumanBrowserWebView`, `setBrowserOverlayOpen` | Introduce an explicit app-webview/window binding before deleting `NativeTerminalContainerView`. Keeping only weak webview fields is insufficient unless every window lookup and guard is rewired. |
| Native browser loading color comes from `QmuxTerminalTheme.backgroundColor(currentThemeName)`. | Same host: `setHumanBrowserLoadingBackground` | Removing frontend theme loading alone leaves a native Ghostty dependency. Pass a Session-owned browser background to native support, with a startup fallback, and clear `underPageBackgroundColor` when loading ends. |
| Browser overlay-open changes are serialized; human-browser geometry, visibility and navigation have their own revision/occlusion logic. Pointer claims, by contrast, protect Ghostty hit testing. | [api.ts](../src/lib/api.ts): `setNativeTerminalBrowserOverlayOpen`, pointer-claim helpers; [BrowserOverlay.tsx](../src/components/BrowserOverlay.tsx); [human_browser.rs](../src-tauri/src/human_browser.rs) | Preserve overlay transition ordering and child-WebView occlusion. Remove renderer pointer routing without substituting it for native-browser visibility management. |
| `--turn-font-delta`, derived from the terminal font size, affects research, shell and browser text; web WOFF2 assets are separate from native terminal TTFs. | [App.tsx](../src/App.tsx): `turnFontDelta`, `appStyle`; [research.css](../src/styles/features/research.css); [tokens.css](../src/styles/tokens.css) | Decouple app typography before deleting terminal settings. Preserve the current visible size behavior through an app-owned value/fallback; do not delete shared fonts or reset all settings. |
| Native app shortcuts must not consume events before the frontend listener is ready. Web shortcuts have a separate Cmd-K rule and browser/iframe exclusions. | `src-tauri/src/native_terminal.rs`: `classify_web_app_shortcut`, `qmux_native_terminal_did_receive_app_shortcut`; [WebAppShortcutRouting.swift](../src-tauri/swift-native-support/Sources/SessionNativeSupport/WebAppShortcutRouting.swift) | Move the readiness gate and web classifier together. Keep iframe fallback limited to Command chords and keep editable-sensitive browser shortcuts with the page. |
| XCTest is not available with every Command Line Tools-only setup. Existing macOS Rust tests deliberately call production Swift C-ABI probes. | `src-tauri/src/native_terminal.rs`: macOS `tests`; [RustCallbackStubs.swift](../src-tauri/swift-native-support/Tests/SessionNativeSupportTests/RustCallbackStubs.swift) | Retain the Rust-to-Swift test route and test-only Rust callback stubs. Do not replace all native coverage with a Swift-only test requirement. |
| Foundation Models is independently compiled, weak-linked, and required for release by default. | [build.rs](../src-tauri/build.rs): `build_foundation_title_bridge`, `foundation_models_required` | A newer SDK/toolchain can still be required after Ghostty removal. Do not relax the release requirement or confuse that SDK need with a leftover Ghostty dependency. |

## Stage 1 — Establish the live boundary

### Work

1. Expand the reviewed call matrix to cover every exported bridge function and every
   `native_terminal_*` Tauri command. Record its Rust/Swift/TypeScript callers,
   registration, platform guards, runtime trigger, test coverage, and disposition:
   retain, renderer-only, or unresolved. Registration alone does not establish a
   live product path; a missing Linux caller does not establish macOS dead code.
2. Trace startup, foreground activation, hide/show, minimize/restore, resize,
   sleep/wake, explicit reload, and WebContent termination from `main.rs` through
   the host. Record observer ownership and cleanup, not just function signatures.
3. Trace keyboard and pointer behavior for the app WKWebView, external child
   WKWebViews, and iframe previews separately. Distinguish fallback app shortcuts
   from terminal shortcuts, and native-browser occlusion from Ghostty hit testing.
   Retain editable-target and IME exclusions, consumed key-up handling, and the
   boundary that prevents an external browsing document from acting as the app.
4. Confirm the already-separated SDK/JSONL research route remains unchanged.
   Finish tracing adapter shell launches, queued prompts, the legacy research-pane
   fallback, local PTYs, and restored remote panes. Record all platform branches
   and the reader/writer/exit owner after native callbacks are removed.
5. Audit appearance and assets. `App.tsx` derives `--terminal-bg` from the Ghostty
   catalog; this can affect visible nonterminal surfaces. Native Ioskeley TTF
   registration is distinct from WOFF2 fonts used by web text/code. Classify each
   font and CSS variable by actual consumer before proposing deletion.
6. Establish baseline behavior on macOS and capture a universal build's link
   inputs, SwiftPM resolution, app size, and identifiers. Record representative
   saved settings containing an old Ghostty theme and representative research
   state, including running/interrupted work.

### Deliverable and gate

A reviewed call/disposition matrix, a native API contract, and a smoke-test
baseline. Resolve unknown browser/recovery/process consumers before deleting any
bridge family. Run `npm run preflight`, existing macOS Rust-to-Swift bridge
probes, Swift tests where XCTest is available, and a macOS app build. Record
missing coverage explicitly. This stage changes documentation and, where useful,
focused behavioral tests only; runtime behavior stays the same.

## Stage 2 — Extract native support and disconnect runtime rendering

### Native support layout: extract in place first

Add `src-tauri/src/native_support.rs`. Extract `NativeSupportHost.swift`,
`NativeSupportBridge.swift`, and focused recovery/sound/shortcut helpers into the
**existing** `QmuxNativeTerminal` Swift target first. Their code must not import
Ghostty or refer to terminal panes. Keep the existing package, library identity,
linking and target structure during this behavioral change.

This avoids the first plan's unnecessary intermediate Swift target and archive
composition change. Stage 2 still compiles the legacy renderer; it does not claim
the package graph is Ghostty-free. Stage 3 removes those sources/dependencies and
may move the same reduced package to `src-tauri/swift-native-support/` without
changing the surviving ABI or library identity.

Move each surviving C export out of `NativeTerminalBridge.swift` exactly once.
Never link duplicate definitions or activate two event monitors/recovery owners.
Any temporary forwarding wrapper must have a named owner and be removed in Stage 3.

Organize the Swift implementation into small responsibilities:

- A host holding weak references to Tauri-owned views and an explicitly bound
  NSWindow, with initialize, prepare-for-reload, and shutdown operations. Replace
  `container != nil` readiness guards and `container?.window` everywhere. Define
  how attachment failure and a replaced/closed window invalidate the binding.
- Browser focus, history, loading appearance, and app/iframe shortcut routing.
- Window/application lifecycle and the existing interface-health probes.
- Completion-sound playback through AppKit/Foundation.
- C ABI exports and Rust callbacks with explicit main-thread requirements,
  pointer ownership, error reporting, and string allocation/free conventions.

Use AppKit, WebKit, Foundation, and only additional Apple frameworks justified by
retained code. No Ghostty imports, terminal surface objects, or Ghostty theme
lookups may appear in the extracted support files or final reduced package.
Preserve surviving `qmux_native_*` and health callback names and signatures;
move their implementation ownership exactly once to avoid duplicate symbols.
Keep the separate Foundation Models bridge untouched.

### Retained API families

| Family | Keep/move | Remove from its implementation |
| --- | --- | --- |
| Host | availability, initialize, prepare-for-webview-reload, shutdown | Font registration, terminal container creation, pane registry, geometry ownership. |
| Browser | human-browser registration, loading background, history state, overlay-open and iframe-fallback state | Dependence on terminal theme/settings or a live terminal container. |
| App | application-active query, completion-sound playback, app shortcut and browser-Escape callbacks | Terminal search/paste, terminal Cmd-K behavior, terminal Ctrl-D close interception. |
| Recovery | sleep callback, begin/cancel/unhealthy-webview callbacks, native snapshot probe | Pane loops and renderer reset state; keep Rust generation/readiness coordination. |
| Test probes | web/iframe/browser shortcut decisions used by macOS Rust tests | Terminal-owner cases once retired; retain surviving ABI signatures if reserved arguments remain. |

### Safe sequence within the stage

1. Move sound playback and app-active queries first. Then extract the host,
   browser and recovery logic without installing a second event monitor. The
   existing library continues to link while each family moves to its new owner.
   Keep synchronous AppKit work on the main thread, initialize callback state
   before enabling callbacks, and invalidate queued callbacks during shutdown.
2. Make every retained PTY launch/reattach path explicitly non-rendering. Replace
   backend `native_surface` selection and the renderer-specific dispatch only
   after direct writer behavior is available. Preserve `write_pane_sequenced`,
   per-pane send serialization, paste framing, submit delays, write failure
   reporting, and the existing child watcher/reaping semantics. Do not rewrite
   the pane-less research session tables or interruption channels.
3. Remove frontend attachment from process/log readiness. For fresh non-rendering
   panes, enable durable recording before starting the reader. For existing
   buffered panes, flush startup bytes once under the existing ordering lock and
   then mark ready. Keep `pane_attach` temporarily idempotent if callers remain;
   it must not double-record output. Test output beyond `BACKLOG_CAP`, EOF before
   attach, concurrent attach/read, and operation with no frontend listener.
4. Preserve the remote handshake, generation guards, initial-history checkpoint
   and reconnection behavior separately from renderer replay. Do not record
   handshake bytes as user output or duplicate captured history across reconnect.
   Replace all waits for geometry/`complete_pending_attach` with process-owned
   readiness. Keep terminal dimensions needed by a real PTY/tmux session even
   though there is no rendered surface; use an explicit default sizing policy.
5. Switch `main.rs`, `human_browser.rs`, `show_hide_shortcut.rs`, and sound callers
   to `native_support`. Retain the Rust event-listener-ready gate and the web
   shortcut classifier (including Cmd-K). Preserve consumed key-up tracking,
   iframe Command-only fallback, and browser editable-sensitive exclusions.
   Remove the renderer-specific pointer monitor and triple-click forwarding;
   normal WebKit mouse dispatch and DOM text selection must work directly.
6. Update frontend APIs with the same commit that changes registrations. Preserve
   the serialized overlay-open transition queue and `BrowserOverlay`'s native
   browser occlusion/navigation-revision logic. Remove pane keyboard-owner,
   backstop, overlay-region and pointer-claim calls once they have no renderer
   consumer. Browser callbacks after close/reload must not reclaim focus.
7. Replace both theme consumers: CSS/browser appearance and Swift loading color.
   Give native support a validated Session background value with a default before
   frontend boot; clear it when loading finishes. Decouple `--turn-font-delta`
   from terminal preferences while preserving visible research typography. Keep
   body/code WOFF2 fonts; only native TTF registration is terminal-only.
8. Activate the extracted host with zero terminal surfaces and zero terminal
   geometry callbacks. Retire renderer-dependent public operations at activation:
   `pane.read source=viewport` must return an explicit unsupported/invalid-source
   error, and its CLI help changes in the same commit. Remove obsolete Tauri
   registrations then, even if unreferenced renderer implementation remains
   compiled until Stage 3. Do not leave callable APIs that silently fail because
   the old host was never initialized.

### Gate

Update tests for retired renderer behavior as part of the activation change;
port retained behavior assertions rather than suppressing unrelated failures.
Run frontend/server/Rust checks, the macOS Rust-to-Swift bridge probes, and a
macOS production app build. Run Swift tests with a full Xcode toolchain where
available; their absence under Command Line Tools is an explicit coverage gap,
not a reason to remove the C-ABI probes. Smoke-test the retained native behavior
with no terminal host initialized.
Research launch, streamed output, follow-up, cancellation, completion, and app
reload must work without geometry/renderer callbacks. Fail the stage if either
recovery probe or completion sounds depend on the old host.

## Stage 3 — Delete the terminal dependency chain

### Runtime and API cleanup

- Remove the remaining renderer implementation from `native_terminal.rs`, or
  delete the file once every retained function is owned elsewhere. Remove its
  obsolete imports, Tauri registrations, callback exports, structs, and platform
  stubs. Keep realistic non-macOS behavior for retained native support.
- Delete native surface creation/removal, Ghostty byte delivery, renderer replay
  state, geometry-triggered deferred attaches, and renderer-only input scheduling
  from `pty.rs` and `state.rs`. Preserve the process capabilities proven live in
  Stage 1: writers, logs, transcript ingestion, cancellation, wait/reaping,
  bounded buffering, remote reconnection, and authenticated control APIs.
- Remove terminal-only handlers and props from `useSessionEvents.ts`, `App.tsx`,
  `src/lib/api.ts`, `src/types.ts`, settings helpers, and related components/CSS.
  Keep `app.shortcut`, browser Escape, notifications, and the health handshake.
- Delete the now-unreachable viewport implementation after its Stage 2 API
  retirement. Update `session-cli/src/public_cli.rs` help and the `control.rs`
  source-validation test together. The current explicit viewport contract is
  `pane.read`; do not invent changes to unrelated MCP research tools. Keep
  process-output and research-transcript reads and their authorization checks.
- Keep old saved data readable. Do not delete workspaces, research state or
  transcripts. `loadSettings` currently reconstructs known fields and
  `saveSettings` serializes that object: unknown-field round-tripping is not an
  existing guarantee. Preserve supported preferences and their storage key;
  retain legacy terminal values inert where needed for the narrow typography
  transition, without adding a wholesale settings-schema migration.

### Swift, assets, and dependency deletion

Delete legacy renderer source files from the existing target and move the reduced
package only after retained code/tests have moved. No extra target is required.
Renderer source deletion candidates include:
`NativeTerminalPane.swift`, `QmuxTerminalView.swift`, `QmuxTerminalTheme.swift`,
`TerminalPaneSettings.swift`, `TerminalSessionRegistry.swift`, terminal annotation
registries/snapshots, and terminal container/pointer/layout code that has no
remaining browser or window purpose. Port useful shortcut/lifecycle tests; remove
only tests whose product behavior has been retired.

Remove the Ghostty patch, old `Package.resolved` and its transitive MSDisplayLink
pin when unused, the `vendor/libghostty-spm` gitlink, and its `.gitmodules` entry.
Check submodule-local changes before removal and never remove unrelated submodules
or user data. Drop submodule-init instructions only if no remaining dependency
needs them. Remove terminal-only TTF assets and license bundle entries only after
confirming no web or retained native consumer; keep relevant web fonts and licenses.
Specifically, the four `IoskeleyMonoTerm-*.ttf` files are included by native font
registration; `IoskeleyMono-*.woff2` is used by CSS and must not be bundled into
the same deletion. Preserve `TerminalPointerRouting.swift` only if a real remaining
consumer is found: its current triple-click helper exists for Ghostty and can go.

### Build simplification

- Replace `build_native_terminal_bridge` with the native-support build.
- Remove `prepare_patched_ghostty_dependency`, `copy_package_tree`, vendor watches,
  patch application, `QMUX_GHOSTTY_PACKAGE_PATH`, `libghostty.a` checks, and the
  `static=ghostty` link directive.
- Remove Ghostty-only frameworks and `c++` only after checking all other native
  dependencies. WebKit's internal use of graphics frameworks is not evidence
  that this bridge itself must link Ghostty's entire framework list.
- Retain per-architecture Swift scratch paths, SDK/deployment-target selection,
  source change tracking, and native archive relink tracking. If the package path
  changes, update both `cargo:rerun-if-changed` and `.gitignore` for the new Swift
  scratch directory. Build both architectures in a clean directory to catch
  stale source lists. Test a Swift-only edit followed by an incremental build to
  verify that the app relinks. Keep the existing
  bridge stamp identifier if still used. Verify whether retained Objective-C
  categories need `-force_load`; do not remove it solely because Ghostty is gone.
- Leave `build_foundation_title_bridge` and its required/optional build policy
  intact. Preserve shared SDK/triple helpers that it still calls.
- Update `AGENTS.md`, README, and the cutover guide to describe the smaller native
  bridge and which retired native identifiers no longer exist.

### Gate

Build and test from a checkout without the Ghostty submodule. Both the app and
native-support tests must compile without any old Swift build output. Only now
claim the Swift package graph is Ghostty-free. Preserve the test-only callback
stubs needed to link Swift tests; do not ship those stubs in the production
archive. Searches must find no active Ghostty imports, package references, patch commands, library
links, or runtime calls. Historical documentation references are acceptable;
unused binary/build artifacts are not proof of a dependency.

## Stage 4 — Validate behavior and release artifacts

### Automated checks

Run `npm run preflight`, frontend/server production builds, shell syntax checks,
`git diff --check`, macOS Rust bridge probes, and the native-support Swift tests
where XCTest is available. Preserve and run
the Rust interface-health tests in `main.rs`; add focused cases for duplicate
reload claims, cancelled generations, callbacks after shutdown, and hidden-window
probe deferral where coverage is missing. Exercise shortcut classification in both
Rust/Swift and frontend tests, including editable/IME contexts and iframe fallback.

Add process regressions demonstrating that no renderer attach is required for
startup, immediate durable output, ordered prompt submission, cancellation, and
exit. Include more than 8 MiB of output before any attach, an exit-before-attach
case, and remote reconnect/history deduplication. Verify supported research still
binds with `pane_id = None`; the legacy pane fallback no longer exists.
Cover old settings with a Ghostty theme, non-default font size, and saved research.
Keep security and input ordering assertions when simplifying the native input path.

### Universal build and dependency proof

On a macOS builder with the existing signing/updater credentials:

1. Use a clean checkout and fresh Cargo/Swift build-output directories. Prefer a
   clean checkout using the normal `src-tauri/target` layout so release-artifact
   path assumptions do not become a second build-script change. Do not initialize
   the removed submodule. Prewarm ordinary toolchain/dependency caches
   separately if an offline dependency test is desired.
2. Run `SESSION_BUILD_TARGET=universal-apple-darwin npm run build`. This is the
   production app/DMG build; `npm run build:release` also creates/uploads a GitHub
   release and is not required to validate removal. Notarization is a separate
   delivery action using the existing identity if included in release acceptance.
3. Confirm both arm64 and x86_64 slices with `lipo -info`; inspect bundle ID,
   executable metadata, signing identity, and `codesign --verify` results. Confirm
   Foundation Models symbols/build behavior remain present as before. Use a
   toolchain with `FoundationModels.framework` for the full release gate; do not
   set `SESSION_ALLOW_MISSING_FOUNDATION_MODELS` to make that gate pass.
4. Save verbose build/link logs and inspect the Swift package graph, archive/link
   inputs, and symbols/link map for both architectures. `otool -L` alone cannot
   prove removal because Ghostty is statically linked. A stripped release binary
   may also need its pre-strip objects/link map for meaningful symbol inspection.
5. Confirm no step downloads, checks out, copies, patches, compiles, or links
   Ghostty or its now-unused transitive dependencies. Compare bundle contents and
   size to the baseline; size improvement is supporting evidence, not the gate.

### macOS smoke-test matrix

| Surface | Scenarios and pass criteria |
| --- | --- |
| Research | Start Claude/Codex/Grok, stream long answers, follow up, branch, retry, cancel mid-stream, finish, and reopen existing documents. Confirm no pane allocation; run retained legacy pane/control paths separately. |
| Activity and persistence | Notes/links, draft and scroll restoration, saved research/settings, and reload during a run continue working. |
| Browser | Test automated Chromium, external native WKWebView, and sandboxed/local iframe modes separately. Navigate back/forward/reload, rapidly open/close, switch documents, and open a modal over the child browser. Revision ordering, occlusion, history, focus handoff and loading backgrounds stay correct. |
| Keyboard | App shortcuts from app content, browser content, and iframe focus; Escape closes the correct overlay; native editable controls and IME keep their input; key repeat/key-up do not duplicate commands. |
| Focus and pointer | Click between composer, document selection, menus, dialogs, and browser; dismiss overlays; drag/resize UI; hide/show and switch applications. No stolen focus, stuck pointer capture, or click-through to an occluded browser. |
| Window lifecycle | Resize continuously, minimize/restore, move between displays, sleep/wake, and reopen after inactivity. No blank stage, stale geometry, or accidental hidden-window focus. |
| Recovery | Trigger explicit reload and WebContent termination, and deterministically simulate missing JS acknowledgements and failed/hung native snapshots in test builds. Verify one recovery per generation, retry/cancellation rules, state restoration, and no healthy-webview reload loop. |
| Notifications | Preview each supported completion-sound source, complete a background run, and exercise show/hide hotkey behavior while another app is active. |

Test the universal artifact on Apple Silicon and Intel hardware where available;
record any architecture executed only through translation or not executed. Linux
checks cannot certify AppKit/WebKit behavior or signing. Any unavailable release
or smoke-test gate remains explicitly incomplete rather than reported as passed.

## Suggested commit boundaries

1. Dependency/call matrix and baseline behavioral coverage.
2. In-place native-support extraction, PTY readiness/input decoupling, and atomic
   host/API activation; retain the old dependency until the new runtime passes
   its gate. Keep these as preparatory commits plus one coupled activation commit
   if the diff is too large, but test every intermediate state.
3. Delete renderer APIs/assets/package/submodule and simplify native builds.
4. Complete regression coverage, build/dependency evidence, and final docs.

Each implementation commit must compile. During Stage 2, separate preparatory
commits may compile the extracted support files without activating them; the final
activation commit must switch all coupled callers together. Stop at a failing stage gate
and repair it before starting the next stage.

## Completion criteria

Session builds a signed universal app without Ghostty source or artifacts; the
retained native-support package has no Ghostty dependencies; research and browser
behavior pass the matrix; existing data and Apple identity are preserved; and
Foundation Models remains independent and intact. Record exact commands, results,
artifact locations, and any unexecuted macOS checks with the final review.
