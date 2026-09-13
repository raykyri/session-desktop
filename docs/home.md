# Home

Home is Session's research launch surface and activity feed. Open it from the
sidebar to start a query or browse research queries, links, and X posts, newest
first.

- Write a research prompt in the composer. Its unfinished draft survives
  navigation and reloads in the same application session.
- Open a research query to read it in Session's document view. That view provides
  follow-ups, branching, retry/cancel, highlights, and the normal research controls.
  Back returns to Home, restoring its composer draft and scroll position.
- Use a saved link or X post's menu to copy or open its link, refresh or retry a
  post, or delete the entry. Undo restores the most recent deletion.
- New activity appears live. When scrolled down, the new-activity button returns to
  the newest items. Older pages load as you approach the end, with a manual
  Load older/Retry control when needed. Refresh reloads the current feed head.
- Back/Forward buttons, Cmd/Ctrl-[ and ], Alt-Left/Right, and mouse history buttons
  use the same workspace history as research documents.

The feed renders directly in the application. It has no iframe, template SDK,
external source chooser, or separate development server. Use `npm run dev`
for application development and `npm run test:unit` for feed, pagination, and
state-restoration coverage.

Legacy note entries are ignored. The previous browser's session envelope is read
only for the feed's scroll state; stored template URLs and browser routes no longer
control the UI.
