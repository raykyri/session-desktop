# Session desktop: UX review

Scope: product, information architecture, interaction design, copy, visual design and accessibility of the desktop frontend (`src/`), judged from source at commit 81f8998. The app was not run; Tauri APIs are required to load any data, so a browser build would show an empty feed. Line numbers refer to that commit.

Goal context: make first use understandable, and support both chatting with models and organizing thinking as an outline, knowledge base or graph.

Severity: **P0** blocks or seriously confuses first-time use; **P1** significant friction or a gap against the redesign goals; **P2** noticeable friction or an accessibility defect with a workaround; **P3** polish.

Counts: P0 3, P1 13, P2 17, P3 7 (total 40).

## Summary

| ID | Sev | Area | Title |
| --- | --- | --- | --- |
| UX-01 | P0 | first-run | First run puts the only primary action in a 240-300px side column and leaves the main stage empty |
| UX-02 | P0 | composer | 'Post to network' is offered in the main composer, but network delivery does not exist |
| UX-03 | P0 | thread view | A conversation cannot be read as a conversation: questions newest-first in one column, one answer at a time in another |
| UX-04 | P1 | terminology/copy | Workspace, Folder, Home/Unfiled, group and tab all name overlapping containers, and two of them share the folder icon |
| UX-05 | P1 | navigation/IA | Home shows only unfiled questions; filing a question removes it from the main list |
| UX-06 | P1 | organization | Star, Bookmark, Highlight, Follow and Archive are five separate 'keep this' marks with unclear differences |
| UX-07 | P1 | organization | A card's … button and its right-click menu are different menus; Rename, Archive and Delete are only in the hidden one |
| UX-08 | P1 | knowledge/linking | Follow-up versus branch is not explained, and branch UI never names the branch |
| UX-09 | P1 | knowledge/linking | Research trees have no outline or map view; structure is visible only as horizontal columns and margin markers |
| UX-10 | P1 | knowledge/linking | No search across research content; ⌘F covers only open columns and ⌘K matches titles of active trees |
| UX-11 | P1 | knowledge/linking | No links between threads, no backlinks, and highlights cannot carry notes |
| UX-12 | P1 | feedback/status | The model that answers is not visible: the composer shows an agent logo, answers hide the model in a menu |
| UX-13 | P1 | first-run | Agent setup does not notice a completed sign-in until the user presses an icon-only refresh |
| UX-14 | P1 | terminology/copy | Terminal-era copy is still shown in Settings and dialogs |
| UX-15 | P1 | terminology/copy | Internal implementation terms appear in user-facing messages |
| UX-16 | P1 | thread view | Answer actions sit on the question row in the other column; the answer column itself has no controls |
| UX-17 | P2 | composer | Composer hides the agent choice, mode switch and send button until it has focus |
| UX-18 | P2 | navigation/IA | The new-question composer moves between top and bottom of the feed, and there is no 'New question' button |
| UX-19 | P2 | first-run | First-run Home shows empty Drafts and Archive trays with explanatory text |
| UX-20 | P2 | organization | Feed cards have no metadata and show the full question text without clamping |
| UX-21 | P2 | feedback/status | Card status is an 8px colored dot whose tooltip cannot be reached and which hides on hover |
| UX-22 | P2 | navigation/IA | Settings mixes basic preferences with advanced and remote-machine configuration, and omits some that exist |
| UX-23 | P2 | terminology/copy | Copy points to 'Settings → Agents' and 'Review agents in Settings', but agents are a separate dialog |
| UX-24 | P2 | first-run | When no agent is ready, the composer and the setup guide show duplicate alerts |
| UX-25 | P2 | first-run | 'Login to GitHub' is a permanent sidebar call to action with no stated purpose |
| UX-26 | P2 | keyboard | ⌘K command palette is undiscoverable, thin, and not exposed correctly to assistive technology |
| UX-27 | P2 | keyboard | Shortcuts are numerous, overloaded and mostly hidden |
| UX-28 | P2 | accessibility | Settings and Agents dialogs do not move or contain focus; their tabs lack keyboard support |
| UX-29 | P2 | accessibility | Message-row controls are 22x20px |
| UX-30 | P2 | thread view | Users cannot select or copy text in their own questions or in feed cards |
| UX-31 | P2 | organization | Messages in a conversation can be reordered, which suggests the order changes the model's context |
| UX-32 | P2 | feedback/status | Feed and thread errors go to a global banner at the top of the window |
| UX-33 | P2 | performance-perceived | Startup shows an empty feed column with no loading indicator |
| UX-34 | P3 | feedback/status | Disabled actions explain themselves only in title tooltips |
| UX-35 | P3 | navigation/IA | Sidebar controls change position between expanded sidebar and icon rail |
| UX-36 | P3 | navigation/IA | Workspace switcher counts are missing for the first workspace, and scope hides all other workspaces |
| UX-37 | P3 | accessibility | Default placeholder color is below 4.5:1 contrast |
| UX-38 | P3 | visual | Font sizes bypass the type scale |
| UX-39 | P3 | performance-perceived | Folder and Archive trays on Home are not virtualized |
| UX-40 | P3 | terminology/copy | README links to a missing docs/home.md |

## Issues

### UX-01 · P0 · First run puts the only primary action in a 240-300px side column and leaves the main stage empty

**Area:** first-run

**Evidence**

