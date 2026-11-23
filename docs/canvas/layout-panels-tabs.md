# Layout: Branch tabs

Mock: `docs/mockups/canvas-layout-panels-tabs.html`. Only layout and navigation differ from `session-canvas.html`.

## Layout rules

- A left sidebar lists threads (root stacks) by last activity. The open thread's row has the hover background.
- The reader shows one stack in a single column. A thread and its open branches are tabs above it. The thread's tab
  comes first and cannot be closed.
- A branch's tab goes after its parent's tab and after the open tabs of the parent's other branches, so the bar is in
  tree order. A branch of a branch shows a `↳` icon. Each tab shows its author's
  avatar and the first words of its question.
- Opening a branch that is already open switches to its tab. Each tab keeps its scroll position.
- Closing a tab also closes the tabs of branches under it. Tabs are kept per thread while the page is open.
- With more than 6 tabs, the bar shows the thread tab and five tabs around the active one. An overflow menu lists all
  tabs by depth.
- Below 760px, the sidebar is a drawer and the tabs are a horizontally scrolling chip row.

## Navigation

- **Mouse:** the wheel scrolls the reader. On the chip row, it scrolls the row sideways. Middle-click closes a tab.
- **Keyboard:** `[` and `]` switch tabs. In the tab bar, Left/Right, Home/End and Delete (close) work. In the thread
  list, Up/Down move. Parts are focusable, and the context-menu key opens the part menu.
- **Touch:** tap tabs, swipe the chip row, long-press a part.

Nothing needs 2D panning. Zoom, Fit, drag, double-click to create and collapse are removed.

## What the user no longer manages

Placing stacks, overlaps, crossing connectors, branches off-screen and zoom. The open tabs are the only arrangement,
and the layout orders them.

## What is lost

- The thread tree is not visible as a whole, and siblings cannot be read side by side.
- Position no longer shows context: a branch shows its source quote, and the parent is one tab away.
- Spatial arrangement as a memory aid.

## Branching from a paragraph

In the parent, the source paragraph keeps its left mark and has a margin marker with a branch icon and a count. The
marker is dashed when "Show all" hides the paragraph. Choosing a marker opens or
focuses the branch's tab; several branches give a menu. In the branch, "From paragraph ↗" sits above the quote.
Choosing it switches to the parent tab, scrolls to the paragraph and flashes it.

## Adding to a stack

- Under the last part of a stack the viewer authored, a composer is always open. Its placeholder is "Continue". It
  has the draft's fields: a text area, "Add a part", Post and Ask. Ask is the primary button when the last part is an
  answer, Post otherwise. There is no Continue button.
- The composer is not a draft until it has text. With or without text, switching tabs or threads does not ask; the
  text stays with its stack while the page is open.
- Post (Shift+Cmd/Ctrl+Enter) appends the parts; Ask (Cmd/Ctrl+Enter) appends them and an answer. Afterwards the
  composer is open and empty. A blank line and Enter start the next part, as in any draft.
- The discard control shows only when the composer holds text or an extra part. It clears the composer, asking first
  if there is text. Escape leaves the composer and keeps its text.
- The "+" between two parts still opens an insert draft there. The end composer stays open below, with its text.
- Stacks written by others have no composer; the part menu branches from them.

## Open questions

1. Should tabs persist across reloads and devices as per-viewer state?
2. Should closing a parent keep its child tabs?
3. Is a split view of two tabs needed to compare siblings?
4. How does the sidebar scale without channel grouping or filters?
5. By keyboard alone, the part menu offers only the whole-part branch, not a paragraph.
