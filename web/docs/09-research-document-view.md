# Research thread page

The thread page (`/r/$treeId`) shows a research tree as a horizontal strip of
paired columns, ported from the desktop `ResearchThreadPage.tsx` and its
column components. The code is in `packages/client/src/features/thread/`.
What the strip contains is computed by the shared
`packages/shared/src/lib/researchColumns.ts` (`researchStrip`), the same
module the desktop uses; the web supplies the DOM, the data loading and the
history.

## 1. Concepts

- **Tree**: one research investigation. **Node**: a message. An exchange is a
  question with its answer; a post is a note or a saved link (no run); a
  document is an imported or authored report.
- **Chain**: a node and its inline follow-ups (`inline: true`; at most one
  inline child per node). `inlineChainFor` and `chainDisplayOrder`
  (`researchChains.ts`) give the chain and the order its messages column
  lists it in (`chainOrder`, set by drag reorder).
- **Level**: one chain shown as a pair. Level 0 is the root's chain. Level
  n + 1 is the branch selected in the branches column after level n.
- **Branch**: a non-inline child. A branch asked about a passage carries a
  passage anchor (`passageAnchor`); one asked about the whole answer does
  not.
- **Selection**: one selected message per level, root first. It is the
  `?sel=` search parameter (§4).
- **Unsent branch**: a branch being written (after Branch to right or a
  margin marker), not yet sent. It is a group in the branches column after
  the deepest level, with its own ask box.

## 2. Columns

`researchStrip(nodes, selection, pending, editor)` returns the levels and the
columns in order. `columnAttributes` writes each column's identity into the
DOM (`data-research-column`, `data-research-pair`); code that needs a column
element uses `columnSelector`.

