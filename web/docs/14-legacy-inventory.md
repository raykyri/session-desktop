# Legacy inventory: dropped, kept, and references to change

## 1. Dropped subsystems (not ported)

Rust (`src-tauri/src`): `pty.rs`, `scrollback.rs`, `control.rs`,
`control_socket.rs`, `connection_limit.rs`, `shell_jobs.rs`, `host.rs`,
`ssh_config.rs`, `remote_cli.rs`, `remote_files.rs`, `remote_terminal.rs`,
`remote_transcript.rs`, `browser_backend.rs`, `browser_engine.rs`,
`human_browser.rs`, `file_server.rs` (semantics re-created in Phase 7),
`native_support.rs`, `show_hide_shortcut.rs`, `sleep.rs`, `updater.rs`,
`mcp.rs`, `launch_path.rs`, `recovery.rs`, `user_notifications.rs`
(dispatcher re-created server-side), `turn_queue.rs`, `thread_graph.rs`,
`prompt_library.rs`, `image_files.rs`, `github_auth.rs` (replaced by web
OAuth), the `session-cli` and `session-proto` crates, the Swift
`SessionNativeSupport` package, and the entire CLI execution layer:
`research_runtime.rs`, `claude_sdk.rs`, `headless_process.rs`,
`title_generation.rs` (its schema definitions and prompt templates are retained), `adapters/*`,
`launch_path.rs`, `sleep.rs`, the OpenRouter proxy, and the adapter
readiness probes. Within kept logic: `PaneInfo`, splits,
artifacts tray, queued turns, remotes, `WorkspaceScope::Terminal`,
`ResearchRuntime::Pane`, `export_pane_to_research`, `save_pasted_image`,
`read_transcript_image`, `interface_health_probe`, exit confirmation.

Frontend (`src/`): `lib/paneSplits.ts`, `lib/paneTree.ts`,
`lib/terminalTitle.ts`, `lib/terminalAttention.ts`, `lib/remoteConnection.ts`,
`lib/remoteSettings.ts`, `lib/remoteStartup.ts`,
`components/RemoteConnectionDetailsText.tsx`, `lib/threadGraph.ts`,
`lib/threadGraphRefresh.ts`, `lib/handoff.ts`, `lib/transcriptFormat.ts`,
`lib/homeRails.ts`, `lib/homeRailTypes.ts`, `lib/transcriptScroll.ts`,
`lib/transcriptSessions.ts`, `lib/composerActions.ts`,
`lib/composerSlashCommands.ts`, `lib/humanBrowserState.ts`,
`lib/humanBrowserLifecycleQueue.ts`, `lib/browserOverlay.ts` (panel
semantics re-created), `components/BrowserOverlay.tsx`,
`components/GithubAccountControl.tsx` (replaced by account menu),
`adapters/*` (all four files), `lib/adapterReadiness.ts`,
`lib/agentSetup.ts`, `components/AgentSetupGuide.tsx`, `lib/launcherModels.ts`
(replaced by the model registry), `lib/adapterIcons.ts` (replaced by model
icons), `lib/workspaceScope.ts` (except `researchAttention`),
`lib/windowFocus.ts`, the pane context menu, repository
browser, worktree dialog, exit dialog, rename pane/group dialog, remotes
settings tab, and settings `useLoginShell`, `worktreeLocation`, `codeMode`,
`showTabDirectories`, `stickyUserMessages`, `preventSleep`, show/hide
shortcut, `tabTitleProvider`, `openRouterKey`, `openRouterModel`, and every
per-model effort option.

Tauri commands with no web equivalent are listed in `03-api-and-events.md`
§2 (final paragraph).

## 2. Kept and ported

Pure logic (Phase 1 list in `00-plan.md`), research components
(`components/research/*` except `DocumentComposer` creation UI, which the
desktop already hides), `TranscriptMarkdown`, `TranscriptActivity`,
`DiagramBlock`, lightboxes, `DomSearchBar`, `PaneSearchBar` (renamed),
`CommandPalette`, `LauncherSelect` (on Base UI, as the model chip),
`LinkContextMenu` (on Base UI), `UserNotificationStack`,
`ActivityMetadataLine`, `ComposerSubmitShortcut`, `ConfirmDialogActionButton`, `TweetEmbed`,
`ResearchReportImport` (web path only), fonts, `tokens.css`,
`reduced-motion.css` media block, `tests/fixtures/journal/*`.

`ResearchNodeKind: "conversation"`, `origin: "terminalExport"`, the journal
`note` kind, and every desktop file format are dropped (hard cutover, no
import).

## 3. References to the old `web/` landing site that must change

Delete: `web/server.tsx`, `web/landing/LandingPage.tsx`, `web/server.test.ts`,
`web/tsconfig.json`, `site/` (fonts already exist in `src/assets/fonts`;
`site/logo.png` moves to `packages/client/public/logo.png` if the sign-in
page uses it), generated `dist-site/`.

Edit:

| File | Line(s) | Change |
| --- | --- | --- |
| `package.json` | 10 `dev:site` | remove |
| `package.json` | 15 `build:site:server` | remove |
| `package.json` | 16 `start:site` | remove |
| `package.json` | 20 `test:integration` | remove (root `test` becomes `test:unit && test:rust`) |
| `package.json` | 48 `check:types` | `tsc` only |
| `Dockerfile` (root) | all | removed; replaced by `web/Dockerfile` |
| `.dockerignore` (root) | all | removed; `web/.dockerignore` allowlists `web/**` minus `node_modules`, `dist`, `docs` |
| `fly.toml` (root) | all | removed; replaced by `web/fly.toml` (app `session-dev`) |
| `.gitignore` | 3 `dist-site/` | replace with `web/**/dist/`, `web/.data/` |
| `scripts/check-unused-modules.mjs` | 51, 57 | source dirs `["src"]`, roots `["src/main.tsx"]` |
| `tsconfig.runtime.json` | `include` | drop `"web"` |
| `README.md` | 57–70 | remove `dev:site` mention; add "Web application" section pointing at `web/docs` |
| `docs/session-cutover.md` | 16, 47 | `SESSION_PUBLIC_ORIGIN` now configures the web app at `https://session.dev`; the old landing-page origin and Fly app name are no longer deployment contracts |
| `src-tauri/src/encyclopedia.rs` | 564 | OpenRouter `HTTP-Referer` header changed to `https://session.dev` (desktop attribution; optional) |
| `.env.example` (root) | GitHub and OpenRouter lines | move to `web/.env.example` |

No `.github/` workflows exist today; `web.yml` is new. `docs/ghostty-removal-plan.md:182`
mentions "web/iframe" in prose and is not a reference to the directory.

## 4. Desktop-only behaviors intentionally not reproduced

- Native folder picker, Finder reveal, moving a workspace directory.
- Window show/hide global hotkey, hidden-window startup, exit confirmation,
  keep-awake.
- Native menu → `app.shortcut` events.
- Chromium screencast mirror and WKWebView browsing.
- Unbounded run parallelism (replaced by limits).
- Local interactive provider logins and user-supplied API keys (the
  deployment holds provider credentials).
- Agent filesystem access (replaced by attached documents).
- Per-model reasoning effort (fixed at medium).
