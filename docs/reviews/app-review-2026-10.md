# Session desktop app review — October 2026

Scope: React frontend in `src/` and Rust backend in `src-tauri/src/` at commit 81f8998. Every issue below was traced to the cited lines. Machine-readable copy: [`docs/mockups/redesign/issues.json`](../mockups/redesign/issues.json).

Totals: 40 issues — 5 high, 17 medium, 18 low.

## Top themes

- Vocabulary overload is the main comprehension problem. Star, Bookmark, Follow, Highlight, Folder and Archive overlap; "folder" names two unrelated things; Home and Unfiled are one place with two names; menus and dialogs mix question, thread, conversation, branch and pair.
- The Ask/Post switch offers "Post to network", but no network transport exists, and a post's follow-up box defaults to that mode.
- First run is cluttered (composer, empty-feed text, Drafts and Archive trays with their own empty messages) and the agent setup guide disappears as soon as anything exists.
- Branching from a passage appears only after selecting text. The one standing hint uses internal wording ("pair").
- Performance cost is concentrated in the thread page: a 1 s full-content IPC poll per running node and a 1 s top-level clock that re-renders the ~5,000-line component.
- App.tsx (9,859 lines) and ResearchThreadPage.tsx (one ~5,000-line function) hold most behavior, with terminal-era code and dead CSS still mixed in.
- Accessibility: most modal dialogs do not contain Tab focus, tablists lack arrow keys, and Ctrl-Tab has two meanings depending on focus.
- Docs drift: README links a missing docs/home.md, lists stale and incomplete shortcuts, and Settings exposes an OpenRouter title option that has no effect on research.

## Index

| ID | Severity | Area | Title |
| --- | --- | --- | --- |
| S-01 | high | First use | "Post to network" publishes to nothing, and a post's follow-up box defaults to it |
| S-02 | high | First use | Six overlapping "keep track of this" concepts: Star, Bookmark, Follow, Highlight, Folder, Archive |
| S-03 | medium | First use | "Folder" means two different things: workspace directories and sidebar folders |
| S-04 | medium | First use | Agent setup guide disappears as soon as anything exists, including a post made without an agent |
| S-05 | medium | First use | First-run Home shows composer, empty-feed text, and expanded Drafts and Archive trays with their own empty messages |
| S-06 | medium | First use | Ask/Post switch is two unlabeled icons |
| S-07 | medium | First use | Branching from a passage is discoverable only by selecting text; the hint uses internal wording |
| S-08 | low | First use | Agent setup does not re-check after the user signs in; two refresh buttons do the same thing |
| S-09 | medium | Navigation & IA | Home and Unfiled are the same place under two names |
| S-10 | medium | Navigation & IA | The ask box moves between views: top of a scrolling feed on Home, end of list elsewhere |
| S-11 | low | Navigation & IA | Folder trays on Home sit below the entire Unfiled list |
| S-12 | medium | Interaction | Ctrl-Tab silently changes the model in the Home composer but moves between rows everywhere else |
| S-13 | low | Interaction | Three composer implementations with divergent keyboard and submit behavior |
| S-14 | medium | Accessibility | Most aria-modal dialogs do not contain Tab focus |
| S-15 | low | Accessibility | Settings and Agent Setup tablists lack arrow-key navigation and tab/panel association |
| S-16 | low | Accessibility | Reasons for disabled menu items are only in title tooltips, which keyboard users cannot reach |
| S-17 | low | Accessibility | Placeholder text is below 4.5:1 contrast while carrying primary instructions |
| S-18 | low | Accessibility | Reduced-motion overrides miss the running branch-marker pulse |
| S-19 | medium | Correctness | Text typed into the Home composer during submission is erased |
| S-20 | medium | Correctness | A post's follow-up draft is component-local and lost on navigation |
| S-21 | medium | Correctness | OpenRouter "Generate tab titles" setting has no effect on research titles |
| S-22 | low | Correctness | Auto-title can overwrite a rename made between the check and the write |
| S-23 | low | Correctness | Folder grouping is saved as a whole blob with last-writer-wins semantics |
| S-24 | low | Correctness | Legacy Home journal data is discarded on load without a dropped-data notice |
| S-25 | high | Performance | Running answers are fetched in full every second over IPC |
| S-26 | medium | Performance | The entire thread page re-renders once per second while any run is active |
| S-27 | medium | Performance | Home renders every folder's and Archive's cards without virtualization, expanded by default |
| S-28 | low | Performance | Browser overlay polls its snapshot every 500 ms and sets state on every result |
| S-29 | high | Architecture | App.tsx is a 9,859-line component that still carries terminal-era pane, worktree and remote logic |
| S-30 | high | Architecture | ResearchThreadPage is a single ~5,000-line function component |
| S-31 | medium | Architecture | Dead CSS for removed terminal surfaces is not covered by the unused-code check |
| S-32 | low | Architecture | Delete-research confirmation and dialog plumbing are implemented twice |
| S-33 | low | Architecture | focusPaneTab schedules an empty animation frame |
| S-34 | medium | Copy & docs | README links to docs/home.md, which does not exist |
| S-35 | medium | Copy & docs | Delete confirmation exposes internal terms ("descendant node", "freed inline slot") |
| S-36 | low | Copy & docs | README keyboard shortcuts are stale and incomplete |
| S-37 | low | Copy & docs | Browser close tooltip advertises Ctrl+Shift+E, which is not bound |
| S-38 | low | Copy & docs | Backend error strings with internal vocabulary are shown to users verbatim |
| S-39 | low | Copy & docs | "Follow" (notifications) and "follow-up" (a question) collide in copy |
| S-40 | low | Copy & docs | One object, several names: research, question, thread, conversation, branch, pair |