| Role | Component | Content |
| --- | --- | --- |
| messages | `MessagesColumn` | The level's chain as rows (`MessageRow`), the server's queued follow-ups for the chain (`QueuedFollowup`: Cancel, and Retry for a failed send), and the level's ask box. Level 0's header holds the title, Back/Forward and the thread menu. |
| answer | `AnswerColumn` | The selected message's answer (`AnswerPane`): status line, recap, timeline, sources footer, margin markers. `QueuedAnswerColumn` replaces it while a queued item is selected. |
| branches | `BranchesColumn` | "Branches · N": one group per branch of the previous level's listed messages, in passage order (passages from the top, then whole-answer branches). Each group shows its source quote, its messages and its queue; the selected group also has the ask box. The unsent branch is the group headed "New branch". |
| note | `NoteColumn` | A post level: the note (`PostColumn`), double-click to edit. |
| follow-ups | `FollowUpsColumn` | The note's follow-ups (`PostThread`) and the field that asks a question about the note or adds a follow-up note. |
| editor | `EditorColumn` | Editing the root document (after the root's answer column) or a note (in place of its note column). |

`Columns` lays the strip out in one horizontally scrolling row. The
messages-side columns (messages, branches, follow-ups) share one width and the
answer-side columns (answer, note, editor) another; both are automatic (18 %
and 44 % of the strip, clamped) until a `ColumnResizer` sets them, and a set
width is stored per browser (`columnWidths.ts`). Wheel deltas on the strip
scroll it horizontally. The headers of all columns share one height
(`--research-header-height`), so their bottom borders line up. ⌃Tab and
⌃⇧Tab cycle the rows of the column last interacted with.

Message rows clamp at 12 lines with Show more / Show less
(`researchTileOverflows`, `useTileClamp`). A row's glyph shows its run state
(`ui/RowGlyph.tsx`, `researchRowGlyph.ts`). A row with branches shows an
arrow-up-right indicator: it selects the first branch, or clears the next
column when one of the row's branches is open.

## 3. Asking

Every messages column and the selected branch group have an ask box
(`ConversationComposer`). ⌘↵ (Ctrl+↵ off Apple platforms) sends; ⇧⌘↵ sends
the question as a new branch from the selected answer instead. The box has a
model and effort picker (`ModelPicker`, defaulting to the model of the
message it continues) and takes pasted or dropped images (`composer/images.tsx`,
uploaded to `POST /api/images`; the question sends their ids).

- **Follow-up**: `followups.ask` with the chain's head. The server sends it
  at once when the chain's tail is complete and its inline slot is free, and
  queues it otherwise (`05-run-lifecycle-and-streaming.md`). The page reads
  the queue from `detail.queues` and `research.queue.changed`; while the
  tail runs, the box reads "Queue a follow-up" and its button "Queue".
- **Branch**: `research.forkNode` with `inline: false` and the passage
  anchor, if any.
- **Edited failed question**: Edit question on a failed or stopped message
  fills the ask box with its text; sending forks with `replacesNodeId`, so the
  new question takes the failed one's place (`researchEditedQuestionFork`).
- **Note follow-up**: the follow-ups column's field has two modes, Ask and
  Add a note. A follow-up note (`research.createPostFollowUp`) is not sent to
  any agent; its placeholder reads "Add a note (not visible to agent)".

Run controls read `runActive` and `runRetryable` (`runState.ts`): an
`interrupted` run counts as active while `run.resumePending` is not `false`
(the server resumes it) and shows Retry once the server has given up.

## 4. Selection and history

The selection is the `?sel=` search parameter: each level's selected
message id, root first, comma-separated (`useThreadHistory.ts`). Back and
Forward are the browser's; the header's Back/Forward buttons call
`router.history.back()` / `forward()`. The desktop's rules for recording a
visit carry over:

- User navigation pushes an entry: selecting a message, opening a branch,
  clearing a column. Selecting what is already shown adds nothing.
- A selection the page makes itself replaces the entry: the one restored on
  opening (from the URL, else the per-tree store, else the root), a path cut
  to what the tree contains, and the selection after messages are removed
  (`researchSelectionAfterRemoval`).
- `?node=<id>` (from Home or the Highlights view) opens that message's
  source path (`researchLevelPath`) and is replaced by `?sel=`.
  `?highlight=<id>` additionally scrolls to that highlight and flashes it,
  and `?edit=<id>` opens that note in the editor; both parameters are
  removed once handled.

Per-tree state that is not in the URL is kept in localStorage under
`session.thread-navigation.v1` (`persistence.ts`): the last selection, column
scroll offsets (answer, messages, branches; 15-minute TTL), "Show earlier"
expansions, the unsent branch's passage and text, and a pending highlight
focus. Entries for deleted nodes are pruned.

Keyboard (`useThreadKeyboard.ts`):

- ↑/↓, Home/End move between rows of a column; Enter or Space selects the
  focused row and focuses its answer; → goes to the next column (opening the
  first branch when there is none); ← goes back.
- ⌥↑/⌥↓ move the focused message within its column (`setChainOrder`).
- Esc returns focus to the root level's selected row.
- ⌘J (re-dispatched by the app shell) focuses the ask box of the level
  that holds focus.
- ⌃Tab / ⌃⇧Tab cycle rows (above).

Messages are reordered by dragging a row (`useMessageDrag.ts`) or with
⌥↑/⌥↓; the order is stored with `research.setChainOrder` and applied
optimistically.

## 5. Selection, highlights and branches from a passage

The algorithms are in `shared` (`researchSelection.ts`,
`researchHighlights.ts`); the DOM glue is `textRanges.ts`,
`selectionCapture.ts`, `useTextSelection.ts` and `painting.ts`.

1. The browser manages the drag. When a primary-button selection that began
   in an answer ends, it is expanded once to whole words
   (`createResearchSelectionExpander`: `Intl.Segmenter` words, split at
   message boundaries).
2. `captureSelectionAction` measures the selection in the answer's text
   projection (`answer-v1`: the response root's text nodes in DOM order, no
   separators) and clips it to its first paragraph
   (`clipResearchSelectionToParagraph`). A selection that touches a tool or
   thinking row is refused; whitespace is refused unless it lies inside a
   saved highlight.
3. The anchor is `{version: 1, projection: "answer-v1", responseRevision,
   start, end, exact, prefix, suffix}` with up to 128 characters of context,
   clamped to the enclosing message; surrogate pairs are never split. A
   selection in a streaming answer (no revision yet) can be copied but not
   saved.
4. `SelectionToolbar` acts on it: Branch to right (A) opens the unsent
   branch about the passage; Highlight (H) saves it, merging the highlights it
   overlaps (Expand), or Remove highlight(s) (E) when it lies inside saved
   ones; Copy.
5. Painting uses the CSS Custom Highlight API, no wrapped spans. Layers:
   saved highlights, branch passages, overlaps, highlight hover, branch hover,
   the open branch's passage, the unsent branch's passage, the jump flash and
   the selection's highlights (`painting.ts`, styled in `prose.css` with the
   `highlight-pseudo-literal` marker). Without the API, saved highlights are
   drawn by a DOM overlay that adds no text.
