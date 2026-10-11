# Session desktop: engineering issue review

Scope: `src/` (React frontend), `src-tauri/` (Rust backend, Tauri config and capabilities). `web/` was spot-checked (the SSRF guard in `packages/server/src/runs/tools/ssrf.ts`), and nothing reportable was found there. Every finding below was checked by reading the cited code. Line numbers refer to the current HEAD (81f8998).

## Checks run

| Check | Result |
| --- | --- |
| `npm ci` | ok (node_modules is gitignored) |
| `npm run check:types` (tsc + tsconfig.runtime.json) | pass, 0 errors |
| `npm run test:unit` | 762 tests, 762 pass, 0 fail (~20 s) |
| `cargo test --workspace` (Linux, `CARGO_TARGET_DIR` outside the repo) | pass: 1083 + 31 + 3 + 4 tests, 0 failed, 11 ignored (need chrome-headless-shell, tmux, or SSH target). macOS-only code paths are not compiled on Linux; 16 compiler warnings, all platform-gated dead code or vendored wry deprecations |
| eslint-plugin-react-hooks 5.2.0 on a scratch copy of `src/` | 48 exhaustive-deps warnings, 0 rules-of-hooks violations (see ENG-09) |
| Backend command registration vs frontend `invoke` names | 174 registered, 44 never referenced from `src/` (see ENG-01) |

## Summary

P0: 0 · P1: 3 · P2: 7 · P3: 9 · total 19

No P0 was found: there is no confirmed data loss on the normal path and no remotely reachable exploit. The code shows deliberate hardening in several places: atomic fsync'd persistence, DOMPurify for diagrams, safeHref, a sandboxed file-preview iframe, a SO_PEERCRED-checked control socket, and an SSRF guard in the web server. The P1 findings are about blast radius (the IPC surface, the missing error boundary) and structural cost (MainApp).

| ID | Sev | Category | Title |
| --- | --- | --- | --- |
| ENG-01 | P1 | security | 44 registered Tauri commands have no frontend caller, including PTY write, shell spawn, and launch-arbitrary-path |
| ENG-02 | P1 | correctness | No React error boundary anywhere: one render exception blanks the whole window, and the restored selection can repeat it on every launch |
| ENG-03 | P1 | architecture | MainApp is one 8,690-line component that owns nearly all application state and logic |
| ENG-04 | P2 | dead-code | The terminal-pane surface is unreachable: activeSurface can never become "pane", and the split and terminal-map code is dead |
| ENG-05 | P2 | dead-code | Settings shows a Remotes tab that configures SSH hosts no reachable feature uses |
| ENG-06 | P2 | performance | Synchronous Tauri commands take the model lock and do file I/O on the macOS main thread, contrary to the file's own stated rule |
| ENG-07 | P2 | correctness | Backend event batches are handled without per-event isolation, so one throwing handler silently drops the rest of the batch |
| ENG-08 | P2 | error-handling | State persistence failures are written only to stderr; the user keeps working on changes that will be lost |
| ENG-09 | P2 | maintainability | React hooks rules are not enforced: no ESLint in the desktop package, although the code relies on eslint-disable comments |
| ENG-10 | P2 | testing | Test suite does not reach App.tsx, the hooks, the event coalescer, or the SVG sanitizer |
| ENG-11 | P3 | security | read_research_report reads any .md path supplied by the renderer, with no size limit |
| ENG-12 | P3 | accessibility | Settings and Agent Setup dialogs declare aria-modal but do not move, trap, or restore focus; the Settings tabs are only partly wired |
| ENG-13 | P3 | error-handling | Drafts tray turns any load failure into an empty list without reporting it |
| ENG-14 | P3 | security | OpenRouter key is saved over IPC on every keystroke with errors discarded, and lives in renderer state despite the proxy's stated goal |
| ENG-15 | P3 | error-handling | External-open calls discard rejections, so refusals and failures are invisible |
| ENG-16 | P3 | performance | useComposerPopOpen leaks one window listener per pointer press |
| ENG-17 | P3 | correctness | Folder membership of a removed tree is written back by the next folder save |
| ENG-18 | P3 | security | File-server token-leak guard in open_external_url uses a string prefix match |
| ENG-19 | P3 | performance | MainApp refills the research node cache from all activity and detail nodes on every render |

## What App.tsx owns