## First use

### S-01 · "Post to network" publishes to nothing, and a post's follow-up box defaults to it

**Severity:** high  
**Files:** `src/components/research/AskPostSwitch.tsx:5`, `src/components/research/AskPostSwitch.tsx:111`, `src/components/research/ResearchQueryComposer.tsx:398`, `src/components/research/ResearchQueryComposer.tsx:531`, `src/components/research/ResearchPost.tsx:376`, `src/lib/api.ts:266`, `src-tauri/src/research.rs:389`

The Home composer's second mode is labelled "Post to network" with the placeholder "Ask your network, or paste a link to save", and a post's follow-up field starts in that mode (useState<AskMode>("network")). The code's own comments state that network delivery is not built ("no transport yet"); the backend only records a PostDelivery whose sole status is Posted. A new user who picks this mode gets a local note that nobody receives, with no indication of that.

**Fix:** Until a transport exists, rename the mode to a local action (for example "Save as note"), default the follow-up field to Ask, and remove "network" from visible copy.

### S-02 · Six overlapping "keep track of this" concepts: Star, Bookmark, Follow, Highlight, Folder, Archive

**Severity:** high  
**Files:** `src/components/research/ResearchMoveMenu.tsx:62`, `src/components/research/ResearchMoveMenu.tsx:83`, `src/components/research/ResearchMoveMenu.tsx:155`, `src/components/research/ResearchTurn.tsx:740`, `src/components/research/ResearchSidebarNav.tsx:46`, `src/components/research/ResearchThreadPage.tsx:3855`

A question can be bookmarked (listed under Bookmarks), followed (notifications), filed in a folder, or archived; a follow-up or branch can be starred (listed under its question in the feed); a passage can be highlighted (listed under Highlights). Star and Bookmark both mean "show this somewhere else" but apply to different levels and surface in different places, and the row menu is literally titled "Bookmark, follow or move" / "Remove the star, bookmark, follow or move". No surface explains the difference.

**Fix:** Collapse Star and Bookmark into one "pin" concept that works at any level, keep Follow as a notification toggle, and add one-line explanations to the Bookmarks and Highlights empty states.

### S-03 · "Folder" means two different things: workspace directories and sidebar folders

**Severity:** medium  
**Files:** `src/components/research/ResearchWorkspaceSwitcher.tsx:183`, `src/components/research/ResearchWorkspaceSwitcher.tsx:191`, `src/components/research/ResearchSidebarNav.tsx:61`, `src/components/research/ResearchMoveMenu.tsx:119`, `src/lib/appShortcuts.ts:44`

A research workspace is a filesystem directory ("Open in Finder", "Move workspace folder…"), while the sidebar's Folders section holds virtual groupings created with "New folder…" inside a workspace. Both appear in the same sidebar, and the internal shortcut name for the workspace menu is openFolderMenu. A user cannot tell from the labels whether "New folder" creates a directory.

