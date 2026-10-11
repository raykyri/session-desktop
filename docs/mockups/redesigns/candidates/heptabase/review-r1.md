# heptabase r1: self-review

Reviewed from the 10 r1 screenshots (shared `shot.mjs`, 1700px viewport) and the interaction-test captures.

## First minute
- Variant E ("Start here") explains the model well: the Ask card, the agent setup card and the numbered sample tree. At its fit zoom of 72%, though, body text renders at about 9px, and the annotations are hard to read.
- Variants A–D open straight onto a dense board with no orientation. The legend is collapsed to a "Reading this board" chip in A, C and D. In B it is a strip across the top that covers cards. The edge labels "Follow-up" and "Branch" carry most of the meaning, which is not enough for a first-time user.
- At the initial zoom of 80%, card body text is about 10px. Answer cards show roughly 6 lines before the fade, so the board reads as a diagram rather than as something to read.

## Chatting with models
- Ask, follow-up and branch are fluent: the panel composer has a visible Follow-up/Branch switch, a passage can be quoted into a branch, and new cards appear in place and stream.
- The queued state is explained on the card.
- **No Stop.** A running answer can only be watched, and the brief lists Stop as a core control.
- **No way to compare providers.** You cannot ask the same question with a second agent and see the answers side by side, even though comparing providers is goal 2.
- Model visibility is partial. Cards show only the model name ("opus"), and the provider appears only as a colour dot. Retry exists only on failed cards.
- The running time on cards is static.

## Organizing thinking
- Good: workspace map with sections, reused answer cards ("in 2"), notes, highlight cards, Card Library, tag tables, Journal.
- **The Section and Connection tools are stubs** that only show a toast. You cannot draw a connection or group cards yourself, which is the core of Heptabase.
- **Filing by dragging** a whiteboard card into another section does nothing; folders are effectively read-only.
- **No backlinks.** A card never shows which notes or journal days mention it (UX-11 is only half resolved).
- "Related" links between threads are drawn only between neighbouring sections. Non-adjacent links are silently dropped.
- There is no user-made synthesis board, so reuse is shown only one card at a time, never as an argument built from many cards.

## Faithfulness to Heptabase
- Faithful: card-centric whiteboards, right-hand card panel, tabs, Card Library with whiteboard counts, Journal, tags as tables, sections, a minimap, and a calm grid.
- Missing: drawing connections and sections, a card "⋯" menu, the backlinks/mentions area at the bottom of a card, and a whiteboard built from library cards.

## Visual polish
- **The floating action bar covers the card above the selection** (in C and B it hides the question card or the whiteboard card).
- The bottom tool bar and the minimap cover cards at the initial view. The B legend strip covers the top row.
- Whiteboard thumbnails for one-question threads are a single tiny rectangle: an empty-looking region on the workspace map.
- In A, the branch column touches the panel edge.
- The tab strip crushes tab labels to "C…" once five tabs are open.
- Both themes have acceptable contrast. In dark mode the floating bar is a light slab, which is louder than anything else on screen.

## P0/P1 from ux-issues.md still open
- **UX-06 (keep marks):** star, bookmark and follow are simply absent. This is acceptable, but nothing states that placing a card on a whiteboard is the "keep" action.
- **UX-07 (two different menus):** cards have no menu at all, so Rename, Archive and Delete are unreachable.
- **UX-11 (backlinks):** only partly resolved, as above.
- **UX-12 (model visibility):** partial, as above.
- **UX-13 (sign-in detection):** the setup card says the status "updates on its own" but nothing demonstrates it.
- Resolved: UX-01, UX-03, UX-05, UX-08, UX-09, UX-16, and largely UX-02, UX-04 and UX-10.

## Variants
- A, B, C and E each have a clear reason to exist.
- **D is weak.** It looks like A without the panel plus a list on the left, and reuse only appears after a drag. Replace it with a synthesis whiteboard built from library cards (evidence answer cards, highlights and a plan note connected by labelled arrows), with the library beside it as the source.

## Known weaknesses listed at the end of round 1
- Small text at the initial zoom; the A branch column at the edge.
- The floating bar covers cards; the tool bar and legend cover cards.
- Non-adjacent "Related" links are dropped.
- The Section and Connection tools are stubs; Recap is only displayed.
- Thumbnails are sparse; elapsed time is static; new threads cannot be filed by dragging.
- Streamed answers are generic per workspace.