`MainApp` (lines 1167-9855) is the whole application. Its responsibilities, in rough order of size:

1. Research navigation and data: tree, activity, and recent-activity snapshots, detail fetch sequencing, the research event reducer (5702-6019), recovery timers, viewed acknowledgements, page history, folder, draft, and highlight feeds, and composer submission.
2. The legacy pane and terminal surface: panes, groups, splits, attach retries, pane chrome, close and exit dialogs, and tab titles with OpenRouter title generation. Most of this is unreachable (ENG-04).
3. Agent, turn, and queue state: turns, queued turns, hook-event export, transcript options, thread graphs, and per-agent drafts with flush-on-hide.
4. The browser overlay and links: per-owner overlay state, the native human browser, link context menu, and local-path opening.
5. Settings, the Remotes editor, Agent Setup, appearance, the show/hide shortcut capture, the GitHub account, and the global keyboard and Escape dispatchers.
6. About 1,450 lines of JSX for all of the above.

Suggested split order: delete the dead pane surface (ENG-04, ENG-05); extract the research event reducer as a pure module with tests; extract useResearchSelection; move the Settings and Agent Setup dialogs into self-contained components; extract useBrowserOverlays; move agent, turn, and queue state into an external store so event batches stop re-rendering MainApp.

## Issues

### ENG-01 · P1 · security: 44 registered Tauri commands have no frontend caller, including PTY write, shell spawn, and launch-arbitrary-path

**Evidence**

- `src-tauri/src/main.rs:3490`: generate_handler! registers 174 commands. 44 of them appear nowhere in src/ as a command string: agent_submit_turn, agent_*_queued_turn (6), agent_unpause, agent_clear_working_status, artifact_list/remove/restore/open_external/reveal/file_url, pane_write, pane_resize, pane_reconnect, pane_reorder, pane_set_layout, pane_move_to_group, pane_restore_last_closed, pane_reset_terminal_modes, group_create, group_reorder, worktree_remove, prompt_library_list/save/delete/reveal, save_pasted_image, read_transcript_image, set_agent_transcript, list/create/update/delete/assign_global_draft, browser_open_terminal_path, list_thread_graphs, list_shell_agent_jobs, list_research_workspaces, get_conversation_history_snapshot.
- `src-tauri/src/main.rs:2509`: pane_write(pane_id, data, paste, submit) writes arbitrary bytes into a pane's PTY, which is command execution in that shell.
- `src-tauri/src/main.rs:1087`: artifact_restore accepts a full ArtifactInfo from the renderer; normalize_artifact_target (state.rs:674) accepts any non-empty path.
- `src-tauri/src/main.rs:1098`: artifact_open_external then runs `open <path>` (main.rs:1170), which launches .app bundles and mounts disk images. The doc comment says the target 'comes from Session state by id, never from arbitrary frontend input', but artifact_restore is how arbitrary input enters that state.
- `src-tauri/src/main.rs:2407`: spawn_shell is referenced by the frontend only from splitTerminal (App.tsx:4377), which is unreachable (see ENG-04).
- `src-tauri/build.rs:14`: Plain tauri_build::build() with no app manifest, so there is no per-command permission set: every registered command is callable by any script that runs in the main webview.
- `src-tauri/capabilities/default.json:1`: The capability file scopes only core and plugin permissions. App commands are not listed, so it cannot narrow them.
- `README.md:1`: README says the module reachability check 'does not audit Rust command registration', so nothing flags this.

**Scenario / cost.** Getting script to run in the main webview would require a renderer bug: a sanitizer bypass in the Mermaid/Graphviz SVG path (DiagramBlock.tsx), a dependency compromise, or a future rehype-raw. Such a script can call invoke('artifact_restore', {artifact:{id:'x', path:'/Applications/Calculator.app', ...}}) and then invoke('artifact_open_external', {artifactId:'x'}) to launch any local app or file. It can also call pane_write against any live pane id. No UI in the shipping product uses any of these commands.

**Recommendation.** Remove the 44 unused commands from generate_handler! (and spawn_shell, once the dead split path is deleted). Change artifact_restore to restore by id from a backend-held undo buffer rather than from a renderer-supplied struct. Add a test that compares the generate_handler! list against the command strings in src/lib/api.ts, so registration drift fails CI. Longer term, define an app permission manifest (tauri_build::Attributes::app_manifest) and grant the main webview only the commands it uses.

