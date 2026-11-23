# Layout: stacked sheets

Mock: `docs/mockups/canvas-layout-panels-sheets.html`. Only layout and navigation differ from the base.

## Layout rules

- **Sidebar.** Channels and their threads, by last activity, with new-part and branch counts. It collapses to one tile per channel, which lists the channel's threads.
- **Reader.** One thread in a column up to 700px wide.
- **Sheets.**
  - Opening a branch slides its stack in from the right, covering 62% of the width.
  - The thread behind is dimmed, its column moves left, and the sidebar collapses to tiles.
  - A branch opened inside a sheet stacks a sheet 24px further right. Older sheets keep a 24px strip labelled with level, author and first line.
- **Sheet header.** "From paragraph" (or answer, question, post), channel, author, the quoted source and a close button. Each sheet ends with Continue for its author, or Branch for everyone else.
- **Motion.** Sheets slide in for 200ms and out for 160ms. Nothing animates under `prefers-reduced-motion`.
- **At 640px and below,** sheets are full-screen with a Back button, and the sidebar is a drawer.

## Navigation

- **Wheel.** The reader and each sheet scroll vertically. Choosing a strip pops back to that level; choosing the dimmed thread closes every sheet.
- **Keyboard.** Tab reaches threads and branch controls, and Enter opens one. Escape closes the menu, the drawer or a draft in the top level, then pops one sheet. Focus returns to the control that opened it.
- **Touch.** Swiping a sheet right pops it, and the sheet follows the finger. Long-press opens the part menu.
- **Bell.** It opens the part's thread and the sheets that lead to its stack.

## No longer managed

Position, overlap, zoom, panning, Fit, collapsed units, and where a new stack goes. The open path is view state.

## Lost compared with the free canvas

- Sibling branches, or two threads, side by side.
- A spatial overview of a channel; the sidebar list replaces it.
- A parent sheet's text while a child is open: only its strip shows.

## Branching from a paragraph

- The paragraph keeps the base mark and gets a chip in the right margin with its branch count. With several branches, the chip lists them. Branches from a whole part are pills under it.
- While a first-level sheet is open, its source paragraph is raised over the dimmed thread and tinted. A bar on the sheet's edge stays level with it.
- Every sheet header quotes its source.

## Open questions

1. Should nested sources stay visible, for example by narrowing the parent sheet instead of covering it?
2. Should the sheets narrow instead of the sidebar collapsing?
3. Is a 24px strip wide enough to choose by touch on tablets?
