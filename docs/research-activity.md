# Research Activity

Research Activity is a regular Session feed. Open it from the sidebar to see
research queries, saved notes, links, and X posts together, newest first.

- Write a note or paste a URL into the composer. Enter adds it; Shift-Enter inserts
  a new line. The unfinished draft survives navigation and reloads in the same
  application session.
- Open a research query to read it in Session's document view. That view provides
  follow-ups, branching, retry/cancel, highlights, and the normal research controls.
  Back returns to the feed, restoring its draft and scroll position.
- Use an entry's menu to copy text or links, open the original link, refresh or retry
  a tweet, or delete the entry. Undo restores the most recent deletion.
- New activity appears live. When scrolled down, the new-activity button returns to
  the newest items. Older pages load as you approach the end, with a manual
  Load older/Retry control when needed. Refresh reloads the current feed head.
- Back/Forward buttons, Cmd/Ctrl-[ and ], Alt-Left/Right, and mouse history buttons
  use the same workspace history as research documents.

The feed renders directly in the application. It has no iframe, template SDK,
external source chooser, or separate development server. Use `npm run dev:tauri`
for application development and `npm run test:unit` for feed, journal, pagination,
and state-restoration coverage.

The existing journal/research backend and compatibility storage keys are retained.
The previous browser's session envelope is read only for the feed's draft and
scroll state; stored template URLs and browser routes no longer control the UI.