### ENG-02 · P1 · correctness: No React error boundary anywhere: one render exception blanks the whole window, and the restored selection can repeat it on every launch

**Evidence**

- `src/App.tsx:9857`: App() returns <MainApp /> directly, with no boundary.
- `src/main.tsx:9`: createRoot(...).render(<App />) with no boundary, and there is no window.onerror or unhandledrejection handler anywhere in src/.
- `src/App.tsx:4663`: Startup reads ACTIVE_RESEARCH_TREE_KEY from localStorage and reopens that tree (setActiveResearchTreeId at 4699-4701).
- `src/components/research/ResearchThreadPage.tsx:1720`: The thread page also restores the saved selected node from navigation persistence on mount.
- `src-tauri/src/main.rs:3016`: The interface health probe runs only after wake, suspension, or display transitions (doc comment at 3011-3014). It is not a crash-recovery path.

**Scenario / cost.** An unexpected node shape throws during render of ResearchThreadPage, ResearchTurn, or TranscriptMarkdown. Examples: a body variant written by a newer build, a null in agent-authored data, a markdown plugin edge case. React 19 unmounts the entire tree, so the window is blank: no sidebar, no Settings, no way to navigate away. On relaunch, the startup code restores the same tree and node from localStorage, and the window goes blank again on every launch until the user clears WebKit storage by hand.

**Recommendation.** Add an app-level error boundary that renders a recovery screen with 'Go to Home' and a reload button, and that clears ACTIVE_RESEARCH_TREE_KEY and ACTIVE_RESEARCH_PANE_KEY when the error happens during the first render after restore. Add finer-grained boundaries around ResearchThreadPage, each feed card, and each TranscriptMarkdown block, so a bad node degrades to an inline error. Log caught errors to the backend's stderr so they reach diagnostics.

### ENG-03 · P1 · architecture: MainApp is one 8,690-line component that owns nearly all application state and logic

**Evidence**

- `src/App.tsx:1167`: function MainApp() runs from 1167 to 9855. In the file: 96 useState, 127 useRef, 69 useEffect, 7 useLayoutEffect, 97 useCallback, 29 useMemo, 29 addEventListener.
- `src/App.tsx:1167`: 472 component-level declarations, classified by name: ~138 research, feed, folder, draft, highlight, and tree; ~95 pane, terminal, split, and attach; ~84 agent, turn, queue, transcript, and thread graph; ~33 browser overlay and link handling; ~31 settings, remotes, shortcuts, and appearance; ~19 tab-title generation and OpenRouter.
- `src/App.tsx:5702`: The research event reducer (handleResearchEvent, about 320 lines, 5702-6019) is a closure over about 20 refs and setters, so it cannot be unit-tested.
- `src/App.tsx:8398`: About 1,450 lines of JSX (8398-9855) include the Settings dialog (two tabs, with remote editor, OpenRouter, and shortcut capture), the Agent Setup dialog, three confirm dialogs, the sidebar, the browser overlay wiring, and the link context menu.
- `src/App.tsx:1446`: Render-phase side effects run in the component body, for example refilling researchNodeEventCacheRef and the many `xRef.current = x` mirrors.

**Scenario / cost.** Cost to maintainers: any state change re-runs the whole 8.7k-line function body (hundreds of hook calls) once per 16 ms event batch. Correctness depends on hand-maintained ref mirrors and dependency arrays that are not linted (ENG-09). The event reducer and the selection and restore logic have no tests because they cannot be imported. Merge conflicts concentrate in a single file. The dead terminal surface (ENG-04) has stayed hidden because nobody can reason about the file as a whole.

**Recommendation.** First delete the dead pane-surface code (ENG-04), which removes roughly a quarter of the declarations. Then extract in this order: (1) handleResearchEvent and its snapshot patches into a pure reducer in src/lib/ (inputs are state plus event, outputs are next state plus effects), with tests; (2) research navigation and selection (selectResearchTree, focusResearchHome, restore, page history) into a useResearchSelection hook; (3) the Settings and Agent Setup dialogs into components that own their own state (remote drafts, probe state, OpenRouter test); (4) browser-overlay state and link handling into a useBrowserOverlays hook; (5) agent, turn, and queue state into a store, such as useSyncExternalStore over a small module, so that event handling does not re-render MainApp. Put the composed providers in App.tsx.

