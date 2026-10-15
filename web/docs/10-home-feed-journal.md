# Home feed, journal, report import

Ports `src/components/research/ResearchActivityFeed.tsx`,
`ResearchFeedCard.tsx`, `ResearchFeedTray.tsx`, `ResearchTrashList.tsx`,
`ResearchDraftView.tsx`, `ResearchFolderDialogs.tsx`,
`ResearchDeleteDialog.tsx`, `ResearchQueryComposer.tsx`,
`AskNoteSwitch.tsx`, `ResearchQuestionModelPicker.tsx`, `ResearchImages.tsx`,
`ResearchSidebarNav.tsx`, `ResearchHighlightsFeed.tsx`,
`ResearchReportImport.tsx` and `TweetEmbed.tsx` onto the server API in
`03-api-and-events.md`. Behavior reference: `docs/home.md`. The code is in
`features/home`, `features/composer`, `features/drafts` and
`features/sidebar`; the routes are in `routes/home.tsx` and
`routes/places.tsx`.

## 1. Home and the places

A signed-in visit to `/` renders `FeedView` with the `home` view
(`routes/home.tsx`); `/?feed=all` (the sidebar's All Users place) renders the
public feed (§2). Home's header holds Refresh Home (reads the workspace's
threads, folders, drafts, Trash and every card's root again, as the desktop's
`refreshResearchNavigation`) and Import .md report (§5). Threads that arrive
above the list's first row while it is scrolled more than 60 px from the top
raise an "N new activities" button that returns to the top (the desktop's
`newActivityCount`); scrolling back to the top clears it. The column is capped at `--research-feed-max-width` and
scrolls vertically; the scroll offset is kept per workspace under
`home:<workspaceId>` in the `navigation` store.

Home, top to bottom:

1. The composer (§6), above the list. Report import (§5) wraps the column.
2. **Unfiled**: the workspace's threads that are not in a folder, the
   Archive or the Trash, in the stored order. The list is virtualized
   (TanStack Virtual) and is the drop target `system:unfiled`.
