# Layout: Miller columns

Mock: `docs/mockups/canvas-layout-miller.html`. A column browser replaces the canvas; everything else is unchanged.

## Layout rules

- Columns from left to right: **Threads**, the root stacks with the newest activity first; **the thread**, read in
  full; and **one column per open branch**, each forked from the previous column.
- **Channels** (All, then each channel, with new counts) are shown in one of three places, set with the "Channels"
  toggle at the right of the top bar:
  - **Header** (default): a row of chips in the top bar, left of the breadcrumb. The breadcrumb keeps at least
    300px; the chip row scrolls horizontally when it does not fit.
  - **Above**: the same row as its own bar above the top bar.
  - **Column**: a list in a first column, before Threads (156–200px).
  The choice is view state, kept in localStorage.
- The deepest column gets a reading width (460–680px). Once a branch is open, the Channels column (when shown)
  narrows to 156px, Threads to 256px and each earlier stack column to 360px. Overflow scrolls the row horizontally
  to the newest column. Each column scrolls vertically.
- Add post and Add ask are at the top of Threads. They post to the selected channel, or to #public from All.
- Below 640px, one column fills the screen, and a back button names the previous column. With channels in a row,
  Threads is the first column and the row scrolls horizontally; in Header it is a second row of the top bar. The
  toggle shows icons only.

## Navigation

- **Mouse:** the wheel scrolls the column under the pointer. The toolbar breadcrumb reaches columns scrolled off to
  the left.
- **Keyboard:** Up and Down move within a column, and moving onto a channel, thread or branch marker opens it in the
  next column. Right enters the next column; on a part, it opens the part's first branch. Left returns to the item
  that opened the column. Enter on a part opens the part menu. With channels in a row, Left and Right move between
  channels and open them, Down enters Threads, and Left (or Up on the first thread) in Threads returns to the
  selected channel.
- **Touch:** tapping goes one column deeper and Back returns. Long-press opens the part menu.

## No longer managed

Positions, dragging, zoom, Fit, overlaps and collapse. Order comes from activity, and a branch always opens next to its
source.

## Lost

- An overview: threads can't be seen side by side, and a thread's branch structure shows only as counts and markers.
- Arrangement as meaning, such as placing related threads together.
- Sibling branches show one at a time, with chips in the branch header to switch between them.
- From depth 3 on a 1280px screen, the thread scrolls off to the left.

## Branching from a paragraph

A paragraph with branches has a left mark and a margin marker with the branch count, which carries a dot if anything
in those branches is new. Branches from a whole part show as "n branches" under the part. Choosing a
marker opens the branch in the next column, makes the marker solid and turns the paragraph's mark to accent. The
branch header quotes the paragraph. Hovering a branch tints its source paragraph; clicking the quote, or
Back on a narrow screen, scrolls to the source and flashes it.

## Open questions

1. Should a multi-branch marker open a list column instead of the first branch?
2. Should Threads put unread threads first?
3. Opening a stack marks it as read. Is that too early for long answers?
4. In Column mode, at depth 2 or more, should Channels collapse to an icon rail?
5. With the keyboard alone, you can branch from a whole part, but not from one paragraph.
