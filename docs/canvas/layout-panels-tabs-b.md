# Layout: Thread list and branch columns (12b)

Mock: `docs/mockups/canvas-layout-panels-tabs-b.html`. It starts from layout 12, "Branch tabs"
(`canvas-layout-panels-tabs.html`), and replaces its tab bar and one-stack reader with one row of layout 3, "Rows"
(`canvas-layout-rows.html`). The data model, context rules, post menu, drafts, end composer and bell are layout 12's,
with the post and run changes of `session-canvas.html` (see "From the base mock" below).

## Layout rules

- A left sidebar lists threads (root stacks) by last activity, as in layout 12. The open thread's row has the hover
  background. The sidebar is the only thread switcher.
- The main area shows the open thread as one row of depth columns. Column 0 holds the root. Column 1 holds the root's
  branches, top to bottom in anchor order (by post, then paragraph). Column 2 holds the branches of the column-1
  stacks, parent by parent in column order, so one parent's group never interleaves with another's; and so on.
- In each column, a branch is placed so that its connector end (the middle of its "From paragraph" line) is level
  with its anchor, where there is room; otherwise it goes 16px below the stack above it in the column. Stacks never
  overlap.
- A branch made while the page is open goes to the end of its parent's group, so the stacks already shown do not
  move. Its connector can then cross its siblings' connectors until the next load.
- Cards have no height cap. Long answers keep "Show all". The pane scrolls vertically, and horizontally when the
  columns are wider than it.
- Column width: three columns fit the pane, between 300 and 400px each (344px at 1440px with the 280px sidebar). A
  thread four columns deep scrolls sideways; the bar's arrows move the pane by one column.
- Below 760px, the sidebar is a drawer. A column is the pane width minus a 28px peek of the next column, and
  horizontal scrolling snaps to columns.

## Navigation

- **Mouse:** the wheel scrolls the pane; Shift+wheel or a trackpad swipe scrolls it sideways. The bar's arrows move
  it by one column. A click on a stack selects it; a click on the empty pane clears the selection.
- **Keyboard:** ← selects the parent; → selects a branch (the one last left with ←, else the first). ↑ and ↓ select
  the stack above or below in the same column and stop at its ends. With nothing selected, an arrow selects the
  root. Enter moves to the selected stack's composer, if the viewer wrote the stack. `[` and `]` open the previous
  or next thread in the sidebar. In the thread list, Up/Down move. Posts are focusable, and the context-menu key
  opens the post menu.
- **Touch:** swipe vertically and horizontally in the pane; a column snaps to the left edge, and the next column
  shows at the right edge. Long-press a post for the post menu.
- **Selection:** the selected stack has an accent ring. The connectors from the root to it use the accent colour, and
  so does the hovered branch's connector. The paragraph the selected or hovered branch starts from is tinted.
  Selecting a stack marks its posts as read. Each thread keeps its selected stack and scroll position while the page
  is open.
- **Bell:** an item opens its thread (its sidebar row is marked and scrolled into view), selects the stack, scrolls
  the pane to the post and flashes it.

Zoom, Fit, dragging, double-click to create and 2D free placement are not part of this layout.

## Differences from layout 12

- No tabs. Every branch of the open thread is on screen in its column, so there is nothing to open or close. The
  tab bar, the tab overflow menu, middle-click and the `[`/`]` tab keys are gone; `[`/`]` switch threads instead.
- No branch markers in the card margin. The connector dot on the parent's right edge marks the anchor, and the branch
  is next to it.
- "From paragraph ↗" does not switch tabs: it keeps the branch selected, scrolls the pane to the paragraph in the
  parent (expanding "Show all" if the paragraph is under it) and flashes it.
- The post menu's items say "New branch in the next column" instead of "New branch tab".
- The end composer ("Continue") is open on every stack the viewer wrote, in every column, not only in the active
  tab. Each keeps its own text.
- The bar shows the open thread's channel and first words on every width, the key hints on wide pages, the column
  arrows when the pane scrolls sideways, and the bell.
- Layout 12 has no Stop control on running answers; 12b has the base mock's Stop (see below).

## From the base mock

These follow `docs/mockups/session-canvas.html` ("0. Session Canvas") and `session-canvas-concept.md`; layouts 3 and
12 do not have them yet.

