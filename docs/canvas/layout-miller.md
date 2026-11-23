# Layout: Miller columns

Mock: `docs/mockups/canvas-layout-miller.html`. A variant of `session-canvas.html` that replaces the free canvas with
a column browser. The data model, context rule, part menu, drafts and bell are unchanged.

## Layout rules

- Columns, left to right: **Channels** (All, then each channel, with new counts); **Threads** (the channel's root
  stacks, newest activity first: avatar, first line, part and branch counts, new dot); **the thread**, read in full;
  then **one column per open branch**, each a fork of a part in the column before it.
- The deepest column gets a reading width (460–680px). Once a branch is open, Channels narrows to 156px, Threads to
  256px and each earlier stack column to 360px. Past that, the row scrolls horizontally and scrolls to the newest
  column. Each column scrolls vertically on its own.
- Add post and Add ask sit at the top of the Threads column and post to the chosen channel (#public from All).
- Below 640px, one column fills the screen and the toolbar shows a back button naming the previous column.

## Navigation

- **Mouse or trackpad:** the wheel scrolls the column under the pointer. A horizontal wheel or the breadcrumb in the
  toolbar reaches columns scrolled off the left.
- **Keyboard:** Up and Down move within a column; moving onto a channel, a thread or a branch marker opens it in the
  next column. Right enters the next column (on a part, it opens that part's first branch). Left returns to the
  item that opened the column. Enter or the context-menu key on a focused part opens the part menu.
- **Touch:** tap to go one column deeper and use Back to return. Long-press opens the part menu as before.

## What the user no longer manages

There is no x or y position, dragging, zoom level, Fit, overlap or collapse. Order comes from activity, and where a
branch appears comes from the column it was opened from. A thread is always reached through the same three choices.

## What is lost

- An overview: you cannot see several threads side by side, or the shape of a thread's branches at a glance. Only
  counts and markers show that branches exist.
- Spatial memory and arrangement. Placement no longer carries meaning, such as putting related threads together.
- Sibling branches show one at a time: a marker with a count opens the first, and chips in the branch header switch
  between the others.
- At depth 3 and beyond, the thread and its source scroll off to the left on a 1280px screen.

## Branching from a paragraph

A paragraph with branches has a left rule and a marker in the right margin with the branch count (a new dot if
anything in those branches is new). Branches from a whole part show as an "n branches" marker under the part.
Choosing a marker opens the branch in the next column; the marker turns solid and the paragraph's rule turns accent.
The branch header quotes the paragraph. Hovering the branch column, a marker or a sibling chip tints the source
paragraph in the previous column. Clicking the quote, or going Back on a narrow screen, scrolls to the source and
flashes it.

## Open questions

1. Should a marker with several branches open a list column instead of the first branch with chips?
2. Should Threads show unread threads first, or keep strict activity order?
3. Opening a stack marks its parts as read. Is that too eager for long answers that are scrolled past?
4. Should channels collapse to an icon rail at depth 2 or more, so the thread stays on screen longer?
5. A keyboard user can branch from a whole part, but not from a paragraph without the mouse.