6. Anchors are relocated with `resolveResearchHighlightOffset`; a highlight
   that cannot be placed is reported as hidden rather than guessed.
7. Margin markers (`useThreadAnnotations.ts`, `MarkerButton`): one per
   paragraph that has branches, level with it, and one in the answer's foot
   for whole-answer branches. A marker opens its branch, or a menu when there
   are several; its label says how many branches it has and whether one is
   open.

## 6. Answers

`AnswerColumn` loads its node's content with `useNodeContent` (snapshot plus
the live turns while the run is active, `05-run-lifecycle-and-streaming.md`
§4, §9) and builds the view with `buildSegmentView` (`segmentView.ts`):
the collapsed answer is the text after the last tool call, the full trace
shows everything, and at most 100 timeline items are rendered
(`TIMELINE_ITEM_RENDER_WINDOW`, with "Show N earlier response items"). The
live tail keeps its timeline key when the snapshot replaces it, so the answer
does not remount.

While a run is active a status line replaces the footer: "Queued · N ahead",
"Starting…", "Thinking" or "Working", or "Interrupted · resuming", with the
elapsed time and Stop. A settled answer shows its sources footer and its
time; a failed or stopped one shows "Error." or the reason, Retry or Run
again, and Edit question. The recap ("Recap: …") is shown above a complete
answer only when it was written for the revision on screen; Generate recap in
the answer menu opens `RecapDialog` (instructions, Generate candidate, Use
this recap).

Answer widgets render through `ResearchMarkdown` and `features/widgets`. The
page provides `WidgetChangeContext` (Ask for changes opens a whole-answer
branch with `widgetChangePrompt` in its ask box), and each timeline item
provides `WidgetAnswerContext` (node, tree, message key, why a branch cannot
be asked) and `SessionWidgetStreamingContext` (true while the run is
active).

## 7. Editing

