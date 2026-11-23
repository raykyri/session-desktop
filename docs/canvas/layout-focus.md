# Layout: Overview and focus

Mock: `docs/mockups/canvas-layout-focus.html`. There are two discrete views and no continuous pan or zoom.

## Layout rules

- **Overview.** Each unit (a root and its lane forks) is a tile in a responsive grid that scrolls vertically.
  - A tile shows the channel, the first part, counts and new parts.
  - A thumbnail draws the unit's tree: one dot per part and one column per lane.
  - Tiles are ordered by last activity at page load, and the order stays fixed during the visit. A new unit goes
    first.
- **Focus.** One unit, laid out by the existing lane rules, with lane width fitted to the viewport.
  - If the whole unit fits, nothing moves.
  - With room for three lanes or more, the root is pinned at the left, and branch lanes slide under it. A control
    counts the hidden lanes.
  - With room for two lanes, the pair slides.
  - On a phone, the selected lane fills the width and the parent shows as a strip at the left edge.
  - Selecting a stack applies the smallest slide that keeps the stack and its parent in view.

## Navigation

- **Mouse.**
  - Click a tile to open it.
  - Click a stack, a breadcrumb (Root › Branch › Branch) or the hidden-lane control to select it.
  - "← All" or Escape returns to the overview at the same scroll position.
  - Ctrl+wheel switches views, and a horizontal trackpad swipe moves one lane.
- **Keyboard.**
  - In the overview, the arrow keys move between tiles and Enter opens one.
  - In focus, ← selects the parent and → selects the last child you visited.
  - In focus, ↑ and ↓ scroll a tall stack, then move to the next stack in the lane.
- **Touch.** Tap to open or select. Pinch switches views, and a horizontal swipe moves one lane.

## What the user no longer manages

Placing units, overlaps, the zoom level, and position in two dimensions.

## What is lost

- Spatial memory, and deliberate arrangement. Grid order only follows recency.
- Comparing several units side by side.
- On a laptop, with four lanes or more, the middle lanes are hidden. The breadcrumb stands in for them.

## Branching from a paragraph

This is unchanged in focus.
- The anchor paragraph is marked, and the connector starts at it.
- The fork header reads "From paragraph" above the quote.
- When the parent lane is hidden, the fork gets a dashed stub. On a phone, the parent strip shows no text. In both
  cases the header quote carries the link.

## Open questions

1. Should the overview order be live, or fixed per visit as it is here?
2. On a phone, is a parent strip enough context for a paragraph branch?
3. Collapse is removed, because the tile is the collapsed form. Do long units need it inside focus?
