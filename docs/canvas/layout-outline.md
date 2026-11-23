# Layout: Outline

Mock: `docs/mockups/canvas-layout-outline.html`, a copy of `session-canvas.html` with the 2D canvas replaced by a
single-column document about 680px wide. Data model, context rules, authorship, the part menu, drafts and the bell are
unchanged.

## Layout rules

- The page is a feed of root stacks, ordered by latest activity (any part in the stack or its branches) when the page
  loads. Activity during a visit does not reorder the feed; a new root goes to the top.
- Each stack is expanded or collapsed. Collapsed shows the first part and "N more parts · M branches".
- A branch is drawn under the part it starts from, indented to that part's text column, with a left rule and a
  "From answer / question / post" header. A branch from a paragraph is drawn inside the answer, directly after that
  paragraph, and the answer is split around it.
- Siblings at one anchor are ordered by when they were started, oldest first. A new branch goes to the end of its
  group, so nothing already read moves. Anchors themselves follow document order.
- Three levels are shown: the stack, its branches, and their branches. Deeper branches become one row, "N more
  levels · K branches", which opens the level-2 branch on its own with breadcrumbs back to the feed.

## Navigation

- **Mouse wheel**: the page scrolls vertically, like a document.
- **Keyboard**:
  - Up and Down move a cursor between parts in reading order.
  - Left collapses the branches under the part, then the stack the part is in, then moves to the part the branch
    starts from. Right expands.
  - "o" opens the current branch on its own. Escape goes back.
- **Touch**: vertical scrolling only, and long-press opens the part menu. The chevrons and the open button are 32px
  targets.
- **Bell**: opens the part's stack and the branches above it, scrolls the part into view and places the cursor on it.
  If the part is past the third level, its parent branch opens on its own.

## What the user no longer manages

Position, panning, zoom level, overlap between units, and where a new stack goes. There is one scroll axis and one
reading order.

## What is lost

- A parent and its branch can no longer be read side by side. A long branch pushes the rest of its parent down.
- There is no overview of the channel at a glance, and no spatial memory ("the thread at top left").
- There is no personal arrangement. That also removes open question 4 in the concept note (shared x, y).

## Branching from a paragraph

The branch sits directly after the paragraph. The paragraph has a short rule in the gutter. Hovering the branch
highlights the paragraph and turns the branch's rule blue. When the branch is opened on its own, its header quotes the
paragraph.

## Why indentation reads differently from the removed inline forks

The canvas dropped inline forks at the user's request in favour of lanes. A single column has no lanes, so branches
return inline here. They differ from the removed inline forks in four ways:
- every level is indented and ruled, so a branch never looks like the parent's next part;
- the parent's own parts resume at the outer indent;
- every branch collapses on its own;
- nesting is capped, so depth cannot run off the page.

The underlying cost is the same: someone else's exchange sits inside the stack you are reading.

## Open questions

1. A branch from a question sits between the question and its answer, which is true to its context but breaks the
   pair. Should it go after the answer?
2. An answer with paragraph branches is shown in full. Should it be clamped, with its branches listed below?
3. Up and Down skip the rest of an answer after a paragraph branch, because the answer is one part.
4. Should the feed re-sort live, with a "newer activity" bar?