**Fix:** Reserve "folder" for one concept (sidebar groupings) and describe the workspace as a "workspace" or "location" everywhere, including "Move workspace…".

### S-04 · Agent setup guide disappears as soon as anything exists, including a post made without an agent

**Severity:** medium  
**Files:** `src/components/research/ResearchActivityFeed.tsx:1204`, `src/components/research/ResearchActivityFeed.tsx:1432`, `src/components/research/ResearchQueryComposer.tsx:341`, `src/App.tsx:8316`

The inline setup guide renders only while homeHasNothing is true (no items, drafts or trees). Posting needs no ready adapter (canSubmit allows askMode === "network" without one), so a user with no agent who tries the Post mode removes the only first-run guidance from Home. The same happens if agents later become unavailable after any research exists.

**Fix:** Show the setup guide (or a compact banner linking to it) whenever no adapter can launch research, independent of whether Home has content.

### S-05 · First-run Home shows composer, empty-feed text, and expanded Drafts and Archive trays with their own empty messages

**Severity:** medium  
**Files:** `src/components/research/ResearchActivityFeed.tsx:1009`, `src/components/research/ResearchActivityFeed.tsx:1435`, `src/components/research/ResearchActivityFeed.tsx:1463`, `src/components/research/ResearchFeedTray.tsx:12`

Home always renders trays for Drafts, every folder and Archive after the Unfiled list, expanded by default. On a fresh install the user sees "Research, posts, and saved links appear here", then "No drafts. Use Save draft in the composer…", then "Archive is empty. Archived questions stop sending follow-up notifications." Three empty states introduce three concepts before the first question is asked.

**Fix:** Hide empty trays on Home (they remain in the sidebar), so first run shows only the composer and a single explanatory line.

### S-06 · Ask/Post switch is two unlabeled icons

**Severity:** medium  
**Files:** `src/components/research/AskPostSwitch.tsx:79`, `src/components/research/AskPostSwitch.tsx:119`

The mode control is a radiogroup of two icon-only segments: the selected agent's logo (which also opens the model menu on a second press) and a Users glyph. Their meaning is only in title tooltips. The Ask segment doubles as a menu trigger, which a first-time user has no visual cue for beyond a 9px chevron.

**Fix:** Add visible text labels ("Ask", "Post") to the segments and move the model picker to its own labelled control.

### S-07 · Branching from a passage is discoverable only by selecting text; the hint uses internal wording

**Severity:** medium  
**Files:** `src/components/research/ResearchThreadPage.tsx:5730`, `src/components/research/ResearchThreadPage.tsx:5764`, `src/components/research/ResearchThreadPage.tsx:5541`

Branching, the product's core feature, is offered in a toolbar that appears only after a text selection, or under "Branch from the whole answer" in the answer's … menu. The only standing hint is the filler column text "Select a passage or a branch marker beside the answer to open it as the next pair", which uses the internal term "pair" and implies that selecting text opens a branch, when the user must then press Branch (or A).

**Fix:** Add a visible Branch control on each finished answer and rewrite the hint as "Select text in the answer, then choose Branch to ask about it".

### S-08 · Agent setup does not re-check after the user signs in; two refresh buttons do the same thing

**Severity:** low  
**Files:** `src/App.tsx:6481`, `src/components/AgentSetupGuide.tsx:135`, `src/components/AgentSetupGuide.tsx:224`

Readiness is probed when the Agent Setup dialog opens and on manual refresh only. After running `claude auth login` in a terminal the guide stays on the sign-in step until the user finds the refresh icon. The tab-row refresh and the footer "Refresh agent status" button both call the same onRefresh, which re-probes all agents.

**Fix:** Re-probe on window focus while the guide is visible, and keep a single refresh control with a text label.

## Navigation & IA

### S-09 · Home and Unfiled are the same place under two names

**Severity:** medium  
**Files:** `src/components/research/ResearchSidebarNav.tsx:48`, `src/components/research/ResearchMoveMenu.tsx:23`, `src/components/research/ResearchActivityFeed.tsx:1383`, `src/components/research/ResearchFeedTray.tsx:12`

