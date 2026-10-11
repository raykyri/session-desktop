# tana r1: self-review

Reviewed all five variants in both themes from `shots/tana-r1-*` (1700px viewport), plus the note, highlight-search, thread-mid and command-line screens, and by running the 19-step interaction script.

## First minute
- Variant e (First run) works: a Welcome outline fills the main stage, agent status is visible, and the Ask node and suggestion chips sit in step 2. Steps check themselves off.
- Variants a–d drop the user straight into dense sample data. The only orientation is a "Getting started" row at the bottom of the sidebar. Today's meta line ("Type anywhere below…") is the only explanation.
- In the agent step, "Status refreshes by itself" is only a claim: nothing changes on screen. UX-13 is resolved in copy only.

## Chatting
- Ask, stream, follow-up, branch and queue all work. The model is visible on every question (Agent field) and in the composer.
- **No Stop.** A running question has no way to stop it, and there is no Stopped state. Retry exists only for failed runs.
- **No provider comparison.** You cannot re-ask the same question with another model, although the brief asks for this.
- Branch works only from a whole paragraph (hover button). Selecting text does nothing, so a branch's anchor quote is the paragraph's first 80 characters, not the passage the user meant. Highlight takes the first sentence for the same reason.
- Follow-up and branch look identical in the outline. Only indentation tells them apart, and with four field rows under each question the indentation is hard to read (UX-08 is only partly resolved).

## Organizing thinking
- References, Referenced by, Add to…, drag-to-sidebar, Tab/⇧Tab editing and live searches all work. This is the strongest part.
- A reference to a paragraph inside a note renders as plain body text. It is indistinguishable from the user's own words.
- **No graph or map.** The only views of tree shape are the outline itself and the table's "Relation" column. UX-09 is only partly resolved.
- The right-click menu does nothing. The "…" menu exists only on threads (UX-07).

## Faithfulness to Tana
- Strong: bullets with halos for collapsed nodes, zoom with breadcrumbs, supertag chips with colors, fields, live search nodes with a query builder, Outline/Table/Cards views, a daily page, ⌘K, references with Referenced by.
- Weak: Tana renders fields as compact rows that only appear when a node is open. r1 stacks four full-width field rows under every question, which reads as a form, not an outline.
- Weak: Tana's selection-driven commands (select text and act on it) are missing.

## Visual polish
- Thread pages are long and dense: 4 field rows per question, and at depth 3 the text column narrows.
- When a long title wraps, its tag and status chips start on a second line indented by the chip margin. The header actions used to wrap onto their own row (fixed late in r1).
- The branch-anchor underline disappears under `code` spans (only the commas show blue).
- Search pages (Needs you, Running) leave the lower half empty apart from a hint box. The inbox `detail` text (for example "AccessDenied…", "212 of 327 files") is not shown, although it is the most useful line.
- The ref pill to a draft uses the question colour, which makes a draft look like a run.
- The file is 155 KB, over the ~150 KB target.
- The shared `shot.mjs` 1340px viewport clipped the window. It has since been fixed upstream.

## Unresolved P0/P1 items (ux-issues.md)
- UX-07: right-click and "…" menus still differ, and there is no menu on questions or notes.
- UX-08: partly resolved. Follow-up vs branch is structural but not labelled.
- UX-09: partly resolved. No map or graph.
- UX-13: resolved in copy only. Sign-in detection is not shown.
- UX-01: resolved in variant e only. Other variants have no in-place orientation.
- The rest (UX-02, 03, 04, 05, 06, 10, 11, 12, 14, 15, 16) are resolved in these mocks.

## Variants
- a (Journal home), b (Node panel), c (Answer blocks) and e (First run) each test a real alternative.
- **d (Workspace table) is weak.** It differs from a only in which page and view open first. Table and Cards are one click away in every variant. Replace it with a Graph home variant that also adds the missing map.

## Known weaknesses carried from r1
- Long titles wrap the chips; inline fields are too dense; there is no graph, calendar or list view.
- Highlight works from the hover button only, with no selection bar.
- Paragraph references in notes are unstyled; search pages are empty below the results.
- Past day pages have no sample content.
- The file size is over target.
