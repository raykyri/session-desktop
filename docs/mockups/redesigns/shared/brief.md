# Session desktop redesign: product brief

Source: `/home/user/session-desktop` (React/Tauri, macOS 13+). Read alongside `data.js`, which every mock should render.

## 1. What the app does

Session is a desktop workspace for long-running research with local coding-agent CLIs (Claude Code, Codex, Grok). A person types a question; Session launches the agent CLI with the person's existing credentials, streams its tool activity and answer, and stores the question, answer, tool trace and sources as a node in a durable **research tree**. Any answer can be continued (a follow-up in the same conversation) or **branched** from a specific passage, so one investigation grows into a tree. Trees are listed on a Home feed, filed into folders, scoped by workspace, and survive restarts (history, drafts, active runs, navigation state).

There is no terminal surface. Every view is a reading/writing surface over research trees.

## 2. Core objects (code name → UI name)

| Concept | Code | UI copy | Notes |
| --- | --- | --- | --- |
| Workspace | `GroupInfo` / workspace scope, `ResearchWorkspaceSwitcher` | "Workspace", "Default workspace" | A directory on disk; scopes sidebar, feed and folders. Switcher at sidebar bottom (⌘O): Add, Rename, Open in Finder, Move workspace folder…, Remove. |
| Folder | `ResearchFolder {id, name, workspaceId}` | "Folders", "New folder…" | User-made, one workspace each. Membership is tree → folder. Deleting a folder returns its trees to Unfiled. |
| System places | `system:unfiled`, `system:drafts`, `system:archive` | Home list, "Drafts", "Archive" | Unfiled is the Home list itself. Archive stops follow-up notifications and blocks branching. |
| Research tree / thread | `ResearchTree`, `ResearchTreeSummary` | "question", "thread", "research" (inconsistent) | Generated title, root node, workspace, `bookmarked`, `followed`, `archivedAt`, `hasUnseenUpdate`, `hasUnseenFailure`, run counts. |
| Node | `ResearchNode` = post \| exchange \| document | — | `parentNodeId`, `inline`, `anchor`, `title`, `starredAt`, `highlights[]`. |
| Exchange (question + answer) | `ResearchExchangeNode` | message row + "Research response" | `message`, `agent`, `run {status, error, startedAt, completedAt}`, `recap`. |
| Run status | `ResearchNodeStatus` | pills: Queued, Running, Failed, Stopped | `queued`, `starting`, `running`, `complete`, `failed`, `cancelled`. No "needs review" or "awaiting clarification" state; `data.js` proposes `needs-review`. |
| Follow-up (inline) | node with `inline: true` | typed in the column's ask box | Continues the conversation in the same messages column (one inline child per node). Exchanges fork the agent's native session. |
| Branch | node with `inline: false`, optional `anchor {kind:"passage", anchor}` | "Branch", "New branch", "Branch from the whole answer", "N branches" | Asked from a passage or the whole answer. Opens a column pair to the right; the passage is tinted blue and gets a margin marker. |
| Star | `starredAt` | star button, "Remove star" | A starred follow-up or branch is listed as an indented child row under its card in the feed. |
| Post | `ResearchPostNode`, `format: "text" \| "link"` | "Post", "Ask your network, or paste a link to save" | Written by the user. A lone URL becomes a link post (link card or tweet embed). Network delivery is recorded, not transmitted. |
| Document | `ResearchDocumentNode`, `source: imported \| authored \| transcript` | "Imported", "Edit document" | Long-form content with no run. Imported reports come from a `.md` file plus "Prompt that generated this report". |
| Draft | `ResearchDraft {id, workspaceId, prompt}` | "Save draft", "Draft" | Unsent question in Drafts; opens as a messages column. |
| Highlight | `ResearchHighlight {anchor: {exact, prefix, suffix, start, end}}` | "Highlight", "Remove highlight", sidebar "Highlights" | One amber colour, no note, within one paragraph. `data.js` adds colour and note as proposals. |
| Bookmark | `tree.bookmarked` | "Bookmark", "Remove bookmark", sidebar "Bookmarks" | Per thread. |
| Follow | `tree.followed` | "Follow"/"Unfollow", toast "Following. You'll be notified of replies." | Notification subscription for network replies; distinct from Bookmark. |
| Archive | `tree.archivedAt` | "Archive", "Unarchive research" | Archived threads are read-only for branching. |
| Recap | `ResearchRecap {text, model, instructions}` | "Generate recap", "Recap updated" | Generated summary above an answer. Dialog: Instructions, Agent, Model, Candidate vs Current. |
| Sources | links inside the answer Markdown | — | No sources list exists; links open in the browser overlay. `data.js` gives each turn `sources[]`. |
| Run trace / activity | transcript `Turn` blocks, `TranscriptActivity` | "Working · reading lesswrong.com", "Show trace"/"Hide trace", "Show full transcript", "Called N tools" | Tool calls, thinking, then the answer. Only the answer shows by default. |
| Provider / model / effort | `AgentSpec {adapter, model, effort}` | Ask segment "Ask with {agent} {model}", menus "Model", "Effort" | Adapters `claude`, `codex`, `grok`. Models: Claude fable/opus/sonnet; Codex gpt-6-astra, gpt-5.6-*, gpt-5.5, gpt-5.4; Grok grok-build; plus Custom. Effort for Claude and Codex only. Follow-ups inherit all three. |
| Queue | client queue in a messages column | "Queued. It runs after the running answer finishes.", "Not sent", Retry, Edit question, Remove | Sending while the column's answer runs queues it. Research has no "Send now" (legacy agent-pane code only). |