- `src/App.tsx:9599`: The research stage is always ResearchColumns: the feed column plus a content column.
- `src/App.tsx:9717`: With nothing open, the content column (most of the window) shows only 'Select a question to open its conversation.'
- `src/lib/researchColumnWidths.ts:34`: Feed column defaults to 21% of the area, clamped to 240-300px.
- `src/components/research/ResearchActivityFeed.tsx:1359`: The Home composer is rendered inside that narrow feed column.
- `src/components/research/ResearchActivityFeed.tsx:1436`: The only first-run text: 'Research, posts, and saved links appear here. New ones start at the top.'
- `src/components/research/ResearchActivityFeed.tsx:1433`: When no agent is ready, the multi-step AgentSetupGuide is also squeezed into the feed column.

**Why it matters:** A new user sees a large empty pane with an instruction that refers to questions they do not have, and a one-line text field in a narrow side column. Nothing states what Session does, what a question, branch, or post is, or which agent will answer. The setup guide, which has tabs, steps and command lines, is rendered at 240-300px width.

**Recommendation:** Add an explicit empty state for the content column when no thread is open: a centered, wide composer (or the setup guide when no agent is ready) with a two-sentence explanation of questions, follow-ups and branches, plus 2-3 example prompts. Move the feed composer there on first run, or let the feed column take the full width until the first thread exists.

### UX-02 · P0 · 'Post to network' is offered in the main composer, but network delivery does not exist

**Area:** composer

**Evidence**

- `src/components/research/AskPostSwitch.tsx:5`: Comment: 'the network, which posts a post to Home (network delivery itself is not built yet)'.
- `src/components/research/AskPostSwitch.tsx:111`: The second segment is an icon-only Users button labelled 'Post to network'.
- `src/components/research/ResearchQueryComposer.tsx:531`: Placeholder in Post mode: 'Ask your network, or paste a link to save'.
- `src/components/research/ResearchQueryComposer.tsx:396`: Send label switches between 'Save link', 'Post to network' and 'Start research'.
- `src/App.tsx:8097`: Follow toast: 'Following. You'll be notified of replies.' (replies from whom is not stated).

**Why it matters:** The first control next to the text field implies a social feature (a 'network' of people) that the app does not have. Users either avoid it or post and wait for replies that never arrive. It also hides the feature the redesign needs: a way to write a note without asking an agent.

**Recommendation:** Rename the mode to 'Note' (text) and 'Save link' (single URL) and drop 'network' from all copy until delivery ships. Show the mode as a labelled segmented control ('Ask agent' / 'Write note') instead of two icons. Treat notes as first-class knowledge-base entries that can later be linked and branched from.

### UX-03 · P0 · A conversation cannot be read as a conversation: questions newest-first in one column, one answer at a time in another

**Area:** thread view

**Evidence**

- `src/components/research/ResearchThreadPage.tsx:5286`: The follow-up composer renders at the top of the messages column, above the list.
- `src/lib/researchChains.ts:168`: chainDisplayOrder reverses unlisted messages, so the newest question is listed first.
- `src/components/research/ResearchThreadPage.tsx:4951`: The answer column renders the answer of the single selected message only.
- `src/components/research/ResearchConversationComposer.tsx:30`: 'It scrolls with them (nothing is docked or sticky).'
- `src/components/research/ResearchTurn.tsx:605`: A message row is the user's message plus a meta line; answers never appear in this column.

**Why it matters:** Anyone using Session to chat with a model expects question, answer, question, answer in reading order with the input at the end. Here the second question appears above the first, the first answer disappears when the new one is selected, and there is no way to scroll through the exchange. Reviewing a 5-turn thread requires 5 selections. This conflicts directly with the 'chat with models' goal.

**Recommendation:** Offer a linear reading mode per level: questions and answers interleaved oldest-first, composer docked at the bottom, each answer collapsible to its recap. Keep the current messages-plus-answer pair as an 'outline' mode for long research. At minimum, list messages oldest-first and keep the composer sticky.

### UX-04 · P1 · Workspace, Folder, Home/Unfiled, group and tab all name overlapping containers, and two of them share the folder icon

**Area:** terminology/copy

**Evidence**

- `src/components/research/ResearchWorkspaceSwitcher.tsx:46`: Code comment acknowledges the conflict: a workspace is a folder on disk, while the feed's 'folders' file questions inside a workspace.
- `src/components/research/ResearchWorkspaceSwitcher.tsx:241`: The workspace trigger uses the Folder icon and shows the disk path.
- `src/components/research/ResearchFeedChrome.tsx:13`: User folders also use the Folder icon.
- `src/components/research/ResearchMoveMenu.tsx:23`: Move menu calls the Home place 'Unfiled' (with a House icon); the sidebar calls it 'Home'.
- `src/App.tsx:8260`: Toast: 'Sent. Moved from Drafts to Unfiled.'
- `src/App.tsx:9220`: Remote removal: 'Existing groups stay connected to this machine.'
- `src/App.tsx:9529`: Rename dialog titles: 'Rename workspace' / 'Rename group' / 'Rename tab'.

**Why it matters:** A new user sees a 'Folders' section in the sidebar and a folder-icon 'Default workspace' control at the bottom and cannot tell which one organizes questions. 'Unfiled' appears in toasts and menus but nowhere in navigation. 'Group' and 'tab' refer to terminal-era concepts with no visible counterpart.

**Recommendation:** Pick one vocabulary and apply it everywhere: e.g. 'Library' (disk location, rarely changed, moved into Settings or a top-level switcher with a distinct icon), 'Collections' or 'Folders' (organization inside it), and 'Inbox' for unfiled questions, used as the Home section label too. Remove 'group' and 'tab' from all user-facing strings.

### UX-05 · P1 · Home shows only unfiled questions; filing a question removes it from the main list

**Area:** navigation/IA

**Evidence**