- **Terms.** Visible text and labels say "post" (one block of text by one author, or one model answer), "stack" (the
  drawn column of a thread) and "branch"; "part" and "fork" remain only in code names and the stored `fork` field.
  Examples: "N posts · M branches" in the root header and the sidebar, "Insert a post here", "Add a post", "Next
  post", "The run read N posts".
- **No selection button.** Selecting text in an answer shows no floating "Ask about this" button. The post menu
  offers "Ask about the selection" when text is selected.
- **No "Inserted" label.** A post written after the posts below it has no label.
- **Stop.** A queued or running answer shows a Stop button to the thread's author. Stop cancels the run's remaining
  timers and sets its status to `stopped`; the answer then reads "Stopped before it finished", keeps the text
  written so far and has no progress bar. The pending line reads "Queued" or "Step n of 4 · …", without a count of
  the posts read.
- **Run record.** A run has no `by` (who asked) or `ctx` (ids read); context is set by position. A person's post
  directly followed by an answer is a question and answer pair, whoever wrote the post, so there is no "Asked by"
  line.

## Differences from layout 3

- One thread at a time, chosen in the sidebar, instead of a page of rows. There is no row header, no row collapse
  and no per-stack dots; the sidebar shows counts and new posts per thread.
- ↑ and ↓ stop at the ends of a column instead of moving to the previous or next row.
- Stacks keep layout 12's card design: a header on the root, "From paragraph ↗" with the quote on branches, and the
  always-open end composer instead of a "Continue" button.
- The highlighted path covers every connector from the root to the selected stack, not only the selected branch's.
- Column width follows the pane (three columns) instead of a fixed 320px.

## What the user no longer manages

Placement, overlap, 2D panning, zoom, Fit, connector crossings, and which branches are open.

## What is lost

- A view of several threads at once: other threads are only rows in the sidebar.
- A branch starts level with its anchor only while there is room; behind a tall sibling it starts lower, and the
  connector turns.
- In a column with several tall branches, the later ones are far below their anchors and need vertical scrolling.
- On a thread deeper than the pane is wide, and on every narrow page, a parent and its deeper branches are not
  visible together; the connector shows only its stub at the edge of the column in view.
- Compared with layout 12, a single stack is narrower (344px instead of up to 656px), so long answers
  are taller.

## Branching from a paragraph

A dot on the parent's right edge sits level with the anchored paragraph (hollow when the paragraph is under "Show
all"; the dot then sits at the bottom of the shortened answer). Each branch has one connector, from the dot to the
branch's left edge at its "From paragraph" line: a straight line when the branch is level with its anchor, an elbow
in the gap when it was pushed down. Elbows whose vertical spans overlap are spread across the gap, later branches
nearer the parent, so connectors in anchor order do not cross. Anchors under "Show all" share one dot position.

The post menu (right-click, long-press or the context-menu key) offers "Ask about this paragraph" and "Branch from
this answer" (or question, post). The new branch goes to the end of its parent's group in the next column, is
selected, and its draft is focused; the pane scrolls to it.

## Adding to a stack

- Under the last post of every stack the viewer authored, in any column, a composer is always open. Its placeholder
  is "Continue". It has the draft's fields: a text area, "Add a post", Post and Ask. Ask is the primary button when
  the last post is an answer, Post otherwise.
- The composer is not a draft until it has text. Switching threads does not ask; the text stays with its stack
  while the page is open.
- Post (Shift+Cmd/Ctrl+Enter) appends the posts; Ask (Cmd/Ctrl+Enter) appends them and an answer. Afterwards the
  composer is open, empty and focused, and the stack below it in the column moves down if the stack grew.
- The discard control shows only when the composer holds text or an extra post field. Escape leaves the composer and
  keeps its text; focus moves to its stack, so the arrow keys work from there.
- The "+" between two posts still opens an insert draft there. Stacks written by others have no composer; the post
  menu branches from them.

## Open questions

1. Should ↑ and ↓ at the end of a column move to the previous or next thread, as rows do in layout 3?
2. Should a branch made during the visit take its anchor order at once, moving the siblings below it?
3. Should the root column be wider than the branch columns when the thread is shallow?
4. On narrow pages, should tapping a connector dot scroll to its branch, since the branch is usually off-screen?
5. How does the sidebar scale without channel grouping or filters?