### ENG-04 · P2 · dead-code: The terminal-pane surface is unreachable: activeSurface can never become "pane", and the split and terminal-map code is dead

**Evidence**

- `src/App.tsx:1457`: useState<'pane' | 'research'>('research'). The only setter call is setActiveSurfaceState('research') at 1462, and activeSurfaceRef.current is only ever assigned 'research'.
- `src/App.tsx:1862`: researchSurfaceActive = activeSurface === 'research' is therefore always true. Every branch on activeSurface === 'pane' is dead (for example 1868, 2127, 2146, 3758, 7191, 7370, 7839, 9591).
- `src/App.tsx:1207`: splitPaneBelowRef and splitPaneRightRef, along with requestClosePaneRef, canToggleActiveTranscriptExpandedRef, and toggleActiveTranscriptExpandedRef, are assigned at 7187-7196 and never read. splitPaneBelow and splitPaneRight are reachable only through these refs, so splitTerminal (4357) and its spawnShell call (4377) are dead.
- `src/App.tsx:4397`: splitTerminal schedules an empty requestAnimationFrame(() => {}) callback, left over from a removed focus handoff.
- `src/App.tsx:1581`: terminalMapOpen is only ever set to false (6562). terminalMapOpenRef is write-only, and the terminalMapOpen ? sidebarPanes : ... branch at 2417 is dead.
- `src/App.tsx:585`: Terminal layout constants (TERMINAL_MIN_WIDTH, TERMINAL_SPLIT_*, TURN_PANE_*, DEFAULT_INITIAL_COLS/ROWS) still feed reservedTerminalStageWidth and the split math.
- `README.md:1`: The README says Session 'intentionally has no terminal surface, terminal tabs, transcript side pane, terminal map, shell launcher'.

**Scenario / cost.** TypeScript's noUnusedLocals does not catch values that are written but never read through ref.current, or branches guarded by a state value that never changes, so the code compiles. About 95 pane, terminal, and split declarations, src/lib/paneSplits.ts (1,343 lines), and the related effects still run or allocate on every render (for example the visibleTerminalPanes and activePaneSplit memos). Maintainers edit and review code that cannot execute.

**Recommendation.** Delete the pane-surface branch from MainApp: activeSurface state, the split, terminal-map, and pane-chrome refs, splitTerminal, and the turn-pane width logic. Then delete the frontend modules that are reachable only from that code. Keep the backend PTY and process infrastructure that research runs use (per AGENTS.md), but remove its IPC entry points that only the deleted code called (ENG-01). Extend scripts/check-unused-modules.mjs or add a lint rule (for example no-unused-private-class-members is not enough; use a small custom check for refs that are written but never read).

### ENG-05 · P2 · dead-code: Settings shows a Remotes tab that configures SSH hosts no reachable feature uses

**Evidence**

- `src/App.tsx:8636`: The Remotes tab is always rendered in the Settings tablist, with an editor, probe, and delete flow for saved SSH remotes (upsert_remote, probe_remote, delete_remote, list_ssh_config_aliases).
- `src/lib/api.ts:468`: remoteId reaches the backend only through spawnShell(...), whose only caller is the dead splitTerminal (ENG-04).
- `src/lib/api.ts:156`: Research workspaces are created by research_workspace_create_pick (a local folder picker).
- `src-tauri/src/research_runtime.rs:116`: launch_claude and launch_jsonl run with cwd = workspace.dir locally. PrepareAgentWorkspaceRequest has no remote field, and `remote:` appears in research_runtime.rs only in test fixtures (remote: None).

**Scenario / cost.** A user opens Settings → Remotes, adds a host, and the probe succeeds. Nothing in Home, the composer, or the workspace menu ever offers that remote, so the configuration has no effect. The tab also keeps about 250 lines of settings UI plus remoteStartup and remoteConnection state in MainApp.

**Recommendation.** Hide the Remotes tab, or remove it together with the frontend remote-startup tracking, until research runs support remote workspaces. If remote research is planned, track it explicitly and gate the tab behind that capability.

### ENG-06 · P2 · performance: Synchronous Tauri commands take the model lock and do file I/O on the macOS main thread, contrary to the file's own stated rule

**Evidence**

