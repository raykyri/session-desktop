# macos r1: self-review

I re-shot r1 at full width (shared/shot.mjs, 1700px viewport) and reviewed all 5 variants in both themes, together with the interaction screenshots (`shots/macos-r1-test-*.png`).

## First minute
- Variant E works. The Welcome sheet explains question, follow-up and branch with one diagram. Agent status changes from "Waiting for sign-in" to "Ready" without a refresh button. The empty workspace puts the composer in the middle of the window, which fixes UX-01.
- Variants A–D have no first-run path a new user would find. The Welcome guide is the last item in the sidebar "+" menu. Nothing in the window says what an Inbox is or how a thread grows.
- The sidebar footer gear opens the Agents sheet, not Settings. No Settings surface exists, so UX-14 (terminal-era Settings copy) and UX-22 are not addressed. They are only avoided.

## Chatting with models
- Ask, follow-up, queue, Stop and Retry all work, and the model is visible on every answer and in the composer. Branching from a passage depends on text selection. The only visible cues are the margin bar and the dotted anchor.
- UX-16 is still open. Each answer has only a 15px "…" next to the metadata. There is no Copy / Branch / Retry bar at the end of the answer, where people look after reading.
- In A the reading column is about 540px, because sidebar (208) + list (280) + Inspector (252) take the rest. Long answers with code wrap heavily.
- Queued follow-ups show a callout. A queued follow-up is not shown in the composer area, so it is easy to miss.
- In B, answers in grey bubbles are heavy in dark mode, and a long technical answer in a bubble reads worse than a document block. A tinted surface with less contrast would be closer to Messages and easier to read.

## Organizing thinking
- Present and working: tree Outline view, Finder Columns, note outlines with links back to questions, Add to Note from a selection, links, backlinks and shared tags in the Inspector, the Sources table and the global Map.
- The Map opens with t1 selected and dims most of the board, so the first impression is a washed-out canvas. The legend is wider than it needs to be.
- No view shows a single thread's tree as a picture. The Outline is a table and Columns is a path. A spatial view of one tree, with branches as connectors and highlights attached to their passage, would show the "tree" claim best.
- Links can only be added through Open Quickly (Add Link…). That works but nothing points to it.

## Fidelity to macOS idioms
- Faithful: the source list with sections, counts and disclosure; the unified toolbar with title, subtitle and search; segmented controls; pop-up buttons; token fields; sheets attached under the toolbar; the Spotlight-style Open Quickly; context menus; the Xcode-style Inspector tabs.
- Off:
  - Sidebar selection is a neutral grey pill. macOS uses an accent-tinted pill while the sidebar has focus.
  - The jump bar truncates to "M…" and "Storage …". Xcode collapses earlier path components first.
  - Columns has no path bar.
  - Inspector sections lack the disclosure triangles Xcode uses.

## Visual polish
- The jump bar truncates badly in branch lines.
- In the Inspector, "Contains 4 questions: 1 follow-up, …" is cut off and the Title field is clipped.
- In C at 3+ branch levels the first column scrolls out of view.
- Map: dimmed nodes have low contrast, and in dark mode the notes are brown with low contrast.
- No overlap bugs or empty regions remain after the round-1 fixes. Both themes have adequate contrast apart from the dimmed map cards.

## P0/P1 status (ux-issues.md)
- **Resolved:**
  - UX-01, UX-02 (Post removed from the composer), UX-03, UX-05 (All Threads).
  - UX-07: the toolbar "…" and the context menu are the same menu.
  - UX-08, UX-09, UX-10, UX-11, UX-12.
  - UX-13: resolved in the sheet.
- **Partly resolved:**
  - UX-04: workspace has its own icon, but "All in Compilers" plus a section header is redundant.
  - UX-06: Bookmark, Highlight and Notify remain.
- **Unresolved:**
  - UX-14 and UX-22: no Settings surface.
  - UX-16: no answer action bar.
  - UX-15: not exercised.

## Variants
- **A** Mail layout: solid.
- **B** Outline sidebar: a real alternative, but the bubbles need restyling.
- **C** Column browser: too close to A. It is A's own Columns view mode with the list hidden.
- **D** Map board: redundant. It is A with the sidebar's Map item selected, so it is a place, not a design alternative.
- **E** Welcome: good, but it is the only variant with a first-run path.

## Known weaknesses carried from round 1
- File is 177 KB against the ~150 KB guideline, with about 38 KB of CSS.
- The map layout is placed by hand for the sample data.
- No resizable splitters and no drag-and-drop filing.
- Links in answers do nothing.
- Copy as Markdown, Rename (folder menu) and Recap generation are placeholders.
- Keyboard shortcuts work only after a click inside the window.
