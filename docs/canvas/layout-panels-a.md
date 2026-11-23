# Layout: thread list and canvas (9a)

Mock: `docs/mockups/canvas-layout-panels-a.html`. A variant of layout 9 (`canvas-layout-panels.html`, notes
`layout-panels.md`). It keeps 9's top bar and threads sidebar and replaces 9's main pane and branch panel with the
canvas of the base mock (`session-canvas.html`, concept `session-canvas-concept.md`), limited to one thread at a time.
Seed content and data model are those of layout 9; stacks have no stored x or y.

## Layout rules

- Two regions below the top bar:
  - **Sidebar.** The chosen channel's threads by last activity, each with its new-post count (as in 9).
  - **Canvas.** The chosen thread's unit: the root stack at the canvas origin and every branch below it, each in a
    lane to the right of its anchor post or paragraph. Siblings stack by the extent of their subtree, so connectors
    do not cross. The layout, connectors, card styling, avatars and model mark are the base mock's code.
- **Channels** (All, then each channel, with new counts) are shown in one of three places, set with the "Channels"
  toggle at the right of the top bar, as in 9: Header (default), Above or Sidebar. The choice is view state, kept in
  localStorage under `session.panels-a.channels` (9 uses `session.panels.channels`).
- A branch stack starts with its quoted source ("From paragraph", "From answer", "From post"). The connector starts
  at the anchor paragraph on the parent's right edge, and that paragraph has the base mock's 2px mark. Hovering a
  branch highlights its anchor; the connector of the selected stack is drawn in the accent colour.
- Any stack can be collapsed (the chevron in its header or quote) to its first post, "N more posts" and its branch
  count; its branches are hidden until it is expanded. This is the base mock's collapsed form, applied per stack
  instead of per unit.
- Long answers are clamped with "Show all", as in the base mock.
- Below 50% zoom each stack shows one headline, as in the base mock.
- Only a stack's author continues it: their stacks end with "Continue" and show seams between posts. Other people's
  stacks show neither; the part menu branches from them.
- A running answer shows its step and, for the stack's author, Stop. The text written so far stays.
- At 960px and below the sidebar is a drawer, the channel row scrolls horizontally (in Header it is a second row of
  the top bar), and the canvas fills the area below the top bar. Choosing a channel in the row opens the drawer on its
  threads. On a touch screen at 480px and below, Add post and Add ask drop their plus icon so that the first row of
  the top bar fits.

## Navigation

- **Choosing a thread** (sidebar, Alt+Up/Down) draws its unit, selects its root stack and fits the canvas to the
  unit's width, from its top, at no more than 100% and no less than 50%. On a phone (720px and below) the floor is
  the zoom at which the root stack fills the pane's width, so the root opens readable and branches are reached by
  panning. **Fit** fits the whole unit, width and height, at any zoom from 15% to 100%.
- **Mouse:** drag the empty canvas or use the wheel to pan; Ctrl+wheel zooms at the pointer. The zoom buttons and the
  percentage (back to 100%) are at the bottom right of the canvas.
- **Touch:** one finger pans anywhere except on text, buttons and fields; two fingers pinch. Press and hold a post for
  its menu.
- **Keyboard:**
  - Alt+Up/Down moves to the previous or next thread in the sidebar list.
  - Arrow keys in the canvas move the selection between stacks and pan the selected stack into view: Left to the
    parent, Right to the first (topmost) branch, Up and Down to the previous or next branch of the same parent. With
    nothing selected, an arrow selects the root.
  - Stacks use a roving tabindex (the selected stack, or the root, is in the tab order); posts are focusable. Focus
    moved by Tab pans the canvas to the focused element and selects its stack.
  - The context-menu key or Shift+F10 opens a focused post's menu.
  - In the channel row, Left/Right (and Home/End) move between channels and choose them.
  - Escape closes the menu, then the drawer, then the draft, then clears the selection.
- **Bell:** choosing a new post switches the sidebar to its channel (unless All is chosen), draws its thread, expands
  every stack above it, selects its stack and pans so the post is near the top of the canvas at 90% zoom or more,
  then marks it with a short flash.
- **Branching:** the part menu ("Ask about this paragraph", "Ask about the selection", "Branch from this answer /
  question / post") adds the branch in the lane beside its anchor, with its draft open and focused. The canvas pans
  to the draft, and zooms to 100% first when the zoom is below 70%.

## Compared with layout 9

| 9 | 9a |
|---|---|
| Main pane: one stack in a column, with a composer at the bottom | The canvas: the whole thread unit; drafts open inside the stack, as in the base mock |
| Right panel: one branch, a breadcrumb trail, Swap | Branches are drawn beside their anchors; no trail and no Swap |
| Branch rows ("2 branches") under each post | Dropped: the branches are visible beside the post |
| Margin markers with branch counts beside paragraphs | Dropped: the connector and the 2px paragraph mark show the anchor |
| A button on text selection ("Ask about this") | Dropped, as in the base mock: the part menu offers "Ask about the selection" |
| "Only X continues this thread" under others' stacks | Dropped, as in the base mock: those stacks have no Continue and no seams |
| Each pane scrolls vertically | The canvas pans and zooms |

The branch rows and margin markers were not kept for low zoom either. Below 50% the base mock's headlines replace
post text, and they name each branch; a count beside a paragraph would be unreadable at that size.

## Compared with the base mock

- One unit at a time, chosen in the sidebar, instead of every thread of every channel on one canvas. There is no
  overlap sweep between units and no packing of units into columns.
- No stored positions: the root is at the origin, so a stack cannot be dragged by its header, and double-click on the
  canvas does not start a thread. Add post and Add ask start a thread in the channel being viewed (public when viewing
  All) and draw it alone on the canvas.
- Collapse applies to any stack, not only to a root.
- Pan and zoom coordinates are relative to the canvas pane, not the window.

## No longer managed

Position, overlap between threads, and where a new thread goes.

## Lost

- Two threads cannot be seen side by side.
- Arranging threads by hand on a shared canvas.
- A deep or wide unit is large: reading one branch can mean panning away from the root, and Fit can go well below
  50% (the markets thread fits at about 22% at 1440×900).

## Open questions

1. Should each thread keep its own pan, zoom and selection while the page is open, instead of fitting on every
   choice?
2. Should branches of the unit that the viewer has read start collapsed, so a long unit opens smaller?
3. On a phone the root fills the width and branches are off to the right. Is panning enough, or should the arrow
   keys' parent/child moves have touch equivalents (for example tapping a connector)?
4. Leaving a draft with text asks first. Should it be kept instead?