- `src/components/research/ResearchActivityFeed.tsx:219`: researchFeedRows keeps only trees whose place is RESEARCH_UNFILED_FOLDER_ID on Home.
- `src/components/research/ResearchActivityFeed.tsx:1383`: The Home list's accessible name is 'Unfiled', while its visible heading is 'Home'.
- `src/components/research/ResearchActivityFeed.tsx:1464`: Below the list, Home appends a tray for Drafts, every user folder, and Archive.
- `src/components/research/ResearchFeedTray.tsx:12`: Empty Unfiled text: 'Nothing unfiled. New questions land here.'

**Why it matters:** 'Home' reads as 'everything recent', but moving a question into a folder makes it jump from the top list into a tray further down. Recent activity in filed questions is not surfaced at the top. Home also duplicates the sidebar's folder list as trays, so the page grows with every folder.

**Recommendation:** Either make Home a true recent-activity view across all places (with a place label on each card) and keep the inbox as its own sidebar entry, or rename Home to 'Inbox'. Drop the per-folder trays from Home or make them opt-in; the sidebar already lists folders.

### UX-06 · P1 · Star, Bookmark, Highlight, Follow and Archive are five separate 'keep this' marks with unclear differences

**Area:** organization

**Evidence**

- `src/components/research/ResearchTurn.tsx:740`: Star tooltip: 'Star: list this under its question in the feed'.
- `src/components/research/ResearchMoveMenu.tsx:61`: Bookmark and Follow are items in the card's menu.
- `src/components/research/ResearchSidebarNav.tsx:52`: Bookmarks and Highlights are top-level sidebar destinations; starred items have no destination.
- `src/components/research/ResearchFeedTray.tsx:14`: 'Archived questions stop sending follow-up notifications' ties Archive to Follow.
- `src/components/research/ResearchFeedCard.tsx:171`: Card menu label: 'Bookmark, follow or move'.

**Why it matters:** A new user must learn that Star applies to a follow-up or branch and promotes it in the feed, Bookmark applies to a whole question, Highlight applies to a passage, and Follow controls notifications. With no explanation, users pick one at random and later cannot find the item.

**Recommendation:** Collapse to two concepts: 'Pin' (any question, follow-up or branch; shown in a single Pinned view and under its parent card) and 'Highlight' (passages). Make notification behavior a per-thread setting with a sensible default (notify when a run I started finishes) instead of a Follow mark.

### UX-07 · P1 · A card's … button and its right-click menu are different menus; Rename, Archive and Delete are only in the hidden one

**Area:** organization

**Evidence**

- `src/components/research/ResearchActivityFeed.tsx:920`: onMenu (the … button) opens the move menu: Bookmark, Follow, Move to, New folder.
- `src/components/research/ResearchActivityFeed.tsx:924`: onContextMenu opens a different menu: Generate recap, Rename, Archive, Delete.
- `src/components/research/ResearchTreeMenu.tsx:8`: Archive and Delete carry single-key shortcuts A and D inside that context menu.
- `src/components/research/ResearchFeedCard.tsx:171`: The … button is labelled 'Bookmark, follow or move'.

**Why it matters:** Users who look for Rename or Delete in the visible … menu do not find them. Right-click is not discoverable on a card that looks like a list row, and the two menus contradict the recent change that makes a unit's context menu equal its … menu.

**Recommendation:** Use one menu for both triggers: Open, Rename, Pin, Move to ▸, Archive, Delete, in that order, with Generate recap under a secondary group.

### UX-08 · P1 · Follow-up versus branch is not explained, and branch UI never names the branch

**Area:** knowledge/linking

**Evidence**

- `src/components/research/ResearchConversationComposer.tsx:13`: ⇧⌘↵ sends as a new branch; the composer shows only a Send arrow, with no visible branch option.
- `src/components/research/ResearchColumnChrome.tsx:45`: Branch headers read 'Branch · 2 messages' instead of the branch question.
- `src/components/research/ResearchThreadPage.tsx:5730`: Filler copy: 'Select a passage or a branch marker beside the answer to open it as the next pair.'
- `src/components/research/ResearchThreadPage.tsx:5784`: The selection toolbar's action is 'Branch', not a verb describing what happens ('Ask about this').
- `src/components/research/ResearchTurn.tsx:753`: Branch count tooltip: 'marked in the answer's right margin'.

**Why it matters:** Branching is the product's main differentiator, but a new user cannot predict whether a question will continue the column or open a new pair to the right. Several open branches look identical in their headers, so users lose track of which column is which.

**Recommendation:** Show the branch question (or an editable title) in each branch header, with the quoted passage beneath. Label the selection action 'Ask about selection'. Add a visible 'Continue' / 'New branch' choice next to Send, and a one-time inline hint the first time an answer completes.

### UX-09 · P1 · Research trees have no outline or map view; structure is visible only as horizontal columns and margin markers

**Area:** knowledge/linking

**Evidence**

- `src/components/research/ResearchThreadPage.tsx:5727`: The thread page renders strip.columns: one messages/answer pair per open level.
- `src/components/research/ResearchTurn.tsx:747`: Branches are discoverable through a small count button on a message row.
- `src/components/research/ResearchFeedCard.tsx:233`: The feed lists only starred children under a card; other branches are not listed.
- `docs/mockups/interaction-candidates/index.html:1`: Mockups explore column motion only; none show a whole-tree overview.

**Why it matters:** For the 'organize thinking as an outline' goal, the user needs to see the whole tree: every question, its follow-ups, its branches and their status. Today only the currently open path is visible, so a tree with 10 branches can only be explored one column at a time.

**Recommendation:** Add an outline panel (toggleable, keyboard navigable, tree role) that lists every node indented by parent, with status, star/pin and recap on hover; clicking a node opens its path in the column strip. A graph view can come later on the same data.

### UX-10 · P1 · No search across research content; ⌘F covers only open columns and ⌘K matches titles of active trees

