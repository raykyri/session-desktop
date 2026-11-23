# Layout: Branch tabs

Mock: `docs/mockups/canvas-layout-panels-tabs.html`, a layout variant of `docs/mockups/session-canvas.html`. The data
model, context rules, part menu, drafts, composer and bell are unchanged.

## Layout rules

- A left sidebar lists threads (root stacks), most recent activity first, each with its channel, part and branch counts,
  and new-part count. Add post and Add ask sit above the list.
- The reader shows one stack at a time in a single column. A thread and the branches opened from it are tabs above the
  reader. The thread is always the first tab and cannot be closed.
- Opening a branch adds its tab after its parent's tab and after any open tabs of the parent's other branches, so the
  bar reads in tree order. If the parent is not open, it is opened first. A branch of a branch carries a `↳` icon. Each
  tab shows its author's avatar and the first words of its first person part.
- Opening a branch that already has a tab switches to that tab. Each tab keeps its scroll position.
- Closing a tab also closes the tabs of branches opened under it. Tabs are kept per thread while the page is open.
- With more than 6 tabs, the bar shows the thread tab and five branch tabs around the active one. An overflow menu lists
  every tab, indented by depth, with close buttons.
- Below 760px, the sidebar becomes a drawer and the tabs become a horizontally scrolling row of chips.

## Navigation

- **Mouse:** the wheel scrolls the reader vertically. Over the chip row on narrow pages, the wheel scrolls the row
  sideways. Middle-click closes a tab.
- **Keyboard:** `[` and `]` switch to the previous or next tab. In the tab bar, Left and Right move between tabs,
  Home and End go to the first and last tab, and Delete closes the focused tab. In the thread list, Up and Down move
  between threads. Parts are focusable, and the context-menu key opens the part menu.
- **Touch:** tap a tab or chip, swipe the chip row, and long-press a part for the part menu.

Nothing requires 2D panning. Zoom, Fit, drag, double-click to create and collapse are removed.

## What the user no longer manages

- Placing stacks and units.
- Overlapping stacks.
- Connectors that cross.
- Finding a branch that is off-screen.
- Zoom levels.

The set of open tabs is the only arrangement, and the layout produces it.

## What is lost

- The whole thread tree is no longer visible at once, and siblings cannot be read side by side.
- Context is no longer visible as position on screen: a branch shows only its source quote, and the parent is one tab
  away.
- People can no longer arrange stacks spatially as a way to remember them.

## Branching from a paragraph

In the parent, the source paragraph keeps its left mark and has a margin marker that shows a branch icon and a count.
When the paragraph is hidden by "Show all", the marker is dashed. Hovering a marker tints the paragraph. Choosing a
marker opens or switches to the branch's tab; with several branches, a menu lists them. In the branch, the header reads
"From paragraph ↗" above the quote. Choosing it switches to the parent tab, scrolls to the paragraph and flashes it.

## Open questions

1. Should tabs persist across reloads and devices, as per-viewer state?
2. Should closing a parent tab keep its child tabs open?
3. Sibling branches cannot be compared side by side. Would a split view of two tabs be worth adding?
4. The sidebar has no channel grouping or filtering. How will it scale to hundreds of threads?
5. Branching from a paragraph by keyboard alone is not supported: the context-menu key on a part offers only the
   whole-part branch.
