# Layout: depth columns

Mock: `docs/mockups/canvas-layout-columns-depth.html`.

## Rules

- Column *d* holds the visible stacks at fork depth *d*. Column 0 holds the roots, by last activity at load. Add post and Add ask insert a root at the top.
- A branch sits level with its anchor (part or paragraph), so its connector is one horizontal line across the gap. If its place is taken, it sits lower and the connector bends once.
- Siblings stack downward without overlap. Nothing is placed by hand; `x` and `y` are ignored.
- Depth 3 and deeper are 44px strips of chips (author, part count) until one is chosen.
- One vertical scroll. Horizontal scroll only when open columns exceed the window. Below 720px, one column at a time, with a depth switcher.

## Navigation

- **Wheel:** vertical scroll; all columns move together.
- **Keyboard:** Up/Down move within a column. Left goes to the parent and tints the anchor. Right goes to the branch last left, or the first. Selection scrolls into view and opens strips or collapsed roots.
- **Touch:** native scroll. On narrow screens, a part shows "2 branches in depth 1", and a branch's From row links back to its source.

## No longer managed

Position, pan, zoom, Fit, and where new stacks go.

## Lost

- Hand arrangement and spatial memory of it.
- An overview of the whole channel.
- Units side by side: one unit uses the full width, even with one branch.

## Paragraph branches

The connector starts at the paragraph, which keeps a 2px mark. The branch's header reads "From paragraph" above the quote, and hovering it tints the paragraph. On narrow screens, the From row returns to the paragraph and tints it.

## Vertical space from alignment

Measured with all 22 roots open at 1280px:

- Root `s103` is 1,078px tall; its 6 branches reach 1,802px below it.
- If each unit kept its rows to itself, column 0 would have 20,605px of gaps on a 12,700px page.
- Columns pack independently instead, so branches can sit beside later roots. Unlimited, column 0 has no gaps, but branches drift up to 2,106px from their anchors.

Two limits:
1. A root moves down only until its unit's first branch in each column is within `MAXDRIFT` (120px) of its anchor.
2. When a unit first opens, each branch still more than 120px from its anchor is collapsed to its first part, top down, so the stacks below move up.

Result: 552px of gaps in column 0, 10 of 34 branches collapsed, every open branch within 120px. A collapsed branch can still sit 939px low under a tall aligned sibling. At load (4 roots open), column 0 has no gaps.

## Open questions

1. Auto-collapse hides content the layout chose, not the reader. Acceptable?
2. Should column 0 reorder when others post, or only on reload?
3. Should tall branches be clamped like long answers, so their siblings stay close?
4. Are strips worth having, or should deep columns simply scroll sideways?