**Area:** knowledge/linking

**Evidence**

- `src/components/research/ResearchThreadPage.tsx:5703`: DomSearchBar 'Find in research' searches only the rendered columns of the open thread.
- `src/App.tsx:6600`: Palette commands are built from researchTrees titles; no content, highlights, drafts or archived items.
- `src/components/CommandPalette.tsx:34`: Filtering is a substring match on title, section and hint.

**Why it matters:** A knowledge base without search fails as soon as it holds more than a screenful of questions. Users cannot find an answer they remember a phrase from, a highlight, or an archived thread.

**Recommendation:** Add a global search (sidebar entry and ⌘K mode) over questions, answers, notes, highlights and drafts across places including Archive, with results grouped by thread and a jump to the matching passage.

### UX-11 · P1 · No links between threads, no backlinks, and highlights cannot carry notes

**Area:** knowledge/linking

**Evidence**

- `src/lib/wikilinks.ts:1`: '[[Term]]' markers are kept only for compatibility and stripped to plain text: 'new research does not generate these markers'.
- `src/components/research/ResearchHighlightsFeed.tsx:122`: Highlights feed lists passages grouped by thread with only Open and Remove.
- `src/components/research/ResearchThreadPage.tsx:5765`: Selection toolbar offers Branch, Highlight and Copy; there is no Link or Note action.

**Why it matters:** Knowledge accumulates in separate trees with no way to connect a finding in one to a question in another. This blocks the knowledge-base and knowledge-graph goals.

**Recommendation:** Let users reference another thread or passage from a note or question (e.g. '[[' autocomplete or 'Link to…' on selection), render it as a link, and show 'Referenced by' on the target. Allow a short note on each highlight and show it in the Highlights view.

### UX-12 · P1 · The model that answers is not visible: the composer shows an agent logo, answers hide the model in a menu

**Area:** feedback/status

**Evidence**

- `src/components/research/ResearchQueryComposer.tsx:426`: The model appears only in the Ask segment's aria-label/title ('Ask with Claude Opus …').
- `src/components/research/AskPostSwitch.tsx:99`: The visible Ask segment is the agent icon plus a 9px chevron.
- `src/components/research/ResearchThreadPage.tsx:5485`: Word count, duration and model summary are shown only as meta text inside the answer's … menu.
- `src/components/research/ResearchConversationComposer.tsx:37`: The follow-up composer has no agent/model display or picker.
- `src/App.tsx:8236`: A draft is sent with the Home composer's current agent and model, which the draft view does not show.

**Why it matters:** Users comparing models, or wondering why an answer is slow or shallow, cannot see which model and effort produced it. Sending a draft can silently use a different model from the one the user picked when writing it.

**Recommendation:** Show the model and effort as text in the composer row ('Claude Opus · high'), in each answer's footer next to time and duration, and in the follow-up composer (with a picker if switching is supported). Store and show the agent on drafts.

### UX-13 · P1 · Agent setup does not notice a completed sign-in until the user presses an icon-only refresh

**Area:** first-run

**Evidence**

- `src/App.tsx:6535`: Readiness re-probes on window focus only if the last check is at least 5 minutes old.
- `src/lib/agentSetup.ts:80`: 'Refresh status' is listed as a manual third step.
- `src/components/AgentSetupGuide.tsx:218`: The primary footer button is icon-only (RefreshCw) with aria-label 'Refresh agent status'.
- `src/components/AgentSetupGuide.tsx:129`: A second icon-only refresh button above does the same thing (both call onRefresh for all agents).
- `src/lib/adapterReadiness.ts:44`: Status pill label for needsAuth is 'Sign in', which reads as a button.

**Why it matters:** The expected flow is: copy the login command, run it in Terminal, switch back. On return the guide still says 'Sign in', so users conclude the login failed. The fix (a small unlabeled icon) is easy to miss.

**Recommendation:** Re-probe on every window focus while the setup guide or Agents dialog is visible, and poll every few seconds after a command is copied. Give the primary button a text label ('Check again'), remove the duplicate, and rename the status to 'Not signed in'.

### UX-14 · P1 · Terminal-era copy is still shown in Settings and dialogs

**Area:** terminology/copy

**Evidence**

- `src/App.tsx:9076`: Setting 'Generate tab titles'.
- `src/App.tsx:9098`: 'Sends the first message of each new tab to OpenRouter to summarize a title.'
- `src/App.tsx:8964`: Setting 'Use login shell' with no explanation.
- `src/App.tsx:9470`: Quit dialog: 'Quitting will close all N tabs and stop any running agents or processes.'
- `src/App.tsx:9496`: Quit pending label: 'Closing terminals...'.
- `src/App.tsx:8804`: Remote details list 'Multiplexer' and 'Session CLI'.

**Why it matters:** README states the app has no terminal surface or tabs, but Settings and the quit dialog talk about tabs, terminals and shells. New users wonder what they are missing; the settings they cannot map to anything add noise to the first Settings visit.

**Recommendation:** Rename to 'Generate thread titles' and 'Sends your first question to OpenRouter…'. Move 'Use login shell' under an Advanced section with a one-line explanation (e.g. 'Load your shell profile so agent CLIs find PATH and credentials'). Rewrite the quit dialog in terms of running research. Audit all strings in App.tsx for tab/terminal/group.

### UX-15 · P1 · Internal implementation terms appear in user-facing messages

**Area:** terminology/copy

**Evidence**