The sidebar row is "Home" (with drop target RESEARCH_UNFILED_FOLDER_ID), but the Move to menu lists the same destination as "Unfiled" with a house icon, the feed section is labelled "Unfiled" for screen readers, and its empty text says "Nothing unfiled". Home also contains the folder trays, so it is simultaneously one place and the overview of all places.

**Fix:** Pick one name for the unfiled list (for example "Inbox") and use "Home" only for the overview page.

### S-10 · The ask box moves between views: top of a scrolling feed on Home, end of list elsewhere

**Severity:** medium  
**Files:** `src/components/research/ResearchActivityFeed.tsx:1211`, `src/components/research/ResearchActivityFeed.tsx:1359`, `src/components/research/ResearchActivityFeed.tsx:1462`, `src/components/research/ResearchActivityFeed.tsx:1495`

On Home the composer is the first child of the feed scroller and scrolls out of view; in Bookmarks and folders it is appended after the last card and reached via a "+ Ask" header button. Home therefore mixes an input surface and a reading surface in one scroll region, and the composer's location depends on the current view.

**Fix:** Dock the composer in a fixed position (top of the column, outside the scroller) in every feed view.

### S-11 · Folder trays on Home sit below the entire Unfiled list

**Severity:** low  
**Files:** `src/components/research/ResearchActivityFeed.tsx:1382`, `src/components/research/ResearchActivityFeed.tsx:1463`

Trays for Drafts, user folders and Archive render after the virtualized Unfiled list. With many unfiled questions the trays are only reachable by scrolling past all of them, and the sidebar is the only practical route to folders.

**Fix:** Either remove trays from Home (sidebar already lists folders) or render them as a compact summary above the Unfiled list.

## Interaction

### S-12 · Ctrl-Tab silently changes the model in the Home composer but moves between rows everywhere else

**Severity:** medium  
**Files:** `src/components/research/ResearchQueryComposer.tsx:494`, `src/components/research/ResearchColumns.tsx:154`, `src/lib/launcherKeyboard.ts:11`

In the Home ask box Ctrl-Tab cycles the model and Ctrl-Shift-Tab the agent; the handler stops the event so the column-level Ctrl-Tab row navigation never runs. Elsewhere the same keys select the next or previous row. A user who learned row navigation changes the model of their next launch without noticing, since the model is shown only on an icon segment.

**Fix:** Give model cycling its own chord (or remove it) so Ctrl-Tab has one meaning, and announce model changes in a live region.

### S-13 · Three composer implementations with divergent keyboard and submit behavior

**Severity:** low  
**Files:** `src/components/research/ResearchQueryComposer.tsx:540`, `src/components/research/ResearchPost.tsx:410`, `src/components/research/ResearchPost.tsx:459`, `src/components/research/ResearchConversationComposer.tsx:17`

ResearchQueryComposer, ResearchConversationComposer and PostFollowUpField each implement growth, Enter, Escape and submit separately. Escape in PostFollowUpField does not check isComposing (the Home composer does), so Escape during IME composition blurs the field; the post field disables its textarea while submitting but the Home field does not; only the Home field swallows Enter on empty text.

**Fix:** Extract a shared composer hook for key handling and submit lifecycle and use it in all three components.

## Accessibility

### S-14 · Most aria-modal dialogs do not contain Tab focus

**Severity:** medium  
**Files:** `src/App.tsx:8564`, `src/App.tsx:8607`, `src/App.tsx:9215`, `src/App.tsx:9264`, `src/App.tsx:9463`, `src/App.tsx:9519`, `src/components/CommandPalette.tsx:114`, `src/components/GithubAccountControl.tsx:228`, `src/components/research/researchFocus.ts:93`

There are 16 hand-rolled role="dialog" aria-modal="true" surfaces and one native <dialog>. Only those in ResearchThreadPage, ResearchTreeMenu and ResearchRecapDialog use trapResearchDialogTab, and ResearchFolderDialogs has its own copy; Settings, Agent Setup, the close/exit/rename/remote-delete confirmations in App.tsx, the command palette, the GitHub sign-in dialog and the lightboxes let Tab move into the page behind the scrim.

**Fix:** Use one dialog primitive (native <dialog> with showModal(), or a shared component using trapResearchDialogTab and useResearchDialogReturnFocus) for every modal.

### S-15 · Settings and Agent Setup tablists lack arrow-key navigation and tab/panel association

