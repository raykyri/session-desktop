# Layout: Channels and threads on a canvas (5a)

Mock: `docs/mockups/canvas-layout-miller-a.html`. A variant of layout 5 (`docs/canvas/layout-miller.md`): the
channel row and the threads column stay, and the Miller columns are replaced by one canvas pane that draws the chosen
thread as the base mock does (`docs/mockups/session-canvas.html`, `docs/canvas/session-canvas-concept.md`).

## Layout rules

- Left to right: **Threads**, the root stacks of the chosen channel with the newest activity first; then the
  **canvas pane**, which fills the rest of the width.
- **Channels** are shown in one of three places, set with the "Channels" toggle at the right of the top bar, as in 5:
  - **Header** (default): a row of chips in the top bar, left of the breadcrumb.
  - **Above**: the same row as its own bar above the top bar.
  - **Column**: a list in a first column, before Threads (156–200px).
  The choice is view state, kept in localStorage under `session.miller-a.channels`.
- Threads is 304px wide (256px below 1100px). Add post and Add ask are at the top of it. They post to the selected
  channel, or to #public from All. Each row shows the first post, the channel (from All), the post count, the branch
  count, the last activity and the new count.
- The canvas pane holds one unit: the chosen thread's root stack and all of its branches, at any depth. The layout
  is the base mock's:
  - The root is at the origin. Each branch is drawn in the lane to the right of its parent, starting level with its
    anchor post, or with its anchor paragraph for a branch from a paragraph.
  - Siblings are stacked by the extent of their whole subtree, so connectors do not cross.
  - A connector runs from the anchor on the parent's right edge to the top of the branch. It is highlighted for the
    selected stack. A paragraph that a branch starts from has a mark at its left. When the paragraph is inside a
    clamped answer, the connector starts at the bottom of the clamp.
  - Stacks, avatars, the circle-dot model mark, seams, "Continue", "Show all", Stop and the "From paragraph" header are
    unchanged from the base mock.
  - The root's header has a collapse button. A collapsed root shows its first post, "N more posts" and the branch
    count, and hides its branches.
- Zoom controls (−, the zoom level, which resets to 100%, +, Fit) are at the top right of the pane. Until the first
  draft is opened, a one-line hint is shown at the top left of the pane on screens wider than 1180px.
- Below 640px one view fills the screen: Channels (in Column mode only), Threads or the canvas. A back button names
  the previous view. With channels in a row, the row scrolls horizontally; in Header it is a second row of the top
  bar.

## Choosing a thread

Choosing a thread in the list (click, tap, or Up and Down) draws its unit, selects the root and sets the view:

1. If the whole unit fits in the pane at 75% or more, it is fitted and centred (at most 100%).
2. Otherwise, if the unit's width fits at 75% or more, the pane zooms to that width, centres it, and puts the top of
   the root at the top of the pane. The rest is reached by panning down.
3. Otherwise the root is shown at up to 100% (as wide as the pane allows), at the top left, with its branches
   continuing to the right.

Choosing the thread that is already shown sets the view again. Fit always fits the whole unit, even below 50%.

## Navigation

- **Mouse:** drag on empty canvas, or on the root's header, to pan. The wheel pans. Ctrl+wheel (or a trackpad
  pinch) zooms at the pointer. Clicking a stack selects it; clicking empty canvas clears the selection.
- **Touch:** one finger pans from anywhere on the canvas except a button or a text field; two fingers pinch. Tapping
  a stack selects it. Long-press opens the part menu.
- **Keyboard, lists** (as in 5): Up and Down move within a column, and moving onto a channel or a thread opens it.
  Right, or Enter, on a thread moves focus to the canvas. With channels in a row, Left and Right move between channels
  and open them, Down enters Threads, and Left (or Up on the first thread) returns to the selected channel.
- **Keyboard, canvas** (focus on the canvas):
  - Left selects the parent stack. On the root, it returns focus to the thread list (on a narrow screen, it goes
    back).
  - Right selects the topmost branch of the selected stack.
  - Up and Down select the previous or next stack with the same parent, top to bottom as drawn. When there is no such
    stack in that direction, they pan the canvas by a third of its height, so a long stack can be read.
  - Home selects the root. Escape discards a draft, or else clears the selection.
  - The selected stack is brought into view after each move.
- **Bell:** choosing a new post chooses its thread (and switches the channel unless All is selected), selects the
  stack it is in, and pans so the post is near the top of the pane at 90% or more. When there is room, the parent
  stack is shown to the left. On a narrow screen, this opens the canvas view.

## Branching

The part menu (right-click, or long-press) is the only place to branch, as in the base mock: "Ask about this
paragraph" (or "Ask about the selection") and "Branch from this answer / question / post". The new branch is added
to the canvas in the lane beside its anchor, with its draft open and focused. The pane pans to it, and zooms to 100%
first if the zoom is below 75%. The menu is not offered below 50% zoom.

## Read state

Selecting a stack marks its posts as read. They keep their dot while the thread stays on the canvas. On a narrow
screen this happens only when the canvas view is shown. The bell and the thread counts update as in 5.

## Compared with 5

- **Kept:** the channel row and its three-way toggle, the threads column with new counts, Add post and Add ask, the
  bell, the part menu, drafts, seams, Continue for the author, and the narrow single-view rule with a back button.
- **Replaced:** the thread column and the branch columns are replaced by the canvas pane. Branch markers, sibling
  chips and the "Close this branch" button are gone: every branch of the thread is drawn at once, and the connectors
  show where each starts.
- **Added from the base mock:** pan, zoom, Fit, collapse of the root, and Stop on a
  queued or running answer (for the thread's author).
- **Removed:** the "Ask about this" button that appeared on text selection in 5. As in the base mock, the part menu
  offers "Ask about the selection" instead.
- **Not carried over from the base mock:** stored positions, dragging stacks, double-click to create, the overlap sweep
  and branches placed on their own. The pane holds one unit, so positions are derived from anchors and are not
  shared.

## Gained over 5

- A thread's branch structure is visible at once, including sibling branches and branches at depth 3 or more.
- Branches stay beside the paragraph they start from, and the thread does not scroll off to the left as branches open.

## Lost compared with the base mock

- Threads are never seen side by side, so arranging threads on the canvas cannot carry meaning.
- Reading a long root means panning, not scrolling a column. The wheel pans, but there is no scroll bar.

## Open questions

1. Should choosing a thread restore the last view of that thread instead of fitting it again?
2. Should the canvas also show the thread's channel neighbours, collapsed, below the chosen unit?
3. Keyboard users can select stacks but not individual posts. Should Enter on a stack move into its posts, so the part
   menu can be opened from the keyboard?
4. Is 75% the right threshold for fitting the whole unit, or should the threshold depend on the pane's width?