## 3. Screens and navigation

**Window layout (left to right):** sidebar → feed column (240–320px, resizable) → thread column strip (horizontally scrolling) → optional browser overlay.

**Sidebar.** Primary rows: Home, Bookmarks, Highlights. Then a "Folders" section with "+": Drafts, user folders (… menu: Rename…, Delete…), Archive. Rows carry no counts. Home and every folder row is a drop target for dragged cards. Bottom: workspace switcher, GitHub account control, Settings. Collapses to a 52px icon rail (folder monograms) with ⌘⇧G, or automatically below 900px.

**Home feed (`ResearchActivityFeed`).** Header "Home" with Refresh and "Import .md report". Then the ask box (one line, "Ask a question"; it grows on focus to show the Ask/Post switch, the model menu and a send arrow; "Save draft" appears below once there is text). Then the Unfiled list (virtualized cards, newest first, manual reorder by drag or ⌥↑/⌥↓), then one collapsible **tray** per place: Drafts, each folder, Archive. A "N new activities" pill appears for items above the scroll position. Folder, Drafts, Archive and Bookmarks views show one place, with "+ Ask" in the header.

**Feed card (`ResearchFeedCard`).** Title (when it differs from the question), the question or post body (clamped; link card / tweet embed for links), status ("Running", "Failed", "Failed since last viewed"), an unread dot, indented child rows for starred follow-ups/branches, a drag grip, and a … menu: Bookmark, Follow, Move to {folders}, New folder…. The context menu adds Rename, Archive, Generate recap, Delete. ↑/↓ moves between rows; → or Enter opens the thread.

**Thread page (`ResearchThreadPage`, `researchColumns.ts`).** Each **level** is a pair of columns: a **messages column** (`Tn`: the chain's user messages as bubbles, each with time, status pill, star, "N branches", and an answer … menu) and an **answer column** (`An`: the selected message's answer, run status line with elapsed time and Stop, recap, Markdown answer, trace toggle). Level 0 is the root conversation; each open branch adds another pair to the right, under a header "Branch · N messages". An unsent branch adds a column with the quoted passage and an ask box ("New branch"). Posts show as a post column plus a "Thread · N" column; editing a document or post adds an editor column. The root header has Back/Forward and "+ Ask". Each messages column has its ask box at the top. Answer menu: Show full transcript, Branch from the whole answer, Copy answer as Markdown, Copy thread as Markdown, Generate recap, Retry run.

**Selection bar.** Selecting answer text shows a floating bar: Branch, Highlight (or Remove highlight), Copy. Disabled with "Wait for the answer to finish" while a run is active.

**Highlights view.** Saved passages grouped by thread, each shown inside its surrounding sentence; opening one jumps to the passage.

**Browser overlay (`BrowserOverlay`).** Opens from a link: address bar, back/forward, refresh, history, WebKit/Chromium engine switch, resizable, Hide.

**Settings (⌘,).** Modal (Basic, Remote machines): Dark/Light, Warm/Cool theme, body font, text size, "Require ⌘↵ to send", notifications, workspace root. **Agent Setup** is a separate modal.

**Other.** Command palette, find bar, toasts, recap dialog, folder dialogs, delete confirmations.

## 4. Key flows

