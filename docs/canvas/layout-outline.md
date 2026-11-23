# Layout: Outline

Mock: `docs/mockups/canvas-layout-outline.html`. The canvas becomes a single column about 680px wide; nothing else
changes.

## Layout rules

- The page is a feed of root stacks, ordered by latest activity (in the stack or its branches) when the page loads.
  The feed does not re-sort during a visit. A new root goes to the top.
- Stacks are expanded or collapsed. A collapsed stack shows its first part, "N more posts" and its branch count.
- A branch is drawn under the part it starts from, indented to that part's text column, with a left rule and a
  "From answer / question / post" header.
- Siblings at one anchor are ordered oldest first, by their first part. A new branch goes to the end of its group, so
  nothing already read moves.
- Three levels are shown: the stack, its branches, and their branches. Deeper branches become a row reading
  "N more levels", which opens the level-2 branch on its own, with breadcrumbs.

## Navigation

- **Wheel**: vertical scrolling only.
- **Keyboard**:
  - Up and Down move a cursor through the parts in reading order.
  - Left collapses the branches under the part, then the stack it is in, then moves to the branch's anchor. Right
    expands.
  - "o" opens the current branch on its own. Escape goes back.
- **Touch**: scrolling, and long-press for the part menu.
- **Bell**: expands what is needed and puts the cursor on the part. Past level 2, the parent branch opens on its own.

## No longer managed

Position, panning, zoom, overlap, and where new stacks go.

## Lost

- Parent and branch can't be read side by side; a long branch pushes its parent's later parts down.
- There is no channel overview and no spatial memory.
- There is no personal arrangement. This also settles concept open question 4 (shared x, y).

## Branching from a paragraph

The branch is drawn inside the answer, directly after the paragraph, and the answer continues below it. The paragraph
keeps its gutter mark, and hovering the branch highlights it.

## Inline branches, again

The canvas removed inline forks at the user's request in favour of lanes. A single column has no lanes, so branches
are inline again. Three things make them read differently:
- every level is indented and ruled, and the parent resumes at the outer indent;
- each branch collapses separately;
- depth is capped.

The cost remains: another person's exchange sits inside the stack being read.

## Open questions

1. A branch from a question sits between the question and its answer. Should it follow the answer?
2. An answer with paragraph branches is never clamped.
3. Up and Down skip the part of an answer that follows a paragraph branch.
4. The 18px indent for an inserted ask resembles a branch's indent.
5. Should the feed re-sort live?
