# Layout: Miller, two panes

Mock: `docs/mockups/canvas-layout-miller-pair.html`, a layout variant of `docs/mockups/session-canvas.html`. The data
model, context rules, drafts, part menu and bell menu are unchanged.

## Layout rules

- A collapsible thread list on the left shows root stacks, most recently active first.
- The open thread is a path: the root, then one branch per level. Two adjacent levels are shown as equal-width panes,
  the parent and the child. Before any branch is open, the right pane lists the root's branches.
- Levels left of the parent are 34px strips, one per level, each showing its first words rotated.
- Paragraphs and parts with branches carry a margin marker with a count. A marker with one branch opens it; one with
  several opens a list. The pane header's branch button lists every branch of that stack.
- A branch chosen in the parent replaces the child. A branch chosen in the child opens one level deeper, and the pair
  slides left one step; the old parent becomes a strip.

## Navigation

- **Mouse:** the wheel scrolls the pane under the pointer; panes scroll independently. Choosing a strip slides back to
  that level.
- **Keyboard:** Left and Right move one level. Focus moves within the pair first, and the pair slides when focus leaves
  it. Right on the last level opens its first branch. Up and Down scroll the focused pane. Escape closes an open draft,
  otherwise it returns to the root.
- **Touch:** below 720px one pane is shown, the strips become a back button showing the parent's first words, and the
  thread list is a drawer. Long-press opens the part menu.

There is no 2D panning, zoom or Fit.

## What the user no longer manages

- Placement: no stored positions, overlaps or lanes.
- Orientation: one thread is open, and the strips show the levels above.
- Viewport: no zoom level, and no canvas region to find again.

## What is lost

- Seeing several threads, or a whole branch tree, at once; siblings appear only as marker counts.
- Comparing sibling branches side by side.
- Spatial memory: canvas position carried meaning.
- Double-click to create at a point.

## Branching from a paragraph

The parent highlights the paragraph the child starts from and fills its marker. A connector runs from the marker
across the gutter to the child's "From paragraph" header; if the paragraph scrolls out of view, the connector is dashed
and starts at the pane edge. Choosing the header scrolls the parent to the paragraph and flashes it. On one pane, going
back highlights the source paragraph and outlines its marker.

## Open questions

1. Past about six levels, should older strips merge into one?
2. Should Right open the first branch or the newest?
3. Should a viewer's path through a thread persist between visits?
4. A draft in a level that becomes a strip is kept but hidden. Should sliding away ask first?
