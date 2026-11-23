# Layout: Branch tabs on a canvas (12a)

Mock: `docs/mockups/canvas-layout-panels-tabs-a.html`. A variant of layout 12 (`canvas-layout-panels-tabs.html`,
notes in `layout-panels-tabs.md`). It keeps 12's frame and replaces 12's one-stack reader with a canvas pane. The
pane's layout, connectors, pan and zoom come from `session-canvas.html`. The data model, context rules, part menu,
drafts and bell are the same as in 12.

## Kept from 12

- The threads sidebar, ordered by last activity. The open thread's row has the hover background.
- The top bar: the tab bar, the tab overflow menu (more than 6 tabs), and the bell.
- Add post and Add ask. Each starts a new thread whose root stack is alone on the canvas, with a first-part draft.
- The part menu: right-click, long-press, or the context-menu key on a focused part. Selecting text in an answer
  offers "Ask about this".
- Drafts: the insert draft opened by the seam "+", and the end composer that is always open under the last part of
  each stack the viewer wrote. The composer keeps its text while the page is open. Post and Ask leave it open and
  empty.
- Below 760px: the sidebar is a drawer, and the tabs are a chip row that scrolls sideways.

## The canvas pane

- The pane shows the open thread's unit: its root stack and every branch under it. Other threads are not drawn. The
  root sits at (0, 0). No positions are stored, and stacks cannot be dragged.
- Each branch is placed in the lane to the right of its parent and starts level with its anchor (the part, or the
  paragraph for a paragraph branch). Branches in one lane are stacked by the extent of their subtrees, so a
  branch's own branches stay beside it and connectors do not cross.
- A connector runs from the anchor on the parent's right edge to the branch's top-left corner. The anchor paragraph
  has a 2px mark. If the paragraph is below the fold of a clamped answer, the connector starts at the fold. Hovering
  a branch highlights its anchor and its connector. The connector into the selected stack is drawn in the accent
  colour.
- Cards use the base mock's styling: avatars, the circle-dot model mark, and "From paragraph" (or answer, question,
  post) above a branch's quote. Choosing "From paragraph" selects the parent, pans to the paragraph and flashes it.
- Any stack with more than one part, or with branches, can be collapsed. A collapsed stack shows its first part and
  a row with "N more parts" and the number of branches it hides. Its branches are not drawn.
- Layout 12's margin markers are removed. The connectors replace them.

## Tabs

A tab is a stack the viewer has open in this thread. The active tab is the selected stack.

- Choosing a tab selects its stack and pans the canvas to it: the stack is centred across the pane with its top
  24px below the pane's top. The zoom becomes 100% unless it is already between 85% and 125%.
- Clicking or tapping a stack on the canvas selects it and activates its tab. If the stack has no tab, one is
  opened. The canvas pans only as far as needed to show the stack.
- Tabs are in tree order: the order in which stacks are reached reading the thread top to bottom, each branch after
  the part it starts from. Unlike 12, opening a tab does not open the tabs of the stack's ancestors, because the
  ancestors are on the canvas.
- Closing a tab deselects its stack if it was selected. The stack stays on the canvas. Unlike 12, the tabs of
  branches under it stay open. The thread's own tab cannot be closed.
- Clicking empty canvas, or Escape with nothing else open, deselects. No tab is active then.
- "Ask about this paragraph" and "Branch from this …" in the part menu draw the new branch in its lane, open its tab,
  select it, put focus in its first-part draft, and pan only as far as needed to show it.
- Each thread keeps its open tabs, its active tab and its canvas view while the page is open.
- Parts in a stack count as read when the selection leaves the stack, as in 12 when a tab is left.

## Navigation

- **Mouse:** drag empty canvas or use the wheel to pan. Ctrl/Cmd+wheel zooms at the pointer. The zoom buttons (−,
  the percentage, which resets to 100%, +, and Fit) are in the top bar, left of the bell. Fit shows the whole unit,
  at 100% at most. Middle-click closes a tab.
- **Keyboard:** `[` and `]` switch tabs, and each switch pans the canvas. In the tab bar, Left/Right, Home/End and
  Delete (close) work. In the thread list, Up/Down move. Parts are focusable. Focusing a part off-screen pans the
  canvas to it.
- **Touch:** one finger pans anywhere except text fields and buttons, two fingers pinch to zoom, and a long press on
  a part opens the part menu. Below 760px the zoom buttons float at the bottom-right of the canvas.
- Cards show their full content at every zoom, and the part menu works at every zoom.

## Compared with 12

- The thread tree is visible as a whole. Siblings can be read side by side, and a branch's parent is beside it.
- Position shows context again: a branch's connector starts at its paragraph.
- The user manages pan and zoom again. The layout still places every stack, and tabs give a way to jump between
  stacks without panning by hand.
- Long answers are clamped, so a connector from a paragraph below the fold starts at the fold until "Show all".

## Open questions

1. Should selecting a stack on the canvas open a tab at all, or only mark it, with tabs opened explicitly (for
   example by double-click or from the part menu)? With the current rule, reading around the canvas accumulates tabs.
2. Should a closed tab's stack be dimmed or collapsed on the canvas to show that it is not in the working set?
3. Should the canvas show other threads of the channel as collapsed units, as the base mock does, with the sidebar as
   an index?
4. Should collapse state be per tab, so that closing a tab collapses its stack?
5. By keyboard alone, the part menu offers only the whole-part branch, not a paragraph (as in 12).
