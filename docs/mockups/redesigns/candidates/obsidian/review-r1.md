# obsidian r1: self-review

Reviewed from the 1700px re-shoot of all five variants in light and dark, plus the Playwright interaction screenshots.

## First minute
- Variant E (new vault) works. The Welcome note says what Session does, connects an agent (status changes without a manual refresh), and offers the ask callout and example prompts.
- Variants A–D open the sample vault directly on a dense thread note with nothing that explains it. There is no "Start here" note in the sample vault, and the icon-only ribbon gives no hint. The only first-run path is through the vault menu or the command palette.
- E: the ribbon hints next to the labels (⌘O, ⌘P) are clipped at the edge. The Grok row shows an install command I made up (`npm install -g grok-cli`). The ask placeholder wraps onto two lines.

## Chatting with models
- Good: questions and answers read in order. The provider, model and effort are on every question callout. Queued questions show as a "Queued" heading. Stop and Retry are next to the run. The status bar streams the current tool step.
- Weak: in A, the ask callout sits at the very end of a long note, so asking a follow-up means scrolling past every answer. Nothing is docked.
- Branching works only by selecting text (or the heading ⋯ menu). The composer explains this but has no control for it.
- Streamed answers are canned. Thread t1 gets content-specific text; every other thread gets a placeholder.
- B shows the binding twice: the view header says "Chat bound to …" and a "Saved in …" bar repeats it.

## Organizing thinking
- Good: the outline pane shows the tree, including branches. Backlinks and unlinked mentions (with a Link button), outgoing links and sources, the local and global graph, the canvas and the foldable outline notes all work.
- Gaps:
  - A highlight's note can be read but not added or edited, and there is no way to change its colour.
  - Search lists `status:`, `model:` and `path:` operators, but only `tag:` is implemented.
  - Extract only creates a new note (A) or appends to the open note (B). There is no choice of target.
- The canvas lays out one thread; it cannot show cross-thread links.

## Faithfulness to Obsidian
- Strong: left ribbon, explorer with indent guides and file badges, browser-style tabs and splits, the properties block, callouts, Live Preview / Reading / Source modes, block IDs, a stacked right sidebar, graph settings with Filters, Groups and Forces, the canvas toolbar, the command palette and quick switcher, and the floating status bar.
- Missing or off:
  - Hover preview exists only on links, not on graph nodes.
  - Graph labels do not fade with zoom.
  - Graph settings has a Display section that does nothing.
  - The tab bar has no context menu.

## Visual polish
- C:
  - The settings panel covers the right third of the graph.
  - Labels overlap inside clusters.
  - The info card covers nodes at the bottom left.
  - The Tags pane is a long, uniform list of "1" counts.
  - Runs items take four lines each and clip text mid-word.
- A: three backlink cards repeat the same "related: DataView…" line, and the lower right stack (Outline) is cramped.
- B: bullet link chips in the knowledge note wrap onto their own line.
- D: the Sources group sits far to the bottom right while the bottom left is empty.
- All variants: the floating status bar covers the last lines of the doc while you scroll (as in Obsidian, but visible here). The outline pane prefixes every heading with "H2", which is noise.
- Contrast is fine in both themes. Dark-theme callout tints are low-contrast but readable.

## UX P0/P1 still open
- UX-01: solved only on the new-vault path, not when the sample vault opens.
- UX-07: still open. The explorer context menu and the view header's ⋯ menu are different lists: Archive is only in one, and Generate recap is only in the other.
- UX-10: partly solved. The search operators are listed but not implemented.
- UX-11: partly solved. Highlight notes cannot be created.
- UX-06: mostly solved (Star folded into heading bookmarks, Follow dropped). Archive still sits beside Bookmarks.
- UX-03, 04, 05, 08, 09, 12, 13 and 16 are addressed.

## Weak or similar variants
- C (Graph first) is the weakest. It is a graph view with no way to ask or read without leaving it, so it drops the chat goal entirely.
- A and B differ enough: the composer is inline in A and a separate bound chat in B.
- D and E are distinct.

## Known weaknesses listed in round 1
- The file is about 184 KB, over the ~150 KB guideline.
- Opening a split makes panes narrow (the right sidebar now closes automatically).
- Graph labels overlap, with no zoom fade.
- The canvas only fits one thread's tree.
- Streamed answers are canned.
- Drafts and recap are thin.
- The graph Display section does nothing.
