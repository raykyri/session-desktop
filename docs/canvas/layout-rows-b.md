# Layout: Rows, branch left or right (3b)

Mock: `docs/mockups/canvas-layout-rows-b.html` ("3b. Session Canvas: Rows, branch left or right"). It starts from a copy of 3a (`canvas-layout-rows-a.html`, notes `layout-rows-a.md`) and adds the two-sided branching of 0a-2 (`session-canvas-0a-2.html`, notes `session-canvas-0a-2.md`).

Request: "make a version of 0a-2 like 3a (or 3a like 0a-2) -- no free scrolling, but use 0a-2's multi directional branching".

## What comes from where

| | 3a | 0a-2 | 3b |
| --- | --- | --- | --- |
| Page | rows, one per thread; the page scrolls vertically | free 2D canvas with pan, zoom and Fit | rows, as in 3a; no pan, no zoom, no Fit |
| Root stack | 640px, centred on the page at the row's start | 680px main column, centred at 100% | 640px, centred on the page at the row's start |
| Branch sides | right only | left or right | left or right |
| Horizontal movement | each row scrolls on its own | pan the canvas | each row scrolls on its own, both ways from its start |
| Side choice | none | "Open on [Left] [Right]" in the post menu | as 0a-2 |

## Stored side

As in 0a-2: `Thread.side`, `'l'` or `'r'`, is stored on a branch of a root only. A branch of a branch stores no side and continues outward on its parent's side (`sideOf`). Seed branches of roots are `'r'`, except 0a-2's `SEED_LEFT` ids, which all exist in this seed: `s9`, `s20`, `s72`, `s97`, `s108`, `s114`, `s163` and `s214`.

Rows expanded at load that have left columns:

- `s1`: `s9` in left column 1 and `s6` in right column 1, from the same paragraph.
- `s18`: `s20` on the left; `s22` and `s24` in right columns 1 and 2.
- `s103`: three left columns (`s108` and `s114`, then `s122`, then `s131`) and one right column (`s117`, `s111`).

Collapsed rows with left columns: `s68` (`s72`, `s74` in left columns 1 and 2), `s95`, `s212`, `s158`.

## Row geometry

Per row, from the number of left columns in use (`nl`), the root's width `rw` and its centred left edge `rl` (both as in 3a, the same for every row at a given width), `W` = 320px and `GAP` = 40px:

| value | rule |
| --- | --- |
| root left edge in the lane (`rx`) | `max(rl, 16 + nl * (W + GAP))` |
| right column d | `rx + rw + GAP + (d - 1) * (W + GAP)` |
| left column d | `rx - d * (W + GAP)`: left column 1 is next to the root, columns grow leftward |
| row start (`s0`) | `rx - rl`: at `scrollLeft = s0` the root's centre is the page's centre |
| lane width | the outermost right column's right edge + 16px, and at least `s0 +` the track width |

- If the left columns fit in the space left of the centred root, `s0` is 0. A row with no left columns has `s0 = 0` and no left scroll room.
- Vertical placement is 3a's rule on each side separately: level with the anchor paragraph where the column is free there, otherwise 16px below the stack above it in that column. The row is as tall as its tallest column on either side.
- Below 720px the root is the track width less 16px on each side, centred; both sides are reached by scrolling the row.

Values of `s0` with the seed (rows at load):

| width | `s1` (1 left column) | `s18` (1 left) | `s103` (3 left) |
| --- | --- | --- | --- |
| 1440 | 0 (left column 1 is visible beside the root) | 0 | 696 |
| 1100 | 146 | 146 | 866 |
| 390 | 358 | 358 | 1074 |

At 1440px, row `s1` fits the page without scrolling: one left column, the root and one right column.

## Row scrolling

- Rows load at their start. A row's scroll is kept across re-renders relative to its start: when `s0` changes (a left column is added, a collapsed row is expanded, the window width changes), `scrollLeft` moves by the same amount, so the root stays where it was on the screen. Expanding `s68` at 1100px moves its start from 0 to 506 and leaves its root centred.
- Shift+wheel, a trackpad swipe and touch move a row in either direction. On touch, a centred root snaps back to the start.
- The row header has no arrow buttons and no collapse control, as in 3a. Its dots cover both sides, in page order: left columns from the outermost in, the root, then right columns outward; within a column, top to bottom. A dot selects its stack and scrolls the row the least distance that shows it.
- Selecting a root (click, its dot, the keyboard, the bell) returns its row to its start.
- A new branch on either side scrolls its row by the least distance that shows the whole stack.

## Connectors

A connector to a branch on the right is drawn as in 3a. A connector to a branch on the left starts at the anchor on the parent's left edge and ends at the branch's right edge, 16px below its top, with the elbow in the gap when the branch was pushed below its anchor. Gaps are per side and depth, and elbows in one gap are spread outward from the parent so they do not cross.

