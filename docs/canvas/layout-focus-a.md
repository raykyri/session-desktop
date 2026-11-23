# Layout 4a: Thread cards and canvas

Mock: `docs/mockups/canvas-layout-focus-a.html`. This variant of layout 4 (`docs/mockups/canvas-layout-focus.html`,
notes `layout-focus.md`) keeps 4's tiles and draws the selected tile's unit on a canvas that pans and zooms, as
`docs/mockups/session-canvas.html` does. There are no discrete views. The page has a thread column at the left and a
canvas in the rest of the page.

## Layout rules

- **Thread column.** Layout 4's tiles, in one column that scrolls vertically on its own.
  - A tile shows the channel, the first post, post and branch counts, the new count, the time of last activity, and
    a thumbnail of the unit's tree (one dot per post, one column per lane).
  - The order is last activity at page load, and it stays fixed during the visit. A new thread goes first.
  - The selected tile has an accent outline.
  - Tiles update as posts and branches are added: counts, thumbnail, new count and time.
- **Canvas.** Everything to the right of the column. It draws one unit: the selected tile's root stack and its
  branches.
  - The layout, connectors, cards and pan/zoom code are those of the base mock. Each branch sits in a lane beside its
    anchor post or anchor paragraph. Siblings are stacked by subtree extent. A connector starts at the anchor
    paragraph, which is marked.
  - The root of the unit is at the canvas origin. No positions are stored.
- **Framing.** Choosing a tile frames its unit. The unit is aligned to the top left of the canvas, at the zoom that fits
  its width, with a floor of 80% and a ceiling of 100%. A wider unit shows its first lanes, and the rest is reached
  by panning. Below 720px wide, the floor is the zoom that fits one lane.
- **Fit.** Fit shows the whole unit, at any zoom down to 15%. Below 50%, each stack shows one headline, as in the base
  mock.
- **Below 720px wide.** The page shows either the column or the canvas. Choosing a tile opens the canvas, and a
  Threads button on the canvas returns to the column. Add post, Add ask and the bell stay in the header.

## Navigation

- **Mouse.**
  - Click a tile to select it and frame its unit. Clicking the selected tile frames it again.
  - Drag the empty canvas or use the wheel to pan. Ctrl+wheel zooms at the pointer. The zoom buttons, the percentage
    (back to 100%) and Fit are at the top right of the canvas.
  - Click a stack to select it.
- **Keyboard.**
  - In the column, ↑ and ↓ move between tiles and select them. Home and End go to the first and last tile.
  - Enter, Space or → moves focus into the canvas.
  - On the canvas, ← selects the parent stack. → selects a child stack: the one last visited, or else the first one in
    view. ↑ and ↓ select the stack above or below in the same lane. The canvas pans to keep the selection in view.
  - ← on the root stack, or Escape, returns focus to the selected tile.
- **Touch.** Tap a tile to open the canvas. One finger pans, except on text and controls, and two fingers pinch to
  zoom. A long press on a post opens the part menu.

## Kept from layout 4

- Add post and Add ask. The new thread gets a tile at the top of the column and opens on the canvas with its draft.
  Discarding the empty draft removes the tile and selects the previous one again.
- The bell. Choosing a post selects its thread's tile (the column scrolls to it), selects its stack, and pans the
  canvas to the post. A post in the upper part of its stack is shown with the stack's header.
- The part menu (right-click, or long press on touch) for branching from a paragraph, a selection or a whole post.
  The column and canvas both update.
- Drafts, seams and Continue for the stack's author. Stop on a queued or running answer (from the base mock; the
  seed has no running answers, so Stop appears after an ask).

## Differences from layout 4

- No focus view, no lane sliding, no pinned root, no hidden-lane control, no dashed stubs and no breadcrumb. Lanes
  keep a fixed width (320px), and the canvas pans and zooms instead.
- The overview is a single column beside the canvas, not a page of its own. The tiles are always visible on a wide
  page, so moving between units takes one click or one key.
- Ctrl+wheel and pinch zoom the canvas. In 4 they switched views.
- Only the connector that starts the selected stack is drawn in the accent colour, as in the base mock. 4 coloured
  the whole path from the root.
- No "Ask about this" button on text selection, as in the base mock. The part menu offers "Ask about the selection".

## What the user no longer manages

Placing units, and overlaps between units. Only one unit is drawn at a time.

## What is lost

- Comparing several units side by side. Moving to another unit replaces the canvas.
- Spatial memory across units. Each unit starts at the same place, and pan and zoom are not kept per unit.
- The column takes 344px of a wide page, so a unit with four lanes or more needs panning at 80%.

## Open questions

1. Should pan and zoom be remembered per unit, so returning to a tile restores where the person was?
2. Is 80% the right floor for framing, or should a wide unit start at 100% with its first two lanes?
3. Should the column narrow, or collapse to an icon strip, while the person works on the canvas?
4. Below 720px, should the canvas keep a strip of the column (the selected tile) for context?
