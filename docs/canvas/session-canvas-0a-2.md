# Session Canvas 0a-2: Branch left or right

Mock: `docs/mockups/session-canvas-0a-2.html` ("0a-2. Session Canvas: Branch left or right"). It starts from 0a
(`docs/mockups/session-canvas-0a.html`, notes `docs/canvas/session-canvas-0a.md`), which is derived from the base
mock `docs/mockups/session-canvas.html` (concept `docs/canvas/session-canvas-concept.md`). Everything in the 0a notes
applies here, except where this file says otherwise.

Request: "also 0a-2 where we can branch both left and right from the main column".

## Layout

| element | rule |
|---|---|
| main column | as in 0a: root stacks, 680px wide; below 720px, the page width minus 16px on each side |
| right column n | x = `MAINW + 44 + (n - 1) * (320 + 44)`, as in 0a |
| left column n | x = `-n * (320 + 44)`: left columns grow leftward from the main column |

- A branch of a root is drawn in left column 1 or right column 1. Its own branches continue outward on the same side:
  a branch at depth n on the left is in left column n.
- Inside a row the two sides are placed independently, with the same rule as 0a: level with the anchor when the
  column is free there, otherwise 16px below the previous card in that column. The row ends below the lowest card on
  either side.

## Stored side

`Thread.side`, `'l'` or `'r'`, is stored on a branch of a root only. It is content, the same for every viewer, like
`fork`. A branch of a branch stores no side and takes its parent's (`sideOf` in the mock). Seed branches of roots are
`'r'`, except `s9`, `s20`, `s72`, `s97`, `s108`, `s114`, `s163` and `s214`, which are `'l'`, so both sides are
populated on load (in the expanded units: `s9` on the left beside `s6` on the right, from the same paragraph; `s72`
and its branch `s74` in left columns 1 and 2).

## Post menu

On a post in the main column the menu has a side toggle above its two items:

```
Open on                [← Left] [Right →]
↰ Ask about this paragraph
  Opens a stack on the left, about this paragraph
↰ Branch from this answer
  Opens a stack on the left, about the whole answer
```

- Both items use the side the toggle shows; their icon and second line follow it.
- The toggle starts at the side chosen last on this page (view state, Right at first). Clicking it, or ArrowLeft and
  ArrowRight while the menu is open, switches it without closing the menu.
- This was chosen over four items ("… to the left" and "… to the right" for each action): the menu keeps two items,
  and choosing a side is one control instead of a longer list to read.

On a post in a side column there is no toggle. The items read "Opens a stack further left" (or right), and the
branch opens in the next column outward on that side.

## Connectors

A connector to a branch on the right is drawn as in 0a. A connector to a branch on the left starts at the anchor on
the parent's left edge, runs left into the column gap, turns with a rounded elbow, and ends at the branch's right
edge, 16px below its top. Tracks are assigned per side and gap, so connectors on one side do not cross.

## View

- Fit fits the full width in use, from the deepest visible left column to the deepest visible right column. With the
  seed at 1440px this is about 79% (one main column, two left and one right side columns); with every unit expanded it
  is about 56%.
- The page opens at 100% with the main column centred horizontally, at its top; Fit shows every column in use.
  Below 720px the main column fills the width. Left columns are reached by panning
  right, right columns by panning left; the connector ticks on the main column's edges show where branches start.

## Open questions

1. The side is shared: the person who branches chooses where the branch is drawn for everyone. Is that acceptable,
   or should the side be chosen by the layout (for example, the side with more room in the row)?
2. Can a branch's side be changed after it is created? The mock has no control for it.
3. Should the toggle default to the side nearer the pointer instead of the last choice?

## Verification

The same Playwright checks as 0a, at 1440x900 and 390x844, pass with left columns included in the column positions:
cards on column x positions, no overlaps, connectors from the anchor on the parent's facing edge to the branch's
facing edge, no crossings, none through another card. In addition: the menu on a main-column answer shows the toggle;
choosing Left and "Ask about this paragraph" opens a branch in left column 1 with `side: 'l'`; a branch from a post in
that branch opens in left column 2 and the menu there has no toggle; choosing Right and "Branch from this answer"
opens a branch in right column 1 with `side: 'r'`.