- `src/components/research/ResearchThreadPage.tsx:4802`: 'Waiting for the native session checkpoint before continuing.'
- `src/components/research/ResearchThreadPage.tsx:5960`: Delete dialog: '…descendant node(s) in total… Its parent answer keeps the freed inline slot.'
- `src/components/research/ResearchThreadPage.tsx:5730`: '…to open it as the next pair.'
- `src/components/research/ResearchColumnChrome.tsx:63`: Badge tooltip: 'point-in-time copy of an imported conversation' (code comment says 'terminal conversation').
- `src/components/BrowserOverlay.tsx:1014`: Browser engine toggle: 'Use the mirrored Chromium agent browser' vs 'Use the WebKit browser'.
- `src/lib/adapterReadiness.ts:59`: 'Install <binary> or configure its binary path.' There is no binary-path setting in the UI.

**Why it matters:** These strings describe internal data structures. A user reading them cannot decide what to do, and the binary-path advice points to a setting that does not exist in the interface.

**Recommendation:** Rewrite in task terms: 'Preparing to continue… (a few seconds)'; 'Deletes this follow-up and the N follow-ups and branches after it.'; 'Select text in the answer to ask about it.'; 'Your browser' / 'Agent's browser'. For a missing binary, link to the install command and to the config file location.

### UX-16 · P1 · Answer actions sit on the question row in the other column; the answer column itself has no controls

**Area:** thread view

**Evidence**

- `src/components/research/ResearchThreadPage.tsx:4985`: The answer column header is an empty drag bar.
- `src/components/research/ResearchTurn.tsx:766`: The '…' (Answer actions) button is on the message row in the messages column.
- `src/components/research/ResearchThreadPage.tsx:5541`: Branch from the whole answer, Copy answer, Retry, Generate recap, Rename and Delete all live in that menu.

**Why it matters:** Users reading an answer look for Copy, Branch or Retry next to it. The controls are on a 22x20px button in a different column, labelled with an ellipsis. Copy-the-answer, the most common action in a chat tool, takes three steps.

**Recommendation:** Add an action bar at the end (and optionally the top) of each answer: Copy, Ask about this answer, Retry, and a … menu for the rest. Keep the row's … as a shortcut to the same menu.

### UX-17 · P2 · Composer hides the agent choice, mode switch and send button until it has focus

**Area:** composer

**Evidence**

- `src/components/research/ResearchQueryComposer.tsx:311`: expanded = focused || Boolean(prompt).
- `src/components/research/ResearchQueryComposer.tsx:571`: The row with Ask/Post, model menu and send renders only when expanded.
- `src/components/research/ResearchQueryComposer.tsx:657`: Save draft appears only once there is text.
- `src/components/research/ResearchQueryComposer.tsx:494`: ⌃Tab cycles model and ⌃⇧Tab the agent, with no visible hint.

**Why it matters:** At rest the composer is a bare one-line field. A new user does not learn that they can choose an agent, that drafts exist, or what Enter will do, until they click into it.

**Recommendation:** Keep the controls row visible at rest on Home (it costs one line), with the model name as text. Collapse only in narrow folder views.

### UX-18 · P2 · The new-question composer moves between top and bottom of the feed, and there is no 'New question' button

**Area:** navigation/IA

**Evidence**

- `src/components/research/ResearchActivityFeed.tsx:1359`: On Home the composer starts the list.
- `src/components/research/ResearchActivityFeed.tsx:1462`: In Bookmarks it ends the list; in a folder it follows the cards (line 1495).
- `src/components/research/ResearchActivityFeed.tsx:1217`: A '+ Ask' header button scrolls to it ('Go to the ask box').
- `src/components/research/ResearchSidebarNav.tsx:157`: Sidebar and rail have no New question entry; ⌘N is the only global path and is labelled 'Home' in the palette (App.tsx 6611).

**Why it matters:** The primary action has no fixed position. In a long folder the composer is off-screen at the bottom, and '+ Ask' does not say it scrolls rather than opening a new question.

**Recommendation:** Add a persistent 'New question' button at the top of the sidebar/rail (⌘N) that opens a composer in the content column, pre-filed into the current folder. Keep the composer at the top in every feed view.

### UX-19 · P2 · First-run Home shows empty Drafts and Archive trays with explanatory text

**Area:** first-run

**Evidence**

- `src/components/research/ResearchActivityFeed.tsx:1009`: Drafts and Archive trays are always appended to Home.
- `src/components/research/ResearchActivityFeed.tsx:994`: Empty trays render researchPlaceEmptyText.
- `src/components/research/ResearchFeedTray.tsx:14`: 'Archive is empty. Archived questions stop sending follow-up notifications.'

**Why it matters:** The first screen contains three empty-state messages about features the user has not used (Drafts, Archive, notifications). They compete with the one thing to do: ask a question.

**Recommendation:** Hide empty trays on Home, or hide all trays until the user has at least one question.

### UX-20 · P2 · Feed cards have no metadata and show the full question text without clamping

**Area:** organization

**Evidence**

- `src/components/research/ResearchFeedCard.tsx:148`: Comment: cards have 'no metadata row'.
- `src/styles/features/feed.css:768`: 'Show the full question'; .research-feed-card-question has no line clamp.
- `src/components/research/ResearchActivityFeed.tsx:873`: The card body is the full prompt; no date, agent, follow-up or branch count.

**Why it matters:** Scanning a list of questions to find yesterday's Claude run is slow: every card looks the same apart from text, and a pasted multi-paragraph prompt produces a card taller than the 240-300px column is wide.

**Recommendation:** Clamp the question to 3 lines and add a quiet meta line: relative time, agent/model, follow-up and branch counts, and a text status ('Running 2m', 'Failed').

### UX-21 · P2 · Card status is an 8px colored dot whose tooltip cannot be reached and which hides on hover

**Area:** feedback/status

**Evidence**

