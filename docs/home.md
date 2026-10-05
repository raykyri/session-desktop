# Home

Home is Session's research launch surface and activity feed. Open it from the
sidebar to start a query, post a note, or browse research queries and notes,
newest first.

- Write a research prompt in the composer. Its unfinished draft survives
  navigation and reloads in the same application session. The composer opens
  on Ask network; switch to Ask AI to start a research run.
- Ask network posts a note: a research thread with no answer of its own,
  shown at the top of Home. Posting stores the Ask AI agent and model as the
  default for the note's follow-ups. A note is marked "Posted to network", but
  there is no network transport yet: nothing is sent, and no other person's
  replies can arrive. A body that is only a URL is saved as a link (or, for an
  X post, as the post) instead of being posted.
- A network note's card lists its replies inline (the first five threads, with
  "Show more" for the rest), then its follow-ups. Respond answers a reply one
  level down; Delete removes one of your own responses (they cannot be
  edited). Ask AI about this starts an AI follow-up with that reply quoted.
- A note's follow-up field asks AI by default, answered with the note, its
  replies, and any linked post as context. On a network note it can also post
  a network follow-up, which is a note of its own under the first. Follow-ups
  run independently, and Retry reruns a failed one in place. Saved links and
  posts take AI follow-ups only.
- Opening a note shows its page: the note, a Replies group (a placeholder
  until the first reply), and the follow-ups with their answers. Opening an AI
  follow-up shows that run's own page, with highlights and branching.
- Exported terminal conversations appear in the feed like research queries,
  with a terminal glyph, their first user message, and their follow-ups.
- Open a research query to read it in Session's document view. That view provides
  follow-ups, branching, retry/cancel, highlights, and the normal research controls.
  Back returns to Home, restoring its composer draft and scroll position.
- Each research query ends with Follow and Bookmark controls beside its
  timestamp. Both are stored on the thread, and the open thread shows the same
  pair beneath its root prompt next to the answering model and time.
- A card whose thread failed since you last viewed it shows a red "!" on its
  avatar in place of the unread dot. Opening the thread clears it.
- The Bookmarks tab below Home in the sidebar shows the same feed limited to
  bookmarked threads, without the composer.
- The Archived tab below Bookmarks lists archived threads, most recently
  archived first. Opening one reads it beside the list; right-click a card to
  unarchive or delete it.
- The Highlights tab below Archived lists every highlight saved in open
  threads, newest first under day headers, each shown inside its surrounding
  context. Opening one selects its thread and scrolls to the passage.
- Right-click a card for its thread menu: rename, archive, or delete. Deleting
  a note or saved link has no undo; archive moves it to the Archived tab.
  Archiving or deleting the open thread closes it back to the feed.
- New activity appears live. When scrolled down, the new-activity button returns to
  the newest items. Older pages load as you approach the end, with a manual
  Load older/Retry control when needed. Refresh reloads the current feed head.
- Back/Forward buttons, Cmd/Ctrl-[ and ], Alt-Left/Right, and mouse history buttons
  use the same workspace history as research documents.

The feed renders directly in the application. It has no iframe, template SDK,
external source chooser, or separate development server. Use `npm run dev`
for application development and `npm run test:unit` for feed, pagination, and
state-restoration coverage.

Saved links and X posts from the former journal were not migrated to notes; a
leftover `journal` key in `.session/state.json` is discarded on load. The
previous browser's session envelope is read only for the feed's scroll state;
stored template URLs and browser routes no longer control the UI.

Legacy `[[Term]]` and `[[Term|label]]` markers in saved answers render as plain
text. Encyclopedia generation and navigation have been removed. Existing
`.session/encyclopedia-v1/` files are left on disk but are no longer used.