**Severity:** low  
**Files:** `src/App.tsx:8624`, `src/components/AgentSetupGuide.tsx:109`

Both use role="tablist"/role="tab" but every tab is in the Tab order and no handler responds to Left/Right/Home/End. The Settings tabs have no ids or aria-controls and the panels have no aria-labelledby. The AskPostSwitch in the same codebase implements roving tabindex correctly, so the pattern exists.

**Fix:** Apply roving tabindex and arrow-key handling to both tablists and link tabs to panels with aria-controls/aria-labelledby.

### S-16 · Reasons for disabled menu items are only in title tooltips, which keyboard users cannot reach

**Severity:** low  
**Files:** `src/components/research/ResearchMenu.tsx:12`, `src/components/research/ResearchMoveMenu.tsx:84`, `src/components/research/ResearchThreadPage.tsx:5543`

Menu navigation skips disabled items (ENABLED_ITEM_SELECTOR is [role^='menuitem']:not(:disabled)). Explanations such as why Follow is unavailable on an archived question or why branching is blocked ("Wait for the answer to finish") are set only as title attributes on those disabled items, so they are neither focusable nor announced.

**Fix:** Keep explanatory items focusable with aria-disabled="true" and expose the reason with aria-describedby or an inline note.

### S-17 · Placeholder text is below 4.5:1 contrast while carrying primary instructions

**Severity:** low  
**Files:** `src/styles/tokens.css:246`, `src/styles/tokens.css:598`, `src/styles/base.css:37`, `src/components/research/ResearchQueryComposer.tsx:531`

--placeholder-color is #6b726d in the dark theme (3.3–3.8:1 against field and panel backgrounds #111315–#1d2224) and #8e958f in the light theme (3.07:1 on #ffffff). Several fields have no other visible label, so placeholders such as "Ask your network, or paste a link to save" are the only instruction.

**Fix:** Raise placeholder tokens to at least 4.5:1 in each theme, or move instructions to visible helper text.

### S-18 · Reduced-motion overrides miss the running branch-marker pulse

**Severity:** low  
**Files:** `src/styles/features/research.css:1110`, `src/styles/reduced-motion.css:23`, `src/styles/reduced-motion.css:62`

.research-marker.is-running::after runs research-pulse infinitely. The reduced-motion rules stop .research-pulse and .research-feed-status.is-running but not this pseudo-element, so it keeps pulsing with the in-app Reduce motion setting or the OS preference enabled.

**Fix:** Add .research-marker.is-running::after to both the .reduce-motion and prefers-reduced-motion blocks.

## Correctness

### S-19 · Text typed into the Home composer during submission is erased

**Severity:** medium  
**Files:** `src/components/research/ResearchQueryComposer.tsx:346`, `src/components/research/ResearchQueryComposer.tsx:379`, `src/components/research/ResearchQueryComposer.tsx:525`, `src/App.tsx:6133`

submit() captures prompt.trim(), awaits onCreate/onPost (which first awaits an adapter probe and workspace resolution), then calls setPrompt("") and storeDraft(""). The textarea is not disabled while submitting, so anything the user types during that await is discarded without notice. PostFollowUpField avoids this by disabling its textarea.

**Fix:** Clear only if the field still equals the submitted text, or disable/readOnly the textarea while submitting.

### S-20 · A post's follow-up draft is component-local and lost on navigation

**Severity:** medium  
**Files:** `src/components/research/ResearchPost.tsx:375`, `src/components/research/ResearchThreadPage.tsx:1751`

PostFollowUpField keeps its text in useState(""). Conversation composers persist drafts through useResearchComposerDrafts and the Home composer through sessionDrafts, but leaving a post's thread column or switching questions discards an unsent follow-up. README advertises draft recovery after restart.

**Fix:** Store PostFollowUpField drafts through useResearchComposerDrafts keyed by the post node id.

### S-21 · OpenRouter "Generate tab titles" setting has no effect on research titles

**Severity:** medium  
**Files:** `src/App.tsx:9076`, `src/App.tsx:9098`, `src/App.tsx:3212`, `src/App.tsx:6030`, `src-tauri/src/title_generation.rs:39`

