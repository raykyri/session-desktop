# Layout: Rows

Mock: `docs/mockups/canvas-layout-rows.html`, a copy of `session-canvas.html` that changes only layout and navigation.

## Layout rules

- The page is a vertical list of rows, one per root stack, ordered by last activity at load. Rows keep their place while the page is open; Add post and Add ask insert a row at the top.
- A row has one column per depth. Column 0 holds the root. Column 1 holds the root's branches, stacked top to bottom in anchor order (by part, then paragraph). Column 2 holds the branches of the column-1 stacks, parent by parent in column order, so one parent's group never interleaves with another's; and so on.
- In each column a branch is placed level with its anchor where there is room (the connector's end, 16px below the branch's top, at the anchor's height); otherwise it goes 16px below the stack above it in the column. Stacks never overlap.
- A branch made while the page is open goes to the end of its parent's group, so the stacks already shown do not move. Its connector can then cross its siblings' connectors until the next load.
- Row height follows the tallest column, with no cap: cards are never cut off and the page scrolls. Long answers keep "Show all".
- Rows with parts new to the viewer start expanded.

## Navigation

- **Wheel:** scrolls the page. Shift+wheel or a trackpad swipe moves a row sideways. The row header has arrows that move by whole columns, and one dot per stack (column by column), filled while its column is in view, that selects it and scrolls the row and, if the stack is out of view, the page to it.
- **Keyboard:** ← moves to the parent; → moves to a branch (the one last left with ←, else the first). ↑ and ↓ move between the stacks in a column; past the top or bottom of the column they move to the previous or next row, returning to that row's last selected stack. Enter expands a collapsed row.
- **Touch:** swipe vertically for the page and horizontally for a row, which snaps. The next card shows at the edge.
- **Bell:** an item scrolls to its row, then its stack, then its part.

## What the user no longer manages

Placement, overlap, 2D panning, zoom, Fit and connector crossings.

## What is lost

- Spatial memory, and a view of the whole channel.
- A branch starts level with its anchor only while there is room; behind a tall sibling it starts lower, and the connector turns.
- In a column with several tall branches, the later ones are far below their anchors and the parent, and need vertical scrolling.
- On a row deeper than the page is wide, the parent and its deeper branches are not visible together.

## Branching from a paragraph

A dot on the parent's right edge sits level with the marked paragraph (hollow when the paragraph is hidden under "Show all"; the dot then sits at the bottom of the shortened answer). Each branch has one connector, from the dot to the branch's left edge next to its header: a straight line when the branch is level with its anchor, an elbow in the gap when it was pushed down. Elbows whose vertical spans overlap are spread across the gap, later branches nearer the parent, so connectors in anchor order do not cross. The selected or hovered branch's connector uses the accent colour and its paragraph is tinted. The branch header ("From paragraph" and the quote) stays pinned in its card; clicking it scrolls back to the paragraph.

## Does a row stay legible with 6 or more branches?

Better than with siblings side by side: siblings share one column, so the row grows downward, and the width depends only on depth (three columns fit at 1280px, four at 1440px). With many siblings from one answer, the later ones are pushed well below their anchors; each still has its own connector, but the elbows stand close together (6px apart) and the page must scroll to reach them. Anchors under "Show all" share one dot position at the bottom of the shortened answer. The dots and the branch count show size and position.

## Open questions

1. Should rows re-sort live when others post?
2. Should cards scroll internally, which catches the wheel, or only clamp?
3. Should a branch made during the visit take its anchor order at once, moving the siblings below it, rather than going to the end of its group?
