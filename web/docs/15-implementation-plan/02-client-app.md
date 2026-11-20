# 02 — Client app

Status: draft. This file plans the client that implements the members mockup
(`docs/mockups/session-web-members.html`): one React codebase in
`web/packages/client` that ships as the web client and, inside Tauri, as the
macOS desktop client (`AGENTS.md`, "Desktop"). Screens read a replica through
reactive queries (ADR-20) and write through shared mutators applied
optimistically from an outbox (ADR-19). Styling follows ADR-8 (Tailwind v4 over
`tokens.css`), ADR-9 (Base UI wrappers in `src/ui/`) and
`web/docs/08-design-system-and-styling.md`. Each work item (W) names what is
built, where, and the check that accepts it. The server half, sync protocol and
run execution belong to `01-architecture-and-data.md` and
`03-agents-and-research.md`, membership and moderation rules to
`04-membership-moderation-security.md`; §13 lists what this file needs from
them, with ids `N1`-`N15` (01 uses `D` for its database items). Item ids of
other files are cited as "01 C3", "03 K8", "04 §5".

"The mock" below means the members mockup's behaviour as read from its source;
function names are given in parentheses. Exact user-facing copy is taken from
those functions unless an item or 01-04 says otherwise.

## 1. Package layout

`AGENTS.md` replaces the web client's trees and workspaces with spaces and drops
existing web data. The client keeps its build, design-system layer and Markdown
pipeline, and replaces every feature that reads research trees, workspaces,
folders or the TanStack Query research cache.

| Path in `packages/client/src` | Fate |
|---|---|
| `main.tsx`, `app/providers.tsx`, `app/ThemeEffects.tsx`, `app/RouteBoundary.tsx`, `app/queryClient.ts` | Kept; providers gain `ReplicaProvider`; `QueryClientProvider` stays for online-only calls (ADR-20) |
| `app/router.tsx`, `app/SessionBoot.tsx`, `app/layout/AppShell.tsx` | Rewritten; `app/layout/Sidebar.tsx` deleted (no sidebar) |
| `app/captureInvite.ts`, `lib/pendingInvite.ts` | Kept; the fragment capture is reused for `/i#<code>` and channel links (§2.1) |
| `routes/home.tsx`, `research.$treeId.tsx`, `highlights.tsx`, `places.tsx` | Deleted; new route modules per §2.1 |
| `routes/notifications.tsx` | Rewritten for W2.6 |
| `routes/admin.tsx`, `settings.tsx`, `login.tsx`, `devUi.tsx`, `invite.tsx`, `chunks.ts` | Kept and restyled; `invite.tsx` rewritten for account invites |
| `api/trpc.ts` | Kept for online-only procedures (auth, usage, API keys, invites, directory, settings) |
| `api/api.ts`, `cache.ts`, `events.ts`, `queries.ts` | Deleted; replaced by `replica/` (§9) |
| `stores/settings`, `overlays`, `notifications`, `connection`, `localAccount`, `lightboxes` | Kept |
| `stores/navigation`, `drafts` | Rewritten (§9.4) |
| `stores/liveTurns`, `recapPending`, `homeFocus` | Deleted; `replica/runStream.ts` replaces `liveTurns` (ADR-22) |
| `lib/platform.ts`, `motion.ts`, `clipboard.ts`, `relativeTime.ts`, `toast.ts` | Kept; `platform.ts` gains `isDesktop`, `motion.ts` gains `scrollIntoPadded` |
| `lib/researchDraftAutosave.ts`, `researchImages.ts`, `transcriptSearch.ts`, `tabMerge.ts`, `localOwner.ts` | Deleted with the research client |
| `features/markdown` | Kept; gains citation and passage plugins (§4.4) |
| `features/composer` | Rewritten (§5); `QuestionModelPicker.tsx` is the base of `ModelPicker` |
| `features/home`, `sidebar`, `thread`, `drafts`, `highlights`, `import`, `journal`, `research`, `sharing`, `palette`, `account`, `widgets` | Deleted at cutover (`widgets` pending open question 6) |
| `features/notifications` | Rewritten for W2.6 over the user log's notification records |
| `ui/*` | Kept; new `RoundButton`, `SplitButton`, `TreeRail` |
| `styles/tokens.css`, `fonts.css`, `prose.css`, `app.css` | Kept, extended (§11); `feed.css`, `tweet.css` deleted |

New code:

```
src/replica/              ReplicaProvider, adapters/, queries.ts, writes.ts, viewer.ts, runStream.ts, fixtureReplica.ts
src/features/shell/       AppBar, ScopePicker, ChannelStrip, UsageRing, SavedButton, LayoutToggle, AccountMenu, useBarAutoHide
src/features/feed/        FeedPage, FeedRow, ThreadCard, TitleRow, Byline, AnswerProse, CardFooter, RunStatus, RemovedCard, BranchedFrom
src/features/branches/    BranchTree, BranchCard, BranchActions, BranchComments, SelectionActions, lookPhrase.ts, geometry.ts
src/features/replies/     ReplyTree, ReplyCard
src/features/composer/    NewThreadComposer, InlineComposer, SendSplitButton, ChannelPicker, ModelPicker
src/features/channels/    ChannelHeader, ChannelInfoDialog, AboutEditorDialog, ModerationLogDialog, RemoveDialog, ReportDialog,
                          MemberListDialog, ChannelInviteDialog, NewChannelDialog, BrowsePage, FrozenBanner
src/features/membership/  MembersPage, InviteTree, InviteLinks, AuthDialog, InviteRequiredPage
src/features/usage/       UsagePage, RecentRuns, OutOfTokensChoice, ApiKeys
src/features/notifications/ NotificationsPage, NotificationRow
```

**W1.1 Remove the research client.** Acceptance: `npm run check` passes;
`rg "research\.(create|fork|get)|workspaces\.|folders\." packages/client/src`
finds no procedure calls; the build contains no `tweet.css` or `feed.css`
rules.

**W1.2 One web/desktop seam.** `lib/platform.ts` exposes `isDesktop` and the
storage adapter choice. Acceptance: an ESLint `no-restricted-imports` rule
limits `@tauri-apps/*` to `replica/adapters/` and `lib/platform.ts`.

## 2. App shell

### 2.1 Routes

| Path | Screen |
|---|---|
| `/` | Home feed: threads of joined channels |
| `/c/$name` | Channel feed with channel header; a `#<code>` fragment is a channel invite link (04 §5) |
| `/saved` | Saved threads |
| `/browse` | Browse channels |
| `/invites` | Invite tree and invite links (`membersPage`) |
| `/usage` | Usage and API keys |
| `/welcome` | Invite required (`statusPage`) |
| `/notifications` | Notifications (W2.6) |
| `/i` | Account invite link; the code is in the fragment (`<SESSION_PUBLIC_ORIGIN>/i#<code>`, in production `https://session.dev/i#<code>`; 04 §3.2, §3.4), captured into memory, removed from the URL, and opens the auth dialog over `/` |
| `/settings`, `/admin` | Kept from the current client, restyled |