- `src/components/research/ResearchFeedCard.tsx:222`: The status dot carries title={statusLabel}.
- `src/styles/features/feed.css:851`: .research-feed-status has pointer-events: none, so the title never shows.
- `src/styles/features/feed.css:874`: The dot is hidden (opacity 0) on hover and focus.
- `src/styles/features/feed.css:822`: Unread (blue), running (amber, pulsing) and failed (red) dots share the same corner.

**Why it matters:** Sighted users must infer meaning from color alone; with Reduce motion the running pulse stops, leaving only hue. Hovering to learn more removes the dot.

**Recommendation:** Use a short text or icon+text status in the meta line ('Running', 'Failed', 'New'), keep it visible on hover, and move the hover controls so they do not cover it.

### UX-22 · P2 · Settings mixes basic preferences with advanced and remote-machine configuration, and omits some that exist

**Area:** navigation/IA

**Evidence**

- `src/App.tsx:8627`: Two tabs only: 'Basic' and 'Remotes'.
- `src/App.tsx:8898`: Basic contains a global show/hide hotkey capture, login shell and OpenRouter keys next to Appearance.
- `src/App.tsx:8651`: Remotes tab: SSH config import, multiplexer, workspace root.
- `src/lib/settings.ts:233`: showNotifications exists and gates notifications but has no control in Settings.
- `src/App.tsx:8568`: Agents are a separate dialog titled 'Agent Setup', reached from a different button.

**Why it matters:** First-time Settings visitors see SSH and API-key fields before finding notification or agent settings. Agent configuration, the most likely reason to open Settings, is not in Settings at all.

**Recommendation:** Organize Settings into General (send key, appearance, notifications), Agents (the current setup guide), Research (instructions, title generation), and Advanced (login shell, hotkey, remotes).

### UX-23 · P2 · Copy points to 'Settings → Agents' and 'Review agents in Settings', but agents are a separate dialog

**Area:** terminology/copy

**Evidence**

- `README.md:27`: '…before opening **Settings → Agents**.'
- `src/App.tsx:8244`: Error: 'No research agent is ready. Review agents in Settings.'
- `src/App.tsx:8551`: Agents open as their own dialog from a Bot icon, not a Settings tab.
- `src/components/research/ResearchQueryComposer.tsx:650`: Composer button reads 'Review agents'.

**Why it matters:** Users follow the instruction, open Settings, see Basic and Remotes, and find no agents.

**Recommendation:** Make Agents a Settings tab (see the Settings issue) or change every reference to 'Agents (sidebar)'.

### UX-24 · P2 · When no agent is ready, the composer and the setup guide show duplicate alerts

**Area:** first-run

**Evidence**

- `src/components/research/ResearchQueryComposer.tsx:632`: A role=alert paragraph with the adapter message and a 'Review agents' button under the composer.
- `src/App.tsx:8316`: The full AgentSetupGuide is also rendered on Home in the same state.

**Why it matters:** Two separate blocks describe the same problem with different wording, and the role=alert text is announced to screen readers on load.

**Recommendation:** When the setup guide is shown, suppress the composer's alert and disable the composer with a short 'Set up an agent below to ask questions' hint. Use role=status, not alert, for a persistent state.

### UX-25 · P2 · 'Login to GitHub' is a permanent sidebar call to action with no stated purpose

**Area:** first-run

**Evidence**

- `src/App.tsx:8541`: GithubAccountControl renders at the bottom of the sidebar.
- `src/components/GithubAccountControl.tsx:315`: Signed-out label: 'Login to GitHub'.

**Why it matters:** A prominent sign-in button implies an account is required. Nothing explains what GitHub access enables. 'Login' is also a noun; the verb is 'Log in' or 'Sign in'.

**Recommendation:** Move it to Settings → Accounts with a one-line purpose ('Lets agents read private repositories' or whatever it actually enables), or show it only when a feature needs it. Use 'Sign in with GitHub'.

### UX-26 · P2 · ⌘K command palette is undiscoverable, thin, and not exposed correctly to assistive technology

**Area:** keyboard

**Evidence**

- `README.md:127`: Keyboard shortcuts list omits ⌘K.
- `src/App.tsx:6607`: Only four actions: Home, Toggle sidebar, Open Settings, Open Agents.
- `src/components/CommandPalette.tsx:118`: The input has no label and no role=combobox, aria-controls or aria-activedescendant.
- `src/components/CommandPalette.tsx:141`: Options are buttons that never receive focus, so arrow-key selection is not announced.

**Why it matters:** Keyboard users cannot find the palette, and once found it cannot create a question, open Bookmarks, Highlights, Drafts or a folder, or move a thread. Screen reader users hear nothing while arrowing.

**Recommendation:** Add New question, every sidebar destination, folders, Move to…, Archive and search to the palette. Show ⌘K in the sidebar. Implement the combobox/listbox pattern with aria-activedescendant.

### UX-27 · P2 · Shortcuts are numerous, overloaded and mostly hidden

**Area:** keyboard

**Evidence**

- `src/lib/launcherKeyboard.ts:11`: In the Home composer ⌃Tab cycles the model and ⌃⇧Tab the agent.
- `src/lib/researchSiblingCycle.ts:1`: Elsewhere in the columns ⌃Tab / ⌃⇧Tab select the next or previous row.
- `src/components/research/ResearchConversationComposer.tsx:24`: ⇧⌘↵ sends as a branch; no visible hint.
- `src/components/research/ResearchThreadPage.tsx:5778`: Selection toolbar single-key shortcuts A (Branch) and H (Highlight).
- `src/components/research/ResearchActivityFeed.tsx:1336`: ⌥↑/⌥↓ reorder cards.
- `README.md:127`: README lists 7 shortcuts; ⌘K, ⌘F, ⌃Tab, ⇧⌘↵, ⌥↑/↓, A/H/D are missing.

