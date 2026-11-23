# Layout: thread and branch panel

Mock: `docs/mockups/canvas-layout-panels.html`. Only layout and navigation differ from the base.

## Layout rules

- Three fixed regions replace the canvas:
  - **Sidebar.** Channels, then the chosen channel's threads by last activity, each with its new-part count.
  - **Main pane.** One stack in a column up to 720px wide.
  - **Right panel.** One branch below the main stack.
- Under each part with branches, a row ("2 branches") lists each branch's author and first line. Choosing one opens it in the panel.
- The panel header has a trail (Thread › Branch › Branch), Swap, Close and the quoted source. A branch opened inside the panel replaces its content and extends the trail, so depth never adds panes.
- Swap moves the branch into the main pane. There, Swap or the quote puts the parent back, with the branch in the panel.
- Composers sit at the bottom of the main pane and the panel. Only the author's composer continues the stack. Everyone else sees "Only X continues this thread" and a button that branches from the last part.
- At 960px and below the sidebar is a drawer. At 720px and below the panel is a full-screen sheet.

## Navigation

- **Wheel:** each region scrolls vertically on its own.
- **Keyboard:**
  - Tab reaches threads, branch rows, markers and parts.
  - Alt+↑/↓ changes thread.
  - The context-menu key or Shift+F10 opens a focused part's menu.
  - Escape closes the menu, drawer, draft, then panel.
- **Touch:** tap threads and branch rows; press and hold a part for its menu.
- **Bell:** it opens the thread and, for a part in a branch, that branch in the panel, then scrolls to the part.

## No longer managed

Position, overlap, zoom, expanded units, and where a new stack goes.

## Lost

- The overview: two stacks are visible at once, and siblings are compared through summary rows.
- Spatial memory and arrangement by hand.
- Collapse and clamped answers, which a scrolling pane does not need.
- A branch's sub-branches are visible only after you open it.

## Branching from a paragraph

The paragraph gets a faint left rule and a gutter marker with its branch count. One branch opens directly; several open a list. In summary rows, paragraph branches carry a pilcrow.

While a branch is open:
- its source paragraph (or part) is highlighted in the main pane;
- its marker is filled;
- the panel header quotes the source.

Hovering a branch row highlights its anchor.

## Open questions

1. A paragraph branch cannot be made from the keyboard alone. Should paragraphs be focusable?
2. Should each trail step keep its scroll position?
3. The main pane highlights only the first anchor on the path. Should it show the whole path?
4. Leaving a draft with text asks first. Should it be kept instead?