1. **First launch and agent setup.** Home shows a setup guide instead of the empty feed when no agent is ready: "Set up an agent — Research requires at least one supported agent CLI installed and signed in on this Mac." Per agent: Install the CLI (copyable command), Sign in (`claude auth login`, `codex login`, `grok login`), Refresh status. Status: Ready, Needs update, Not checked, or an error. The composer shows "Review agents" until one is ready.
2. **Start research.** ⌘N → Home ask box → type → choose agent/model/effort from the Ask segment's menu (⌃Tab cycles model, ⌃⇧Tab agent) → ⌘↵. A "Running" card appears at the top of Unfiled; its answer column shows "Working · {latest tool}" and elapsed time.
3. **Follow-up.** Type in the ask box at the top of the messages column (⌘J focuses it). If the answer is still running, the question is queued below it.
4. **Branch.** Select a passage → Branch → a pending column with the quote and an ask box → send. The parent paragraph gets a margin marker and blue tint; the message row shows "1 branch". Alternative: answer menu → Branch from the whole answer, or ⇧⌘↵.
5. **File into folder.** Drag a card onto a sidebar folder or a Home tray, or … → Move to → folder / New folder…. Archive via context menu.
6. **Highlight.** Select text → Highlight. Amber wash; listed under sidebar Highlights. Selecting across an existing highlight offers Remove.
7. **Review run trace.** In the answer column, "Show trace" during a run, or answer menu → Show full transcript after it, reveals tool calls ("Called Read", "Called 4 tools") and thinking between messages.
8. **Recap.** Context or answer menu → Generate recap → set instructions/agent/model → generate a candidate → apply.
9. **Import report.** Home header → Import .md report (or drop a file) → enter the prompt that generated it → becomes an imported document thread.

## 5. Visual language (current)

- **Theme:** dark by default, "Warm" (`orange-blob`) palette. Page `#121110`, sidebar `#171716`, thread pane `#1c1b1a`, cards `#222120`, menus `#23221f`, dividers `#2d2d2c`. Text `#e7e7e2`, headings `#f4f3ec`, muted `#919994`. Accent blue `#33adff`. Running/attention amber `#d7a84f`, failed `#d98787`, success `#81c784`, info `#6da7ec`. Highlight `rgba(240,178,70,0.19–0.42)`; branch passage blue tint. Light mode and a "Cool" teal-accent theme exist. Adapter tints: Claude `#d9a07d`, Codex `#8fc7a6`.
- **Type:** DM Sans for UI (Inter and Valley Sans selectable), JetBrains Mono for code. Scale: 11 / 12 / 13 (base) / 15 (inputs) px; answer body about 14.5px at line-height 1.5; column titles 15px/600, branch titles 14px.
- **Density:** compact desktop. Controls 26/30/34px tall, radii 4/6/8px (cards 10px), feed card padding 10×12px with 2px gaps, feed max width 540px, Lucide icons at 13–16px. Selection is a background fill. Motion: scroll and 120ms hover transitions only.

## 6. What confuses a first-time user

1. **Thread vs question vs research vs tree.** The same object is called all four in copy and menus ("Unarchive research", "Bookmark … question", "Thread copied.").
2. **Folder vs workspace.** A workspace is also a directory on disk ("Move workspace folder…"), while "Folders" in the sidebar are labels inside a workspace.
3. **Follow-up vs branch.** Both are questions about an answer; which one you get depends on where you type or on ⇧⌘↵. The whole tree shape is never shown.
4. **Two columns per level.** Messages and answer sit side by side, and each branch adds two more columns. With two or three branches open, the window scrolls horizontally and the parent's context is off-screen.
5. **Bookmark vs Follow vs Star vs Highlight.** These are four separate "keep this" actions with different scopes (thread, notifications, child row in the feed, passage) and different places they show up.
6. **Ask vs Post.** Post sends to a "network" that does not deliver anything yet, and pasting a URL silently turns the input into a saved link.
7. **Home is also "Unfiled".** Filing a card into a folder takes it out of the top list and puts it into a tray further down Home.
8. **No attention inbox.** Finished-but-unread runs show only as a dot on a card. Failures show as "Failed since last viewed". You have to scan the feed and trays to find what needs you.
9. **Sources and trace are hidden.** Sources are inline links only. The tool trace sits behind "Show trace" or an answer … menu item.
10. **Queued follow-ups** appear as greyed rows with Retry/Edit/Remove. Nothing explains that a column runs one answer at a time.