**Why it matters:** The same chord means different things depending on focus, and many capabilities (branch from composer, reorder, cycle siblings) exist only as shortcuts users will not find.

**Recommendation:** Add a shortcuts sheet (⌘/ and a palette entry). Give ⌃Tab one meaning; move model cycling to the model menu. Surface ⇧⌘↵ as a visible 'Send as branch' option.

### UX-28 · P2 · Settings and Agents dialogs do not move or contain focus; their tabs lack keyboard support

**Area:** accessibility

**Evidence**

- `src/App.tsx:8561`: Agents dialog: role=dialog aria-modal, but no initial focus or focus trap.
- `src/App.tsx:8604`: Settings dialog: same; focus stays on the trigger behind the backdrop.
- `src/App.tsx:8624`: Settings tabs are role=tab buttons with no arrow-key handling, roving tabindex or aria-controls; tabpanels (8648, 8860) have no aria-labelledby.
- `src/components/AgentSetupGuide.tsx:109`: Agent tabs: same pattern without arrow keys.
- `src/components/research/ResearchThreadPage.tsx:5854`: Contrast: research dialogs do call trapResearchDialogTab.

**Why it matters:** Keyboard and screen reader users open Settings and are left outside it; Tab moves through the page underneath. aria-modal without focus management makes the rest of the page unreachable to some screen readers while focus is still there.

**Recommendation:** Reuse the research dialog helpers (initial focus, trapResearchDialogTab, return focus) for Settings and Agents, or use the native <dialog> element as ResearchReportImport does. Implement the WAI-ARIA tabs pattern.

### UX-29 · P2 · Message-row controls are 22x20px

**Area:** accessibility

**Evidence**

- `src/styles/features/research.css:938`: .research-msg-button: min-width 22px, height 20px (Star, branch count, Answer actions).
- `src/styles/features/feed.css:358`: Ask/Post segments are 24px tall.

**Why it matters:** These are the main per-message actions. Targets under 24x24 CSS px fail WCAG 2.2 SC 2.5.8 and are hard to hit with a trackpad, especially when they appear only on hover.

**Recommendation:** Raise interactive targets to at least 24x24 (28 preferred) or add invisible padding to the hit area.

### UX-30 · P2 · Users cannot select or copy text in their own questions or in feed cards

**Area:** thread view

**Evidence**

- `src/styles/features/research.css:846`: .research-msg-row[data-research-card] sets user-select: none when the column is reorderable (2+ messages).
- `src/styles/features/feed.css:654`: Feed cards and child rows set user-select: none.
- `src/components/research/ResearchTurn.tsx:698`: A pointer press anywhere on the row starts a drag.

**Why it matters:** Copying part of a previous question to reuse it, a frequent chat action, is impossible once a conversation has two messages. The whole row being a drag handle also makes accidental reorders likely.

**Recommendation:** Restrict drag to the grip handle (which already exists visually) and allow text selection in the row body.

### UX-31 · P2 · Messages in a conversation can be reordered, which suggests the order changes the model's context

**Area:** organization

**Evidence**

- `src/lib/researchChains.ts:155`: chainDisplayOrder applies a stored display order separate from the chain.
- `src/components/research/ResearchTurn.tsx:605`: Rows of a column with 2+ messages are draggable.
- `src/components/research/ResearchThreadPage.tsx:5290`: The messages list is a drop target (data-research-drop-kinds='message').

**Why it matters:** In a chat, order is causal: each answer saw the questions before it. Reordering the display without changing the context lets the list misrepresent what the model knew, and nothing on screen says the reorder is cosmetic.

**Recommendation:** Remove reordering in linear conversations, or limit it to an explicit outline mode and label it ('Display order only; does not change what the agent saw').

### UX-32 · P2 · Feed and thread errors go to a global banner at the top of the window

**Area:** feedback/status

**Evidence**

- `src/App.tsx:9565`: A single error-banner in <main> receives setError.
- `src/App.tsx:9634`: The feed passes onError={setError}.
- `src/App.tsx:9697`: The thread page passes onError={setError}.
- `src/App.tsx:9821`: Separate app toast, research toast (9830) and notification stack (9815) also exist.

**Why it matters:** An error caused by an action in a menu or column appears far from it. Three toast/notification systems with different positions and styles make feedback inconsistent.

**Recommendation:** Show errors inline at the control or column that caused them (the composer already does this), keep the banner for app-level failures, and merge the toast systems into one.

### UX-33 · P2 · Startup shows an empty feed column with no loading indicator

**Area:** performance-perceived

**Evidence**

- `src/App.tsx:9603`: The feed renders `config ? … : null`; until config loads the column is empty.
- `src/App.tsx:8285`: The composer is also null until configAdapters exists.

**Why it matters:** On a slow start the first impression is a blank window with a placeholder sentence, which reads as broken.

**Recommendation:** Render the feed header and a skeleton list immediately, with a 'Loading research…' status.

### UX-34 · P3 · Disabled actions explain themselves only in title tooltips

**Area:** feedback/status

**Evidence**

- `src/components/research/ResearchTreeMenu.tsx:79`: 'Research with active runs cannot be archived' as title on a disabled item.
- `src/components/research/ResearchThreadPage.tsx:5983`: The delete dialog's confirm button is disabled during active runs with no message in the dialog.
- `src/components/research/ResearchMoveMenu.tsx:85`: Follow's disabled reason is a title attribute.

**Why it matters:** Keyboard users and touch-trackpad users never see title tooltips, so a greyed-out item has no explanation.