Settings offers "Generate tab titles" with an OpenRouter key, model and a test button, and says it "Sends the first message of each new tab to OpenRouter". The only consumer (firstMessageTitleConfig) runs for shell-launched Codex agents in terminal panes (registerShellCodexFirstMessageTitle), which the app no longer exposes. Research titles come from generate_research_agent_title using the node's own adapter. Users can store a third-party API key for a setting that does nothing visible.

**Fix:** Remove the setting from the UI, or route research title generation through it and rename it "Generate research titles".

### S-22 · Auto-title can overwrite a rename made between the check and the write

**Severity:** low  
**Files:** `src/App.tsx:6037`, `src/App.tsx:6046`, `src/App.tsx:6066`

applyGeneratedResearchTreeTitle fetches the whole tree with getResearchTree, compares the title to the original, then calls renameResearchTree in a separate IPC call. A user rename landing between the two calls is overwritten. The node variant has the same check-then-act gap, and both fetch a full tree detail just to read one title.

**Fix:** Add an expected-title parameter to the rename commands so the backend applies the generated title only if the title is unchanged.

### S-23 · Folder grouping is saved as a whole blob with last-writer-wins semantics

**Severity:** low  
**Files:** `src/lib/researchFolderStore.ts:57`, `src-tauri/src/state.rs:4001`, `src-tauri/src/state.rs:7406`

Each commit sends the full ResearchFolderState derived from the client's last-known state; the backend replaces its copy without a revision check. The backend also edits folders itself (workspace removal scrubs that workspace's folders), so a client write queued from pre-removal state can reintroduce removed folders or drop another window's change until the next refresh.

**Fix:** Add a revision to ResearchFolderState and reject stale writes, or send folder operations instead of whole snapshots.

### S-24 · Legacy Home journal data is discarded on load without a dropped-data notice

**Severity:** low  
**Files:** `src-tauri/src/persistence.rs:799`

The loader calls map.remove("journal") with the comment that saved links and X posts were replaced "without migration". Unlike neighbouring fields, nothing is pushed to the dropped list, so a user upgrading with journal entries loses them without a load warning; recovery depends on knowing about the migration backup files.

**Fix:** Record a dropped entry with the item count, or convert journal entries to link posts during migration.

## Performance

### S-25 · Running answers are fetched in full every second over IPC

**Severity:** high  
**Files:** `src/components/research/ResearchThreadPage.tsx:2411`, `src/components/research/ResearchThreadPage.tsx:2437`, `src-tauri/src/state.rs:4166`

For each active node in the open chain, the content loader calls getResearchNodeContent and, while the status is active, schedules the next call 1000 ms later. Each call takes the global model lock, clones the node and rebuilds its response turns, and the full payload replaces contentByNode state, re-rendering the page. This runs in addition to the research.* and turn.* event stream that already reports changes.

**Fix:** Drive content refresh from turn.appended/research.node.updated events (fetching deltas), and keep a slow poll only as a fallback.

### S-26 · The entire thread page re-renders once per second while any run is active

**Severity:** medium  
**Files:** `src/components/research/ResearchThreadPage.tsx:1126`, `src/components/research/ResearchThreadPage.tsx:4270`, `src/components/research/ResearchThreadPage.tsx:5009`

metadataNow is state on the top-level ResearchThreadPage function (lines 988–6005) and a 1 s interval updates it whenever chainNodes has an active run. It feeds only the elapsed-time labels, but every tick re-executes the ~5,000-line component body, its 76 useMemo/useCallback hooks and the render of every visible column.

**Fix:** Move elapsed-clock rendering into a small leaf component that owns its own interval.

### S-27 · Home renders every folder's and Archive's cards without virtualization, expanded by default

**Severity:** medium  
**Files:** `src/components/research/ResearchActivityFeed.tsx:992`, `src/components/research/ResearchActivityFeed.tsx:1009`, `src/components/research/ResearchActivityFeed.tsx:1463`, `src/components/research/ResearchFeedTray.tsx:84`

The Unfiled list is virtualized, but renderPlaceCards maps all trees of each tray (and ResearchArchivedFeed receives all trees) into the DOM. Trays are expanded unless the user collapsed them, so DOM size on Home grows linearly with the total number of filed and archived questions.

**Fix:** Collapse trays by default with a count and a short preview (for example the first five cards), or reuse the virtual list for tray content.

### S-28 · Browser overlay polls its snapshot every 500 ms and sets state on every result

