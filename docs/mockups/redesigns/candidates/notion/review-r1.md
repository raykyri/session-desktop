# notion r1: self-review

Based on all five variants in both themes (official `shot.mjs`, 1700px viewport) and my interaction script (14 checks, all pass).

## First minute
- D (Getting started) explains Session in one paragraph. However, the first screen is taken up by the cover, the title and a three-row agent table, so the Ask block (the action that matters) sits below the fold even though Claude Code is already Ready.
- A, B, C and E assume an existing user. Home's only explanation is the composer placeholder. Nothing says what a "Research" page is or how a follow-up differs from a branch; that is only explained inside Getting started.
- Naming conflict: the sidebar header says "Teamspaces", while the composer chip, workspace menu and page copy say "workspace". This repeats UX-04 (container names overlap).

## Chatting
- Good: you can ask from Home or from the end of a page, and the answer streams into the page. Provider, model and effort are visible on every answer (UX-12). Follow-up / Branch is an explicit switch with a hint line. Queued follow-ups explain the queue. Stop and Retry work, and the waiting run shows a reply box.
- Weak: the elapsed timer only updates when a step changes, so it often stays at "0s". Sample runs never tick at all.
- Weak: on a thread page the properties block is about 300px tall, so the conversation starts below the fold. You have to scroll before you can read the question.
- C (AI panel): the panel repeats the answer text that is already on the page, which wastes the panel. It should show what the page cannot: the run console (steps, queue, model per run).

## Organizing thinking
- Good:
  - Notes have @-mentions of threads or single answers.
  - Backlinks are listed on every page.
  - Highlights and Sources are databases.
  - "Add to note…" turns a paragraph into a linked bullet.
  - The slash menu inserts Ask AI blocks, linked views and highlight embeds.
- Missing: no view of the research tree's shape (UX-09). Branches are only visible inline as toggles or page links. Notion's floating table of contents would fit and would act as the map.
- Missing: highlights cannot be removed, and clicking one does nothing.
- Mention chips in notes wrap onto their own line, because the editable text is a flex item. That breaks the reading flow of an outline.
- No graph. Notion has none either, so a per-page map plus backlinks is the honest equivalent.

## Fidelity to Notion
- Strong:
  - Sidebar structure, breadcrumbs, the Share / Updates / star row, and page icon + title + properties.
  - Block handles (+ and ⋮⋮), the slash menu, toggles and callouts.
  - Database view tabs, filter chips, the "New" split button, the side peek, the Inbox slide-out, and the ⌘K search modal.
- Weak:
  - The board groups by raw status value. Notion's Status property groups values into To-do / In progress / Complete; that grouping would also fit the window.
  - The full-page database header is too large (60px icon plus a 40px title).
  - There is no right-click menu: the "…" menu and the context menu should be the same menu (UX-07).
  - Properties cannot be collapsed. Notion pages use "N more properties".

## Visual polish
- Board columns (5 × 256px) and wide tables scroll horizontally at 1280px. In B, two columns are cut off on first load.
- The timeline puts labels on the left with the pill first when a bar ends near today. This looks reversed.
- In the dark theme, the Recently-visited card header strip is invisible, and the board column tints were too saturated (reduced late in r1).
- Gallery card previews are dense, but readable.
- Recent cards all use the same sparkle icon, so they are hard to tell apart. Showing the status dot helps.
- The file is 169 KB, over the ~150 KB target.

## P0/P1 status (ux-issues.md)
- Resolved:
  - UX-01: Ask box in the main stage, plus the Getting started page.
  - UX-02: Post removed.
  - UX-03: the conversation reads top to bottom.
  - UX-05: Folder is a property.
  - UX-08: Follow-up / Branch switch with hints; branches are named.
  - UX-10: search covers answer text.
  - UX-11: links, backlinks and highlight notes.
  - UX-12: model shown on every answer.
  - UX-13: agent status updates automatically.
  - UX-16: answer actions sit in the answer header.
- Partially resolved:
  - UX-04: Teamspaces vs. workspace naming.
  - UX-06: Star still exists in a menu next to Favorite and Highlight.
  - UX-07: there is no context menu at all.
- Unresolved:
  - UX-09: no tree map or outline of a thread.

## Variants
- A (table home, inline) and E (full-width table, peek) start from similar tables. E earns its place through the side peek and density, but its first screen looks like A's database.
- B changes two things at once: the board, and branches as sub-pages. That is acceptable, but the board needs the status groups to look intentional.
- C is distinct, but its panel is redundant with the page (see Chatting).
- D is the strongest first-run, but it hides the Ask block below the fold.

## Known weaknesses listed in r1
Size; tall properties block; board and table horizontal scroll; static elapsed time on sample runs; rough timeline labels; panel in C duplicates answer text; mention chips wrap in notes; highlights cannot be removed; no graph or map.
