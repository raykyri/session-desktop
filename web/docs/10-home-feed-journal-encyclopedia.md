# Home feed, journal, encyclopedia, report import

Ports `src/components/research/ResearchActivityFeed.tsx` (1,483 lines),
`ResearchHighlightsFeed.tsx`, `EncyclopediaPageView.tsx`,
`EncyclopediaSidebarSection.tsx`, `ResearchReportImport.tsx`,
`TweetEmbed.tsx`, `ResearchQueryComposer.tsx`, `AgentSetupGuide.tsx`, and
the Home-related parts of `App.tsx`, onto the server API in
`03-api-and-events.md`. Behavior reference: `docs/home.md`.

## 1. Home (`/`)

Layout: `.research-reading-surface` column capped at
`--research-feed-max-width` (540 px) plus padding, vertical scroll only.

Sections top to bottom:
1. Header with `HistoryNav` and workspace scope label.
2. `ResearchQueryComposer` (`07-client-architecture.md` §6) with model chip
   and document attachments. Files go to `POST /uploads` as soon as they are
   dropped (progress and extraction status on the chips); the draft stores
   the returned document ids. Submit → `research.createTree` with
   `documentIds` → navigate to `/r/$treeId`; the returned detail is written
   to the `tree` cache and the summary prepended to `trees` (position 0).
3. `ReportImport` drop target and composer icon (§5). The desktop's
   `AgentSetupGuide` (`App.tsx:11877`) is not ported: models are configured
   by the deployment, and an unavailable provider is shown as a disabled
   model in the composer.
5. Activity feed (§2).
6. Delete-undo bar for journal removals (`journalUndo`, `App.tsx:6460`).

## 2. Activity feed

Data: `useInfiniteQuery(["activity", { workspaceId, bookmarkedOnly }])` over
`feed.recentActivity`, page size 50, `getNextPageParam = nextCursor`.
Items are `RecentActivityItem` (`journal` or `research-query`).

Live updates: events patch page 0 through the shared reducers
(`upsertActivityNode`, `removeActivityNode`, `journal.entry.*`). New items
arriving while the user is scrolled down increment a counter shown on the
"new activity" button, which scrolls to top and clears it (desktop behavior).
"Load older" fetches the next page; a failed
page shows Retry.

Virtualization: TanStack Virtual with dynamic measurement (`measureElement`);
replaces the hand-rolled canvas rows in `ResearchActivityFeed.tsx`. Scroll
anchor (top item id + offset) saved to the `navigation` store, debounced 200
ms, flushed on `pagehide` (`useActivityFeedState.ts`), restored on return.

Cards:
- `ResearchQueryCard`: prompt (tagged-instruction stripped, wikilinks
  stripped), model icon and label, document count, status, relative time,
  recap text
  (`.research-summary-text`), `queryTarget` quote for anchored follow-ups,
  tweet attachments, up to one level of `children` as compact rows, Follow
  and Bookmark toggles beside the timestamp once the query is no longer
  running (`ResearchActivityFeed.tsx:365`; `research.setTreeFollowed` /
  `setTreeBookmarked`, optimistic). Right-click opens the same tree menu as
  the sidebar (`ResearchTreeMenuItems`, including Generate summary) with
  rename and delete dialogs rendered inline in the feed
  (`ResearchActivityFeed.tsx:1408-1441`). Click → `/r/$treeId?node=<nodeId>`.
- `JournalEntryCard` (link): favicon-less title/URL row, `ActivityMetadataLine`,
  menu (`journalEntryMenuItems`, `ResearchActivityFeed.tsx:162-185`): Open
  link, Copy link, separator, Delete. Single-letter shortcut badges from the desktop UI were removed because Base UI menus reserve typed letters for typeahead list navigation rather than shortcut execution.
- `JournalTweetCard`: tweet entries render directly via the tweet card component without an outer container (`journal.css:1-5`);
  `TweetEmbed` ported unchanged; placeholder while `hydration === "pending"`,
  failure state with Retry (`journal.hydrateTweet`); menu: Open on X, Copy
  link, Refresh tweet or Retry tweet, separator, Delete.
- Delete → `journal.remove` with the removed entry kept in the undo bar; Undo
  → `journal.restore(entry)`.

Adding to the journal (new on the web): the desktop currently has no UI
that creates journal entries; `App.tsx` only restores, updates, and deletes
them (`App.tsx:433-435`, `:6451`, `:6513`), and entries exist only from
legacy data and imports. The web app adds `journal.add`: the Home composer
accepts a bare URL. If `tweetIdFromUrl` matches, it creates a tweet entry;
otherwise, it creates a link entry. The server hydrates tweets and caches the
snapshot. This
is an addition beyond desktop parity and is marked as such in the checklist.

## 3. Bookmarks (`/bookmarks`)

Same feed component with `bookmarkedOnly: true` and no composer; the server
filters roots by `trees.bookmarked` (the desktop filtered client-side).

## 4. Highlights (`/highlights`)

