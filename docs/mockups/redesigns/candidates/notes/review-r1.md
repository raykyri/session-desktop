# notes r1: self-review

Re-shot all five variants in both themes at 1700px. No console errors.

## First minute
- Variant e works: the Welcome note says what Session does, shows agent status and gives a checklist that ticks itself. In a–d, though, nothing tells a new user what the yellow-ruled block is or where to type. The only way into the Welcome note is New Folder → New Workspace…, which a new user will not find.
- The ask line is too faint: a 2px grey bar and grey placeholder at the end of a long note. The "Return ↵" hint shows only after the user starts typing. A new user cannot tell that the last line of the note is where they ask.
- e's list pane is one row followed by 600px of empty space, and the sidebar shows a single folder. It reads as unfinished, and there is no finished example note to learn from.

## Chatting
- Ask, follow up, branch from a selection, queue, Stop, Retry and Edit question all work, and every answer names its model. The model popover is clear.
- Every line at the end of a thread note sends a question. You cannot write your own text inside a research note, which undercuts the premise that a thread is just a note.
- A streaming answer does not follow the scroll. Its end runs below the fold while text is still arriving.
- Every branch section has its own ask line. With two or three branches open, the note shows several identical prompts and it is unclear which one continues which conversation (UX-08 is only partly fixed).
- The queued explanation is long, and the queued state exists only for questions typed in this session.

## Organizing thinking
- Outline notes link to specific answers, and research notes show Linked notes and Mentioned in. That covers backlinks.
- There is no map or graph of notes and no view of a research tree's shape apart from folding sections (UX-09 is not fixed).
- Answer passages cannot be reused. The only option is Highlight; you cannot quote a passage into another note. Highlight notes cannot be edited.
- In outline notes the "Keep writing" line throws away what you type. `>>` and `#` are mentioned in the placeholder but do nothing there. The toolbar's Aa, Checklist, Table and Attach buttons are decorative.

## Fidelity to Apple Notes
- These match Notes well: the three panes, account-style sections, the list grouped by date with a yellow selection, the gallery, folding headings, the centred date, tag chips and >> links.
- These miss: the format bar does nothing. The Quick Note icon reads as an external-link icon. Notes' link-suggestion menu when you type `>>` is missing.

## Visual polish
- When a highlight crosses inline code, the highlight breaks into pieces around each code chip.
- Gallery status badges sit on top of the preview text.
- Variant d's toolbar was crowded, and the search field ran into the drawer (patched late in r1).
- In dark mode the selection bar has low contrast against the page.
- Each list row repeats the folder/workspace line even in views scoped to one workspace (for example "Notes · Compilers" under "Notes" in a workspace).
- Answers are dense with inline code. Code chips need a lighter fill.

## P0/P1 items from `review/ux-issues.md` still open
- **UX-01:** fixed only in variant e; a–d have no route to onboarding.
- **UX-08:** follow-up vs branch is explained only in the Welcome note.
- **UX-09:** there is no tree view or map.
- **UX-11:** linking is partial. Users cannot create links, passages cannot be quoted into other notes, and highlight notes are read-only.
- **UX-13:** "Check again" exists only in the Welcome note, not in the model popover.

Fixed: UX-02, 03, 05, 06, 07, 10, 12 and 16.

## Weak or similar variants
- **c (Gallery first)** is only the gallery toggle, which every variant already has. It is redundant; replace it with something that addresses UX-09.
- **a and b** differ in a meaningful way (sections vs separate notes), and **d** differs clearly. Keep all three.

## Known weaknesses from the round-1 report
- Gallery badges overlap the preview text.
- The first-run list and sidebar look sparse.
- The format buttons are decorative.
- The ask line's left marker is too faint to find.
- Variant d's toolbar is crowded.
- Streamed answers are canned and don't follow the scroll.
- Moving a note to another workspace is refused with a message.
- `>>` links and #tags are only parsed when they appear in questions.