- `src-tauri/src/main.rs:1344`: A comment explains that list and refetch commands are async because sync commands run on the macOS main thread and park it on the model mutex while the persister or research settle holds it, which caused 'a visible stall'.
- `src-tauri/src/main.rs:1613`: list_research_highlights is sync. state.rs:4068 locks the model and walks every research node and highlight.
- `src-tauri/src/main.rs:1569`: list_research_drafts and list_research_folders (also sync) are called on every research.drafts.changed and research.folders.changed event.
- `src-tauri/src/main.rs:2330`: remove_research_tree is sync. state.rs:6925 takes research_document_lock and the model lock, then deletes one response snapshot file per node (7018-7023) and thread-graph files (7026-7036) on the main thread.
- `src-tauri/src/state.rs:2897`: persist_snapshot_locked clones the entire model (all research nodes, threads, artifacts, and queues) under the model lock every 200 ms while changes are happening (PERSIST_DEBOUNCE, state.rs:244).
- `src-tauri/src/main.rs:2314`: archive_research_tree, restore_research_tree, remove_research_branch, rename_research_*, set_research_*, save_research_draft, and reorder_* are also sync. In total, 52 sync commands are used by the frontend.

**Scenario / cost.** While a research run streams, the persister holds the model lock while it clones the model. The user opens the Highlights feed or deletes a large tree. The main thread blocks first on the lock and then on N unlink calls, so AppKit cannot pump events and the window stops responding to input and paint for the duration. The cost grows with the number of nodes, because both the scan and the clone are O(N).

**Recommendation.** Mark every command that locks the model or touches the filesystem as #[tauri::command(async)], or as async with spawn_blocking. Leave sync only the commands that must run on the main thread for AppKit. Move remove_research_tree's file deletion to a background thread after the event is emitted. Add a source-level test that fails if a #[tauri::command] fn (not async) calls .model.lock() or std::fs.

### ENG-07 · P2 · correctness: Backend event batches are handled without per-event isolation, so one throwing handler silently drops the rest of the batch

**Evidence**

- `src/hooks/useSessionEvents.ts:517`: flushPendingEvents splices the whole pending queue (pendingEvents.splice(0, length)) and then loops `for (const event of batch) handleEvent(event)` with no try/catch.
- `src/hooks/useSessionEvents.ts:213`: handleEvent calls onResearchChanged, which is App's handleResearchEvent: about 320 lines of snapshot patching that index nested optional data.
- `src/App.tsx:5702`: handleResearchEvent has no try/catch. Parse failures route to scheduleResearchRefresh, but exceptions thrown inside patch helpers do not.

**Scenario / cost.** A burst of 30 events arrives inside one 16 ms window. Event 3 throws, for example in a patchResearchSummaryForNode path receiving an unexpected previous node. Events 4-30 have already been removed from the queue and are never applied. These can include research.node.updated with a completion, agent status changes, or a pane removal. The UI shows a run as still running, or a stale tree list, until some unrelated event triggers a full refresh. The exception surfaces only as an uncaught error in a setTimeout callback.

**Recommendation.** Wrap each handleEvent(event) call in try/catch, log the event type and error, and schedule the existing full recovery path (scheduleResearchRefresh, plus a panes and agents refetch) when any handler throws. Add a unit test that feeds a batch with a throwing handler and asserts that later events are still applied.

### ENG-08 · P2 · error-handling: State persistence failures are written only to stderr; the user keeps working on changes that will be lost

**Evidence**

- `src-tauri/src/state.rs:2888`: persist_now: `if let Err(err) = self.persist_snapshot_locked() { eprintln!(...) }`. No event is emitted and no failure state is kept.
- `src-tauri/src/state.rs:3005`: finalize_persistence_for_exit handles the final snapshot the same way, logging to stderr only.
- `src-tauri/src/persistence.rs:1149`: save can fail on create_dir_all, write, fsync, or rename, for example from a full disk, a permission change on the workspace root, or a read-only external volume.

**Scenario / cost.** The workspace root is on an external volume that becomes read-only, or the disk fills up. Every debounced save fails while the UI continues to accept new research trees, drafts, highlights, and folder moves. On restart, everything since the first failure is gone. Shipping macOS builds have no visible stderr, so the user gets no signal at all.

**Recommendation.** Record the last persist error and its time in AppState, emit a session event (for example app.persistence.failed with the message) on the transition into failure and back out of it, and show a persistent banner in the frontend. Retry with backoff. On exit, if the final snapshot fails, block quit with a dialog that offers to retry.