**Recommendation:** Render the reason as visible secondary text in the menu item and in the dialog body, and offer 'Stop runs and delete'.

### UX-35 · P3 · Sidebar controls change position between expanded sidebar and icon rail

**Area:** navigation/IA

**Evidence**

- `src/App.tsx:8482`: Expanded: Settings, Agents and theme toggle in the header, top right; workspace and GitHub at the bottom.
- `src/App.tsx:8432`: Rail: workspace (with GitHub inside its menu), Agents, theme and Settings in the footer.
- `src/components/research/ResearchFeedChrome.tsx:18`: The 'Home' title is visually hidden while the rail is shown.

**Why it matters:** Users who collapse the sidebar (or hit the narrow-window breakpoint) must relearn where Settings is, and lose the visible page title on Home.

**Recommendation:** Keep the same order in both states (account/settings at the bottom), and keep the feed title visible.

### UX-36 · P3 · Workspace switcher counts are missing for the first workspace, and scope hides all other workspaces

**Area:** navigation/IA

**Evidence**

- `src/components/research/ResearchWorkspaceSwitcher.tsx:148`: Counts render only when index > 0.
- `src/lib/researchScope.ts:3`: Research is scoped to exactly one workspace; there is no all-workspaces view.
- `src/components/research/ResearchWorkspaceSwitcher.tsx:116`: 'Default research' is renamed to 'Default workspace' only in this menu.

**Why it matters:** The first entry looks different from the others, and users with several workspaces cannot see or search across them.

**Recommendation:** Show counts for every workspace, use one display name everywhere, and consider an 'All workspaces' scope for Home and search.

### UX-37 · P3 · Default placeholder color is below 4.5:1 contrast

**Area:** accessibility

**Evidence**

- `src/styles/tokens.css:246`: Dark --placeholder-color #6b726d: about 3.7:1 on #131517 and 3.5:1 on #1c1b1a.
- `src/styles/tokens.css:598`: Light --placeholder-color #8e958f: about 2.8:1 on #f4f6f5.
- `src/styles/base.css:35`: Applies to every input and textarea placeholder without an override (palette, settings, browser address).

**Why it matters:** Placeholders carry instructions ('Type a command or search…', 'Enter a URL'); low-vision users cannot read them.

**Recommendation:** Use --text-faint (about 5:1 in both themes, already used by the composers) as the default placeholder color.

### UX-38 · P3 · Font sizes bypass the type scale

**Area:** visual

**Evidence**

- `src/styles/tokens.css:189`: The scale defines --fs-xs 11px, --fs-sm 12px, --fs-base 13px, --fs-input 15px.
- `src/styles/features/research.css:952`: Example of an ad-hoc size: calc(11.5px + offset).
- `src/styles/features/*.css`: About 30 distinct font-size expressions are in use, including 10.5, 11.5, 12.5 and 13.5px literals (19 uses of calc(12.5px …) alone).

**Why it matters:** Half-pixel steps produce a hierarchy that is hard to perceive and makes the redesign harder to apply consistently. Many meta labels sit at 10.5-11.5px.

**Recommendation:** Reduce to 5-6 tokens, map every literal to one, and set a 12px floor for meta text.

### UX-39 · P3 · Folder and Archive trays on Home are not virtualized

**Area:** performance-perceived

**Evidence**

- `src/components/research/ResearchActivityFeed.tsx:1393`: Only the Unfiled list uses the virtual canvas.
- `src/components/research/ResearchActivityFeed.tsx:1000`: Each tray renders every tree card in its place.
- `src/components/research/ResearchActivityFeed.tsx:980`: The Archive tray renders ResearchArchivedFeed with all archived trees.

**Why it matters:** Home slows down as folders and the archive grow, even when the user only wants the inbox.

**Recommendation:** Show the first N cards per tray with 'Show all in <folder>', or drop trays from Home (see the Home issue).

### UX-40 · P3 · README links to a missing docs/home.md

**Area:** terminology/copy

**Evidence**

- `README.md:149`: 'See docs/home.md for the activity feed…'; the file does not exist in docs/.

**Why it matters:** Contributors working on the redesign cannot find the documented Home behavior.

**Recommendation:** Restore the document or remove the link.

## Strengths to keep

- Run status is specific and live: 'Working · reading lesswrong.com', an elapsed clock and a Stop button (ResearchTurn.tsx 310-322, 520-530).
- Branch columns quote the passage they were asked about, including the case where the answer was rerun (ResearchThreadPage.tsx 4854-4880).
- Selection toolbar with Branch, Highlight and Copy, keyboard shortcuts, and stated reasons when an action is unavailable (ResearchThreadPage.tsx 5760-5820).
- Destructive operations are mostly non-destructive or reversible: deleting a folder moves its questions to Unfiled (ResearchFolderDialogs.tsx 193), removing a workspace keeps files on disk (App.tsx 9275), moves have Undo toasts.
- Keyboard model in the feed: roving tabindex, arrow keys between rows, ⌥↑/⌥↓ reordering with position announcements in a live region (ResearchActivityFeed.tsx 111-127, 1310-1350).
- Composer errors stay next to the composer with the text intact for retry (ResearchQueryComposer.tsx 382-386).
- Drafts autosave and the Home composer restores its text and agent choice across restarts (ResearchDraftView.tsx, ResearchQueryComposer.tsx 225-259).
- Setup guide uses numbered steps with copyable commands and checks per agent (AgentSetupGuide.tsx, agentSetup.ts).
- Reduce motion is honored from both the OS and an in-app setting (ResearchColumns.tsx 30-36).
- The Home list is virtualized with scroll anchoring and an 'N new activities' pill instead of jumping (ResearchActivityFeed.tsx 629-650, 1361-1378).
