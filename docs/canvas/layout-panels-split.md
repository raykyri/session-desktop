# Layout: Split panes

Mock: `docs/mockups/canvas-layout-panels-split.html`, a copy of `session-canvas.html` with only layout and navigation changed.

## Layout rules

- There is no canvas and no sidebar. The top bar holds the thread switcher, Post, Ask, the workspace model and the bell.
- The body has at most two panes of equal width. The left pane shows a thread, or the branch that is the parent of the right pane. The right pane shows one branch.
- The view is a path: the root stack, then each branch opened from the step before it. The left pane shows the second-to-last step and the right pane the last. A breadcrumb row above the panes lists the whole path.
- Under each part, every branch that starts at it gets one row showing its first question, part count, sub-branch count and new count. The open branch's row is marked.
- If you open a branch from the left pane, it fills the right pane. If you open one from the right pane, the right pane's stack slides into the left pane and the new branch takes the right pane.
- Clicking a crumb puts that stack in the left pane and the next step in the right pane. "Close branch" removes the last step and leaves one wide pane, centred at up to 820px.
- You can drag the divider to resize the panes, between about 25% and 75%. Double-click it to reset. When focused, it also responds to the arrow keys.
- At 700px or narrower, only one pane is shown. While a branch is open, a segmented control reads Thread | Branch.

## Navigation

- **Mouse wheel:** each pane scrolls vertically on its own, and each stack keeps its scroll position when it moves between panes.
- **Keyboard:**
  - ⌘K or Ctrl+K opens the thread switcher, which is searchable and grouped by channel with new counts. Arrow keys and Enter choose a thread.
  - Alt+← moves one step toward the root, and Alt+→ moves forward again.
  - Branch rows, crumbs, the divider and both panes are reachable with Tab. Once focused, a pane scrolls with the arrow and Page keys.
- **Touch:** panes scroll natively. A long press opens the part menu, and Thread | Branch switches between the panes.
- There is no 2D panning or zoom.

## What the user no longer manages

- Positions, overlap and lanes.
- Zoom level and Fit.
- Collapsing groups to make room.
- Finding a thread that has scrolled off screen. Every thread is in the switcher.

## What is lost

- An overview of all threads and their branch shapes at once. The switcher is a list, not a map.
- Seeing siblings side by side. Two branches from the same paragraph cannot be open together.
- Depth is shown only in the breadcrumb, so the tree shape beyond the current path is hidden.
- Spatial memory: "the thread at the top left".
- Unit collapse is removed because a pane holds one stack.

## How branching from a paragraph is shown

- In the left pane, the source paragraph is tinted and gets an accent bar. A part branched as a whole gets an inset bar instead.
- A connector curve runs from the paragraph's right edge, across the divider, to the left end of the right pane's header, which reads "From paragraph" followed by the quote.
- If the source scrolls out of view, the connector's end is held at the edge of the pane and drawn dashed. Clicking the header scrolls the left pane back to the source.
- On narrow screens there is no connector. The Thread pane keeps the highlight, and the header switches to it.
- Branch rows under a part highlight their anchor on hover. The base mock's 2px marks beside anchored paragraphs remain.

## Open questions

1. Alt+→ reopens a closed branch at its scroll position, but nothing on screen says so. Does it need a visible control?
2. Should a third pane appear on very wide screens instead of shifting?
3. Branch rows add height under parts that have many branches. Should rows collapse after three?
4. The switcher orders threads by last activity within each channel. Should channels be ordered by new count?
5. A draft that has text stays in its stack when you navigate away, and an empty draft is dropped. Is a stack holding only a hidden draft clear enough?
