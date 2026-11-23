# Layout: Split panes

Mock: `docs/mockups/canvas-layout-panels-split.html`, a copy of `session-canvas.html` with only layout and navigation changed.

## Layout rules

- There is no canvas and no sidebar. The top bar holds the thread switcher, Post, Ask, the workspace model and the bell.
- The view is a path: a root stack, then each branch opened from the step before it. The left pane shows the second-to-last step and the right pane the last. A breadcrumb row lists the whole path.
- Under each part, each branch that starts there has a row: its first question, part count and new count. The open branch's row is marked.
- A branch opened from the left pane fills the right pane. One opened from the right pane slides the right pane's stack into the left pane.
- A crumb puts its stack on the left and the next step on the right. "Close branch" drops the last step and leaves one wide pane.
- The divider drags between about 25% and 75%. Double-click resets it, and arrow keys move it when it has focus.
- At 700px or narrower, one pane is shown, chosen with a Thread | Branch control.

## Navigation

- **Wheel:** each pane scrolls on its own, and a stack keeps its scroll position when it changes panes.
- **Keyboard:** ⌘K or Ctrl+K opens the switcher, which is searchable and grouped by channel with new counts. Alt+← steps toward the root and Alt+→ steps forward. Rows, crumbs, the divider and the panes are Tab stops.
- **Touch:** panes scroll natively, a long press opens the part menu, and Thread | Branch switches panes.
- There is no 2D panning or zoom.

## What the user no longer manages

- Positions, overlaps and lanes.
- Zoom and Fit.
- Collapsing groups to make room.
- Finding threads that have scrolled off screen.

## What is lost

- An overview of every thread's shape. The switcher is a list, not a map.
- Siblings side by side. Two branches of one paragraph cannot be open together.
- The tree beyond the current path. Only the breadcrumb shows depth.
- Spatial memory, and unit collapse.

## How branching from a paragraph is shown

- In the left pane, the source paragraph is tinted and gets an accent bar. A whole-part source gets an inset bar.
- A connector curve runs from the paragraph's right edge, across the divider, to the right pane's header, which reads "From paragraph" and the quote.
- If the source scrolls out of view, the connector's end stays at the pane's edge and is drawn dashed. Clicking the header scrolls back to the source.
- On narrow screens there is no connector. Clicking the header switches to the Thread pane, where the highlight stays.

## Open questions

1. Alt+→ reopens a closed branch, but nothing on screen says so. Should there be a visible control?
2. Should a third pane appear on very wide screens instead of the shift?
3. Should branch rows collapse after three?
4. A draft with text stays behind when you navigate away. Is that clear enough?