- **Document**: Edit document (the root's answer menu) opens the editor
  column after the root's answer. The answer column shows a preview of the
  change. Save writes `research.updateDocument` with the revision it opened;
  a stale revision is refused and the editor stays open. ⌘S saves and stays
  in edit mode with a toast; Cancel asks before discarding changes; Ask as a
  question starts a new thread with the edited text.
- **Note**: double-click a note, or Edit note in its menu, to edit it in
  place. A double-click on a note's card on Home opens the thread with
  `?edit=` (a single click on that card waits 250 ms for the second click
  before opening the thread, since Home is its own route on the web). Save writes `research.updatePost` with `expectedText`; when the
  note changed meanwhile the server refuses and the editor shows the message
  with the text kept.
- **Stale edits (web only)**: a `CONFLICT` from `updatePost` or
  `updateDocument` opens "This note changed" / "This document changed"
  (`features/sharing/StaleEditDialog.tsx`) with the reader's text, read-only
  with Copy my text. Reload latest version refetches the thread (and, for a
  document, its content) and makes the latest saved version the editor's
  base (`expectedText`, title, revision, highlights; what the preview
  compares with); the field keeps the reader's text, so the next save
  replaces the latest version with it. The same prompt follows a refused
  messages reorder (`setChainOrder` with `expectedOrder`, the order the
  column showed; reload refetches the thread) and a refused recap
  (`recaps.applyCandidate`; reload re-reads the answer and its recap and
  drops the candidate, keeping the instructions).

## 8. Menus and dialogs

`ThreadMenu` is one Base UI menu anchored to the clicked button or the
pointer (right-click). The answer menu holds the message's statistics,
Branch to right, Copy answer (or Copy conversation), Copy thread, Show full
transcript, Rerun, Generate recap, Rename…, Edit document and the delete
item. The note menu holds Edit note, Copy note and Delete note (D). Dialogs
are centred confirm dialogs (`ThreadDialogs.tsx`):

- **Rerun**: "Rerun will replace the current answer. Continue?";
  `research.rerunNode`. Refused while the answer, or the answer it follows,
  is still running.
- **Delete**: on the root, "Move to Trash" (`research.trashTree`) with a
  "Delete now" step for permanent deletion; on a branch or follow-up,
  permanent deletion naming what else it removes (both on
  `ui/DeleteDialog`). Refused while runs in the subtree are active.
- **Rename** and **Generate recap**.

## 8a. Shared threads (web only)

`ThreadPage` provides `ThreadCollaborationContext`
(`features/sharing/context.ts`): the reader's permissions
(`features/sharing/permissions.ts`, the server's rules from
`02-domain-model-and-database.md` §5.16) and the thread's participants.

| | Owner | Commenter | Viewer, guest |
| --- | --- | --- | --- |
| Ask boxes, Branch to right, follow-up notes, highlights, Generate recap | yes | yes | no (the selection bar offers Copy alone) |
| Rename, Delete, Edit note / question | any message | their own, while nobody else replied under it | no |
| Retry, Rerun | questions they asked | questions they asked | no |
| Stop | any run | their own | no |
| Cancel / Retry a queued follow-up | Cancel any; Retry their own | their own | no |
| Rename the thread, reorder messages, Edit document, delete the thread | yes | no | no |
| Remove a highlight | any | their own | no |

An archived thread is read-only for everyone, as on the desktop. A guest
(signed out, on a public thread) has no event stream, so the page does not
update live.

- **Thread menu** (the root's answer or note menu): Share… opens
  `ShareDialog` (anyone signed in); Notify me / Stop notifying me toggles
  `subscriptions.set` (`ResearchTree.followed`).
- **Share dialog** (`features/sharing/ShareDialog.tsx`): "Who can read it"
  (Private: the owner and the people it is shared with; Public: anyone with
  the link, listed in All Users), People (owner first; the owner changes a
  member's role, Commenter or Viewer, or removes them), Invite (by GitHub
  username, or Copy invite link, each with a role; the created link is shown
  so it can be copied by hand), and Pending invitations with Revoke. Anyone
  else sees "Who can read it" and People read-only; a member has Leave…,
  which confirms, leaves (`sharing.leave`) and opens Home.
- **Author chips** (`features/sharing/AuthorChip.tsx`), when the thread has
  more than one participant: avatar and name on each question row
  (`MessageRow`), queued follow-up, note (`PostColumnBody`) and follow-up row
  ("You" for the reader), and "Highlighted by …" in a highlight's passage
  menu. "Edited" names the editor when it is not the author ("Edited by …",
  on notes and documents, from `editedBy`).
- **Presence**: the thread is declared open while the page is mounted
  (`useThreadInterest`, renewed by the event bridge, `07` §4.2); the root
  header shows the other people who have it open (`PresenceAvatars`, up to
  four, "Also viewing: …"), from `events.presence` and
  `research.presence.changed`.

## 9. Not ported

The desktop's swipe navigation, its Home group panel in the strip, Move to
folder in the thread menu, client-side retries of queued items (the server
retries), effort on Ask as a question (the model is sent), and restoring the
strip's horizontal position on return.

## 10. Tests

- `test/research.thread.test.tsx`: the strip on the real router: paired
  columns, selection history, whole-answer branches, queued follow-ups with
  Cancel, ⌘↵ and ⌘J, Edit question, Rerun, recap, queue position, snapshot
  swap without remount, note columns, double-click edit with a stale-edit
  refusal, passage quotes.
- `test/research.selection.test.ts`: projection, offsets, word expansion,
  capture, paragraph clipping, live selections.
- `test/research.segment.test.ts`: timeline windowing, status line, run
  state, sources.
- `test/research.threadState.test.ts`: `?sel=` encoding, column widths,
  persistence, composer chords, note follow-up copy.
- `test/research.dialogs.test.tsx`: recap, delete, rerun, tree menu.
- `test/sharing.test.tsx` (web only): the permission rules, what a viewer,
  a commenter and the owner are offered, author chips and Edited by, the
  Share dialog for the owner and for a member, Notify me, presence and its
  renewal, partial tree events, the stale-edit prompt, Shared with me and
  the invitation route.
- `e2e/research.spec.ts`: streaming and reload, resume after reload in two
  tabs, paired columns with keyboard navigation and reload restoring the
  selection, a highlight and Branch to right on another model, a follow-up
  queued while the answer streams and then cancelled, a note follow-up with
  a double-click edit refused as stale, a double-click on a note's Home
  card opening its editor, Rerun, and the recap dialog.
