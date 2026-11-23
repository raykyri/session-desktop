# Layout: Columns

Mock: `docs/mockups/canvas-layout-columns.html`. Only the layout and navigation of `session-canvas.html` change.

## Layout rules

- The page is split. The left 58% holds the column strip; the right part is a canvas pane that draws the open thread
  in 2D (see "Canvas pane" below).
- One strip of equal-width columns. The strip scrolls horizontally inside its own container; each column scrolls
  vertically on its own. Columns are sized so that two full columns and three spines fit the strip on a 1440px
  screen (one full column from 900 to about 1300px wide).
- Column 1 lists the root stacks, most recent activity first. Every later column holds one stack.
- The open columns form a trail. Opening a branch from column k puts it in column k+1, closes the columns after it, and scrolls it into view.
- Earlier columns stick at the left as 40px spines with a vertical title. Scroll positions are aligned, so a column shows in full or as a spine. A narrow screen shows only the previous column's spine.
- Below 900px only one of the two is shown, the columns by default. A button in the top bar (Canvas / Columns)
  switches between them. Opening a stack from the canvas, from the bell, or with Add post or Add ask switches back to
  the columns.

## Canvas pane

- It shows the thread whose root is open in the first stack column: the root and all its branches. With no stack
  open it shows an empty state ("No thread is open").
- Placement, card styling, connectors, the model mark and avatars are those of `session-canvas.html`. Each branch
  sits in a lane to the right of its source stack, level with the source paragraph or part; siblings are stacked by
  the height of their subtree, so connectors do not cross. A connector runs from the source paragraph (or part) on
  the right edge of the source card to the top of the branch.
- Cards are drawn in full, not in the collapsed "N more posts" form, because a collapsed card hides the paragraphs
  that connectors start from. Answers over 520 characters are clamped as in the base mock, except answers with
  paragraph branches. Below 50% zoom each card shows a headline in place of its text, as in the base mock.
- The pane is read-only: drafts, inserts, the part menu and drags all happen in the columns. A draft branch appears
  in the pane as a card marked "Draft".
- **Pan:** drag anywhere in the pane, or scroll (Shift+scroll moves sideways). **Zoom:** Ctrl/Cmd+scroll, pinch, the
  − and + buttons, or the percentage (back to 100%). **Fit** shows the whole thread. The view is kept while the same
  thread is open; opening another thread fits its width (at no less than 45%) and aligns its top.

## Keeping the two in sync

- Stacks open in the columns have an accent outline in the pane, and the connectors into them are accent. The
  selected stack has a stronger outline and a thicker connector.
- Clicking a card opens the path from the root to that stack in the columns, as the bell does, and pans the pane so
  the card is at the top. A card already open in the columns only focuses its column.
- When the selection changes in the columns (opening a branch, clicking a stack, a spine, ← or →) and the selected
  card is off-screen, the pane pans to it.
- Hovering a stack, its branch row or its index row in the columns outlines its card with a dashed line. Hovering a
  card outlines the same stack in the columns: its column header, its card, the branch row under its source and its
  index row.

## Navigation

- **Wheel or trackpad:** vertical scroll moves the column under the pointer. Shift+wheel or a sideways swipe moves along the strip, which snaps to the aligned positions.
- **Keyboard:** ← and → move focus between columns; ↑ and ↓ scroll the focused column.
- **Touch:** a swipe moves one column. Tapping a spine returns to it. A long press opens the part menu.
- **Stepping back:** click a spine, or a branch's "From paragraph" header, which scrolls the source column to the paragraph.

## Creating branches

- The part menu works as before, and its result opens in the next column.
- Drag a part by its avatar or model mark, or drag selected text, into any column to the right, or into the empty slot after the last column. A drop on a column replaces it and the columns after it. A dragged selection is stored as `block` and `quote`.

## How a paragraph branch is shown

- A paragraph's branches are listed under it; whole-part branches are listed under the part.
- While a branch is open, its row and the paragraph's margin mark turn accent. A connector runs from the paragraph to the "From paragraph" header.
- A branch dropped further right gets no connector. Its row reads "N columns right" and its header reads "N columns left".

## What the user no longer manages

Positions and overlaps. The canvas pane is placed automatically and cannot be rearranged; the trail to the left of a
branch is the context it reads.

## What is lost

- Side-by-side reading in the columns: one path through a tree is open at a time. The canvas pane gives the overview
  of the whole thread, at a size where long threads show headlines rather than text.
- Collapse, which the index row replaces, and double-click to create.
- Moving a thread by dragging its header, and creating or editing in the 2D view.
- On a screen narrower than 900px, the columns and the canvas cannot be seen at the same time.

## Open questions

1. Should the trail persist per viewer, or be shareable as a link?
2. Is a drop into an existing column worth having, given that the branch then sits away from its source?
3. Should the index filter or group by channel?
4. Does an answer with many paragraph branches need a way to jump between them?
5. Should the canvas pane show every thread (as the base mock does) rather than only the open one?
6. Should the pane be resizable, or collapsible to give the columns the full width?