3. One tray per place, each collapsible with its state stored through
   `folders.set` (`collapsed`): **Drafts**, one tray per folder in folder
   order, **Archive**, then **Trash**. The Trash tray starts collapsed and its
   open state is local to the view and not saved, as on the desktop
   (`ResearchActivityFeed`'s `trashTrayOpen`). An empty tray shows the desktop's empty
   text ("No drafts. Use Save draft in the composer to keep a question for
   later.", "Empty folder. Drag or file questions here.", …).
4. A "+ New folder" link below the Trash tray.

Places (all behind `requireSignedIn`; `routes/places.tsx`):

| Route | View |
| --- | --- |
| `/f/$folderId` | One folder's cards; Rename and Delete buttons in the header; the composer below the list files new threads into the folder. |
| `/drafts` | The drafts; composer below the list. |
| `/drafts/$draftId` | `DraftView` (§3). A draft that no longer exists shows "This draft was sent or deleted." |
| `/archive` | Archived threads. |
| `/trash` | `TrashList` (§4). |
| `/highlights` | §4a. |
| `/shared` | Web only: Shared with me (§4b). |
| `/notifications` | Web only: the notification inbox (§4c). |
| `/invite` | Web only: an invitation link, `/invite#<token>` (§4b). Not behind the guard: signed out, it sends the reader to `/login` and back. `/invite/$token` (links of the earlier form) stores the token and replaces the address with `/invite`. |

Each place view has a Back to Home button and the place name as its `h1`.

Data: the structure (order, places, groups) is `research.listTrees` with
`includeArchived: true` plus `folders.get` (`["folders", workspaceId]`). A
card's content is its thread's root entry, read per rendered card through
`useFeedRoot(treeId)`: `loadFeedRoot` batches the reads of one tick (up to
100 ids) into `feed.recentQueriesForTrees` and caches each result under
`["feedRoot", treeId]`. Events keep that key current (`07` §4).

### Cards (`FeedCard`, `CardBody`)

- The glyph is `ui/RowGlyph.tsx` (`researchRowGlyph`): question, note, link
  or document, with the run state.
- Title: `researchCardTitle`. A note or an untitled question shows its text
  as a muted preview clamped to four lines, with blank lines collapsed; a
  note whose first line is a Markdown heading shows that heading in the title
  style above a three-line preview. A link post shows the X post label
  "[Tweet: @handle]" ("[Tweet]" without a handle) or a link card.
- The rail (on hover or focus) holds the drag grip and the … button
  ("Thread actions"). There is no Follow or Bookmark control.
- A card with children shows "N items" with a collapse toggle and the
  `researchGroupSummary` line; children render one level deep in an indented
  group, whose foot holds the "Move out of group" drop strip while a child is
  dragged.
- Click, Enter or → opens the thread (`/r/$treeId`). A draft card opens
  `/drafts/$draftId`.

### Card menu (`TreeMenu.tsx`)

Opened by the … button, a right-click (at the pointer) or Shift+F10:
Make child of… (the `researchNestCandidates`; disabled with "No question,
document or post to nest under" when there are none), Move out of group,
Collapse/Expand group, "Move to" (Unfiled, each folder, Archive, Trash),
Generate recap, Rename…, Unarchive research, Delete…. As on the desktop, D
chooses Delete and, on Home, A chooses Archive while the menu is open
(`MenuItem`'s `shortcut`, handled by `AnchoredMenu`); Delete is disabled with
"Research with active runs cannot be deleted" while the thread runs. Archiving a parent
confirms "Archive “T” and its N child?"; nesting a card that holds children
confirms flattening them. Moves toast "Moved to X." or "Moved under “P”." with
Undo (`lib/toast.ts`, 8 s).

### Nesting and reordering by drag (`useCardDrag.ts`)

Port of the desktop's `useResearchCardDrag`, reading cards, groups and drop
targets by `data-research-*` attributes. Over a card, the middle band nests
under it and the top and bottom edges reorder before or after it; groups are
one level deep, so a card that holds children cannot nest under another card
(`researchCardDrop`). A tray, a sidebar place or the "Move out of group"
strip files the card there. The marks (`is-insert-before`/`-after`,
`is-drop-nest`, `is-drop-invalid`, `is-drop-target`) and the drag ghost are
classes in `styles/feed.css`. Escape cancels.

### Keyboard

↑/↓ move between cards (roving tabindex, `applyFeedRoving`); Enter and →
open the focused card (Enter does not move into its children); ⌥↑/⌥↓
reorder within the place and announce "Moved to position i of n."; ⌥→ nests
under the card above; ⌥← moves a child out of its group.

### Delete, Archive, Trash

Delete is two-step (`ui/DeleteDialog.tsx`): "Move to Trash" is the primary
action and a "Delete now" link opens a second confirmation ("Delete
permanently?", "This can’t be undone."). The server cascades archive, trash,
restore and delete from a parent to its group's children, so the client calls
each procedure once, for the parent. Moving to the Trash toasts with Undo.

Web only: when the reader's own thread is shared, both steps add a sentence
about its members (`features/sharing/ownerWarnings.tsx`, member count from
`sharing.listMembers`): Move to Trash "The 2 people it is shared with lose
access while it is in the Trash. The questions and notes they added go with
it."; Delete "The 2 people it is shared with lose access, and the questions
and notes they added are deleted with it." ("The person it is shared with
loses …" for one). Home's card menu, the thread page's root Delete and the
Delete offer after Ask as a question use them.

## 2. Public feeds

All Users (every account's public threads) is a web-only sidebar place,
`/?feed=all`; guests always see it at `/`. The earlier My Workspaces feed and
the header's "Feed" menu are removed (an old `?feed=workspaces` link opens
Home). The public feed keeps `ActivityFeed` over
`useInfiniteQuery(["activity", { scope, workspaceId }])` and
`feed.recentActivity` (page size 50, "Load older", Retry on a failed page),
rendering `PublicFeedCard` (glyph, title, preview; no menu). Live updates:
`feed.item.upserted` and `feed.item.removed` patch only the keys whose scope
matches; items that arrive while the list is scrolled down raise the "N new
activities" counter. The scroll anchor is saved under `all-users`.

## 3. Drafts

The composer's More actions → "Save draft" saves a draft (`drafts.save`).
Drafts are listed in the Drafts tray and at `/drafts`, reordered by drag
(`drafts.reorder`) and deleted from their menu (Open, Delete). `DraftView`
(`/drafts/$draftId`) shows a "Draft question" field that saves 500 ms after
the last edit (`lib/researchDraftAutosave.ts`, ported from the desktop), saves
at once on ⌘S ("Draft saved.") and flushes on close. An added or removed
image saves at once with the text. Text or images whose save failed stay
unsaved, so ⌘S and closing save them again. Send asks the question
with the Home composer's model and effort (`research.createTree`), deletes the
draft and opens the thread. `drafts.changed` invalidates `["drafts", ws]`.

## 4. Trash (`TrashList`)

`research.listTrash` for the workspace, with trashed folders and their
threads grouped (`researchTrashEntries`). Each entry has Restore and "Delete
now" (with the permanent-delete confirmation); the header has "Empty Trash"
("Empty the Trash?", "N items will be deleted.", `research.emptyTrash`).
`research.trash.changed` invalidates `["trash", ws]`. A restored child whose
parent is still in the Trash returns to its place as a top-level card.

### Folders

`FolderDialogsHost` (mounted in `AppShell`) owns the New folder and Rename
dialogs and the folder delete confirmation for the sidebar, the trays and the
folder view. The name field starts empty, as on the desktop (a prefilled
default name collides with the uniqueness check); `researchFolderNameError`
validates locally and the message of a refused `folders.set` is shown in the
dialog. Deleting a folder moves it to the Trash ("Moved the folder to the
Trash." with Undo); deleting it permanently files its threads in Unfiled
("Deleted folder. N questions moved to Unfiled."). Folder state writes are
optimistic and serialized per workspace (`commitFolderState` in
`useFiling.ts`).

## 4b. Shared with me (`/shared`, web only)

The threads other people share with the reader (`sharing.listShared`,
`["shared", "shared"]`), most recently updated first, as cards in the
`shared` view of `FeedView`; above them, the invitations addressed to the
reader's GitHub login (`invites.received`, `features/sharing/ReceivedInvites.tsx`),
each with Accept (`invites.accept({ inviteId })`, then the thread opens).
`research.invites.changed` refetches them; an invitation also arrives as a
`notification.requested` toast that opens the Shared place.

A shared thread is the owner's in order and nesting, and the reader's in
placement:

- Move to (card menu) and a drag onto a sidebar folder file it in one of the
  reader's own folders (`folders.set` membership; the thread is then also
  listed with that workspace's threads); "Shared with me" takes it out of
  them; Archive moves it to the reader's own Archive. Drafts and New folder…
  are not offered. Shared cards are neither nest targets nor nestable (⌥→
  and a drop on a card announce "Shared threads can’t be nested."), and
  `research.reorderTrees` is sent with the reader's own threads only
  (`ownTree` in `useFiling.ts`).
- Rename is not offered; Generate recap only to a commenter.
- The reader's Archive lists their archived shared threads
  (`sharing.listShared({ place: "archive" })`) with their own; Unarchive
  restores the reader's copy. A thread its owner archived
  (`archivedBy: "owner"`) has Unarchive and every Move to target disabled
  with "This thread was archived by its owner; only they can unarchive it."
- The reader's Trash lists the shared threads they moved there from this
  workspace (`research.trashTree({ treeId, workspaceId })`,
  `sharing.listShared({ place: "trash", workspaceId })`), marked "Shared
  with you"; Restore brings it back, and Delete now leaves the thread
  ("Leave “…”?", the owner and the other people keep it). Empty Trash leaves
  the shared threads in this workspace's Trash, which its confirmation says.
  The thread page's root Delete (offered to a commenter) uses the same two
  steps (`sharedTreeDeleteSteps`).
- ⌥↑/⌥↓ on a shared thread's card moves nothing and announces "Shared
  threads keep their owner’s order."

An invitation link is `/invite#<token>` (`invites.create`'s `url`). The
token is the URL fragment, so no request carries it. On a page load,
`app/captureInvite.ts` (imported first by `main.tsx`, before the router
module and any request) reads it, replaces the address with `/invite`
(`history.replaceState`, keeping the entry's state) and keeps the token in
this tab's `sessionStorage` (`lib/pendingInvite.ts`,
`session.pending-invite.v1`, dropped after an hour; in memory when storage is
blocked). `/invite` (`routes/invite.tsx`) then accepts it
(`invites.accept({ token })`), forgets it, and opens the thread, replacing
the history entry. Signed out, it navigates to `/login?redirect=/invite`: the
redirect, the GitHub round trip and the history hold only `/invite`, and the
token waits in `sessionStorage` until the reader is back. Another invitation
link opened on the same page changes only the fragment; `hashchange` starts
over with it. `/invite/$token`, the form of earlier links, stores its token
the same way in the route's `beforeLoad` and redirects to `/invite`. With no
token, the page reads "This invitation link is incomplete. Open the whole
link you were sent again." An unknown, used, expired or revoked invitation,
or one addressed to another GitHub account, shows "This invitation can’t be
used" with the server's reason.

Accepting an invitation follows the thread ("Notify me" in the thread menu
turns it off), as the owner follows their own threads; an unfollow stays
(`03-api-and-events.md` §2 `subscriptions.set`).

The owner's Share dialog confirms making a public thread private in its
footer: "Make it private? People who aren’t in it lose access, and it leaves
All Users." and, when it has members, "The 2 people it is shared with keep
access.", with Cancel and Make private. Making it public needs no
confirmation. The dialog's link controls read "Copy invitation link" and
"Invitation link".

## 4c. Notifications (`/notifications`, web only)

The server's notifications to the reader (`notifications.list`, an infinite
query under `["notifications", "list"]`), newest first, from
`features/notifications/NotificationInbox.tsx`: a row is an unread dot, the
title (medium weight while unread), the time (`formatRelativeTime`) and the
body (two lines). A row's name is its title, prefixed "Unread: " while
unread. Opening one marks it read (`notifications.markRead`, patched in the
cache first) and navigates to its `href`; a toast opened from the stack
marks its inbox entry read too (same id). The header has "Mark all as read"
(`notifications.markAllRead`; disabled with nothing unread) and Refresh
Notifications; older pages load with "Show older notifications". The empty
inbox reads "No notifications."; a failed load shows the error with Retry.
`notification.requested` and `notifications.read` refetch the list and the
unread count (`["notifications", "unread"]`), whatever the Notifications
setting (which governs toasts only); `notifications` is a reconnect key.
Retention is the server's: read notifications are deleted after 30 days and
each account keeps its newest 500 (`02-domain-model-and-database.md` §5.17).

## 4a. Highlights (`/highlights`)

Ported from the desktop's `ResearchHighlightsFeed.tsx`
(`features/highlights/HighlightsFeed.tsx`): `highlights.listFeed` grouped by
thread under the thread's title (thread order from the feed, each group
oldest first); a row is the highlighted message's label and the passage
inside up to 60 characters of its paragraph, cut at a word and marked "…"
(`highlightExcerptContext`). The header has Refresh Highlights; the empty
page reads "No highlights. Select text in an answer and choose Highlight.";
a failed load shows the error with Retry. Each row has a × "Remove
highlight" (`highlights.removeMany`), shown on hover and focus; focus then
moves to the next row, the last one, or Refresh. The feed lists the
reader's own threads, whose owner may remove any highlight; a row whose
thread a cached list shows the reader does not own has no × (the feed row
does not name the highlight's author). Click →
`/r/$treeId?node=<nodeId>&highlight=<id>`, which scrolls to it once
(`09-research-document-view.md` §5). Events `research.highlight.*` patch the
list; `research.tree.archived` removes that tree's items.

## 5. Report import

`ResearchReportImport.tsx` minus the Tauri drag-drop branch and
`readResearchReport`. The Import .md report button in Home's header opens
`<input type="file" accept=".md">`; HTML5 drop on the Home column (drops on
the composer, `[data-research-image-drop]`, are left to image attachment);
one file at a time; `.md` only; non-empty; the "Import report" dialog with
the field "Prompt that generated this report"; token estimate via `estimateTokenCount`. Submit →
`research.importReport({ markdown, prompt, workspaceId })` (the web always
uses `gemini-flash` for the recap); the server inserts a `complete` root
`run` node with `origin: "imported"`, writes a single-turn snapshot,
schedules the recap (imported reports bypass the length cutoffs) and emits
`research.tree.created`. Limits: 10,000 words / 10 MiB.

## 6. Composer (`features/composer`)

`ResearchQueryComposer`: the "New question" field in the form "New research".

- The Ask/Note switch (`AskNoteSwitch`, a radio group). In Ask mode the field
  reads "Ask a question" and sends `research.createTree`, then opens the
  thread; in Note mode it reads "Write a note, or paste a link to save" and
  sends `research.createPost` (a bare URL saves a link post, which the server
  hydrates) and stays on Home. The send button reads Start research, Save
  note or Save link.
- Clicking the selected Ask segment opens the model menu
  (`QuestionModelPicker`): the launchable models of the registry (gated
  models only for admins) and an Effort submenu (Default, Low, Medium, High,
  and Extra or Max where the model has them). ⌃Tab cycles the model. The Ask
  segment's label reads "Ask with <model> (<effort>)".
- More actions → "Save draft".
- Images: paste, drop or the picker attach PNG, JPEG, GIF or WebP images,
  uploaded at once (`POST /api/images`) and shown as thumbnails with remove
  buttons. The limits and messages are the desktop's
  (`lib/researchImages.ts`): 20 MB per image, 5 MB for GIF and WebP, the
  per-message count and total size, no images on a note; a model that cannot
  read images blocks the send.
- ⌘↵ sends; Enter in an empty field does nothing; Esc leaves the field.
- The text, model, effort and images persist per workspace in the `drafts`
  store.

`ui/AnchoredMenu.tsx` opens a Base UI menu at an element or a point without
a visible trigger (the card menu, the context menu, the model menu). It
renders a hidden `Menu.Trigger`: Base UI assigns a root menu its floating
tree node through the trigger, and without one a submenu opening closes the
root menu as a sibling.

## 7. Sidebar (`features/sidebar`)

Port of `ResearchSidebarNav.tsx` and the desktop's `AppSidebar` header: the
top row has the mark, Settings (⌘,) and the Light/Dark toggle (titles "Dark
mode"/"Light mode"), and Hide sidebar; then the places, then the workspace
switcher (`WorkspaceSwitcher`) above the account row, as on the desktop.
The sidebar is the `Sidebar` landmark; its splitter is a focusable
`separator` with the width as its value. Signed out, the account row is
"Sign in with GitHub" (the sign-in page's wording too). The places:

- "Research" navigation: Home (a drop target for Unfiled), Highlights and,
  web only, Shared with me, Notifications and All Users (signed in; no
  drops). Shared with me carries a badge with the number of invitations
  waiting (`invites.received`; its name reads "Shared with me, 2
  invitations"), Notifications one with the unread count
  (`notifications.unreadCount`; "Notifications, 3 unread"; 99+ above 99). While ⌘
  (Ctrl off Apple platforms) is held, Home shows its chord, and the
  workspace switcher ⌘O, unless "Show keyboard shortcut hints" is off
  (`lib/shortcutHints.ts`).
- A Folders heading with a New folder button, then the "Folders" navigation:
  Drafts, each folder (a drop target; its … menu offers Rename… and
  Delete…), Archive (a drop target) and Trash.

The tree list, multi-selection, visibility filter and the `filter` search
parameter of the earlier sidebar are removed; threads are filed and ordered
from Home. Sidebar resize 208–420 px and collapse (Shift-Cmd-G) persist in
`navigation`. The workspace switcher's trigger reads the workspace's name, or
"Choose a workspace"; its menu ("Research workspaces") reads Add workspace…,
Make default workspace (web only: the web opens the default workspace where
the desktop reopens the last one used), Rename “W”… and Delete workspace…
(the web deletes; the desktop's item is Remove workspace…). There is no
reordering, as on the desktop.

Collapsed, the sidebar is the desktop's 52 px icon rail
(`features/sidebar/SidebarRail.tsx`, ported from `ResearchSidebarRail`):
Expand sidebar, Home, Highlights, Shared with me, Notifications, All Users,
then Drafts, each folder as its first letter (`researchFolderMonogram`,
named in the tooltip), Archive and Trash, New folder, and at the foot the
Light/Dark toggle and Settings (⌘,). Shared with me and Notifications show
their badges too. Home
and every place but Trash take card drops. Below 900 px the rail stays and
Expand opens the sidebar as a drawer; the rail is inert while the drawer is
open.

## 8. Notifications

`UserNotificationStack` and `useUserNotifications` port unchanged. As on the
desktop, the status of the reader's own action (a client toast, `lib/toast.ts`)
shows at the bottom centre, one at a time (a new one replaces it), and
server notifications stack at the top right (`placement` on the store's
items, `ui/NotificationStack.tsx`). A toast
may carry one action (`action: { label, run }`); `toast(…, { undo })` adds an
"Undo" action and stays 8 s. Client toasts always show; the
`showNotifications` setting hides server notifications only. The desktop's
toasts are kept: "Restored.", "Draft deleted.", "Saved to Drafts.", "Sent.
Moved from Drafts to Unfiled.", "Moved to the Trash." with Undo. Sources:
client-originated toasts, and the server's `notification.requested` events
(a run you asked finished or failed, a new question or note in a thread you
follow, a branch from your answer, an invitation; `03-api-and-events.md`
§3). A server notification with an `href` opens that path when clicked
(`AppShell` passes `onOpen` to the stack, which also marks the inbox entry
read). Max 20 kept, 3 visible. Every server notification is also stored in
the reader's inbox (§4c), with or without the toast.