### ENG-09 · P2 · maintainability: React hooks rules are not enforced: no ESLint in the desktop package, although the code relies on eslint-disable comments

**Evidence**

- `package.json:64`: devDependencies has no eslint or eslint-plugin-react-hooks, and no lint script. ESLint is configured only for web/.
- `src/hooks/useSessionEvents.ts:557`: `// eslint-disable-next-line react-hooks/exhaustive-deps` on the single global event subscription, which captures the handlers from the first render. Similar comments appear at App.tsx:4160, ResearchThreadPage.tsx:1095, and GithubAccountControl.tsx:184.
- `src/App.tsx:6019`: handleResearchEvent's dependency list omits refreshResearchDrafts, refreshResearchFolders, and invalidateResearchHighlights. They happen to be stable today, and useSessionEvents keeps the first-render instance forever.
- `src/App.tsx:2644`: showAppToast is a plain function in the deps of the feedSetupGuide useMemo (8316-8328), so the memo recomputes on every render and passes a new AgentSetupGuide element to the memoized ResearchActivityFeed while the setup guide is shown.

**Scenario / cost.** Running eslint-plugin-react-hooks 5.2.0 on a copy of src/ reported 48 exhaustive-deps warnings (23 in App.tsx, 8 in ResearchThreadPage.tsx) and 0 rules-of-hooks violations. Most are deliberate and refs are used to compensate, but nothing distinguishes deliberate omissions from accidental ones. A future refactor that makes scheduleResearchRefresh or focusResearchHome depend on changing state would silently leave the global event subscription calling a stale closure.

**Recommendation.** Add eslint plus eslint-plugin-react-hooks (and @typescript-eslint/parser) to the desktop package, wire it into `npm run check`, and turn each deliberate omission into an explicit disable with a reason. Wrap showAppToast in useCallback. For useSessionEvents, pass handlers through a ref that is updated each render (the 'latest ref' pattern) so the subscription is set up once and always calls current handlers.

### ENG-10 · P2 · testing: Test suite does not reach App.tsx, the hooks, the event coalescer, or the SVG sanitizer

**Evidence**

- `tests/:1`: 88 test files and 762 passing tests. None import src/App.tsx, src/hooks/useSessionEvents.ts, useResearchDrafts, useResearchFiling, useAppStartup (only src/lib/appStartup is tested), useResearchCardDrag, src/lib/sessionDrafts.ts, src/lib/api.ts, BrowserOverlay.tsx, or ResearchThreadPage.tsx.
- `src/components/DiagramBlock.tsx:117`: diagramSanitizerHook and sanitizeSvg are the boundary for agent-authored SVG injected with dangerouslySetInnerHTML into the privileged webview. No test covers them (tests/diagramLightbox.test.ts reads source text only).
- `src/App.tsx:5702`: The research event reducer: researchEvents.test.ts covers parseResearchEvent and patch helpers, but not the orchestration, which includes the cache, version counters, removed-tree tombstones, and recovery scheduling.
- `src/hooks/useSessionEvents.ts:517`: The 16 ms coalescing, ordering, and dispose-before-listen paths have no tests.

**Scenario / cost.** A DOMPurify upgrade or a change to the hook (for example href handling for xlink:href on <use>) could reopen an injection path into the main webview, which holds the IPC surface in ENG-01, and no test would fail. Regressions in event ordering or recovery, which are the bugs that show up as stale run status, can only be caught manually.

**Recommendation.** Add jsdom-based tests for sanitizeSvg with a corpus of payloads: <script>, on* handlers, foreignObject, javascript: and data: hrefs on <a> and <use>, external xlink:href, and <style> with url(). After extracting the reducer (ENG-03), table-test it with event sequences: create, update, remove, recovery, and out-of-order responses. Test useSessionEvents' batching with fake timers and a stub listenToEvents.

### ENG-11 · P3 · security: read_research_report reads any .md path supplied by the renderer, with no size limit

**Evidence**

- `src-tauri/src/main.rs:1729`: The only checks are that the extension is .md and that std::fs::read_to_string(path) succeeds. There is no root confinement, no check that the path came from a drop or picker, and no size cap.
- `src/components/research/ResearchReportImport.tsx:77`: The legitimate caller passes a path from a Tauri drag-drop event.