**Severity:** low  
**Files:** `src/components/BrowserOverlay.tsx:59`, `src/components/BrowserOverlay.tsx:350`, `src/components/BrowserOverlay.tsx:384`

While the human browser overlay is open, pollLocation calls getHumanBrowserSnapshot every 500 ms and calls setHumanBrowserSnapshot with the result unconditionally, re-rendering the 1,196-line BrowserOverlay twice a second even when nothing changed. The comment describes polling as a fallback for same-document navigations.

**Fix:** Skip setState when the snapshot is unchanged and back off the poll interval when the URL has been stable.

## Architecture

### S-29 · App.tsx is a 9,859-line component that still carries terminal-era pane, worktree and remote logic

**Severity:** high  
**Files:** `src/App.tsx:585`, `src/App.tsx:1551`, `src/App.tsx:2063`, `src/App.tsx:4541`, `src/App.tsx:6460`

App has roughly 96 useState, 69 useEffect and 127 useRef call lines. Research navigation, settings UI, agent setup, OpenRouter titles, pane sizing (TERMINAL_MIN_WIDTH, TERMINAL_SPLIT_MIN_HEIGHT, DEFAULT_INITIAL_COLS), worktree dialogs and remote machine settings live in one function. Any state change re-renders the whole tree, and reviewers cannot reason about one feature without reading unrelated ones.

**Fix:** Extract settings, agent setup, research navigation and pane/process infrastructure into dedicated hooks and components with their own state.

### S-30 · ResearchThreadPage is a single ~5,000-line function component

**Severity:** high  
**Files:** `src/components/research/ResearchThreadPage.tsx:988`, `src/components/research/ResearchThreadPage.tsx:6006`

The file is 6,006 lines; the ResearchThreadPage function spans lines 988–6005 and contains selection/highlight handling, content loading, branch strips, composers, menus and three dialogs, with roughly 74 useState/useEffect calls. memo() at the export cannot help because internal state (including the 1 s clock) re-renders the whole body.

**Fix:** Split into a page shell plus column, selection-toolbar, content-loader hook and dialog modules, each owning its own state.

### S-31 · Dead CSS for removed terminal surfaces is not covered by the unused-code check

**Severity:** medium  
**Files:** `src/styles/features/shell.css:517`, `src/styles/features/shell.css:1201`, `src/styles/features/terminal.css:1`, `scripts/check-unused-modules.mjs:1`

shell.css (2,787 lines) still defines .pane-group, .command-launcher and related selectors that no .ts/.tsx file references; 46 of its 179 top-level class selectors have no string match in src. check:unused audits module reachability only, so stylesheet residue accumulates after each removal.

**Fix:** Delete the unreferenced rule sets and add a CSS class reachability step (or a CSS-module convention) to preflight.

### S-32 · Delete-research confirmation and dialog plumbing are implemented twice

**Severity:** low  
**Files:** `src/components/research/ResearchTreeMenu.tsx:222`, `src/components/research/ResearchThreadPage.tsx:5928`, `src/components/research/ResearchFolderDialogs.tsx:85`

Deleting a whole question has one dialog in ResearchTreeMenu ("Delete “title”?") and another in ResearchThreadPage ("Delete research" with different body copy). ResearchFolderDialogs re-implements Tab trapping instead of using trapResearchDialogTab. Wording and behavior drift between them.

**Fix:** Use one confirmation component for tree deletion and one shared focus-trap helper.

### S-33 · focusPaneTab schedules an empty animation frame

**Severity:** low  
**Files:** `src/App.tsx:6460`, `src/App.tsx:6469`

focusPaneTab ends with requestAnimationFrame(() => { }) whose body is empty, a leftover from removed terminal focus code. The surrounding comment still refers to native-terminal keyboard cycles.

**Fix:** Remove the empty callback and the stale comment.

## Copy & docs

### S-34 · README links to docs/home.md, which does not exist

**Severity:** medium  
**Files:** `README.md:149`

"See docs/home.md for the activity feed and its navigation and card actions." The docs/ directory contains css-conventions.md, dead-code-audit.md, ghostty-removal-plan.md, releasing.md and session-cutover.md only.

**Fix:** Write docs/home.md covering Home, trays, card menus and drag/keyboard reordering, or remove the link.

