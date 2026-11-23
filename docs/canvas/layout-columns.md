# Layout: Columns

Mock: `docs/mockups/canvas-layout-columns.html`. Only the layout and navigation of `session-canvas.html` change.

## Layout rules

- One strip of equal-width columns. The strip scrolls horizontally; each column scrolls vertically on its own.
- Column 1 lists the root stacks, most recent activity first. Every later column holds one stack.
- The open columns form a trail. Opening a branch from column k puts it in column k+1, closes the columns after it, and scrolls it into view.
- Earlier columns stick at the left as 40px spines with a vertical title. Scroll positions are aligned, so a column shows in full or as a spine. A narrow screen shows only the previous column's spine.

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

Positions, overlaps, zoom and 2D panning. The trail to the left of a branch is the context it reads.

## What is lost

- An overview: one path through a tree is visible at a time, so sibling branches cannot be compared side by side.
- Collapse, which the index row replaces, and double-click to create.
- Fit, zoom and pan. The spines show the whole trail, so none of them is kept.

## Open questions

1. Should the trail persist per viewer, or be shareable as a link?
2. Is a drop into an existing column worth having, given that the branch then sits away from its source?
3. Should the index filter or group by channel?
4. Does an answer with many paragraph branches need a way to jump between them?