**Scenario / cost.** A script in the webview (see ENG-01 for the precondition) can read any Markdown file the user owns, such as notes or credential runbooks under ~/, and exfiltrate the contents through a later network-capable command. Separately, dropping a multi-gigabyte .md file loads all of it into the backend's memory and then serializes it over IPC into the webview before the import cap applies.

**Recommendation.** Capture drag-drop paths in Rust (WindowEvent::DragDrop) and let read_research_report accept only a path dropped within the last few seconds, or switch to the dialog plugin's picker. Check metadata().len() against the import character cap before reading.

### ENG-12 · P3 · accessibility: Settings and Agent Setup dialogs declare aria-modal but do not move, trap, or restore focus; the Settings tabs are only partly wired

**Evidence**

- `src/App.tsx:8605`: Settings panel: role=dialog, aria-modal=true, aria-labelledby. No ref, no initial focus, no Tab trap, and no focus restore on close. The only autoFocus inside is in the remote-add form (8697).
- `src/App.tsx:8562`: Agent Setup panel has the same pattern.
- `src/App.tsx:8623`: role=tablist with role=tab buttons that have aria-selected but no id or aria-controls. The tabpanels (8648, 8860) have no aria-labelledby. There is no arrow-key navigation, and every tab is a Tab stop.
- `src/components/research/ResearchFolderDialogs.tsx:85`: For comparison: the folder dialog implements trapFocus and initial focus correctly.

**Scenario / cost.** A keyboard or VoiceOver user presses Cmd-, and focus stays on the element behind the dialog. Tab moves through the obscured sidebar, and Escape closes the dialog without returning focus to the Settings button. aria-modal tells assistive technology that the background is inert when it is not.

**Recommendation.** Extract a shared Modal component, based on the folder dialog's trapFocus, that focuses the first control or the heading on open, traps Tab, and restores focus to the opener on close. Use it for Settings, Agent Setup, and the three confirm dialogs. Give tabs and panels ids with aria-controls and aria-labelledby, and implement roving tabindex with arrow-key navigation.

### ENG-13 · P3 · error-handling: Drafts tray turns any load failure into an empty list without reporting it

**Evidence**

- `src/hooks/useResearchDrafts.ts:37`: refresh(): catch { if (current request) setDrafts([]) }. The comment says this is intended for 'an older backend'. onError is not called.
- `src/App.tsx:5713`: refresh runs on every research.drafts.changed event, so a single failed reload clears a tray that was already populated.

**Scenario / cost.** A transient IPC failure during a drafts reload, for example while the backend is busy (see ENG-06, since list_research_drafts is sync), replaces the user's visible drafts with an empty tray and shows no error. The drafts are still on disk, but the user may believe they were deleted, or may start a new draft in place of the existing one.

**Recommendation.** On failure, keep the previous list and report the error through onError, or mark the tray stale and show a retry control. Treat only a known 'unsupported command' error as empty.

### ENG-14 · P3 · security: OpenRouter key is saved over IPC on every keystroke with errors discarded, and lives in renderer state despite the proxy's stated goal

**Evidence**

- `src/App.tsx:7599`: useEffect on settings.openRouterKey calls `void setOpenRouterKey(...).catch(() => undefined)` on each change. Every keystroke rewrites preferences.json, including fsync and rename (persistence.rs:367-399), and failures are dropped.
- `src-tauri/src/main.rs:643`: The doc comment says the proxy keeps 'the API key never leaves ... the Rust process' and out of 'the renderer heap'. However, openrouter_key_get returns the key to the renderer at startup (App.tsx:4602-4629), where it is stored in settings state.

**Scenario / cost.** When a save fails, for example because preferences.json is not writable, the field still shows the key but it is not stored, so title generation fails after restart with no explanation. Typing a 70-character key causes about 70 synchronous file replacements. The security property described in the comment does not hold, because the key is present in the renderer.

**Recommendation.** Save on blur or explicit confirm, or debounce by about 500 ms, and surface errors next to the field. Have openrouter_key_get return only whether a key is set and a masked suffix, and keep the full key in Rust. That matches the proxy's design.

### ENG-15 · P3 · error-handling: External-open calls discard rejections, so refusals and failures are invisible

**Evidence**