### S-35 · Delete confirmation exposes internal terms ("descendant node", "freed inline slot")

**Severity:** medium  
**Files:** `src/components/research/ResearchThreadPage.tsx:5960`

Deleting a follow-up that has later messages shows: "…everything after it in the thread — N descendant node(s) in total, including any branches. Its parent answer keeps the freed inline slot." This is the one place where a user most needs to understand consequences, and it is written in data-model terms.

**Fix:** Rewrite as "This deletes this follow-up, the N messages after it, and any branches from them. This can't be undone."

### S-36 · README keyboard shortcuts are stale and incomplete

**Severity:** low  
**Files:** `README.md:130`, `src/lib/appShortcuts.ts:38`, `src/lib/appShortcuts.ts:47`, `src/components/research/ResearchConversationComposer.tsx:24`

Cmd-J is described as focusing "the open document's follow-up composer" after the document→thread rename. Cmd-K (command palette), Cmd-Shift-E (source browser), Ctrl-Tab row/model cycling, Option-Up/Down reordering, Shift-Cmd-Enter (branch from composer) and the A/H selection keys are implemented but not listed.

**Fix:** Regenerate the shortcut list from appShortcuts.ts and the composer/selection handlers, using current nouns.

### S-37 · Browser close tooltip advertises Ctrl+Shift+E, which is not bound

**Severity:** low  
**Files:** `src/App.tsx:583`, `src/components/BrowserOverlay.tsx:790`, `src/lib/appShortcuts.ts:47`, `src-tauri/src/native_support.rs:648`

EXPAND_TOGGLE_SHORTCUT_LABEL is "⌘⇧E / Ctrl+Shift+E" and is shown as "Hide browser (Esc, …)". resolveAppShortcut requires metaKey && !ctrlKey for toggleSourceBrowser and the native table maps only Command-Shift-E.

**Fix:** Change the label to "⌘⇧E".

### S-38 · Backend error strings with internal vocabulary are shown to users verbatim

**Severity:** low  
**Files:** `src-tauri/src/state.rs:4176`, `src-tauri/src/state.rs:4664`, `src-tauri/src/state.rs:6450`, `src/components/research/ResearchQueryComposer.tsx:385`

About 31 call sites in src/components/research surface err.message directly. Backend messages include "research node {id} was not found" (17+ sites), "the research node is not a network post" and "The root of a research tree cannot be starred.", exposing node/tree terminology and ids.

**Fix:** Map backend error codes to user-facing messages in one frontend helper and keep ids out of displayed text.

### S-39 · "Follow" (notifications) and "follow-up" (a question) collide in copy

**Severity:** low  
**Files:** `src/components/research/ResearchFeedTray.tsx:14`, `src/components/research/ResearchMoveMenu.tsx:83`, `src/components/research/ResearchThreadPage.tsx:4823`

Follow/Unfollow toggles notifications for a question, while "follow-up" names a subsequent question. The Archive empty text says archived questions "stop sending follow-up notifications", which reads as either concept.

**Fix:** Rename Follow to "Notify me" / "Mute" and reword the Archive text to "Archived questions don't send notifications."

### S-40 · One object, several names: research, question, thread, conversation, branch, pair

**Severity:** low  
**Files:** `src/components/research/ResearchThreadPage.tsx:5549`, `src/components/research/ResearchThreadPage.tsx:5559`, `src/components/research/ResearchThreadPage.tsx:5858`, `src/components/research/ResearchThreadPage.tsx:5255`, `src/components/research/ResearchThreadPage.tsx:5297`, `README.md:14`

The same answer menu offers "Copy conversation as Markdown" and "Copy thread as Markdown"; the root is renamed via "Rename research" but deleted from the feed as a question; column resizers are "Resize thread column" in one layout and "Resize messages column" in another; README calls the unit a "research tree". The recent code-name renames did not extend to this copy.

**Fix:** Write a short glossary (question, follow-up, branch, answer) and align menu labels, dialog titles and README to it.

## Not included

- Visual contrast was checked only for text tokens against flat theme backgrounds; translucent overlays and hover states were not measured.
- Runtime behavior (actual IPC payload sizes, frame timings, VoiceOver output) was not measured; performance and screen-reader findings are derived from code paths.
- The `web/` application was out of scope.
