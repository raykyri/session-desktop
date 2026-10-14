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

A signed-in visit to `/` in workspace mode renders `FeedView` with the
`home` view (`routes/home.tsx`); the header's "Feed: …" menu switches to the
public feeds (§2). The column is capped at `--research-feed-max-width` and
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
   open state is local to the view. An empty tray shows the desktop's empty
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
| `/invite/$token` | Web only: an invitation link (§4b). Not behind the guard: signed out, it sends the reader to `/login` and back. |

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
Make child of… (the `researchNestCandidates`), Move out of group,
Collapse/Expand group, "Move to" (Unfiled, each folder, Archive, Trash),
Generate recap, Rename…, Unarchive research, Delete…. Archiving a parent
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

## 2. Public feeds

The "Feed: …" menu offers Home, My Workspaces and All Users; guests always
see All Users. The public feeds keep `ActivityFeed` over
`useInfiniteQuery(["activity", { scope, workspaceId }])` and
`feed.recentActivity` (page size 50, "Load older", Retry on a failed page),
rendering `PublicFeedCard` (glyph, title, preview; no menu). Live updates:
`feed.item.upserted` and `feed.item.removed` patch only the keys whose scope
matches; items that arrive while the list is scrolled down raise the "new
activity" counter. The scroll anchor is saved under `all-users` or
`my-workspaces`.

## 3. Drafts

The composer's More actions → "Save draft" saves a draft (`drafts.save`).
Drafts are listed in the Drafts tray and at `/drafts`, reordered by drag
(`drafts.reorder`) and deleted from their menu (Open, Delete). `DraftView`
(`/drafts/$draftId`) shows a "Draft question" field that saves 500 ms after
the last edit (`lib/researchDraftAutosave.ts`, ported from the desktop), saves
at once on ⌘S ("Draft saved.") and flushes on close. Send asks the question
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
  restores the reader's copy.
- The reader's Trash lists the shared threads they moved there, from every
  workspace (`sharing.listShared({ place: "trash" })`), marked "Shared with
  you"; Restore brings it back, and Delete now leaves the thread ("Leave
  “…”?", the owner and the other people keep it). Empty Trash leaves every
  shared thread in it, which its confirmation says.

`/invite/$token` (`routes/invite.tsx`) accepts the token
(`invites.accept({ token })`) and opens the thread, replacing the history
entry. Signed out, it navigates to `/login?redirect=/invite/<token>`, so the
reader returns after GitHub sign-in. An unknown, used, expired or revoked
invitation, or one addressed to another GitHub account, shows "This
invitation can’t be used" with the server's reason.

## 4a. Highlights (`/highlights`)

`highlights.listFeed` → items grouped under day headers (local time), newest
first, each rendered as the highlighted passage inside its prefix/suffix
context with the tree title and node label, with a Refresh control in the
header (`ResearchHighlightsFeed.tsx`). Click → `/r/$treeId?node=<nodeId>&highlight=<id>`;
`ResearchPage` reads `highlight` and scrolls to it once
(`09-research-document-view.md` §5). Events `research.highlight.*` patch the
list; `research.tree.archived` removes that tree's items.

## 5. Report import

`ResearchReportImport.tsx` minus the Tauri drag-drop branch and
`readResearchReport`. An upload icon in the composer's control row opens
`<input type="file" accept=".md">`; HTML5 drop on the Home column (drops on
the composer, `[data-research-image-drop]`, are left to image attachment);
one file at a time; `.md` only; non-empty; modal dialog asking for the prompt
that produced the report; token estimate via `estimateTokenCount`. Submit →
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

Port of `ResearchSidebarNav.tsx`: the workspace switcher (`WorkspaceSwitcher`,
unchanged), then the places:

- "Research" navigation: Home (a drop target for Unfiled), Highlights and,
  web only, Shared with me (signed in; no drops).
- A Folders heading with a New folder button, then the "Folders" navigation:
  Drafts, each folder (a drop target; its … menu offers Rename… and
  Delete…), Archive (a drop target) and Trash.

The tree list, multi-selection, visibility filter and the `filter` search
parameter of the earlier sidebar are removed; threads are filed and ordered
from Home. Sidebar resize 208–420 px and collapse (Shift-Cmd-G) persist in
`navigation`.

## 8. Notifications

`UserNotificationStack` and `useUserNotifications` port unchanged. A toast
may carry one action (`action: { label, run }`); `toast(…, { undo })` adds an
"Undo" action, stays 8 s, and is shown even when notifications are off. Sources:
client-originated toasts, and the server's `notification.requested` events
(a run you asked finished or failed, a new question or note in a thread you
follow, a branch from your answer, an invitation; `03-api-and-events.md`
§3). A server notification with an `href` opens that path when clicked
(`AppShell` passes `onOpen` to the stack). Max 20 kept, 3 visible,
`showNotifications` setting honored.
