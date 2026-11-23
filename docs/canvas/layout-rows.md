# Layout: Rows

Mock: `docs/mockups/canvas-layout-rows.html`, a copy of `session-canvas.html` that changes only layout and navigation.

## Layout rules

- The page is a vertical list of rows, one per root stack, ordered by last activity at load. Rows keep their place while the page is open; Add post and Add ask insert a row at the top.
- A row holds the root, then one column per branch, depth first. Each stack is followed by its branches in anchor order.
- Row height follows the tallest stack, with no cap: cards are never cut off and the page scrolls. Long answers keep "Show all".
- Rows with parts new to the viewer start expanded.

## Navigation

- **Wheel:** scrolls the page. Shift+wheel or a trackpad swipe moves a row sideways. The row header has arrows that move by whole stacks, and one dot per stack, filled while in view, that selects it.
- **Keyboard:** ↑ and ↓ move between rows, returning to each row's last selected stack. ← and → move through a row. Enter expands a collapsed row.
- **Touch:** swipe vertically for the page and horizontally for a row, which snaps. The next card shows at the edge.
- **Bell:** an item scrolls to its row, then its stack, then its part.

## What the user no longer manages

Placement, overlap, 2D panning, zoom, Fit and connector crossings.

## What is lost

- Spatial memory, and a view of the whole channel.
- A branch no longer starts level with its anchor.
- On a wide row, the parent and its later branches are not visible together.

## Branching from a paragraph

A dot on the parent's right edge sits level with the marked paragraph (hollow when it is scrolled out of the card). The connector runs from the dot to a spine in the gap, up to a bus in a rail above the cards, and down into the branch. Each parent has one bus, 8px lower per depth level, so buses never cross. The selected or hovered branch's path uses the accent colour and its paragraph is tinted. The branch header ("From paragraph" and the quote) stays pinned in its card; clicking it scrolls back to the paragraph.

## Does a row stay legible with 6 or more branches?

It can be navigated but not read at a glance. At 1280px three stacks fit; with 8 branches (tested) most of the row is off-screen. Siblings share a bus, so only the selected branch's path can be traced. Past the third column the anchor is off-screen; only the header quote and its reveal show where a branch starts. The dots and the branch count show size and position.

## Open questions

1. Should rows re-sort live when others post?
2. Should cards scroll internally, which catches the wheel, or only clamp?
3. Should many sibling branches share one column?
