# Layout: stacked sheets

Mock: `docs/mockups/canvas-layout-panels-sheets.html`. Only layout and navigation differ from the base.

## Layout rules

- **Sidebar.** Channels, each with its threads by last activity, new-part counts and branch counts. It collapses to one tile per channel; a tile lists that channel's threads.
- **Reader.** One thread in a single column, up to 700px wide.
- **Sheets.** Opening a branch slides its stack in from the right, covering 62% of the width.
  - The thread behind it is dimmed and its column moves to the left edge. The sidebar collapses to tiles unless it was expanded on purpose.
  - A branch opened inside a sheet stacks a new sheet on top, 24px further right.
  - Older sheets keep a 24px strip with their level number, author and first line.
- **Sheet header.** "From paragraph" (or answer, question, post), the channel and author, the quoted source, and a close button. Each sheet ends with its own Continue (author) or Branch (everyone else).
- **Motion.** Sheets slide in 200ms and out 160ms. Inserts move parts below for 200ms. With `prefers-reduced-motion`, nothing animates.
- **Narrow screens.** At 640px and below, sheets are full-screen with a Back button, and the sidebar is a drawer.

## Navigation

- **Mouse and wheel.**
  - The reader and each sheet scroll vertically on their own.
  - Choosing a strip pops back to that level. Choosing the dimmed thread closes every sheet.
- **Keyboard.**
  - Tab reaches threads, branch chips and branch pills; Enter opens one.
  - Escape closes the menu, drawer and a draft in the top level, then pops one sheet. Focus returns to the control that opened it.
- **Touch.**
  - Swipe a sheet right to pop it; the sheet follows the finger.
  - Long-press a part for its menu.
- **Bell.** It opens the part's thread and the sheets leading to its stack, then scrolls to the part.

## No longer managed

Position, overlap, zoom, panning, Fit, collapsed units and where a new stack goes. The open path is view state; nothing is placed by hand.

## Lost compared with the free canvas

- Seeing two sibling branches, or two threads, side by side.
- A spatial overview of a channel. The sidebar list replaces it.
- Deep paths are reachable only by stepping down from the thread.
- Older sheets show only a strip, so a parent sheet's text is hidden while a child is open.

## Branching from a paragraph

- In the reader and in sheets, the paragraph has the base mark and a chip in the right margin with the branch count. With more than one branch, the chip lists them.
- Branches from a whole part are pills under the part.
- While a first-level sheet is open, its source paragraph is raised over the dimmed thread and tinted. A bar on the sheet's left edge stays level with it as the reader scrolls.
- Every sheet header quotes its source.

## Open questions

1. Should Escape on a sheet with an unsent draft pop the sheet after confirming, rather than only closing the draft?
2. Should nested sources stay visible, for example by narrowing the parent instead of covering it?
3. Should the sidebar collapse automatically when a sheet opens, or should the sheets narrow instead?
4. Is a 24px strip enough to choose a level by touch, or do tablets need wider strips?