- `src/App.tsx:9753`: BrowserOverlay onOpenExternal: `void openExternalUrl(currentUrl)` without catch. The backend rejects non-http(s) URLs and file-server URLs (main.rs:863-876).
- `src/components/research/TweetEmbed.tsx:15`: There are further uncaught calls at TweetEmbed.tsx:362, 374, 427, 437, ResearchPost.tsx:88, GithubAccountControl.tsx:242, 283, 355, and App.tsx:3527.
- `src/main.tsx:1`: There is no global unhandledrejection handler.

**Scenario / cost.** The user clicks 'Open in external browser' on an overlay showing about:blank or another non-http page, or `open` fails to spawn. Nothing happens and no message is shown. The rejection is visible only in the WebKit inspector.

**Recommendation.** Route every openExternalUrl call through one helper that catches and reports through setError or a toast, and add a dev-mode unhandledrejection logger.

### ENG-16 · P3 · performance: useComposerPopOpen leaks one window listener per pointer press

**Evidence**

- `src/hooks/useComposerPopOpen.ts:62`: onPointerDownCapture adds `pointerup` and `pointercancel` listeners, both with {once:true}. Only one of the two fires, and the other stays attached to window.

**Scenario / cost.** Each click inside a composer leaves one pointercancel listener attached, because pointercancel rarely fires. After a long session there are hundreds of closures on window. When a pointercancel finally fires, for example from a trackpad gesture, all of them run and each schedules a setTimeout.

**Recommendation.** Register a single handler for both events and remove both inside it, or use an AbortController signal shared by the two listeners.

### ENG-17 · P3 · correctness: Folder membership of a removed tree is written back by the next folder save

**Evidence**

- `src-tauri/src/state.rs:6989`: remove_research_tree drops the tree's folder membership ('The grouping must not outlive the tree') but emits only research.tree.removed, not research.folders.changed.
- `src/App.tsx:5977`: The frontend's research.tree.removed handler does not refresh the folder store.
- `src/lib/researchFolderStore.ts:61`: commit() saves the entire ResearchFolderState, including the stale membership, through set_research_folders.
- `src-tauri/src/research.rs:119`: validate_research_folders checks folder names and ids only and accepts membership keys for tree ids that do not exist.

**Scenario / cost.** The user files tree A into folder F, deletes A, and then moves tree B into a folder. The commit sends a membership map that still contains A→F, and the backend persists it. Dangling membership entries accumulate in state.json, which the removal path was written to prevent.

**Recommendation.** In set_research_folders, drop membership keys that are not in model.research_trees. Also emit research.folders.changed from remove_research_tree and remove_research_workspace so the frontend store reloads.

### ENG-18 · P3 · security: File-server token-leak guard in open_external_url uses a string prefix match

**Evidence**

- `src-tauri/src/main.rs:1308`: is_file_server_url checks starts_with('http://127.0.0.1:{port}/') or 'http://localhost:{port}/'.
- `src-tauri/src/main.rs:878`: validated_preview_url in the same file parses the URL and compares scheme, host, and port, which is the correct approach.

**Scenario / cost.** A URL with the same token spelled as http://LOCALHOST:{port}/..., http://localhost.:{port}/..., or http://127.1:{port}/... passes the guard. macOS `open` then normalizes it and the token-bearing URL lands in the external browser's history, which is what the guard exists to prevent. Exploitation requires the caller to already have the token, so this is defense in depth.

**Recommendation.** Parse with url::Url, lowercase the host and strip any trailing dot, treat any loopback IP (127.0.0.0/8, ::1) and 'localhost' as loopback, and compare port_or_known_default(). Reuse the same helper in validated_preview_url.

### ENG-19 · P3 · performance: MainApp refills the research node cache from all activity and detail nodes on every render

**Evidence**

- `src/App.tsx:1446`: The component body loops over researchActivity and activeResearchDetail.nodes and calls Map.set for each node on every render of MainApp.
- `src/hooks/useSessionEvents.ts:51`: MainApp re-renders once per 16 ms event batch whenever any agent is active.

**Scenario / cost.** With a few thousand activity nodes, every event batch performs thousands of Map writes before any JSX work. The loop also overwrites the cache, which handleResearchEvent updates synchronously, with whatever the last committed state holds. That is correct today only because every event path also updates state with the same node.

**Recommendation.** Update the cache only where researchActivity and activeResearchDetail are set (the event handler, recovery, and refresh paths), or derive a Map with useMemo keyed on those arrays. Move the cache into the extracted reducer (ENG-03).
