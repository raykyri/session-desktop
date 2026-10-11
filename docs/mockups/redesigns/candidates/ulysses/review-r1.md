# ulysses r1: self-review

I looked at all 10 shots (5 variants × 2 themes) and ran the interaction tests (31 of 31 pass).

## First minute
- Variant e works. "Welcome to Session" explains the app in two sentences, shows agent status and puts the composer in the main stage, which fixes UX-01. Variants a–d are only reachable through the library item "Getting Started".
- In variant e the agent check is a manual "Copy and check" button. UX-13 asks for automatic detection, and the sheet's text claims the status refreshes on its own, but nothing in the mock does that.
- In variant e, five short guide rows leave the lower half of the sheet list empty. There is no shortcuts sheet, although the design relies on ⌘1/2/3, ⌘O and ⌘N (UX-27).

## Chatting
- Working: asking at the end of the document, Follow-up / Branch with an explanation, queueing with a reason, Stop, Retry, and the model shown in both the section meta and the composer.
- Headings are the full question text. Long questions (t1q1, t3q1, t5q1) become three- and four-line bold headings that dominate the page. The outline uses the short generated titles, so the outline and the editor do not match.
- Pasting a URL just asks about it. Saving a link (what Post did) is no longer possible. Dropping Post was right (UX-02), but saving a link should stay as a deliberate choice.
- The composer's target label truncates to "after “Which mem…”" even when there is room.

## Organizing thinking
- Outline, notes with section refs, keyword filters, links and backlinks, and glue-to-note work.
- No map or graph anywhere. Links are a flat list in Attachments.
- A passage can be marked but not reused. There is no "Add to note" from a selection, and marks cannot be given a note in the UI (UX-11 is half done).
- Search (UX-10) only matches sheet and section titles. Answer text is not searched.
- Glue order follows click order, not list order (Ulysses glues in list order). The list has no sort options.

## Fidelity to Ulysses
- Library sections and groups, the sheet list with keyword chips, hanging markup, the attachments pane with tabs, glue, typewriter mode, the export preview and ⌘1/2/3 are all faithful.
- Missing: sheet-list sort options, a context menu on sheets, and favoriting from the editor.
- The selected-section bar at -58px floats away from the text in typewriter mode. Ulysses marks the current line more quietly.

## Visual polish
- Both themes are clean and contrast is fine. The dark-theme amber marks look slightly muddy.
- The list in c and e has empty space below the rows.
- In d the bottom half of the editor is blank under the composer.
- Heavy, code-laden headings in a and b (see Chatting).

## P0/P1 still open
- **UX-06:** the section star survives next to Favorite, Mark and Keyword, so there are still four "keep" actions. Favorites cannot be set anywhere in the UI.
- **UX-07:** sheets have no menu at all. Rename, Move to group, Archive and Delete exist nowhere.
- **UX-09/11:** no map; marks cannot take notes; passages cannot be reused in notes.
- **UX-10:** search covers titles only.
- **UX-13:** agent check is manual.

## Variants
- **d (editor only, typewriter)** is the weakest. It shows the same single-sheet reading as a, with dimming, and leaves a mostly blank screen. Typewriter mode is a toolbar toggle anyway. It should become a knowledge view: a note with a link map and passage reuse.
- a, b, c and e are distinct and should stay.

## Known weaknesses listed in round 1
- Long question headings.
- Empty list space in c and e.
- Glue order follows selection.
- No drag-to-file and no row context menu.
- Marks cannot be edited.
- Keyword searches cannot be saved as filters.
- Typewriter mode does not keep the line being typed centred.
- The file is close to the size limit.