Feed routes take `?t=<threadId>&sel=<nodeId>`: the feed scrolls to that row and
selects that branch (the mock's `gothread`, `gofrom`). The mock has no
single-thread page (open question 3).

**W2.1 Route tree.** Rewrite `app/router.tsx` with zod-validated search params
and a guard sending a signed-in account without an invite from `/invites` and
`/usage` to `/welcome`. Acceptance: router unit test per path; the guard; that
malformed `sel` values are dropped; that after `/i#SESS-9TQ2-X8` loads,
`location.href` contains no code and the auth dialog shows the inviter.

### 2.2 App bar

Left to right (`appbar`):

1. **Name as home button** (`brandBtn`): agent mark and "Session", label
   "Session home"; goes to `/`.
2. **Scope picker** (`headerSpaces`, `SCOPES`, `SCOPE_IC`): a menu button with
   `menuitemradio` items Joined (check-circle icon), Channels you manage (person
   icon; owner role, only for accounts that can write) and All (compass icon;
   01 C7). The scope chooses which channels the strip lists; Home always shows
   joined channels. With one scope (signed out, where Joined would equal All)
   no picker is drawn.
3. **Channel strip**: horizontally scrolling `#name` chips with
   `aria-current="page"` on the current one, a join "+" on unjoined chips
   under All, a trailing New channel button for writers, and the empty line
   ("You have not made a channel yet." / "Nothing here yet."). No scrollbar; a
   mask fades 40 px at an edge only while content is hidden past it (`--fl`,
   `--fr`). The current chip is scrolled to the centre when it lies within
   40 px of an edge. Shown on feed routes, Browse, Invites and Usage.
4. **Usage ring with track** (`meter`): "Nk left", a fill track, and an 18 px
   ring arc over a full-circle track; tone `ok` below 80 % used, `warn` from
   80 %, `bad` from 95 % (03 K6); `aria-label` "N of M included tokens left
   this week; resets in …". Below 860 px only the ring shows. Opens `/usage`.
   Offline it shows the last value and its time in the label.
5. **Saved round button with count** (`savedBtn` variant `e`): a 28 px pill,
   bookmark filled when the count is above zero, no number at zero, label
   "Saved, N" (or "Saved"), `aria-current="page"` on `/saved` (the mock's
   `aria-pressed` is wrong for a link). The count is computed from save records
   in the user log (01 C2).
6. **Layout toggle round button** (`layoutBtn`): switches between `centred` and
   `wide` (§3.1); its icon shows the target layout, its label is "Wider main
   column" or "Centre the main column"; feed routes only.
7. **Account menu**: header with avatar, name, `@handle` and "Member", "Admin"
   or "No invite yet"; Notifications (with the unread count, W2.6), Invites,
   Saved, Usage and API keys, Sign out. Without an invite: Enter an invite
   code, Sign out.

Items 4-6 are not rendered for accounts without an invite.
**Signed out** (`appbarOut`): name, strip of open channels, "Join with invite"
(opens the auth dialog at the code step) and "Sign in".

**W2.2 `AppBar` and parts** in `features/shell/` on `ui/Menu` and
`ui/RoundButton`. Acceptance: component tests per viewer state (signed out, no
invite, member, channel owner) for which controls render; the list per scope;
ring tone at 79.9/80/94.9/95 %; Saved shows no number at 0 and `aria-current`
only on `/saved`; fade variables are `0px` when the strip does not overflow.

**W2.3 Bar hides on scroll.** `useBarAutoHide(scrollEl)`: shown within 48 px of
the top; past that a downward step over 4 px hides it and an upward step over
4 px shows it, the reference position moving only on such steps or within
48 px of the top. It stays shown while one of its menus is open, on non-feed
screens, and while focus is inside it (a `focusin` shows it, so Shift+Tab from
the feed reaches it). Hiding animates `margin-top` over 0.2 s (none under
reduced motion); the hidden bar is not `inert` and stays in the accessibility
tree. Acceptance: reducer unit test over scroll sequences; Playwright reads the
bar's box after wheel 400 px down (hidden) and 50 px up (shown), and after
Shift+Tab from the first feed control while hidden (shown, focus on the last
bar control).

**W2.4 Full window, no fullscreen.** The mock's Fullscreen button, window frame
(`.frame`) and `fs-exit` are scaffolding. The shell fills the viewport or
window, with one scroll container below the bar. On macOS desktop the bar's
empty areas are the Tauri drag region and it reserves the traffic-light inset
under an overlay title bar. Acceptance: no `requestFullscreen` in the client;
the desktop checklist (§12.3) drags the window by the bar.

**W2.5 Phone width.** ≤ 520 px: brand word hidden, composer controls wrap to a
second row under the text (`ncw`), menus right-anchored and capped at
`100vw - 40px`. ≤ 860 px: feed rows, Invites and Usage stack to one column.
Acceptance: Playwright at 360×740 and 390×844 asserts
`scrollWidth <= innerWidth` on every route and that the send button is visible.

**W2.6 Notifications page** (`/notifications`; not in the mock, which only
toasts "Notified @x."). Lists the notification records of the user log
(01 C16, 04 O1): "@x mentioned you in #name" (mention), "New report in #name"
(`report`, staff only, 04 P1), "Your report in #name was resolved: removed /
dismissed" (`report_resolved`), newest first, each linking to
`/c/$name?t=&sel=`; an item the viewer can no longer read is not served, so
it is not listed. Opening the page writes `notifications.markSeen`; a row
click writes `notifications.markRead`; "Mark all read" writes
`notifications.markAllRead`. The account menu shows the unread count; no app
bar control is added. Empty state "No notifications yet.". Acceptance:
component tests per notification type and for the unread count; a test that
a mention in a private channel the viewer left is not listed.

## 3. Feed

### 3.1 Rows and layouts

Each thread is a row `[card | side column]` under, in order, the no-invite
banner ("You don't have an invite yet. …", Enter a code), the frozen-copy
banner (§6, W6.10), the channel header, the composer and the empty state
(`renderNetwork`).

- **`centred`** (mock layout A): ≥ 1321 px a grid `1fr | 600px | 1fr`, card in
  the middle, side column in the right track capped at 330 px, channel header
  spanning both; 861-1320 px a centred `600px | 330px` pair.
- **`wide`** (mock layout B): ≥ 861 px a centred `720px | 300px` pair.
- ≤ 860 px: one column, side column after the card with a 12 px inset.

The layout is the `prefs` record in the user log (01 C13, written with
`prefs.set`), default `centred`; `navigation` holds the applied value so the
first paint does not wait for the replica (ADR-20). Empty states: Saved
("Nothing saved yet. …"), Home ("Join a few channels to fill Home." with a
Browse channels link), empty channel ("No threads here yet. Ask the first
question."), and a private channel the viewer is not in ("This channel is
private." with the owner's handle).

**W3.1 `FeedPage`, `FeedRow`.** Grid utilities keyed on `data-layout`; rows
virtualised with `@tanstack/react-virtual` past 60 rows, measured after the side
column lays out. Acceptance: visual baselines (§12.2); a test per empty state;
toggling the layout writes one `prefs.set` and a second replica of the same
account applies it.

### 3.2 Card

- **Title row** (`titleRow`), drawn as a tree row: an 11 px hollow node centred
  on the first line, aligned with the composer's node; the title in regular
  weight at the title size (16.5 px in the mock); on the right the author's
  20 px avatar with tooltip "handle · 3h"; a post shows its channel before the
  avatar; then the "…" menu. An ask's title is the question as typed.
- **Branched from** (`fromln`): on a thread opened from a branch, "Branched
  from <title>" linking to the source row with that branch selected.
- **Byline** (asks): agent mark with a tooltip "model · effort" (03 §1,
  K12; "Opus 5.5 · high effort"), then "N sources · Nk tokens · #channel", omitting empty parts. A
  device run shows its label ("Claude Code", "Codex") in place of the token
  count (03 V6). An ask's channel is in the byline, not the title row.
- **Answer prose** (§4.4).
- **Footer**: follow-up button (reply-arrow icon, label "Ask a follow-up") with
  the total branch count for an ask, Reply with the total reply count for a
  post, then Save with the save count (01 C1, C5). A zero count is not drawn;
  the label then omits the number. No likes anywhere.
- **"…" menu**: own thread, Delete (disabled with "Not available once someone
  else has responded" or "Available when the answer finishes"; 01 C15);
  another member's thread, for staff of the channel (04 §4.3), Remove… and
  "Ban from #name"; otherwise Report… for writers.
- **Removed thread** (`card.removed`, 01 C12, 04 §6.2): "Removed by @mod",
  "Reason: “…”" when given, "Ask in #name" or "Post in #name"; no prose,
  footer or side column. The mock also prints the author's handle; that waits
  on 04 question 1.
- **Hidden thread** (04 §6.3): the author and staff see the text under "Hidden
  by moderators"; others see the placeholder. No Hide command.

Signed out, the follow-up, Reply and Save controls open the auth dialog and
focus returns to the control on close; without an invite they are disabled
with "… opens once you have an invite".

**W3.2 `ThreadCard` and parts.** Acceptance: tests for no zero counts, no like
control, byline omissions and the device label, Delete eligibility, Remove and
Ban vs Report by role, the removed and hidden placeholders, and the three
viewer states of the footer.

### 3.3 Run states

`RunStatus` renders the run record of a node (03 §1) on the card and in branch
cards:

| `status` | Shown |
|---|---|
| `queued` | "Queued"; a device run "Waiting for your Mac" (03 V7) |
| `running` | "Researching · Step N of 4" (`step` 0-3, 03 E3) with a pulsing dot, replaced by streamed text as it arrives (ADR-22) |
| `failed` | the reason for `fail.why` (`tokens`: the out-of-tokens copy; `key`, `rate`, `access`, `device_limit`, `too_large`, `stopped`) |
| `cancelled`, `interrupted` | "Stopped" / "Interrupted" with the partial text |

While `queued` or `running` the asker gets Stop (`research.cancelNode`); this
is not in the mock and is required by 05 M5a. After `failed`, `cancelled` or
`interrupted` the asker gets Run again (`research.retryNode`, a new attempt).
While a node runs its follow-up button, Continue, Branch, Comment, selection
actions and Delete are hidden or disabled as in the mock.

**W3.3 `RunStatus`.** Acceptance: a test per status on the fixture replica;
Stop and Run again only for the asker; an `interrupted` run with partial text
keeps that text and shows Run again.

## 4. Side column

### 4.1 Branch tree

Each passage with branches has its own tree in the side column, placed at the
passage's height and pushed down 12 px past the tree above (`pinGroups`,
`place`); ≤ 860 px they stack in reading order. Top-level branches without a
passage (asked from the footer) form a tree placed at the answer's last block.
Rows (`outline`):

- depth-first, indented 13 px per level, the question as typed on one line;
- a look-up branch shows a magnifier and its phrase, never its prompt (03 G3);
- the author's 16 px avatar on the right when it differs from the parent's;
- rows on the selected path wrap to full text;
- an SVG rail: from the parent's dot down, a 6 px rounded corner, into the
  child's dot; 3.5 px dots centred on the row's first line, also when it wraps
  (`drawGraph`); selected path in the accent mix, selected dot filled;
- hovering a passage outlines its tree and the reverse (`hl`);
- the passage ends with an inline count button that selects its first branch
  and scrolls the tree into view (`badge`, `grpopen`).

**W4.1 `BranchTree` and `ui/TreeRail`.** Pure functions in `geometry.ts`:
`railGeometry(rows)` from measured first-line centres (`ResizeObserver` plus
each row's computed line height) and `placePins(anchors, heights, 12)`.
Acceptance: unit tests (a wrapped row keeps its dot on line one; overlapping
anchors stack); Playwright checks each dot within 1 px of its row's first-line
centre.

### 4.2 Selected-row card

Selecting a row toggles its card below the tree (`preview`): who line with "…"
(Open as its own thread, 03 G5; Delete branch with the thread rules plus "Not
available after it was opened as a thread"); a "Look up <phrase>" header or the
quoted passage clipped at 180 characters; run status (§3.3); prose scrolling
within 260 px; actions (`branchActs`) Comment (speech bubble, left,
`aria-pressed`; tooltip "Comment on this branch. Does not run an answer."),
Continue (down arrow; asks under this answer) and Branch (down-right arrow;
asks beside it, at the parent; never on the root, 03 §2.1); "Open thread"
instead when promoted; then comments (`branchReplies`, 01 C4): "N comments",
nested 14 px per level up to 3, each with a Reply / Close reply toggle
(`replyIcon`, `aria-pressed`).

The card fades in (0.25 s, 3 px rise) only when the item it shows changes, not on
re-renders from opening a composer, toggling Comment or a count change
(`pvFade`): the fade is keyed on `(threadId, itemKey)` in a ref.

**W4.2 `BranchCard`, `BranchActions`, `BranchComments`.** Acceptance: Continue
opens the composer with parent = node, placeholder "Continue ask"; Branch with
parent = node's parent, "Ask beside this"; Comment ("Comment here", submit
"Comment") replaces an open ask composer on that thread and the reverse; a
comment writes no run; the fade class is applied once per item change and not
on a count change.

### 4.3 Reply trees on posts

A post's side column is sticky (top 58 px, own scroll) and holds a reply tree on
the same rail (`replyLines`): avatar and one line of text per row, "+N" on a
collapsed reply. A selected row shows a card with Delete in "…" (own replies,
none by others under them), `>` quotes and member `@mentions`, and a Reply /
Close reply toggle; the reply composer's placeholder is "Reply to @handle".
Below the tree "Reply at root" (signed out "Sign in to reply", no invite
"Replying opens once you have an invite"). The footer's Reply opens the root
composer and scrolls to it (§4.5).

**W4.3 `ReplyTree`, `ReplyCard`.** Acceptance: formatting tests (quotes,
mentions of members only); collapse counts; Reply toggling; focus into the
opened composer; a sent reply is selected in the tree.

### 4.4 Answer text: citations, passages, selection

The stored answer and the streamed deltas are both Markdown (03 §1; the
server stores no HTML). Both go through `features/markdown` with raw HTML
disabled and the existing DOMPurify policy on its output (04 Z5), through the
same rehype plugins, so the block structure that passage indexes refer to is
the same for streamed and final text (N12).

- **Citations** (`citeReady`, `citeOpen`): each superscript is a button
  "Source N" opening a popover with title, note and host link (the link takes
  focus), and is wrapped with its preceding word in a `nowrap` span so it never
  starts a line alone. Built as `rehypeCitations`, not by DOM mutation.
- **Passages**: `rehypePassages` gives each top-level block a `data-passage`
  index. Passages with branches get the passage shade with 6 px side bleed; the
  passage an open composer quotes gets the accent tint (`qsel`). The mock's
  word-overlap matching (`groupsFor`, `bestBlock`) does not ship; branches carry
  their passage index (N3).
- **Selection actions**: a selection of 3+ characters inside one finished
  answer (thread card or branch card, 03 G2), for a writer, shows Look up
  (magnifier) above Branch here, 8 px below the selection, equal width,
  right-aligned to a one-line selection and left-aligned otherwise, kept 8 px
  inside the viewport, removed on scroll. Look up shows only for 1-4 whole words
  (`lookPhrase`: no boundary inside a `\p{L}\p{N}` run; edge punctuation
  trimmed). Branch here opens that answer's composer with the selection as
  quote ("Ask about this passage"; long quotes clipped with Show all) and its
  passage index `b`. Look up writes `research.forkNode { kind: "lookup",
  look, quote, b }` at once (the prompt is built by the mutator, 01 C3,
  03 G2) and selects the new row.

**W4.4 Plugins and `SelectionActions`.** `lookPhrase` moves unchanged to
`features/branches/lookPhrase.ts`. The popover also listens to
`selectionchange` (debounced 120 ms) so keyboard selections work, is rendered
so that Tab from the answer reaches Look up then Branch here, and registers in
`stores/overlays`. Acceptance: `lookPhrase` table (1, 4, 5 words; partial word
at either end; punctuation; non-Latin letters); a citation shares a nowrap span
with its word; Playwright selects two words, clicks Look up, and the new row
shows the phrase, not the prompt; a Shift+Arrow selection shows the popover.

### 4.5 Scrolling to a composer

Opening a composer outside the visible area scrolls it in with 24 px below and
60 px above, smoothly or instantly under reduced motion, and focuses it with
`preventScroll` (`focusGlide`). **W4.5** `scrollIntoPadded` in `lib/motion.ts`.
Acceptance: offset unit test; Playwright checks the composer is fully visible
after clicking a footer button near the viewport bottom.

## 5. Composer

The new-thread composer is the mock's `COMPOSERS.split` with `nb-a`:

- a hollow tree node at its start, aligned with the title-row nodes below; the
  growing text field ("Ask anything" / "Write a post"; 15 px, label "Ask or
  post"), controls held on the last line;
- channel picker on Home and Saved (joined channels, `menuitemradio`); on a
  channel route the name as static text;
- model picker for asks: short names, full names in the menu from the server's
  model registry (03 K11); a model needing a missing key shows "Add a key"
  linking to `/usage`; a key-billed model shows "your OpenAI key". On the
  desktop, "Claude Code on this Mac" and "Codex on this Mac" when found
  (03 V1). An Effort submenu (the shipped `QuestionModelPicker`'s) lists
  Default and only the efforts the chosen model accepts
  (`ModelEntry.efforts`, 03 K12); it is rebuilt when the model changes, and an
  effort the new model does not accept falls back to Default. Hidden for
  device executors (03 V1);
- split send button: main part Ask (arrow) or Post (pencil), disabled while
  empty; the arrow part ("Ask or post") opens Ask / Post with icons,
  descriptions ("Agent researches and answers", "A message to people in the
  channel") and a check;
- ⌘↵ (Ctrl↵ elsewhere, `formatChord`) sends, Enter is a newline; a pointer-down
  on the composer outside a control keeps the caret in the field;
- signed out: a disabled `fieldset` at 60 % opacity with a cover button "Sign in
  to ask or post"; no invite, or a channel not joined: not rendered;
- out of included tokens with no usable payer (03 K8): every write that starts
  a run (Ask, follow-up, Continue, Branch, Branch here, Look up) on an
  included-token model is refused before sending with "You're out of tokens
  until Friday. You can still post, or add an API key in Usage." (weekday from
  `usage.get`'s reset time); posts, replies and comments still send. Offline on
  the desktop the write is queued and may come back as `failed { why:
  "tokens" }` (§3.3).

Inline composers (asks on a thread, comments, replies) are one `InlineComposer`
with a text submit ("Ask", "Comment", "Reply") and a close button.

**W5.1** Replace `features/composer/*` (`ResearchQueryComposer`, `AskNoteSwitch`
deleted). Drafts persist per composer key in `stores/drafts`. Acceptance: tests
for mode switching (icon, label, placeholder, model picker hidden for Post), the
empty-text state, the signed-out cover, out-of-tokens refusal for each run-
starting write and not for Post, reply or comment, draft restore across routes,
focus back to the field after a menu choice, the Effort submenu listing only
the chosen model's efforts and resetting on a model change;
`admin.spec.ts` still finds the admin-only model only for administrators.

## 6. Channels

**W6.1 Channel header** (`spaceHead`): glyph, `#name`, lock for private
channels, description clipped at 170 characters, info button ("About this
channel"), and one of: "Your channel" chip, "Joined" (leaves; the sole owner
cannot leave, 04 §4.3), "Members only" chip, Join. Toasts "Joined #name." and
"Left #name.". Acceptance: a test per viewer relation; join and leave are
optimistic writes (§9.2).

**W6.2 Info dialog** (`chInfoDlg`, 04 §4.4): About (owner without one sees "No
description yet. Add one"), Channel by, Members (opens W6.8), Visibility
("Private: only members can read or post" / "Open: anyone can read and join");
the owner gets Edit; staff get "Moderation log (N open)" and "Invite to #name"
in private channels (W6.9). No rules (01 C6). Acceptance: content per role;
focus and Escape per §10.

**W6.3 About editor** (`chEditDlg`): a dialog stacked over the info dialog with
its own scrim; About textarea with a live "N / 300" counter and the error "Keep
the description under 300 characters."; Cancel, Save (`spaces.update { id,
desc }`, 01 C11); toast "Channel updated."; owners only. Acceptance: nested
Base UI dialog; Escape closes only the editor; a non-owner has no Edit.

**W6.4 Moderation log** (`modLogDlg`, 04 §6.5): stacked over the info dialog;
tabs "Open reports (N)" and "Everything"; entries with kind (Report,
Dismissed, Removed, Banned, Unbanned), "@reporter reported @author's ask" or
"@mod removed @author's ask", the note and relative time. The current title is
shown only for an item present in the replica; a removed item shows kind,
author and channel, never its text (01 C12). Open reports on live items offer
Dismiss (`reports.resolve`, toast "Report dismissed.") and Remove (W6.5).
Acceptance: renders from `modlog` and report records; empty states "No open
reports." and "Nothing logged yet."; no removed text in the DOM.

**W6.5 Remove and report dialogs** (`rmDlg`, 04 §6.1-6.2): the title clipped
at 120 characters; optional reason ("Reason, shown with the removal", at most
300; "What is wrong with it?", at most 500); remove says "Readers see that it
was removed. Branches and replies under it go with it."; report says "Reports
go to the moderators of #name. @author is not told who reported." Writes
`moderation.decide` and `reports.create`; a second report on the same item
shows "You already reported this.". Acceptance: the removed placeholder appears
optimistically; the thread's open reports show as resolved; the duplicate-
report refusal keeps the dialog open with the message.

**W6.6 Browse page** (`browsePage`): heading "Browse channels", New channel for
writers, search over name and description; cards with glyph, `#name`, lock,
"by @owner · N members", description clipped at 120, Yours / Joined / Join.
Lists open channels (from `spaces.directory`, 01 C7) and private channels the
viewer is in. Acceptance: filter test; Join from a card stays on Browse; no
private channel of which the viewer is not a member appears.

**W6.7 New channel dialog** (`newSpaceDlg`): name with `#` prefix checked
against `^[a-z0-9][a-z0-9-]{1,29}$` by the shared validator (04 §4.2; error
"Use 2 to 30 lowercase letters, numbers or dashes."), "What is it for?", Open /
Private radios. Creating a space is online-only (`AGENTS.md`): Create is
disabled while the sync connection is down with "Creating a channel needs a
connection."; busy state until the server answers; CONFLICT shows "#name
already exists."; success navigates to `/c/$name` with the toast "#name is
ready. …". Acceptance: validation tests; offline state; CONFLICT keeps the
typed values.

**W6.8 Member list and roles** (04 §4.3, §6.4): from the info dialog's Members
row; owner, staff, then members by join date. Staff get a per-row menu: "Ban
from #name", and in private channels "Remove from channel"; admins and the owner
also get Make moderator / Remove moderator, and the owner Transfer ownership; staff see a Banned
list with Unban. Writes `members.ban`, `members.remove`, `members.setRole`
(with `base.rev`; STALE reloads the row). Not in the mock; built only if 01
question 5 keeps moderators, otherwise the owner gets Ban and Remove only.
Acceptance: menu items per role; a STALE answer to `setRole` reloads the row
and shows the toast; the sole owner's Leave explains "Transfer ownership first."

**W6.9 Channel invite links** (04 §5): staff of a private channel open "Invite
to #name": a one-use link with Copy (`lib/clipboard.ts`, toast "Link copied."),
Revoke and Undo (`invites.create { days: 7 }`, `invites.revoke`,
`invites.restore`). Opening a link signed in calls `spaces.join { space,
invite }`; signed out or without an invite, the auth flow (W7.2) runs first
with the code kept in memory. An unusable link shows "This invite link has
expired or was already used." Acceptance: component test for create, copy,
revoke and undo; `spaces-channels.spec.ts` covers the join (04 B4).

**W6.10 Frozen and refused states** (04 §8, §9): on the desktop, a channel the
viewer was removed from shows "You are no longer a member of #name. This is the
copy on this device." and offers only Delete on the viewer's own threads.
Refusals of queued writes show the 04 §9 messages ("You are no longer a
moderator of #name.", the ban message, the expired-link message) and restore
composer text. Acceptance: fixture-replica tests for each message and the
restored text.

## 7. Membership and sign-in

**W7.1 Invites page** (`membersPage`, 04 §3.2-3.3). Invite tree (`treeA`): the
mock's explanation of 3 open links, rows from `members.tree` (online-only,
TanStack Query) depth-first from the roots with children by join date, 18 px
per level, avatar, handle, " · Admin" for `staff`, and name, the viewer
highlighted, drawn with `TreeRail`. The mock's "mod" tag is dropped (04
question 6). "Invite someone" (`invSection`): "N of 3 left", one row per open
link (`…/i#<code>`) with Copy and revoke × ("Revoke this link"), "Create an
invite link" / "Create a new link" while a slot is free (otherwise "You have 3
open invites. One frees when it is used or revoked."; a waiting account sees
"You can invite once your account is active."), "You invited" with join dates.
Codes come from the server. Acceptance: tree order and depth for the 12-account
fixture (04 §3.3); no create button at 3 open links; Copy through
`lib/clipboard.ts`; toasts "Invite revoked." and "Link copied.".

**W7.2 Auth dialog** (`authScreen`): modal with a focus trap, opened from Sign
in, Join with invite, a signed-out write control, `/i#<code>` or a channel
link. The provider is GitHub (ADR-5, 04 §1); the mock's X copy becomes GitHub
copy. Flows: landing ("Explore together."); valid invite link ("<Name> invited
you to Session"); unusable link: used, revoked and unknown codes get one
answer from `auth.checkInvite` and one message, "This invite code doesn't
work. Ask the person who invited you for a new one." (04 I4); code step (`CODE_COPY`:
"Join with invite?", "Paste the code or link a member sent you.", Continue),
accepting a code or a full link (the code after the last `/` or `#`,
upper-cased), with "Enter the code from your invite." for an empty field, the
unusable message otherwise, and "Invite from <Name>" on success; provider
explainer; no account for this identity ("Enter an invite code", "Continue
without one"); create account (name, handle 3-20 of `[a-z0-9._]` with the
mock's three errors, the Session-wide community-rules checkbox). Focus moves
to the first field or the step heading on each step and returns to the opener
on close. Acceptance: a test per flow on a fake `auth.checkInvite`; code parser
test for `SESS-9TQ2-X8`, `https://session.dev/i#sess-9tq2-x8` and the pasted
path form `https://session.dev/i/SESS-9TQ2-X8/` (04 §3.2); used, revoked and
unknown codes render the same message.

**W7.3 Invite required** (`statusPage`, `/welcome`): heading "Invite
required", the redeem form, the three-item checklist, Browse the network; on
success the toast "You're in. <Name> invited you." and `/`. The feed banner for
accounts without an invite links here. Acceptance: redeem success and the
error messages; banner only for signed-in accounts without an invite.

## 8. Usage and API keys

**W8.1 Usage page** (`usagePage`, 03 §6): heading "Usage and API keys";
"You have N% of usage left this week. Next reset on Fri, in 2d 5h." with a bar
(`role="img"`, "N% left") in the ring's tones; Recent runs (`usage.listRuns`:
question clipped at 90, or "Removed" / "No longer available" without text
(03 K5); share of the weekly allowance, "<1%", or the payer label; date; "No
runs yet this week."); "When included tokens run out": Pause my asks until the
reset / Continue on my Anthropic key (disabled without a valid Anthropic key,
with the mock's reason line; `usage.setBilling`); API keys per provider:
masked key, Valid / Checking… chip, Remove with the inline confirm "Remove the
<provider> key? Asks billed to it will stop." (Keep / Remove), or "Not set"
with Add key (password field, Save / Cancel); next to each key the 03 K14
note that calls on a personal key fall under the person's agreement with the
provider. All online-only (ADR-19), read through TanStack Query; the ring reads
the same `usage.get` query and refetches on the `usage.changed` event (03 K6).
Acceptance: tone thresholds; disabled key radio and its reason; key add,
check state and remove; the model picker drops a key-only model when its key is
removed; the ring updates within 1 s of a fixture run's finish.

## 9. Client state

### 9.1 Replica and queries

`ReplicaProvider` creates the `@session/sync` client (01 Y9) with a memory
adapter on the web (no IndexedDB) and SQLite through Tauri on the desktop.
Screens read named reactive queries from `replica/queries.ts` (01 Y12), or
TanStack Query for online-only calls:

| Hook | Screens | Reads |
|---|---|---|
| `useMe()` | all | user record, `status`, roles (user log) |
| `usePrefs()` | layout | `prefs` record (01 C13) |
| `useChannels(scope)` | strip, Browse, channel picker | spaces, memberships, roles; All adds `spaces.directory` (TanStack) |
| `useChannel(name)` | header, info dialog | space, owner, member count |
| `useMembers(space)` | member list | member records, bans |
| `useFeed({kind, id?})` | feed | threads of joined channels / one channel / saved set, newest first; summaries outside the window (01 R1) |
| `useThreadCounts(id)` | footer | counts record `{ saves, r }` |
| `useAskTree(id)` | branch trees and cards | nodes, answers, passage indexes, look-up phrases |
| `useBranchComments(id, node)` | branch card | comments on a node |
| `useReplies(id)` | reply tree | replies |
| `useRun(node)` | run states | run record plus the stream buffer |
| `useSources(id)` | byline, citation popover | cited pages of the answer |
| `useModerationLog(space)` | moderation log | `modlog` entries, reports |
| `useInvites()` | invites page | `accountInvites.*`, `members.tree` (TanStack, online-only, 01 C8) |
| `useUsage()` | ring, usage page, composer | `usage.get`, `usage.listRuns` (TanStack) |

A summary-only thread renders title, byline and counts; opening its side column
requests the full records (01 R3); offline on the desktop it shows "Available
when online". Unjoined open channels under All are read into an ephemeral
replica that is dropped on leaving the channel view (01 R5).

**W9.1 `replica/`.** Acceptance: on the fixture replica, a write to thread A
does not re-render thread B's row (render counter); a query the replica cannot
answer yields `unknown` and a loading row, not an empty state; opening ten
unjoined channels on the desktop adapter writes nothing to SQLite.

### 9.2 Writes from the outbox

`replica/writes.ts` wraps the mutators the screens call (names per 01 U5 and
03 §2.1, which keep the `spaces.ts` procedure names): `threads.create` (Ask,
and Open as its own thread with `from`), `threads.delete`, `research.forkNode`
(follow-up, Continue, Branch and Branch here with `kind: "ask"`; Look up with
`kind: "lookup"`), `followups.delete`, replies (`research.createPostFollowUp`,
`replies.delete`), `comments.create`, `comments.delete`, `saved.set`,
`prefs.set`, `spaces.join`, `spaces.leave`, `spaces.update`,
`reports.create`, `reports.resolve`, `moderation.decide`, `members.ban`,
`members.unban`, `members.remove`, `members.setRole`, `invites.create`,
`invites.revoke`, `invites.restore`, `notifications.markSeen`,
`notifications.markRead`, `notifications.markAllRead`, `research.cancelNode`,
`research.retryNode`. Each makes its ULIDs, applies the prediction to the
replica and enqueues the envelope.

- Unconfirmed writes render as final, without spinners.
- A recorded refusal rolls the prediction back and shows a toast for the code
  (STALE, FORBIDDEN, CONFLICT, PRECONDITION_FAILED, …, with the 04 §9 copy
  where it applies); typed text returns to its composer.
- Web: the outbox holds a write only while its request is in flight; a network
  failure marks the item "Not sent" with Retry (same mutation id) and Discard.
- Desktop: writes are kept 3 days in server time; one that failed 5 times or was
  dropped is listed with its text in a "Not sent" toast while the outbox
  continues (`AGENTS.md`, 01 Y10).
- `UPGRADE_REQUIRED` shows "Update Session" (01 S1).
- Online-only actions (new channel, account invites, keys, billing, sign-in)
  show a busy state and inline errors.

**W9.2** Acceptance: a fake server refusing a reply (rolled back, text
restored), answering STALE to a role change (toast, record reloaded), and
dropping the web connection (Not sent; Retry reuses the mutation id).

### 9.3 Per-viewer fields

`replica/viewer.ts` computes `mine`, `saved`, `canWrite` (active account, not
banned in the space), `isStaff(space)`, `isOwner(space)`, `canDelete(item)`
(mine, not running, not promoted, nothing by others under it), `showAuthorAvatar`,
`joined(space)` and the scope lists. Acceptance: table-driven unit tests per
field.

### 9.4 UI state (Zustand)

`navigation` (localStorage: scope, applied layout, last channel; sessionStorage:
scroll anchors); `threadUi` (memory: per thread the selected branch or reply, the open
inline composer with kind, parent and quote, collapsed replies; one inline
composer per thread); `drafts` (sessionStorage, per account); `overlays`;
`runStream` (in-flight text keyed by run, attempt, seq; applies only the next
seq, drops lower seqs and older attempts, fetches `GET /api/runs/:id/live` on a
gap or reconnect, clears on the committed turn; 03 T3). **W9.3** Acceptance:
tests for the one-composer rule, a stream gap, a duplicate and an old attempt,
and an account change clearing `threadUi` and `drafts`.

### 9.5 Signed-out reading

No user log and no outbox. Open channels are read through scope-filtered
`snapshot` and `pull` for a signed-out caller (01 Y5, `inv3`) into an
ephemeral read-only replica, as for unjoined channels (01 R5). Acceptance: a
signed-out Playwright spec reads a thread, its branches and replies; every
write control opens the auth dialog.

### 9.6 Fixture replica

`replica/fixtureReplica.ts` loads `docs/mockups/session-web-spaces-fixtures.js`
into a replica running the real mutators with a fake clock and a scripted run
executor. It serves unit tests, `/dev/ui`, and screen work before the server
lands. Acceptance: no fixture strings in `vite build` output.

### 9.7 Mock behaviours and their real sources

| Mock | Real |
|---|---|
| `PROMPTS` replaces fixture text with typed text | stored `q` as sent |
| passage by word overlap (`groupsFor`, `bestBlock`) | stored passage index (N3) |
| `runOf` hashes the id to pick a model and effort | `model` and `effort` on the node and run records (03 §1, K12) |
| `likesBase` as save count; `T.count`, `replyCount` as totals | counts record `{ saves, r }` (01 C1, C5) |
| `setTimeout` answers, `pending`, "Step 1 of 4" | run records, `step` and the stream (03 E3, T1-T3) |
| `charge`, `RUNLOG`, `USAGE`, `BILLING`, `ALLOWANCE`, `RESET` | usage procedures and the ledger (03 K1-K7) |
| key status set to `working` by a timer, toast "key works" | `keyCheck` effect (03 K4) |
| `SPACE_META` owner and `vis`, `JOINED`, `memberCount` hash | space, member and role records (01 C9) |
| `isMod` as owner only | staff roles (04 §4.3) |
| `MEMBERS`, `INVITES`, `newCode`, `inviteState` | account invites and `members.tree` (01 C8, 04 §3) |
| `BRP`, `n.look`, `n.quote`, `addLookup` prompt | comments, `look`, `quote`, server-built `q` (01 C3, C4) |
| `PROMOTED`, `from` | `promoted` on the node, `from` on the thread (03 G5) |
| `MODLOG` seeds, `p.removed` | `modlog` and report records, the placeholder fields (01 C12) |
| `mentionsIn` toast ("Notified @x.") | server mention notifications (01 C16) listed on the notifications page (W2.6); no client toast |
| `render()` with focus restored by signature | React reconciliation and §10 focus rules |

### 9.8 Scaffolding that does not ship

The top bar (title, variant segment, Fullscreen, theme segment), the mock bar
(persona switcher "View as", Layout A/B, Jump to, Tokens), the thesis lines
(`ASK_THESIS`, `TREE_NOTE`), the window frame, hash and Ctrl+letter variant
switching (`go`, `V`, `ORDER`, `variant`), navigation directions B-D
(`navDropTop`, `ddButton`, `spacesMenuItems`, the ⌘K finder, `navRail`,
`navSidebar`, `SP_VARIANTS`, `STARRED`, `VISITS`, `SEEN` unread counts),
unused composer variants (`modeSeg`, `splitBare`, `splitEnds`) and Saved
variants a-d, `previewVariant`, `renderMock`, `X_ACCOUNTS` and the fake X
sign-in, the fixtures and seeded moderation log, the timer-driven run and key
check, the mock's fixed `EFFORT_OPTS` list (the real submenu reads the model
registry, §5), the channel rules state and
`.rulesdlg` styles with the "rules gate" and "agent's rule check" named in the
`submitNew` comment, the defined but unused like code (`likeBtn`, `likeBtnK`,
`LIKED`), and the `data-theme` switch (the app uses `data-appearance` and
`data-color-theme`). Acceptance: a CI `rg` finds none of "View as", "Jump to",
"Fullscreen", "EFFORT_OPTS", "rules gate" or the variant names in
`packages/client/src`.

## 10. Accessibility

### 10.1 Focus

Tab order follows DOM order: the app bar (home, scope picker, strip chips,
New channel, ring, Saved, layout toggle, account menu), then the main column:
banner, channel header, composer, then each row as card (title-row "…",
Branched from, byline tooltip, citations, footer) followed by its side column
(each branch tree, the open card's controls, its composer). A branch or reply
tree is one tab stop with a roving `tabindex`. Opening a menu, dialog or
composer moves focus as follows:

| Layer | Initial focus | Returns to |
|---|---|---|
| Account and "…" menus | first enabled item (disabled items `aria-disabled`, skipped by arrows) | trigger |
| Scope, channel, model, send menus | the checked item; composer menus keep the field as return target | trigger, or the text field |
| Info dialog | Close | info button |
| About editor | About field | Edit |
| Moderation log | the active tab | "Moderation log" button |
| Member list, channel invite dialog | Close | the opening row |
| Remove / report | reason field | the card's "…" button |
| Delete confirmation (`alertdialog`) | Cancel (the mock focuses Delete) | "…" button, or the next row if the item is gone |
| New channel | Name | opener, or the new channel's heading |
| Auth dialog | first field or step heading | opener |
| Inline composer, Escape | — | selected tree row, or the button that opened it |
| Citation popover | its link | the citation |
| Selection actions, Escape | — | the answer, selection kept |
| API key form, Escape | — | Add key or Remove |

Route changes to Browse, Invites, Usage, Notifications and Welcome focus the
page heading (`tabindex="-1"`). Branch and reply trees are `role="tree"`
with `treeitem` rows (`aria-level`, `aria-selected`, `aria-expanded` on
collapsible replies); Up/Down move, Left goes to the parent, Right to the first child, Enter or Space
selects. Toasts are `role="status"`; refusals are `role="alert"`. Icon-only
controls have the labels named in §2-§8. **W10.1** Acceptance: one test per
table row; a keyboard-only Playwright spec tabs through a feed row in the order
above, opens and closes every dialog and menu, and checks
`document.activeElement` after each; `eslint-plugin-jsx-a11y` clean (05 M4).

### 10.2 Escape order

Innermost first, one layer per press: delete confirmation; remove/report;
About editor; moderation log; member list and channel invite dialog; info
dialog; auth dialog; open menu (focus to its trigger); citation popover;
selection actions; the focused inline composer (closes it); API key form, then
key-removal confirm. Base UI handles its nested dialogs, menus and popovers;
selection actions, inline composers and the key form register in
`stores/overlays` (`OVERLAY_PRIORITY` gains `selection`, `inlineComposer`,
`keyForm`) and are dispatched by `AppShell`'s capture handler (07 §4.4). Escape
in a composer with text closes it and keeps the draft. **W10.2** Acceptance: a
test opens the info dialog, moderation log and remove dialog stacked, then
presses Escape four times and checks which layer closed each time and where
focus went; a second test does the same for menu, selection actions and inline
composer.

### 10.3 Reduced motion

Under `prefers-reduced-motion` or `data-reduce-motion` (08 §7): no bar
`margin-top` transition, no card fade (`pvFade`) or dialog entrance, instant
scripted scrolls (`scrollIntoPadded`, strip chip centring, `?t=` scroll to a
row, passage count buttons), and a static dot in place of the status pulse
("Step N of 4" carries progress). **W10.3** Acceptance: Playwright with
`reducedMotion: 'reduce'` reads computed `transition-duration` (0s) on the bar
and card and `animation-name` (`none`) on the status dot, and checks that
`scrollTop` reaches its target in the same frame after opening a composer.

## 11. Styling and dark mode tokens

`tokens.css` stays the token source (08 §1). The mock's roles map to existing
tokens; only these are added, each with a dark value and a light override in
both colour themes and exposed through `@theme inline`: `--passage-mark` (mock:
light `rgba(60,40,20,.06)`, dark `rgba(255,255,255,.07)`), `--avatar-1`…
`--avatar-6` and `--avatar-fg`, `--tree-rail`, `--tree-rail-on`,
`--tree-dot-selected`, and meter tones where status tokens do not fit. Title
and input sizes become `--fs-title` and `--fs-input` with the DM Sans
half-pixel offset (08 §6.5).

**W11.1 Tokens.** Acceptance: 08 §6 contract tests pass (light override per
dark token, no colour literals in components or built CSS); visual baselines
in the four theme × appearance combinations.

**W11.2 Contrast.** A unit test resolves token values from `tokens.css` for
each of the four theme × appearance combinations and checks: body, title,
byline, tree-row and chip text against `--workspace-bg`, `--content-card-bg`
and `--popover-bg`, and against `--passage-mark` and the `qsel` tint
composited over the workspace background, at least 4.5:1;
tree rail, dots, the hollow title node, the ring arc and track, the Saved pill
border, the avatar fill against `--avatar-fg`, and `--focus-ring`, at least
3:1 against their background; disabled controls are exempt. Acceptance: the
test passes in CI and names the failing pair when it does not.

## 12. Testing

### 12.1 Unit and component

AVA, jsdom and Testing Library under `packages/client/test/`, on the fixture
replica: `lookPhrase`, `railGeometry`, `placePins`, `useBarAutoHide`, count and
byline formatting, viewer fields, scope lists, invite-code parsing, run states,
focus table, Escape stack, contrast pairs, one-composer rule, write rollback,
stream gaps, and each screen's viewer states. Tests of the deleted features go
with them (12 §3.5).

### 12.2 End-to-end (`web/e2e`)

Real server with fixture providers, one login per spec (12 §3.6). These names
are the ones 04 and 05 use; each spec gains steps in the milestone that
delivers them.

| Spec (`web/e2e/`) | Milestone | Drives |
|---|---|---|
| `spaces-shell.spec.ts` | M4 | scope, strip, bar hide, layout toggle, phone widths |
| `spaces-feed.spec.ts` | M4, M5a | post, save and the Saved count, a second context seeing a post without a reload, delete, the removed placeholder; the web's in-flight-only outbox (Not sent, Retry, nothing kept after a reload); from M5a, an ask streaming with a reload mid-stream |
| `spaces-replies.spec.ts` | M4 | reply trees, Reply at root, mentions |
| `spaces-signed-out.spec.ts` | M4 | signed-out reading of a thread, its branches and replies (§9.5); write controls open the auth dialog |
| `spaces-keyboard.spec.ts` | M4 | §10 focus order, Escape order, reduced motion |
| `spaces-channels.spec.ts` | M4, M6 | join, leave, New channel, About (M4); channel invite links, report, moderation log, removal with reason, dismissal, ban (M6; 04 B3, B4, §6.6) |
| `spaces-branches.spec.ts` | M5a | follow-up, Continue, Branch, Branch here, Look up, Comment, dot alignment |
| `spaces-runs.spec.ts` | M5a | run states, Stop and Run again (05 M5a) |
| `spaces-usage.spec.ts` | M5b | usage page, keys, billing setting, out-of-tokens refusal |
| `spaces-membership.spec.ts` | M6 | account invite links and codes, waiting accounts, the invite tree (04 I4) |

`visual.spec.ts` is rewritten for Home in `centred` and `wide` at 1440 and
1100 px, a channel at 800 px, an open branch card, the stacked dialogs, Usage,
Invites and the auth dialog. `admin.spec.ts` stays. The `library`, `research`,
`collaboration`, `live` and `widgets` specs are deleted.

### 12.3 Desktop

A macOS checklist (CI when available, a documented manual step until then;
tauri-driver has no macOS support, 05 risks): pair with a device token, quit,
relaunch offline, the feed renders from SQLite, a reply queued offline sends on
reconnect, the window drags by the app bar, a device run shows "Waiting for
your Mac" and then the agent label.

## 13. Dependencies on the server and sync work

| Id | Needs | Provided by |
|---|---|---|
| N1 | `@session/sync` client half (replica, outbox, rebase, reactive queries, memory and SQLite adapters) and `@session/mutators` | 01 Y9-Y12, U1-U5 |
| N2 | Signed-out and unjoined reading of open channels | 01 Y5, R5; 04 §3.5 |
| N3 | Passage index on ask nodes (block index of the quoted passage, absent for footer asks), over a block structure that is the same for streamed and final text | 01 C3, 03 §1 (`b`) |
| N4 | Counts record `{ th, s, saves, r }` with totals; no likes | 01 C1, C5 |
| N5 | `vis: open \| private`, roles, the All directory | 01 C7, C9, C11; 04 §4 |
| N6 | Comments on ask nodes; look-ups through `research.forkNode` with `look` and a server-built `q` | 01 C3, C4, U5; 03 §2.1, G2-G4 |
| N7 | Account invites, waiting accounts, `members.tree` (online-only) | 01 C8; 04 §3 |
| N8 | Placeholder fields `mod`, `modBy`, `modNote`; `modlog` with ban entries | 01 C12; 04 §6.5 |
| N9 | Run records, `step`, failure reasons, stream deltas and `/live`, cancel and retry | 03 §1, E3, G6, T1-T3; 01 Y7 |
| N10 | `usage.*`, `apiKeys.*`, `usage.changed`, model registry with payers, device executors | 03 K4-K8, K11, V1 |
| N11 | GitHub sign-in with the profile step, `auth.checkInvite`, desktop device tokens | 04 §1, §3.4; 01 S2 |
| N12 | Stored answer and stream format: both Markdown | 01 C3; 03 §1 |
| N13 | `prefs` record and `prefs.set` | 01 C13 |
| N14 | Member list, ban, set-role and channel invite link mutators | 04 §4.3, §5, §6.4 |
| N15 | Notification records (mention, `report`, `report_resolved`) and the `notifications.*` mutators, for W2.6 | 01 C16, U5; 04 O1, O2 |

Shell, feed, side column, composer and dialogs are built against the fixture
replica (§9.6) and do not wait on N1-N15.

## 14. Open questions

1. **Passage index.** Settled: 01 C3 and 03 §1 store `b` on the node, sent
   in `research.forkNode` input (N3).
2. **Stop.** The mock has no Stop control; 03 G6 and 05 M5a need one. Placement
   proposed in §3.3 (beside the run status, asker only).
3. **Thread addresses.** Notifications and shared links need one; the plan uses
   `/c/$name?t=&sel=`, which needs a single-thread fallback for threads outside
   the loaded feed.
4. **Removal placeholder author.** Show the author's handle as the mock does
   (04 question 1)?
5. **Notifications inbox.** The mock has no surface for the notifications
   01 C16 and 04 O1-O2 produce. W2.6 adds a minimal page reached from the
   account menu; whether it needs an app bar control or push notifications
   on the desktop is open.
6. **Widgets and artifacts** in answers, which the current Markdown pipeline
   renders and the mock does not show.
7. **Typography.** The mock uses Inter; the client keeps the app's font setting
   and needs title and input sizes decided.
8. **Settings.** The account menu has no Settings entry for appearance, theme,
   reduced motion and the send shortcut.
9. **Effort.** Settled: the submenu ships with the efforts of the chosen
   model (§5, 03 K12); whether effort is capped for included tokens is 03
   question 6.