## Post menu

As in 0a-2. On a post in a root stack:

```
Open on                [← Left] [Right →]
↰ Ask about this paragraph
  New stack on the left, from this paragraph
↰ Branch from this answer
  New stack on the left, from the whole answer
```

- The toggle starts at the side chosen last on this page (view state; Right at first). Clicking it, or ArrowLeft and ArrowRight while the menu is open, switches it without closing the menu.
- On a post in a side column there is no toggle. The items read "New stack further left" (or right), and the branch opens in the next column outward on that side.

## Keyboard

Left and Right move in the direction of the key:

| selection | ← | → |
| --- | --- | --- |
| root | a branch on the left side | a branch on the right side |
| a stack on the left side | a branch of it (outward) | its parent |
| a stack on the right side | its parent | a branch of it (outward) |

Going outward picks the branch last left toward the parent on that side, else the first. This was chosen over "Left is always the parent" because a key that moves the selection to the right on the left side (toward the parent) or to the left on the right side would contradict the layout. Up and Down are as in 3a: within the column, then the previous or next row. A keyboard move scrolls the page smoothly (instant with reduced motion).

## Changes carried over from the base mock

The refinements of `session-canvas.html` apply here too:

- Visible terms are "post" and "branch": "N more posts", "Insert a post here", "Add a post", "Next post", "The run read N posts". The header comment describes the stored model as Post and Thread.
- No floating "Ask about this" button on a text selection; the post menu keeps "Ask about the selection".
- No "Inserted" label. A post inserted mid-thread, and the answer directly under it, are indented by 18px with a 2px rule (as in the base mock; 3a had the label and no indentation).
- `run` has no `by` or `ctx`. A question and the answer under it are paired whoever asked.
- A queued or running answer shows Stop to the thread's author. A stopped answer reads "Stopped before it finished", with no progress bar; text written so far stays. The progress line no longer says how many posts the run reads.
- The canned answer for a paragraph branch says "the paragraph quoted at the top of the branch"; an empty context reads "nothing".

## Unchanged from 3a

Row order by last activity; rows with new posts start expanded, others collapsed with an "N more posts" row; the 640px centred root and 320px branch columns; anchor placement; "Show all" on long answers; drafts, Continue and inserting between posts; the bell menu; hover and selection highlights of connectors and anchor paragraphs.

## What 3b gains

- Two branches from the same paragraph can sit on both sides of the root, both level with it (row `s1` at 1440px).
- At 1392px and wider, one left column fits beside the centred root without scrolling, so space that 3a leaves empty holds branches.

## What 3b loses

- Below about 1392px the left columns of a row are off-screen at its start, as the right ones are in 3a; a row with branches on both sides now has content off both edges, and only the edge fades and the dots show it.
- The row header stays at the root column while the row scrolls; on a row scrolled to the left, it sits over empty space or a left column's gap.
- The side is shared content: the person who branches chooses where the branch is drawn for everyone (0a-2's open question 1).

## Open questions

1. Should a row with left columns open at its start, or scrolled so its leftmost column shows when there is room for it and the root together?
2. Should the dots mark the root, so that the split between left and right sides is visible in the header?
3. Should the side be chosen by the layout (for example the side with fewer columns in the row) rather than stored?

## Verification

Playwright, at 1440x900, 1100x800 and 390x844, with the font requests answered empty:

- No page or console errors; no requests other than the font hosts.
- Every row's root is centred at load: the root's rect centre equals the page centre (difference 0px in every row at each width).
- Each side stack is at its column's x position, on the correct side of the root, with its stored side matching its drawn side; branches of branches are on their parent's side; no two stacks in a row overlap.
- Each branch has one connector, from the anchor on the parent's facing edge (left edge for the left side) to the branch's facing edge, 16px below its top.
- Scrolling a row fully left shows its left columns, fully right shows its right columns and hides the left ones; selecting the root (its dot or a click) returns the row to `s0` with the root centred.
- Post menu on a root answer: the toggle is shown; ArrowLeft sets both items to the left; "Ask about this paragraph" opens a branch with `side: 'l'` in left column 1, fully in view. The toggle then starts at Left; clicking Right keeps the menu open, and "Branch from this answer" opens a branch with `side: 'r'`. On a post in a left column there is no toggle, the items say "further left", and the branch opens one column further left with no stored side.
- Keyboard: ← from the root selects a left branch, ← again its branch, → returns to the parent and then the root (row back at `s0`), ← remembers the last branch, → from the root selects a right branch and ← returns; ↓ and ↑ move to the next row and back.
- No visible "part" or "fork" outside post text; selecting text shows no floating button; Stop on a running answer leaves "Stopped before it finished" with no bar and no Stop.
- Expanding the collapsed row `s68` (two left columns) keeps its root centred at 1100px and 390px.
