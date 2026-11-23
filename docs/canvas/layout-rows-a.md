# Layout: Rows, centred main thread (3a)

Mock: `docs/mockups/canvas-layout-rows-a.html`, a copy of `canvas-layout-rows.html` (layout 3, notes: `layout-rows.md`) that changes the width and position of each row's root column, the row header's position and the stops of the row arrows, and takes the post and run changes of `session-canvas.html` (see "From the base mock" below). Everything else is as in 3: row order, columns per depth, branch placement, connectors, keyboard navigation, the post menu, drafts, Continue and the bell.

Request: "make a version of 3 that centers the main thread and makes it wider".

## Differences from 3

| | 3 | 3a |
| --- | --- | --- |
| Column 0 (root) width | 320px, as every column | 640px |
| Column 0 position | 16px from the left edge | centred on the page at the row's scroll start, at every width |
| Branch columns | 320px, from 16px + 360px | 320px, from the root's right edge + 40px |
| Row header | full page width | the root column's left edge and width |
| Row header controls | dots, arrows, collapse | dots only (no arrows, no collapse control) |
| Selecting a root | scrolls the row until the root is inside it | scrolls the row back to its start |
| Touch snap | every stack to its start | a centred root to the centre, branches to their start |

## From the base mock

These follow `docs/mockups/session-canvas.html` ("0. Session Canvas") and `session-canvas-concept.md`; layout 3 does not have them yet.

- **Terms.** Visible text and labels say "post" (one block of text by one author, or one model answer), "stack" (the drawn column of a thread) and "branch"; "part" and "fork" remain only in code names and the stored `fork` field. Examples: "N more posts", "Insert a post here", "Add a post", "Next post", "The run read N posts".
- **No selection button.** Selecting text in an answer shows no floating "Ask about this" button. The post menu (right-click or long-press) offers "Ask about the selection" when text is selected.
- **No "Inserted" label.** A post written after the posts below it has no label; 3a does not indent it either.
- **Stop.** A queued or running answer shows a Stop button to the thread's author. Stop cancels the run's remaining timers and sets its status to `stopped`; the answer then reads "Stopped before it finished", keeps the text written so far and has no progress bar. The pending line reads "Queued" or "Step n of 4 · …", without a count of the posts read.
- **Run record.** A run has no `by` (who asked) or `ctx` (ids read); context is set by position. A person's post directly followed by an answer is a question and answer pair, whoever wrote the post, so there is no "Asked by" line.

## Root column

- **Width:** 640px. An answer's text is 586px wide, about 85–90 characters per line at 13.5px, the upper end of a usual reading width, and it leaves room for a branch column beside it on common laptop widths. Branch columns keep 320px (240–320px on a phone).
- **Position**, from the width of the row track (the page width less any vertical scrollbar):
  - **720px or wider:** 640px wide and centred. Each row's lane starts with enough left padding that, with the row at its scroll start (`scrollLeft` 0), the root's centre is the page's centre, so the roots of all rows form one column down the middle of the page.
  - **Below 720px:** the track width less a 16px gutter on each side (358px on a 390px phone), which is also centred. Branches are reached by scrolling the row, as in 3; the dots in the row header show how many there are.
- The rule is the same for every row at a given width, so the root columns line up whatever a row's depth.

## Row scrolling

- The scroll start of every row is the centred root. Rows load there, a new or expanded row starts there, and the lane is rebuilt around it when the window width or the page scrollbar changes.
- A row's horizontal scroll is kept across re-renders, as in 3, so a finished answer or a new post does not move a row the person has scrolled. A new branch scrolls its row by the least distance that shows the whole new stack.
- Shift+wheel, a trackpad swipe and touch move a row sideways; the start is `scrollLeft` 0, so scrolling fully left returns the root to the centre.
- The row header has only the dots: no arrow buttons and no collapse control. A row collapsed at load is expanded with its "N more posts" row.
- Selecting a root (click, row dot, ← from a branch, bell) scrolls its row back to the start.

## Unchanged from 3

- Columns: column 0 the root, column d + 1 the branches of column d's stacks, parent by parent in anchor order; a branch made during the visit goes to the end of its parent's group.
- Branches are placed level with their anchor paragraph where there is room, else 16px below the stack above. Anchor heights are measured from the rendered cards, so they follow the root's new line breaks; the wider root is shorter, and anchored branches move up with it.
- One connector per branch from the dot on the parent's right edge, straight when level and an elbow in the gap when pushed down; elbows spread so they do not cross; the selected or hovered connector and its paragraph are highlighted.
- No card height cap; long answers keep "Show all". Rows with new posts start expanded.
- Keyboard: ← parent, → branch, ↑ ↓ within a column and then to the neighbouring row; Enter expands a collapsed row.
- The bell menu now has the styles of `session-canvas.html`; 3 has none, so its menu opens unstyled at the end of the page.

## What 3a gains over 3

- The root thread, which most readers read first, gets a reading width instead of a 320px column. With the seed data at 1440px, every row expanded and every answer shown in full, the root cards total 23,873px in height against 43,462px in 3 (45% less).
- Every row's root is in the same place, so the page reads as one document down the middle, with branches as side material to its right.

## What 3a loses

- Between 1040 and 1391px only part of the first branch column is visible next to the root; reading a branch needs a row scroll, which moves the root off-centre.
- Below about 1040px no branch column shows next to the centred root until the row is scrolled.
- The space left of the root is unused at wide widths, where 3 would show one or two more columns of branches.
- Below 720px no branch shows next to the root; only the header dots and the connector stub at the right edge indicate branches.
- The row header stays at the root column while the row scrolls, so on a scrolled row it no longer sits over the root.

## Open questions

1. Should the root column shrink between 1040 and 1392px (for example to 560px) so a whole branch column fits next to a centred root?
2. Should the row scroll back to the start on its own when the person selects or scrolls the page to another row?
3. Should the empty space left of the root show the parent of a selected deep branch, rather than stay empty?
