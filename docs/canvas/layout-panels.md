# Layout: thread and branch panel

Mock: `docs/mockups/canvas-layout-panels.html`. Only layout and navigation differ from the base.

## Layout rules

- Three fixed regions replace the canvas:
  - **Sidebar.** The chosen channel's threads by last activity, each with its new-part count.
  - **Main pane.** One stack in a column up to 720px wide.
  - **Right panel.** One branch below the main stack.
- **Channels** (All, then each channel, with new counts) are shown in one of three places, set with the "Channels" toggle at the right of the top bar. The row and toggle are the same as in layout 5 (`canvas-layout-miller.html`).
  - **Header** (default): a row of chips in the top bar, after Add post, Add ask and the model. The row scrolls horizontally when it does not fit, and fades at the edge it continues past.
  - **Above**: the same row as its own 40px bar above the top bar.
  - **Sidebar**: a list above the threads, as before.
  The choice is view state, kept in localStorage.
- Under each part with branches, a row ("2 branches") lists each branch's author and first line. Choosing one opens it in the panel.
- The panel header has a trail (Thread › Branch › Branch), Swap, Close and the quoted source. A branch opened inside the panel replaces its content and extends the trail, so depth never adds panes.
- Swap moves the branch into the main pane. There, Swap or the quote puts the parent back, with the branch in the panel.
- Composers sit at the bottom of the main pane and the panel. Only the author's composer continues the stack. Everyone else sees "Only X continues this thread" and a button that branches from the last part.
- At 960px and below the sidebar is a drawer. At 720px and below the panel is a full-screen sheet.
- At 960px and below, with channels in a row, the row scrolls horizontally; in Header it is a second row of the top bar. Choosing a channel there opens the drawer on its threads. The toggle shows icons only.

## Navigation

- **Wheel:** each region scrolls vertically on its own.
- **Keyboard:**
  - Tab reaches threads, branch rows, markers and parts.
  - Alt+↑/↓ changes thread.
  - In the channel row, ←/→ (and Home/End) move between channels and choose them; Tab leaves the row at the chosen channel.
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
