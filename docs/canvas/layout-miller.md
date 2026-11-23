# Layout: Miller columns

Mock: `docs/mockups/canvas-layout-miller.html`. A column browser replaces the canvas; everything else is unchanged.

## Layout rules

- Columns from left to right: **Channels**, with new counts; **Threads**, the root stacks with the newest activity
  first; **the thread**, read in full; and **one column per open branch**, each forked from the previous column.
- The deepest column gets a reading width (460–680px). Once a branch is open, Channels narrows to 156px, Threads to
  256px and each earlier stack column to 360px. Overflow scrolls the row horizontally to the newest
  column. Each column scrolls vertically.
- Add post and Add ask are at the top of Threads. They post to the selected channel, or to #public from All.
- Below 640px, one column fills the screen, and a back button names the previous column.

## Navigation

- **Mouse:** the wheel scrolls the column under the pointer. The toolbar breadcrumb reaches columns scrolled off to
  the left.
- **Keyboard:** Up and Down move within a column, and moving onto a channel, thread or branch marker opens it in the
  next column. Right enters the next column; on a part, it opens the part's first branch. Left returns to the item
  that opened the column. Enter on a part opens the part menu.
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
4. At depth 2 or more, should Channels collapse to an icon rail?
5. With the keyboard alone, you can branch from a whole part, but not from one paragraph.
