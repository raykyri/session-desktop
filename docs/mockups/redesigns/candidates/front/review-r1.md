# front r1: self-review

Screens checked: all five variants in light and dark (`shots/front-r1-*`, 1700 px viewport), plus the interaction screenshots from the Playwright runs.

## First minute
- Variant e works: the Welcome conversation explains what Session is, has an agent setup card that detects sign-in by itself, offers example questions, and includes a key checklist. The "What arrives in Inbox" legend in the list column helps.
- In the other variants a first-time user lands in a full inbox and sees no hint about follow-up vs. branch until they open "Getting started" at the bottom of the nav.
- In variant e, "Install guide" for Grok does nothing, and the agent setup state exists only in first run. Every other variant shows agents as always ready.

## Chatting with models
- Good: the model and effort are shown on every message, in the composer and in the assignee chip. Queueing is explicit ("Queue" button, a queued card with Edit/Remove), Stop and Retry work, and choosing another agent sends the question as a branch so the answers can be compared.
- Branch, Highlight and Note act on the paragraph's first sentence, not on the text the user selected. That is the wrong mechanism: you cannot quote an exact passage.
- Older answers are only collapsed when a path has three or more turns. On t1 the first screen is a long root answer, and the private notes, highlights and fork row sit below the fold. Front opens a conversation at its newest message with older messages collapsed; r1 does neither.
- The answer footer has Reply/Branch/Note but no Copy, Retry or menu. There is no single "more" menu (UX-07), and rows have no right-click menu.

## Organizing thinking
- The conversation map, notes outline, links/backlinks in Details and the Knowledge folder pages work.
- There is no graph view. Knowledge is organized by folder only, and there is no Highlights list where passages can be reused.
- Users cannot create a link between two conversations; links only come from the sample data (UX-11).
- Only variant d has "Add to note"; elsewhere a passage cannot be sent to a note.
- The composer can only ask. There is no "write a note" or "save a link" entry (UX-02 recommends both as labelled modes).

## Faithfulness to Front
- Strong: nav of inboxes with counts, Assigned to me, status groups, agents as teammates, internal-comment styling, Send and Send & Done, keyboard triage with hint strip, CRM-style context pane, snooze menu, bulk bar, inbox zero.
- Missing: rules (Front's core shared-inbox automation), the per-conversation "…" menu, linking conversations, collapsed older messages, and scrolling to the latest message on open.

## Visual polish
- Detail values clip without an ellipsis (Folder "ML infra › Storage & replica").
- Nav note titles truncate with no tooltip.
- The toolbar is close to overflowing once a Running pill is present.
- The variant c reply bar shows only "to Claude Code" at the far right, which reads as stray text.
- Variant b: rows are fine, and the snoozed/done groups now fill the screen.
- Dark theme contrast is acceptable. The yellow note card in dark mode reads well.
- In variant d, the Knowledge page key findings are dense but readable.

## Unresolved P0/P1 (ux-issues.md)
- UX-02: only partly fixed. Post was dropped, but no Note/Save link mode was added.
- UX-06: Bookmark stays alongside Highlight, Note and Done; "Pin" would be clearer.
- UX-07: no unified menu.
- UX-10: search does not cover highlights and does not jump to the matching passage.
- UX-11: links cannot be created.
- UX-13: auto-detect exists only in first run.
- UX-08: partly fixed. Branches are named, but there is no "ask about selection".
- UX-14/15: Settings is not represented in this mock; out of scope.
- Fixed: UX-01, 03, 04 (mostly), 05, 09 (map), 12, 16 (partly).

## Variants
- a, b and e are distinct and worth keeping.
- c (workspace inboxes and floating compose) is close to a: it differs only in grouping and compose placement.
- d differs from a mostly by its start view and default tab. Both need a stronger reason to exist.

## Known weaknesses carried from round 1
- The file was at the 150 KB limit.
- Selection-less branching and highlighting.
- t1's notes and fork row are below the fold.
- Knowledge is folder-only, with no graph.
- Mock answers use generic text and an example.org source.
- Grok "Install guide" is a no-op.
- Snoozed conversations never return on their own.

## Plan for r2
1. A selection toolbar (Ask about selection / Highlight / Note / Add to note) replaces the hover paragraph bar.
2. Older answers collapse to one-line recaps. The conversation opens scrolled to the newest message, with notes and fork rows always visible.
3. One "…" menu (toolbar, answer footer, row right-click): Pin, Link to conversation, Rename, Copy as Markdown, Generate recap, Delete. Bookmark becomes Pin.
4. Knowledge gets Topics | Map | Highlights. Map is an SVG graph of conversations and notes. Highlights can be added to a note.
5. The new-question composer gets labelled modes: Ask an agent / Write a note / Save a link.
6. Variant c becomes "Workspace inboxes + rules" with a working Rules page. Variant d becomes "Knowledge map", opening on the graph.
7. Search marks matching paragraphs and scrolls to them. "When the run finishes" snooze wakes the conversation. Polish ellipses and the toolbar.
