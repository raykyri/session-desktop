# Session Canvas 0a: Main column

Mock: `docs/mockups/session-canvas-0a.html` ("0a. Session Canvas: Main column"). It is derived from the base mock
`docs/mockups/session-canvas.html` ("0. Session Canvas"; concept `docs/canvas/session-canvas-concept.md`). The seed,
posts, drafts, seams, Continue, Stop, the post menu, the bell and the overview zoom are unchanged. Only the placement
of stacks and the view controls differ.

Request: "create 0a which uses a wider, document width for threads in the main column, and snap all cards to separate
columns. side columns have the current width."

## Layout

| element | rule |
|---|---|
| main column | root stacks only, 680px wide (`MAINW`); below 720px of page width, the page width minus 16px on each side |
| side column n | branches at depth n (1: branches of roots, 2: their branches, ...), 320px wide (`SIDEW`, the base stack width) |
| column x | main: 0; side column n: `MAINW + 44 + (n - 1) * (320 + 44)` |
| row | one root and its visible branches; the next row starts 40px (`ROWGAP`) below the lowest card of the row, in any column |

- Roots are ordered by last activity, newest at the top. The order is computed when the page loads and is not
  recomputed while it is open, so a stack does not move away while someone reads or writes in it. A new root (Add
  post, Add ask) is put at the top.
- Inside a row, branches are placed depth-first, siblings in the order of their anchors. A branch starts level with
  its anchor (the paragraph or the post it branches from) when its column is free there; otherwise it starts 16px
  (`VGAP`) below the previous card in that column. A parent's branches are placed one after another, so they stay
  together in the next column.
- Every card's left edge is one of the column x positions. Nothing is placed between columns.
- Main-column stacks use 15px text (15.5px for a person's post) and clamp long answers at 440px instead of 236px.
  Side-column stacks are unchanged from the base.

## Connectors

A connector starts at the anchor on the parent's right edge (the anchor paragraph, or the top of the post), runs
horizontally into the column gap, turns down with a rounded elbow, and runs horizontally into the branch's header,
16px below its top. When connectors in the same gap overlap vertically, each gets its own track; the one that starts
lower turns nearer the parent. With branches placed in anchor order, connectors in one gap then do not cross.

## Removed from the base

- Stored `x`, `y` on threads. A root's place follows from the order; a branch's place follows from its depth and
  anchor. "Open as its own thread" (a branch with its own `x`, `y`) has no equivalent.
- Dragging a stack by its header, and double-clicking the canvas to create a stack.
- The overlap sweep between units: rows cannot overlap.

## View

- Pan (drag the canvas, scroll, or one finger on touch) moves on both axes; the zoom buttons and the keyboard (+, −, 0)
  zoom; Ctrl+scroll and pinch do not. Cards show their full content at every zoom.
- Fit fits the width of the columns in use (the main column and the deepest visible side column) to the window, at
  most 100%, and keeps what is at the top of the view at the top.
- The page opens at 100% with the main column centred horizontally, at the top of the main column. Side columns that
  do not fit are reached by panning; Fit shows them all.
- Below 720px the page opens at 100% with the main column filling the width. Side columns are reached by panning
  horizontally; the connector ticks on the main column's right edge show where branches start.
- Two fixes that the base does not have: a pan that moves captures the pointer, so releasing it over the toolbar
  ends the pan; and connectors are redrawn when a new stack's opening animation ends, so they do not stay 6px off.

## Open questions

1. Rows leave empty space in the main column when a root's branches are taller than the root. The alternative is a
   continuous main column with per-column cursors carried across rows: the main column reads without gaps, but
   branches then start further below their anchors.
2. Should the order follow activity while the page is open (a stack moves to the top when someone posts in it), or
   only on reload as here?
3. At depth 3 the canvas is 1772px wide. Should deep branches fold into their parent column, or is zooming out to
   Fit enough?

## Verification

Playwright at 1440x900 and 390x844 (fonts routed to empty responses): no page or console errors and no requests
other than the font; main column 680px (358px at 390); every card's left edge on a column x and its width 680 or 320;
no overlapping cards, checked from the rendered rectangles on load, with every unit expanded, and after each action;
each connector starts at its anchor and ends at its branch's header, its elbow is inside the gap, no two connectors
cross, and none passes through another card; the main column is in last-activity order; "Ask about this paragraph"
on a main-column answer opens a branch in column 1 anchored to that paragraph, and a branch from a column-1 post opens
in column 2; Ask starts a run, Stop ends it ("Stopped before it finished"); Continue and a seam insert open drafts
and Post appends; Add post puts a root at the top; the bell lists new posts, choosing one expands its unit, selects
the stack and brings it into view, and Mark all as read clears the list; drag, scroll, the zoom buttons
and Fit work.
