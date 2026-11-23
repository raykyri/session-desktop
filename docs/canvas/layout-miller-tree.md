# Layout: Miller with branch tree

Mock: `docs/mockups/canvas-layout-miller-tree.html`. Three fixed columns replace the canvas; there is no pan or zoom.

## Layout rules

1. **Threads.** Every root stack, ordered by last activity, with a channel filter.
2. **Branch tree.** An outline of the selected thread, root first. Under each stack, a caption names each part that
   has branches ("Answer · Science fiction rarely…"), and its branches are indented under it, one line each: author,
   the first words of the question, and ¶ for a paragraph branch.
3. **Content.** The selected stack, unclamped, with seams, Continue and the draft.

Depth never adds columns. Choosing a node replaces column 3; a breadcrumb shows the path. Each thread reopens at the
node last open in it.

## Navigation

- **Mouse and wheel.** Click a thread, then a node. Each column scrolls on its own.
- **Keyboard.** ↑ and ↓ move within a column, and in columns 1 and 2 they also select. ← and → move between columns.
  In the tree, ← collapses, then goes to the parent, then to column 1; → expands, then goes to the first branch,
  then to column 3. In column 3, ↑ and ↓ move between parts, and Shift+F10 opens the part menu.
- **Touch, below 720px.** One column at a time. A thread opens its tree (or its content if it has no branches), and
  a node opens its content. A back button and Escape go up one level.

## What the user no longer manages

- Position: there is nothing to drag, fit or find off-screen.
- Lanes, connectors and overlaps.
- Lost threads: column 1 lists all of them.

## What is lost

- A parent and its branch side by side. A branch is read alone, with its source quoted above it.
- Spatial memory and hand-made arrangements.
- A map of the whole channel; column 1 is a list.
- Unit collapse, replaced by collapsing tree nodes.

## Paragraph branches

- The tree marks a paragraph branch with ¶.
- In the parent, the paragraph keeps its left mark and gets a ¶ marker in the right margin, with a count when there
  are several branches. The marker selects the branch, or lists the branches.
- The branch opens with "From paragraph" and the quoted paragraph. "Go to source" opens the parent at that paragraph
  and marks it briefly.
- Whole-part branches get a margin marker with a branch icon and read "From answer" (question, post).

## Open questions

1. Should column 3 show a strip of the parent above a branch?
2. Should source-part captions appear only when a stack has branches from more than one part?
3. A thread moves to the top whenever someone adds to it. Should the order stay fixed during a visit?
4. There is no keyboard path to ask about one paragraph; the part menu opens on the whole part.