`highlights.listFeed` → items grouped under day headers (local time), newest
first, each rendered as the highlighted passage inside its prefix/suffix
context with the tree title and node label, with a Refresh control in the
header (`ResearchHighlightsFeed.tsx`). Click → `/r/$treeId?node=<nodeId>&highlight=<id>`;
`ResearchPage` reads `highlight` and scrolls to it once
(`09-research-document-view.md` §5). Events `research.highlight.*` patch the
list; `research.tree.archived` removes that tree's items.

## 5. Report import

`ResearchReportImport.tsx` minus the Tauri drag-drop branch (`:66-80`) and
`readResearchReport`. An upload icon in the composer's control row, next to
the attach button, opens `<input type="file" accept=".md">`; HTML5 drop on
the Home column; one file at a time; `.md` only; non-empty; modal dialog
asking for the prompt that produced the report; token estimate via
`estimateTokenCount`. Submit → `research.importReport({ markdown, prompt,
workspaceId })` (the desktop chose an adapter, `App.tsx:7244-7257`; the web
always uses `gemini-flash` for the recap); server inserts a `complete` root
`run` node with
`origin: "imported"`, writes a single-turn snapshot, schedules the recap
(imported reports bypass the length cutoffs), emits `research.tree.created`.
Limits: 10,000 words / 10 MiB with the same messages as the composer.

## 6. Encyclopedia

Sidebar section (`EncyclopediaSidebarSection`): alphabetical
`encyclopedia.listPages` for the scoped workspace; hidden until the first
page exists.

Page view (`/e/$slug`, `EncyclopediaPageView.tsx`): title, a `Term:` line
when the model's title differs from the wikilink term (`split_title`,
`encyclopedia.rs:428`), status badge
(`generating` spinner, `failed` with error and Retry → `regeneratePage`),
Markdown body through the shared renderer with wikilinks active (onward links
resolve within the same workspace), "Mentioned in" backlinks from
`sources` (question or referring page title, excerpt), header actions
Rewrite (`regeneratePage`) and Delete (`deletePage`, confirm). Events
`encyclopedia.page.updated` patch both the summary list and the open page.

Wikilink activation (`WikilinkActionsContext`): `resolve(term)` looks the
slug up in the cached page list → `ready | generating | failed | missing`;
`activate(term, element)` navigates to `/e/$slug` and, when missing or
failed, first calls `encyclopedia.requestPage` with the source context. The
renderer only calls `activate` for a missing or failed term after the reader
confirms in a popover on the link ("Write an encyclopedia page for X?"), so
a stray click on linked text does not start a model call. Source context:
`{ nodeId, treeId, question: node.prompt, excerpt: <surrounding block text>,
siblingTerms: <other wikilink terms in that block> }` (from a page:
`pageSlug` instead of node/tree). The block text is taken from the nearest
block-level ancestor of the clicked link, wikilinks stripped, capped at 1,500
chars by the client (`shared` constant); the server stores excerpts up to
4,000 chars (`encyclopedia.rs:40-48`).

Generation (server, `04-agent-runtime.md` §9): `gemini-flash` with
`Output.object`; `PAGE_LINKING_INSTRUCTION`; `split_title` tolerance;
`normalize_page` JSON unwrapping; `links` recomputed; `generatedBy`
recorded. The desktop's OpenRouter path and adapter choice are dropped.

## 7. Sidebar (`features/sidebar`)

Port of `ResearchSidebarSection.tsx` (1,605 lines), `ResearchFolderSwitcher.tsx`,
and the sidebar parts of `App.tsx`:

- Rows: Home, Bookmarks, Highlights. Their Cmd-digit chords resolve
  (`shared/app/shortcuts.ts`) however, navigation rows no longer display shortcut badges, as the `showShortcutHints` preference and its associated modifier badges have been removed.
- Encyclopedia section.
- Research list: folders (collapsible, starred first), trees with status dot,
  unseen-update and unseen-failure badges, running count, star, multi-select
  (Shift/Cmd-click), drag reorder with pointer gaps (`researchFolders.ts` drag
  math), row context menu (`ResearchTreeMenuItems`,
  `ResearchTreeMenu.tsx:60-180`: Generate summary, Unarchive, Star/Unstar,
  Rename, Remove from folder, New folder with selection, Archive, Delete; Follow
  and Bookmark live in the document footer and feed cards, not here), a
  multi-selection menu when right-clicking inside an active selection
  (`ResearchSidebarSection.tsx:381-384`: New folder from selection, Remove
  from folders, Archive, Delete), visibility filter (active/archived/all),
  archived section, "N selected" stage (`ResearchFolderDialog`).
- Persisted order: `research.reorderTrees` for tree moves within a section;
  `folders.set` for folder structure, stars, collapsed. Optimistic updates
  with rollback on error.
- Folder switcher (`ResearchFolderSwitcher`, Cmd-O): list of workspaces with
  tree counts, create (name prompt instead of the native picker), rename,
  delete (blocked while runs are active; confirms deletion of its trees),
  reorder, set as default.
- Sidebar resize 208–420 px and collapse (Shift-Cmd-G), persisted in
  `navigation`.

## 8. Notifications

`UserNotificationStack` and `useUserNotifications` port unchanged. Sources: server `notification.requested` events
(run finished or failed while its tree is not the open route; sign-in from a
new device), client-originated toasts (copy confirmations, errors). Max 20
kept, 3 visible, `showNotifications` setting honored.
