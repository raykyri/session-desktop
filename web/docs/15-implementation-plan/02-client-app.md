# 02 — Client app

Status: draft. This file plans the client that implements the members mockup
(`docs/mockups/session-web-members.html`): one React codebase in
`web/packages/client` that ships as the web client. This build is web only
(`00-overview.md`, "Scope of this build"): the Tauri desktop client of
`AGENTS.md` "Desktop" and the phone client are not built, and items that
existed only for them are marked "(removed: web-only build)". Screens read a replica through
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

"The mock" below means the members mockup's behaviour as read from its source
at HEAD (the app code from about line 1128); function names are given in
parentheses. User-facing copy (headings, button labels, menu labels, toasts,
empty states, dialog text, notification text) is the mock's. The client
departs from it in two places only: the account invite link carries the code
in the fragment (`/i#<code>`, the mock prints `session.app/i/<code>`), and
sign-in offers GitHub as well as X. Where an item adds a control or text the
mock lacks (Stop, Run again, Ban on the thread menu, Unban, the member list,
channel invite links), the item says it is a plan addition. Where a rule of
01-04 removes data the mock shows (removed text, the author of a removed
thread), the item says so.

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
| `routes/admin.tsx`, `settings.tsx`, `login.tsx`, `devUi.tsx`, `invite.tsx`, `chunks.ts` | Kept and restyled; `invite.tsx` rewritten for account invites; `admin.tsx` gains the Site Admin settings (W8.2); `settings.tsx` is not linked from the account menu at launch (decision P23) |
| `api/trpc.ts` | Kept for online-only procedures (auth, usage, API keys, invites, directory, settings) |
| `api/api.ts`, `cache.ts`, `events.ts`, `queries.ts` | Deleted; replaced by `replica/` (§9) |
| `stores/settings`, `overlays`, `notifications`, `connection`, `localAccount`, `lightboxes` | Kept |
| `stores/navigation`, `drafts` | Rewritten (§9.4) |
| `stores/liveTurns`, `recapPending`, `homeFocus` | Deleted; `replica/runStream.ts` replaces `liveTurns` (ADR-22) |
| `lib/platform.ts`, `motion.ts`, `clipboard.ts`, `relativeTime.ts`, `toast.ts` | Kept; `motion.ts` gains `scrollIntoPadded` |
| `lib/researchDraftAutosave.ts`, `researchImages.ts`, `transcriptSearch.ts`, `tabMerge.ts`, `localOwner.ts` | Deleted with the research client |
| `features/markdown` | Kept; gains citation and passage plugins (§4.4); the widget and artifact plugins are removed (P21) |
| `features/composer` | Rewritten (§5); `QuestionModelPicker.tsx` is the base of `ModelPicker` |
| `features/home`, `sidebar`, `thread`, `drafts`, `highlights`, `import`, `journal`, `research`, `sharing`, `palette`, `account`, `widgets` | Deleted in M4 (`widgets` too: answers are plain Markdown, decision P21) |
| `features/notifications` | Rewritten for W2.6 over the user log's notification records |
| `ui/*` | Kept; new `RoundButton`, `SplitButton`, `TreeRail` |
| `styles/tokens.css`, `fonts.css`, `prose.css`, `app.css` | Kept, extended (§11); `feed.css`, `tweet.css` deleted |

New code:

```
src/replica/              ReplicaProvider, adapters/, queries.ts, writes.ts, viewer.ts, runStream.ts, fixtureReplica.ts
src/features/shell/       AppBar, ScopePicker, ChannelStrip, UsageRing, SavedButton, LayoutToggle, AccountMenu, useBarAutoHide,
                          SiteFooter
src/features/feed/        FeedPage, FeedRow, ThreadCard, TitleRow, AnswerProse, CardFooter, RunStatus, RemovedCard, BranchedFrom
src/features/branches/    BranchTree, BranchCard, BranchActions, BranchComments, SelectionActions, lookPhrase.ts, geometry.ts
src/features/replies/     ReplyTree, ReplyCard
src/features/composer/    NewThreadComposer, InlineComposer, SendSplitButton, ChannelPicker, ModelPicker
src/features/channels/    ChannelHeader, ChannelInfoDialog, AboutEditorDialog, ModerationLogDialog, RemoveDialog,
                          MemberListDialog, ChannelInviteDialog, NewChannelDialog, BrowsePage, FrozenBanner
src/features/membership/  MembersPage, InviteTree, InviteLinks, AuthDialog, InviteRequiredPage
src/features/usage/       UsagePage, RecentRuns, OutOfTokensChoice, ApiKeys
src/features/notifications/ NotificationsPage, NotificationRow, UnreadDot
src/features/admin/       SiteSettingsPanel
```

**W1.1 Remove the research client.** Acceptance: `npm run check` passes;
`rg "research\.(create|fork|get)|workspaces\.|folders\." packages/client/src`
finds no procedure calls; the build contains no `tweet.css` or `feed.css`
rules.

**W1.2 One web/desktop seam (removed: web-only build).** There is no desktop
client, so no `isDesktop` and no adapter choice; the replica uses the memory
adapter (01 Y9). Acceptance replaced by: `rg "@tauri-apps" packages/client`
finds nothing.

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
| `/admin` | Site admins only: the existing admin page with the Site Admin settings (W8.2) |
| `/i` | Account invite link; the code is in the fragment (`<SESSION_PUBLIC_ORIGIN>/i#<code>`, in production `https://session.dev/i#<code>`; 04 §3.2, §3.4), captured into memory, removed from the URL, and opens the auth dialog over `/` |
| `/settings` | Kept from the current client, restyled; no menu entry at launch (P23) |

Feed routes take `?t=<threadId>&sel=<nodeId>`: the feed scrolls to that row and
selects that branch (the mock's `gothread`, `gofrom`). This is a thread's
address (decision P9): `/c/<name>?t=<threadId>` opens the thread in its
channel feed, scrolled into view. There is no single-thread page. A thread
outside the loaded feed (older than the window, 01 R1) is fetched with
`snapshot(log, { threads: [id] })` and inserted in the feed at its date
order; a thread the viewer cannot read shows the toast "This thread is not
available." and the feed. Notifications and shared links use this address.

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
   icon; channels the viewer owns, only for accounts that can write) and All
   (compass icon; 01 C7). The scope chooses which channels the strip lists;
   Home always shows joined channels. With one scope (signed out, where Joined
   would equal All) no picker is drawn above 520 px; at 520 px and below it
   carries the strip (W2.5) and is drawn with one scope too.
3. **Channel strip**: horizontally scrolling `#name` chips with
   `aria-current="page"` on the current one, a join "+" (title "Join") on
   unjoined chips under All, a trailing New channel button (label "New
   channel") for writers, and the empty line ("You have not made a channel
   yet." under Channels you manage, "Nothing here yet." otherwise). No
   scrollbar; a mask fades 40 px at an edge only while content is hidden past
   it (`--fl`, `--fr`). The current chip is scrolled to the centre when it
   lies within 40 px of an edge. Shown on the feed routes, Browse, Invites,
   Usage, Notifications and Site Admin; not on `/welcome`. Not shown at 520 px
   and below, where the scope picker's menu lists its channels (W2.5).
4. **Usage ring** (`meter`): an 18 px ring only, at every width (no "Nk left"
   text and no track bar): an arc for the share used over a full-circle
   track; tone `ok` below 80 % used, `warn` from 80 %, `bad` from 95 %
   (03 K6); `aria-label` "N of M included tokens left this week; resets in
   2 days 5 h" (`fmtTok`, `resetIn`). Opens `/usage`. Offline it shows the
   last value and its time in the label.
5. **Saved round button with count** (`savedBtn` variant `e`): a 30 px pill
   (30 px high, at least 30 px wide; a 30 px circle with the bookmark alone
   at zero), bookmark filled when the count is above zero, no number at zero,
   label "Saved, N" (or "Saved"), title "Saved", `aria-current="page"` on
   `/saved` (the mock's `aria-pressed` is wrong for a link). The count is
   computed from save records in the user log (01 C2).
6. **Layout toggle round button** (`layoutBtn`): 30 px; switches between
   `centred` and `wide` (§3.1); its icon shows the target layout (arrows
   outward in `centred`, inward in `wide`), its label and title are "Expand"
   in `centred` and "Collapse" in `wide`; feed routes only.
7. **Account menu**: the 20 px avatar button carries a 9 px unread dot while
   any notification is unread (W2.6; decision P10), and its label becomes
   "Account, N unread notifications". Menu: header with avatar, name and
   "@handle · Member", "@handle · Admin" (site admins) or "@handle · No
   invite yet"; Notifications (with the unread count, W2.6); Invites, Saved,
   Usage and API keys, Site Admin (site admins only, W8.2); Sign out. No
   Settings entry until there are settings beyond Usage (decision P23).
   Without an invite: Enter an invite code, Sign out.

Items 4-6 are not rendered for accounts without an invite.
**Signed out** (`appbarOut`): name, strip of open channels, "Join with invite"
(opens the auth dialog at the code step) and "Sign in".

**Placement** (`#bar`). The bar is absolutely positioned over the page
(`position: absolute; top: 0`), so showing or hiding it never changes the
page's layout or scroll position; the feed and every page reserve its height
with 49 px of top padding (and `scroll-padding-top: 49px` on pages). It spans
the window in both layouts, at every width and on every screen, with the
`.app-bar` insets (16 px left, 14 px right, 12 px gap; at 520 px and below
11 px right and 6 px gap, W2.5), a 1 px divider at its
bottom and no rounded corners. The mock's column-aligned floating card in
layout `centred` above 860 px (`alignBar`) is not built.

**W2.2 `AppBar` and parts** in `features/shell/` on `ui/Menu` and
`ui/RoundButton`. Acceptance: component tests per viewer state (signed out, no
invite, member, channel owner) for which controls render; the list per scope
and its two empty lines; the strip on each route of item 3 and not on
`/welcome`; ring tone at 79.9/80/94.9/95 % and no visible text in the ring
button; Saved shows no number at 0 and `aria-current` only on `/saved`; the
layout toggle's label per layout; fade variables are `0px` when the strip
does not overflow; "Site Admin" in the account menu only for site admins.
Playwright in `centred` at 1440 px reads the bar's box as the viewport's
width and its border radius as 0, and reads the full width in `centred` and
`wide` at 600, 1150 and 1440 px.

**W2.3 Bar hides on scroll.** `useBarAutoHide(scrollEl)`: shown within 48 px of
the top; past that a downward step over 4 px hides it and an upward step over
4 px shows it, the reference position moving only on such steps or within
48 px of the top. It stays shown while one of its menus is open, on non-feed
screens, and while focus is inside it (a `focusin` shows it, so Shift+Tab from
the feed reaches it; a plan addition). A jump from a notification (W2.6) sets
`keepBar`: the scroll event that jump causes does not hide the bar, and the
reference position moves to the new offset. Hiding sets
`transform: translateY(-100%)` with a 0.2 s transition (none under reduced
motion); the hidden bar is not `inert` and stays in the accessibility tree.
The sticky side column of a post (§4.3) has `top: calc(58px + 49px)` while
the bar shows and `top: 58px` while it is hidden. Acceptance: reducer unit
test over scroll sequences, including `keepBar`; Playwright reads the bar's
box after wheel 400 px down (hidden) and 50 px up (shown), checks that the
first row's `getBoundingClientRect().top` and the scroll container's
`scrollTop` do not change when the bar hides or shows, reads the sticky
column's `top` in both states, checks the bar stays shown after opening a
notification, and after Shift+Tab from the first feed control while hidden
(shown, focus on the last bar control).

**W2.4 Full window, no fullscreen.** The mock's Fullscreen button, window frame
(`.frame`) and `fs-exit` are scaffolding. The shell fills the viewport, with
one scroll container under the bar. The Tauri drag region and traffic-light
inset are not built (removed: web-only build). Acceptance: no
`requestFullscreen` in the client.

**W2.5 Narrow widths.** ≤ 520 px: brand word hidden, composer controls wrap to
a second row under the text (`ncw`). The channel strip is not shown and folds
into the scope picker's menu: the scope items as above, the current one
checked; below a separator the current scope's channels in the strip's order
as `menuitemradio` items, the open channel checked (the scope's empty line
instead when it has none; nothing while the channels load); and, for accounts
that can write, a separator and a last item "New channel" in place of the
strip's trailing button. The Join "+" of unjoined channels under All is not in
the menu: the channel's header carries Join. Choosing a channel opens it,
closes the menu and returns focus to the button. The button names where the
viewer is: the open channel ("#name"), otherwise the scope. The menu keeps the
menu keyboard (arrows, Home and End, first letter, matched without the `#`,
Escape, and Tab to close) and scrolls past `min(460px, 62vh)`. Signed out the
button is drawn too, with All as its one scope. The bar's spacing: 4 px
between the brand and the scope button, 6 px between the ring, Saved, the
layout toggle and the account menu, 11 px after the account menu. Acceptance:
a component test with a `matchMedia` stub (the menu lists the strip's channels;
choosing one navigates and checks it); Playwright at 400 px (strip hidden, the
menu's channels, opening one, the button's name, the spacing, nothing past the
bar's edges) and at 521 and 860 px (the strip shows, the menu has the scopes
only). ≤ 600 px: the composer's menus are
right-anchored and capped at `100vw - 40px`, and the Effort submenu is drawn
inline under its row instead of flying out to the side. ≤ 860 px: feed rows,
Invites and Usage stack to one column, the side column is not sticky, and the
bar is full width. Acceptance: Playwright at 360×740 and 390×844 asserts
`scrollWidth <= innerWidth` on every route, that the send button is visible,
and that the open Effort submenu lies inside the viewport.

**W2.6 Notifications page** (`/notifications`, `notifPage`, reached from the
account menu; decision P10). Heading "Notifications" with "Mark all as read"
(disabled while nothing is unread). Under it, while the list is not empty, the
summary line "N unread notifications." (or "1 unread notification.", or "All
caught up.") followed by "Mentions, replies to your posts, branches and
comments on your asks, removals, and invites people used." The list is the
notification records of the user log (01 C16), newest first, in a box; each
row shows the actor's avatar with a kind badge (`N_KIND`), the text, and a
sub-line "#channel · 3h" ("Invites · 3h" for an invite), and unread rows are
tinted with an 8 px dot labelled "Unread". The thread title is the
replica's, clipped at 64 characters, in quotes (`titleOf`):
- `mention`: "@x mentioned you in a reply on “title”" (`comment` or `post`
  in place of `reply`, by where the mention is);
- `reply`: "@x replied to your post “title”";
- `branch`: "@x branched from your ask “title”" (a look-up too);
- `comment`: "@x commented on your ask “title”";
- `removed`: "@x removed your ask: “reason”" (or "post"; without a reason,
  "@x removed your ask"; "thread" while the replica holds no record of the
  thread, so the kind is not guessed). The mock also prints the title; the
  client cannot, because the removal erases the text and the notification
  carries none
  (01 C16, 04 O2);
- `invite_used`: "@x joined Session with your invite". The mock also
  prints the code; the record stores none (04 I1).

A thread the replica has no text for is quoted as “a deleted thread”, and
one it has not loaded as “a thread”. While the page is open it fetches the
threads it has not loaded, reading the log of each such thread's channel
the replica does not read (an open channel the viewer left or was banned
from) as a channel view does. An actor whose account was deleted
reads "Deleted account". Coalesced `reply`, `branch` and `comment` records
(01 C16) read "@x and others …" (a plan addition; the mock has no
coalescing): `n` counts writes, not people. Opening a row
(`openNotif`) writes `notifications.markRead` and goes to the thread's address
(§2.1, `/c/$name?t=&sel=`): a reply mention or reply selects that reply in
the reply tree, a branch selects the new node, a comment or a comment mention
selects the node commented on; the card is scrolled to 12 px below the top of
the feed with `keepBar` set (W2.3) and flashes a 2 px accent ring for 1.6 s
(`.card.flash`; no transition under reduced motion). An invite row goes to
`/invites`. An item the viewer can no longer read is not served, so it is not
listed. "Mark all as read" writes `notifications.markAllRead` and shows the
toast "All notifications marked as read." The unread dot on the account
avatar (`UnreadDot`, 9 px, `--unread-dot`, with the label of §2.2 item 7)
shows while any notification is unread, as in the mock; opening the page
does not clear it. The menu's Notifications entry shows the count; no other
app bar control is added. Empty state (`notifEmpty`): a box with a bell,
"No notifications yet", "You are notified when someone mentions you, replies
to your post, branches or comments on your ask, uses one of your invites, or
when a channel owner removes your thread." and the button "Invite someone"
(to `/invites`). Acceptance: component tests per notification kind and for
the coalesced text; the summary line for 0, 1 and 3 unread; the unread dot
appearing, staying after the page is opened, and clearing after the last
`markRead` or `markAllRead`; the unread count; a reply mention selecting the
reply; the flash class removed after 1.6 s; a test that a mention in a
private channel the viewer left is not listed.

**W2.7 Site footer** (`siteFoot`, 05 §6 Q10). Every feed (after the last row)
and every page (`/saved`, Browse, Invites, Usage, Notifications, Site Admin,
`/welcome`, `/settings`) ends with a centred footer: "Session · Report abuse:
abuse@<host>", the address a `mailto:` link, where `<host>` is the hostname of
`SESSION_PUBLIC_ORIGIN` (in production `abuse@session.dev`); 40 px above it,
a 1 px divider rule on top, extra-small faint text. The address comes from
the client's build-time config of the public origin, not from a literal.
Signed-out readers see it too. Scheduled in M4. Acceptance: a component test
that the address follows the configured origin; `spaces-shell.spec.ts` finds
the footer at the end of Home, a channel, Browse and Usage, signed in and
signed out.

## 3. Feed

### 3.1 Rows and layouts

The feed (`renderNetwork`) is, in order: the no-invite banner ("You don't
have an invite yet. You can read every open channel. Asking, posting and
replying open once you enter an invite code.", button "Enter a code"), the
channel header (W6.1), the frozen-channel banner (W6.10), the composer (§5;
not rendered in a channel the signed-in viewer has not joined), the empty
state, one row `[card | side column]` per thread, and the site footer (W2.7).

- **`centred`** (mock layout A, `pl-a`): above 1320 px a grid
  `1fr | 600px | 1fr` (at most 1340 px wide), card in the middle track, side
  column in the right track capped at 330 px; the channel header takes the
  main column's width. From 861 to 1320 px a centred `600px | 330px` pair, the
  channel header spanning both columns. The app bar follows the same columns
  (§2.2, Placement).
- **`wide`** (mock layout B, `pl-b`): ≥ 861 px a centred `720px | 300px` pair,
  the channel header spanning both.
- Columns are 21 px apart. ≤ 860 px: one column with a 12 px page inset, the
  side column after the card with a further 12 px inset.

The layout is the `prefs` record in the user log (01 C13, written with
`prefs.set`), default `centred`; `navigation` holds the applied value so the
first paint does not wait for the replica (ADR-20). Empty states:
- Saved (`savedEmpty`): a box with a bookmark icon, "Nothing saved yet",
  "Threads you save appear here, newest first. Save one with the bookmark at
  the bottom of the thread; saving again removes it." and the button "Go to
  Home";
- Home: "Join a few channels to fill Home." followed by the inline link
  "Browse channels";
- a channel without threads: "No threads here yet. Ask the first question.";
- a private channel the viewer is not in: "This channel is private. Ask
  @owner to add you."

**W3.1 `FeedPage`, `FeedRow`.** Grid utilities keyed on `data-layout`; rows
virtualised with `@tanstack/react-virtual` past 60 rows, measured after the side
column lays out. Acceptance: visual baselines (§12.2); a test per empty state
with its copy and button; the channel header's width per layout and width
band; toggling the layout writes one `prefs.set` and a second replica of the
same account applies it.

### 3.2 Card

- **Branched from** (`fromln`): on a thread opened from a branch, above the
  title row, a reply-arrow and "Branched from <title>" (the source thread's
  question clipped at 70 characters, bold) linking to the source row with that
  branch selected.
- **Title row** (`titleRow`), drawn as a tree row: an 11 px hollow node centred
  on the first line; the title in regular weight at the title size (16.5 px in
  the mock); on the right the author's 20 px avatar with the tooltip "handle ·
  3h", then the "…" menu. An ask's title is the question as typed. The
  channel of an ask or a post is in the footer meta, not the title row.
- **Answer prose** (asks, §4.4).
- **Footer** (`card-f`): on the left the meta (`fmeta`), for an ask
  "N sources · Nk tokens · #channel" ("1 source", tokens as `ktok`: "41k
  tokens", or the exact number below 1,000), omitting empty parts, and for a
  post "#channel"; then the follow-up button (reply-arrow icon, label and title "Ask a
  follow-up", `aria-label` "Ask a follow-up, N branches") with the total
  branch count for an ask (hidden while the root answer runs), or Reply
  (label "Reply, N replies") with the total reply count for a post; then Save
  (bookmark; label "Save" or "Saved", with ", saved by N" when the count is
  shown; title "Save" or "Saved"; `aria-pressed`) with the save count (01 C1,
  C5). Saving shows the toast "Saved.", unsaving "Removed from saved.". A zero
  count is not drawn; the label then omits the number. In a private channel a
  save count below 3 is not drawn (decision S6, 01 C1). There is no byline,
  no agent mark on the card and no likes. The model and effort of a run are
  stored on the node and run records (03 K12) and shown nowhere in the UI.
- **"…" menu** (`moreMenu`, label "More"): own thread, "Delete ask" or
  "Delete post" (disabled with "Not available once someone else has
  responded", or "Available when the answer finishes" while the root answer
  runs; 01 C15), confirmed by an `alertdialog` "Delete this thread?" / "This
  can't be undone." with Cancel and Delete; another member's thread, for the
  channel's owner (04 §4.3), "Remove…" (W6.5) and "Ban from #name" (a plan
  addition; the mock's thread menu has only Remove…); for anyone else no
  menu.
- **Removed thread** (`card.removed`, 01 C12, 04 §6.2): a removal icon,
  "Removed by @owner", "Reason: “…”" when given, and "Ask by [deleted] in
  #name" or "Post by [deleted] in #name" for every reader, the author
  included (the mock prints the author's handle; 05 §6 P5 decided
  "[deleted]"); no prose, footer or side column. The author's "…" menu keeps
  Delete (04 §6.2).
- **Hidden thread** (04 §6.3): the author and the owner see the text under
  "Hidden by the channel owner"; others see the placeholder. No Hide command
  (decision P7).

Signed out, the follow-up, Reply and Save controls open the auth dialog and
focus returns to the control on close; without an invite they are disabled
with the titles "Ask a follow-up opens once you have an invite", "Reply opens
once you have an invite" and "Saving opens once you have an invite" (the
mock's "Liking opens …" on Save is a leftover of removed likes).

**W3.2 `ThreadCard` and parts.** Acceptance: tests for no zero counts, no
save count below 3 in a private channel, footer meta omissions ("2 sources ·
#ml" without tokens, "41k tokens · #ml" without sources), no model or effort
text anywhere in the card's DOM, Delete eligibility and the confirmation
copy, Remove and Ban for the owner and no menu for other members, the removed
and hidden placeholders, the Save toasts, and the three viewer states of the
footer.

### 3.3 Run states

`RunStatus` renders the run record of a node (03 §1) on the card and in branch
cards:

| `status` | Shown |
|---|---|
| `queued` | "Queued" |
| `running` | "Researching · Step N of 4" (`step` 0-3, 03 E3) with a pulsing dot, replaced by streamed text as it arrives (ADR-22) |
| `complete` | the answer, then the run record's `note` when it has one (03 §1, E5): "Stopped at the run's token limit." (per-run cap, L1) or "Stopped: this week's included tokens ran out." (the member's overdraft limit, K9) |
| `failed` | the reason for `fail.why` (`tokens`: "You're out of tokens until Friday. You can still post, or add an API key in Usage.", weekday from `usage.get`'s `resetAt` in the viewer's time zone, while nothing can pay now, else "This ask did not run: included tokens had run out. Run again to start it."; `key` by `fail.detail`; `rate`, `access`, `error`). A reader who is not the asker reads the author's failure ("This ask did not run: its author had no included tokens left.", "This run stopped: its author's API key could not be used.") |
| `cancelled`, `interrupted` | "Stopped" / "Interrupted" with the partial text |

While `queued` or `running` the asker gets Stop (`research.cancelNode`; a plan
addition required by 05 M5a). After `failed`, `cancelled` or `interrupted` the
asker gets Run again (`research.retryNode`, a new attempt; a plan addition).
While a node runs, its follow-up button, Continue, Branch, Comment, selection
actions and Delete are hidden or disabled as in the mock.

**W3.3 `RunStatus`.** Acceptance: a test per status on the fixture replica,
including both `complete` notes; Stop and Run again only for the asker; an
`interrupted` run with partial text keeps that text and shows Run again.

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
- the passage ends with an inline count button (reply arrow and the count;
  label "N branches on this passage. Open the first", title "Open the
  branches on this passage") that selects its first branch and scrolls the
  tree into view (`badge`, `grpopen`).

**W4.1 `BranchTree` and `ui/TreeRail`.** Pure functions in `geometry.ts`:
`railGeometry(rows)` from measured first-line centres (`ResizeObserver` plus
each row's computed line height) and `placePins(anchors, heights, 12)`.
Acceptance: unit tests (a wrapped row keeps its dot on line one; overlapping
anchors stack); Playwright checks each dot within 1 px of its row's first-line
centre.

### 4.2 Selected-row card

Selecting a row toggles its card below the tree (`preview`): who line (16 px
avatar, handle, relative time) with "…" ("Open as its own thread", for any
writer who can read the branch, shown with the branch's author, 03 G5,
decision P14, toast "Opened as its own thread."; "Delete branch" for its
author with the thread rules plus "Not available after it was opened as a
thread", confirmed by "Delete this branch and the branches under it?" / "This
can't be undone."); a "Look up <phrase>" header (magnifier) or the quoted
passage clipped at 180 characters; run status (§3.3); prose scrolling within
260 px; actions (`branchActs`) Comment (speech bubble, left, `aria-pressed`;
title "Comment on this branch. Does not run an answer."), Continue (down
arrow; title "Ask a new question under this answer. Runs an answer.") and
Branch (down-right arrow; title "Ask a different question at the same point,
next to this one. Runs an answer."; asks at the parent; never on the root,
03 §2.1); "Open thread" instead of Comment when promoted; then comments
(`branchReplies`, 01 C4): "N comments" ("1 comment"), nested 14 px per level
up to 3, each with avatar, handle, time, text and a Reply / Close reply
toggle (`replyIcon`, `aria-pressed`) opening a composer with placeholder
"Reply" and submit "Reply".

The card fades in (0.25 s, 3 px rise) only when the item it shows changes, not on
re-renders from opening a composer, toggling Comment or a count change
(`pvFade`): the fade is keyed on `(threadId, itemKey)` in a ref.

**W4.2 `BranchCard`, `BranchActions`, `BranchComments`.** Acceptance: the
footer's follow-up button opens the composer with parent = the answer,
placeholder "Ask about the answer"; Continue
opens the composer with parent = node, placeholder "Continue ask"; Branch with
parent = node's parent, "Ask beside this"; Comment ("Comment here", submit
"Comment") replaces an open ask composer on that thread and the reverse; a
comment writes no run; the fade class is applied once per item change and not
on a count change.

### 4.3 Reply trees on posts

A post's side column is sticky (`top` 58 px + 49 px while the app bar shows,
58 px while it is hidden, W2.3; at most the viewport height minus 150 px,
own scroll; static at 860 px and below) and holds a reply tree on the same
rail (`replyLines`): avatar and one line of text per row, "+N" on a collapsed
reply. A selected row shows a card with "Delete reply" in "…" (own replies,
none by others under them; confirmed by "Delete this reply and your replies
under it?" / "This can't be undone."), `>` quotes and member `@mentions`, and
a Reply / Close reply toggle; the reply composer's placeholder is "Reply to
@handle". Below the tree "Reply at root" (signed out "Sign in to reply", no
invite "Replying opens once you have an invite"). The footer's Reply opens the
root composer and scrolls to it (§4.5). When a sent post, reply or comment
mentions handles, the toast lists the result the server returns with the
confirmation (N16): "Notified @a, @b." and "@c isn't a member." ("@c, @d
aren't members."), joined in one toast when both apply.

**W4.3 `ReplyTree`, `ReplyCard`.** Acceptance: formatting tests (quotes,
mentions of members only); collapse counts; Reply toggling; focus into the
opened composer; a sent reply is selected in the tree; the mention toast for
a member, a non-member and both.

### 4.4 Answer text: citations, passages, selection

The stored answer and the streamed deltas are both Markdown (03 §1; the
server stores no HTML). Both go through `features/markdown` with raw HTML
disabled and the existing DOMPurify policy on its output (04 Z5), through the
same rehype plugins, so the block structure that passage indexes refer to is
the same for streamed and final text (N12).

- **Citations** (`citeReady`, `citeOpen`): each superscript is a button
  "Source N" opening a popover (`role="dialog"`, label "Source N") with the
  number, title, note and host link ("host ↗", the link takes focus), and is wrapped with its preceding word in a `nowrap` span so it never
  starts a line alone. Built as `rehypeCitations`, not by DOM mutation.
- **Passages**: `rehypePassages` gives each passage a `data-passage` index: a
  top-level block, or an item of a top-level list (the mockup's `blocksOf`:
  top-level paragraphs, items of top-level lists, headings and tables); a
  node's `b` is that index. Passages with branches get the passage shade with 6 px side bleed; the
  passage an open composer quotes gets the accent tint (`qsel`). The mock's
  word-overlap matching (`groupsFor`, `bestBlock`) does not ship; branches carry
  their passage index (N3).
- **Selection actions**: a selection of 3+ characters inside the finished
  answer of a thread card (the mock's `.card .prose[id^="pr-"]`; not in a
  branch card's answer, not while the root answer runs), for a writer, shows
  Look up (magnifier) above Branch here (reply arrow), 8 px below the
  selection, equal width, right-aligned to a one-line selection and
  left-aligned otherwise, kept 8 px inside the viewport, removed on scroll.
  Look up shows only for 1-4 whole words (`lookPhrase`: no boundary inside a
  `\p{L}\p{N}` run; edge punctuation trimmed). The parent of both is the
  thread's answer (the root). Branch here opens the answer's composer with the
  selection as quote (placeholder "Ask about this passage"; a quote over 180
  characters is clipped with "Show all", label "Show the whole quote"; the
  quote has its own Close button) and its passage index `b`. Look up writes
  `research.forkNode { kind: "lookup", look, quote, b }` under the answer at
  once (the prompt is built by the mutator, 01 C3, 03 G2) and selects the new
  row.

**W4.4 Plugins and `SelectionActions`.** `lookPhrase` moves unchanged to
`features/branches/lookPhrase.ts`. The popover also listens to
`selectionchange` (debounced 120 ms) so keyboard selections work, is rendered
so that Tab from the answer reaches Look up then Branch here, and registers in
`stores/overlays`. Acceptance: `lookPhrase` table (1, 4, 5 words; partial word
at either end; punctuation; non-Latin letters); a citation shares a nowrap span
with its word; Playwright selects two words, clicks Look up, and the new row
shows the phrase, not the prompt; a Shift+Arrow selection shows the popover;
a selection in a branch card's answer shows nothing; both actions write
under the root.

### 4.5 Scrolling to a composer

Opening a composer outside the visible area scrolls it in with 24 px below and
60 px above, smoothly or instantly under reduced motion, and focuses it with
`preventScroll` (`focusGlide`). **W4.5** `scrollIntoPadded` in `lib/motion.ts`.
Acceptance: offset unit test; Playwright checks the composer is fully visible
after clicking a footer button near the viewport bottom.

## 5. Composer

The new-thread composer is the mock's `COMPOSERS.split` with `nb-a`:

- the member's 20 px avatar at its start, centred on the text's first line;
  the growing text field ("Ask anything" / "Write a post"; 15 px, label "Ask
  or post"), controls held on the last line;
- channel picker on Home and Saved (title "Channel"; joined channels with
  their glyphs, `menuitemradio`); on a channel route the name as static text;
- model picker for asks (title "Model and effort"): short names on the
  button, full names in the menu, listing every registry model
  (`models.list`, 03 K11, K15) and starting on the site default model and
  default effort unless the person picked another model or effort in this
  tab; a key-only model without its key shows "Add a key" and links to
  `/usage`; with the key it shows "your OpenAI key". No device entries
  ("Claude Code on this Mac"; removed: web-only build). After a separator,
  an "Effort" row shows the current effort and opens a submenu (on hover or
  focus) listing only the efforts the chosen model accepts
  (`ModelEntry.efforts`, 03 K12) as "Low", "Medium", "High", "Max" (and any
  other effort the registry names); there is no "Default" item, and every
  new run carries an explicit effort. When the person picks a model that
  does not accept the current effort, the effort moves to the highest effort
  the model accepts that is not above it, in the order low < medium < high <
  xhigh < max (every registry model accepts low); the same rule applies when
  the composer starts on the default model and default effort. At 600 px and below the submenu is drawn inline under its row
  (W2.5). No cost estimate is shown for high efforts (decision P13);
- split send button: the main part shows the icon of the chosen mode, the
  send arrow for Ask and the pencil for Post, padded 9 px before the icon and
  6 px after it, with label and title "Ask" or "Post", disabled while empty; the chevron part
  (label "Ask or post") opens Ask (arrow) / Post (pencil) with descriptions
  ("Agent researches and answers", "A message to people in the channel")
  and a check;
- ⌘↵ (Ctrl↵ elsewhere, `formatChord`) sends, Enter is a newline; a pointer-down
  on the composer outside a control keeps the caret in the field; choosing
  in any of its menus returns focus to the field;
- signed out: a disabled `fieldset` at 60 % opacity with placeholder "Sign in
  to ask or post" and a cover button labelled "Sign in to ask or post"; no
  invite, or a channel not joined: not rendered;
- out of included tokens with no usable payer (03 K8): every write that starts
  a run (Ask, follow-up, Continue, Branch, Branch here, Look up) on an
  included-token model is refused before sending with the toast "You're out
  of tokens until Friday. You can still post, or add an API key in Usage."
  (`OUT_MSG`; weekday from `usage.get`'s reset time) and the text stays in
  the field; posts, replies and comments still send. A write sent with
  tokens left may still come back as `failed { why: "tokens" }` when the
  allowance ran out before the server applied it (§3.3, 03 K8);
- a full run queue (20 queued runs per member, `SESSION_QUEUED_PER_USER`,
  refused by the `pre` stage; 03 L1, 01 Y2; the toast copy is a plan
  addition, the mock has no queue): when the replica already holds 20 of the member's own run records
  with status `queued`, a run-starting write is not sent and shows the toast
  "You have 20 asks waiting to run. Try again when one starts." with the
  text kept; if the server refuses it anyway with `PRECONDITION_FAILED`
  (`reason: "queue_full"`, recorded), the client rolls the prediction back,
  restores the text to its composer and shows the same toast.

Inline composers (asks on a thread, comments, replies) are one `InlineComposer`
with a text submit ("Ask", "Comment", "Reply") and a Close button (label
"Close"), with the placeholders "Ask about the answer", "Ask about this
passage", "Continue ask", "Ask beside this", "Comment here", "Reply" and
"Reply to @handle" (§4).

**W5.1** Replace `features/composer/*` (`ResearchQueryComposer`, `AskNoteSwitch`
deleted). Drafts persist per composer key in `stores/drafts`. Acceptance: tests
for mode switching (label, placeholder, model picker hidden for Post, the
send arrow for Ask and the pencil for Post), the empty-text state, the member's avatar at the
start, the signed-out cover, out-of-tokens refusal for each run-starting
write and not for Post, reply or comment, the queue-full pre-check and the
rollback on a `queue_full` refusal with the text restored, draft restore
across routes, focus back to the field after a menu choice, the Effort
submenu listing only the chosen model's efforts with no Default item, the
effort moving down on a model change (a model accepting low, medium and high
after `max` picks `high`), the picker starting on the default model and
default effort of `models.list`, and listing every registry model.

## 6. Channels

**W6.1 Channel header** (`spaceHead`): glyph, `#name` (20 px), lock (label
"Private") for private channels, description clipped at 170 characters, info
button (label and title "About this channel"), and, for writers, one of:
"Your channel" chip (the owner, who cannot leave, 04 §4.3), "Joined" (a
button that leaves at once), "Members only" chip (a private channel the
viewer is not in), Join. Its width follows §3.1. A frozen channel (04 §4.5)
shows its banner under the header and no Join. Toasts "Joined #name." and
"Left #name."; leaving a private channel goes to Home, leaving an open one
stays on its feed. Acceptance: a test per viewer relation; join and leave are
optimistic writes (§9.2); leaving a private channel lands on `/`.

**W6.2 Info dialog** (`chInfoDlg`, 04 §4.4): a header with glyph, `#name`,
lock, Edit (owner) and Close; the description, or for an owner without one
"No description yet." with the inline button "Add one" (opens W6.3); facts
"Channel by" (avatar and @owner), "Members" (the count; a button opening the
member list W6.8, a plan addition), "Visibility" ("Private: only members can
read or post" / "Open: anyone can read and join"); for the owner a footer
with "Moderation log" and, in private channels, "Invite to #name" (W6.9, a
plan addition). No rules (01 C6). Acceptance: content per role; focus and
Escape per §10.

**W6.3 About editor** (`chEditDlg`): a dialog stacked over the info dialog with
its own scrim, heading "Edit #name"; the "About" textarea (placeholder "What
the channel is for. Shown at the top of the channel.") with a live "N / 300"
counter and the error "Keep the description under 300 characters."; Cancel,
Save (`spaces.update { id, desc }`, 01 C11); toast "Channel updated." and
focus back on Edit; owners only. Acceptance: nested Base UI dialog; Escape
closes only the editor; a non-owner has no Edit.

**W6.4 Moderation log** (`modLogDlg`, 04 §6.5): stacked over the info dialog,
heading "Moderation log" with Close; the owner's removals and bans, newest
first: a kind chip (Removed, Banned, and Unbanned for the plan's Unban), the
line "@owner removed @author's ask" (or "post") or "@owner banned @member
from #name", "Reason: “…”" when a note exists, and the relative time. The
mock's removal line ends with the thread title clipped at 70 characters; the
client shows no removed text, because the removal erases it (01 C12). Empty
state: "Nothing removed yet. Use “Remove…” in a thread's “…” menu to take it
down." Acceptance: renders from `modlog` records; the empty-state copy; no
removed text in the DOM.

**W6.5 Remove dialog** (`rmDlg`, 04 §6.2), from "Remove…" in a thread's "…"
menu: title "Remove @x's ask" (or "post") with Close; the thread's title in
quotes, clipped at 120 characters; the field "Reason, shown with the removal"
(placeholder "Optional", at most 300 characters); the line "Readers see that
it was removed. Branches and replies under it go with it. @x is notified,
with the reason."; Cancel and Remove (danger). Remove writes
`moderation.decide { item, decision: "removed", note? }`, closes the dialog
and shows the toast "Removed.". Acceptance: the copy; the removed placeholder
appears optimistically; a reason over 300 characters is refused in the
dialog.

**W6.6 Browse page** (`browsePage`): heading "Browse channels", New channel for
writers, a search field (placeholder "Search channels") over name and
description; cards with glyph, `#name`, lock, "by @owner · N members",
description clipped at 120, and for writers Yours (chip) / Joined (leaves) /
Join; "No channels match." when the filter leaves nothing. Lists open
channels (from `spaces.directory`, 01 C7) and private channels the viewer is
in. Acceptance: filter test and its empty line; Join from a card stays on
Browse; no private channel of which the viewer is not a member appears.

**W6.7 New channel dialog** (`newSpaceDlg`): heading "New channel"; "Name"
with a `#` prefix (placeholder "reading-group", hint "Lowercase letters,
numbers and dashes.") checked against `^[a-z0-9][a-z0-9-]{1,29}$` by the
shared validator (04 §4.2; error "Use 2 to 30 lowercase letters, numbers or
dashes."); "What is it for?" (placeholder "One or two sentences shown at the
top of the channel"); radios "Open" ("Anyone can read and join.") and
"Private" ("Only people you add can read or post."); Cancel and "Create
channel". Creating a space is online-only (`AGENTS.md`): "Create channel" is
disabled while the sync connection is down with "Creating a channel needs a
connection." (a plan addition); busy state until the server answers;
CONFLICT shows "#name already exists."; success navigates to `/c/$name` with
the toast "#name is ready. Invite people by sharing its link." Acceptance:
validation tests; offline state; CONFLICT keeps the typed values.

**W6.8 Member list** (04 §4.3, §6.4): from the info dialog's Members row;
the owner, then members by join date. The owner gets a per-row menu on every
other member: "Ban from #name", and in private channels "Remove from
channel"; the owner sees a Banned list with Unban. Writes `members.ban`,
`members.unban` and `members.remove` (with `base.adm`; STALE reloads the
row). The whole list is a plan addition; the mock has none. There are no role
controls: a channel has only its owner and members (01 C18).
Acceptance: menu items for a member and for the owner; a STALE answer to
`members.remove` reloads the row and shows the toast; the owner's header
offers no Leave.

**W6.9 Channel invite links** (04 §5; a plan addition): the owner of a private
channel opens "Invite to #name": a one-use link with Copy (`lib/clipboard.ts`, toast "Link copied."),
Revoke and Undo (`invites.create { days: 7 }`, `invites.revoke`,
`invites.restore`). Opening a link signed in calls `spaces.join { space,
invite }`; signed out or without an invite, the auth flow (W7.2) runs first
with the code kept in memory. An unusable link shows "This invite link has
expired or was already used." Acceptance: component test for create, copy,
revoke and undo; `spaces-channels.spec.ts` covers the join (04 B4).

**W6.10 Frozen and refused states** (04 §8, §9): a channel the viewer was
removed or banned from is dropped from the replica at the resync that
follows, with the toast "You are no longer a member of #name."; the
desktop's frozen copy is not built (removed: web-only build; no copy after a
voluntary Leave either, decision P8). Refusals of queued writes show the 04 §9 messages (the ban message, "#name is
frozen because its owner's account is not active.", the expired-link
message) and restore composer text. A frozen channel (04 §4.5, `frozen` on
the space record) shows the banner "#name is frozen: its owner's account is
not active. You can read it and delete your own posts.", offers only Delete
on the viewer's own items and Leave, and is left out of the composer's
channel picker. Acceptance: fixture-replica tests for each message, the
restored text, the removed-member toast and the frozen-channel banner.

## 7. Membership and sign-in

**W7.1 Invites page** (`membersPage`, 04 §3.2-3.3). Two columns (one at
860 px and below). "Invite tree" (`treeSection`, `treeA`): the line "Session
is invite-only. You can have 3 open invite links at a time. Each link works
for one person. A slot frees when a link is used or revoked.", then rows from
`members.tree` (online-only, TanStack Query) depth-first from the roots with
children by join date, 18 px per level, 20 px avatar, handle, " · Admin" for
site admins, and name, the viewer highlighted, drawn with `TreeRail`. The
mock's " · Mod" tag is dropped (05 §6 P3). "Invite someone" (`invSection`, a
box): "N of 3 left", one row per open link (`…/i#<code>`, the fragment
departure) with Copy and a revoke × (label "Revoke this link", title
"Revoke"), "Create an invite link" (no open link) / "Create a new link" while
a slot is free (otherwise "You have 3 open invites. One frees when it is used
or revoked."; a waiting account sees "You can invite once your account is
active."), then "You invited" with "Joined Nov 14" per person. Codes come
from the server. Toasts: "Invite SESS-XXXX-XX created. Send the link to one
person.", "Invite revoked.", "Link copied.". Acceptance: tree order and depth
for the 12-account fixture (04 §3.3); no create button at 3 open links; Copy
through `lib/clipboard.ts`; the three toasts.

**W7.2 Auth dialog** (`authScreen`, `authDialog`): modal (label "Sign in to
Session", Close button) with a focus trap, opened from Sign in, Join with
invite, a signed-out write control, `/i#<code>` or a channel link. The
providers are GitHub and X (decision P1, 04 §1, §3.4): every X button of the
mock has a GitHub twin with the same wording ("Sign in with GitHub",
"Continue with GitHub", "Sign up with GitHub"; the departure of the
introduction). An account stays bound to the provider it was created with.
Steps, with the mock's copy:
- landing: brand, "Explore together.", "Session is a shared workspace for
  exploring questions, ideas, and artifacts.", "Sign in with X" / "Sign in
  with GitHub", "I have an invite code";
- valid invite link: "<Name> invited you to Session" with @handle, "Explore
  together.", the same line, "Continue with X" / "Continue with GitHub", "I
  already have an account";
- unusable link: "This invite link no longer works", "It has already been
  used or was revoked. Ask the person who sent it for a new one.", the sign-in
  buttons, "I have an invite code"; used, revoked and unknown codes get this
  one answer from `auth.checkInvite` (04 I4);
- code step (`CODE_COPY`): "Back", "Join with invite?", "Paste the code or link
  a member sent you.", a field (placeholder "SESS-XXXX-XX", label "Invite
  code") and Continue, accepting a code or a full link (the code after the
  last `/` or `#`, upper-cased); "Enter the code from your invite." for an
  empty field; for a used, revoked or unknown code the one message "This
  invite code doesn't work. Ask the person who invited you for a new one."
  (04 I4; the mock gives three different messages, which would tell an
  unknown code from a used one); on success "Invite from <Name>" with @handle
  and "Sign up with X" / "Sign up with GitHub";
- provider explainer: "Sign in with X", "Session uses your name, handle and
  profile picture from X for your profile. It cannot post or read your
  messages.", "Continue to X" (for GitHub the same with "GitHub"); the plan
  adds "Use the same account each time you sign in.";
- no account for this identity: "No Session account for @x", "Session is
  invite-only. Ask a member for an invite code, then sign up with it. If you
  already have a code, enter it now.", "Enter an invite code", "Continue
  without one", and "Without an invite you can read every open channel, and
  enter a code later.";
- create account: "Create your account", "Signed in with X as @x", "Invited by
  <Name> · code SESS-XXXX-XX"; "Name"; "Handle on Session" with an `@` prefix
  and the hint "Lowercase letters, numbers, dots and underscores; 3 to 20
  characters."; the errors "Enter a name.", "Handles use 3 to 20 lowercase
  letters, numbers, dots or underscores." and "@handle is taken. Try
  another."; "Create account"; toast "Account created. <Name> invited you.";
  no rules checkbox.

Focus moves to the first field or the step heading on each step and returns
to the opener on close. Acceptance: a test per step on a fake
`auth.checkInvite`; code parser test for `SESS-9TQ2-X8`,
`https://session.dev/i#sess-9tq2-x8` and the pasted path form
`https://session.dev/i/SESS-9TQ2-X8/` (04 §3.2); used, revoked and unknown
codes render the same message; each X button has its GitHub twin.

**W7.3 Invite required** (`statusPage`, `/welcome`): heading "Invite
required"; "You're signed in as @handle, but Session is invite-only. Enter a
code or link from a member to start asking and posting."; the redeem form
(placeholder "SESS-XXXX-XX", button "Use code"; "Enter the code from your
invite." when empty, otherwise the one message of W7.2 for a code that does
not work); the checklist "Read every open channel and its branches" (ticked),
"Ask, post, branch and reply", "Invite people"; "Browse the network". On
success the toast "You're in. <Name> invited you." and `/`. The feed banner
for accounts without an invite ("Enter a code") links here. Acceptance:
redeem success and the error messages; banner only for signed-in accounts
without an invite.

## 8. Usage and API keys

**W8.1 Usage page** (`usagePage`, 03 §6): heading "Usage and API keys", then
boxes:
- "You have N% of usage left this week. Next reset on Fri, in 2d 5h." with a
  bar (`role="img"`, "N% left") in the ring's tones;
- "Recent runs" (`usage.listRuns`): question clipped at 90, or "Removed" /
  "No longer available" without text (03 K5); the share of the weekly
  allowance ("<1%" below 0.5 %) or the payer label ("Anthropic key", "OpenAI
  key", "Included + Anthropic key"); " · " and the date; "No runs yet this
  week." when empty;
- "When included tokens run out": "Pause my asks until the reset" ("You can
  still read, post and reply.") and "Continue on my Anthropic key" ("Asks
  bill to your Anthropic key until the reset."; disabled without a valid
  Anthropic key, with "Add a key below to turn this on." or, with only an
  OpenAI key, "Needs an Anthropic key. Your OpenAI key only runs GPT-6.1
  Sol."), written with `usage.setBilling`; toasts "Asks will continue on
  your API key." and "Asks will pause until the reset.";
- "API keys": one row per provider (Anthropic, OpenAI). A set key shows the
  provider, the masked key ("sk-ant-••••a1f9"), the chip "Valid" (check
  icon) and Remove, which turns the row into "Remove the <provider> key? Asks
  billed to it will stop." with Keep and Remove (toast "<Provider> key
  removed."). A key that a run later finds rejected (03 E5) shows the chip
  "Invalid" (a plan addition). A missing key shows "Not set" and "Add key",
  which opens a password field (placeholder "Paste key (sk-ant-...)" or
  "Paste key (sk-...)", label "<Provider> API key") with Save and Cancel. The
  format errors are the mock's: "Paste a key.", "That looks like an Anthropic
  key. Add it under Anthropic." and "<Provider> keys start with <prefix> and
  are longer than this. Copy the whole key from your <Provider> account."
  Save calls `apiKeys.set`, which checks the key with the provider during the
  request (03 K4): while it runs the form closes and the row shows the
  masked key with the chip "Checking…", as the mockup draws it; each row
  has one polite live region that announces "Checking…", "Valid" or
  "Invalid" as the status changes; on success the chip becomes "Valid" and the
  toast "<Provider> key works." shows; a refusal saves nothing, reopens the
  form with the text kept, and shows "That key was rejected by <Provider>."
  or "Couldn't reach <Provider> to check the key. Try again." under the
  field. Next to each key the 03 K14 note that calls on a personal key fall
  under the person's agreement with the provider (a plan addition).

All online-only (ADR-19), read through TanStack Query; the ring reads the same
`usage.get` query, with a 30 s stale time, and refetches when one of the
viewer's run records reaches a terminal status in the replica (03 K6).
Acceptance: tone thresholds; disabled key radio and its two reasons; the
billing toasts; key add with "Checking…" during the request, then "Valid"
and the toast; both refusal messages with nothing saved; each format error;
remove with its confirm and toast; the model picker drops a key-only model
when its key is removed; the ring updates within 1 s of a fixture run's
finish.

**W8.2 Site Admin settings** (`/admin`, `adminPage`, site admins only;
decision P11, 03 K15). Heading "Site Admin", the line "Settings for everyone
on Session.", and exactly two boxes:
- "Default model": a radio group of the registry models payable with
  included tokens (03 K11 `payers`), each row the model's name with its
  provider in small text (`admin.models.setDefault`). Key-only models are
  not listed. Toast "Default model set to <model>.".
- "Default effort": a radio group of Low, Medium, High and Max, none
  disabled (`admin.models.setDefaultEffort`). Toast "Default effort set to
  <Effort>." (capitalised, "High").

Members' composers then start on both (§5; a model that does not accept the
default effort steps down as in §5). The page shows no prices, no model
descriptions, no availability switches and no per-member overrides (every
registry model stays available to every member; 05 §6 Q9). All online-only
through TanStack Query; a failed write shows an inline error under its group
and restores the previous choice. Acceptance: component tests that a
key-only model is not listed, that all four efforts are enabled, the two
toasts, that a non-admin reaching `/admin` gets the not-found page, and that
a change refetches `models.list`.

## 9. Client state

### 9.1 Replica and queries

`ReplicaProvider` creates the `@session/sync` client (01 Y9) with the memory
adapter (no IndexedDB); a reload starts from a fresh snapshot within the web
window of 01 R1.
Screens read named reactive queries from `replica/queries.ts` (01 Y12), or
TanStack Query for online-only calls:

| Hook | Screens | Reads |
|---|---|---|
| `useMe()` | all | user record, `status` (`waiting` or `active`), `is_admin` (user log) |
| `usePrefs()` | layout | `prefs` record (01 C13) |
| `useChannels(scope)` | strip, Browse, channel picker | spaces with their `owner`, memberships; All adds `spaces.directory` (TanStack) |
| `useChannel(name)` | header, info dialog | space, owner, member count |
| `useMembers(space)` | member list | member records, bans |
| `useFeed({kind, id?})` | feed | threads of joined channels / one channel / saved set, newest first; summaries outside the window (01 R1) |
| `useThreadCounts(id)` | footer | counts record `{ saves, r }` |
| `useAskTree(id)` | branch trees and cards | nodes, answers, passage indexes, look-up phrases |
| `useBranchComments(id, node)` | branch card | comments on a node |
| `useReplies(id)` | reply tree | replies |
| `useRun(node)` | run states | run record plus the stream buffer |
| `useSources(id)` | card footer meta, citation popover | cited pages of the answer |
| `useModerationLog(space)` | moderation log | `modlog` entries |
| `useNotifications()` | notifications page, unread dot | notification records (user log) |
| `useModels()` | composer, Site Admin settings | `models.list` (every registry model, default model and default effort), `admin.models.list` (TanStack, online-only, 03 K15) |
| `useInvites()` | invites page | `accountInvites.*`, `members.tree` (TanStack, online-only, 01 C8) |
| `useUsage()` | ring, usage page, composer | `usage.get`, `usage.listRuns` (TanStack) |

A summary-only thread renders the title row, the footer meta and counts; opening its side column
requests the full records (01 R3); offline it shows "Available when
online". Unjoined open channels under All are read into an ephemeral
replica that is dropped on leaving the channel view (01 R5).

**W9.1 `replica/`.** Acceptance: on the fixture replica, a write to thread A
does not re-render thread B's row (render counter); a query the replica cannot
answer yields `unknown` and a loading row, not an empty state; opening ten
unjoined channels leaves the joined logs unchanged.

### 9.2 Writes from the outbox

`replica/writes.ts` wraps the mutators the screens call (names per 01 U5 and
03 §2.1, which keep the `spaces.ts` procedure names): `threads.create` (Ask,
and Open as its own thread with `from`), `threads.delete`, `research.forkNode`
(follow-up, Continue, Branch and Branch here with `kind: "ask"`; Look up with
`kind: "lookup"`), `followups.delete`, replies (`research.createPostFollowUp`,
`replies.delete`), `comments.create`, `comments.delete`, `saved.set`,
`prefs.set`, `spaces.join`, `spaces.leave`, `spaces.update`,
`moderation.decide`, `members.ban`,
`members.unban`, `members.remove`, `invites.create`,
`invites.revoke`, `invites.restore`,
`notifications.markRead`, `notifications.markAllRead`, `research.cancelNode`,
`research.retryNode`. Each makes its ULIDs, applies the prediction to the
replica and enqueues the envelope.

- Unconfirmed writes render as final, without spinners.
- A recorded refusal rolls the prediction back and shows a toast for the code
  (STALE, FORBIDDEN, CONFLICT, PRECONDITION_FAILED, …, with the 04 §9 copy
  where it applies); typed text returns to its composer.
- A `queue_full` refusal (`PRECONDITION_FAILED`, 01 Y2, 03 L1) is handled
  as in §5: rollback, text restored, the queue toast.
- The outbox holds a write only while its request is in flight. A network
  failure keeps the prediction in the replica (the item stays rendered as
  sent) and marks the write "Not sent" with Retry (same mutation id) and
  Discard (rolls the prediction back and returns typed text to its
  composer). A write that created an item (thread, branch, look-up, reply,
  comment) shows "Not sent · Retry · Discard" under that item. A write with
  no item or composer (`saved.set`, `spaces.join`, `spaces.leave`,
  `prefs.set`, `notifications.markRead`, `notifications.markAllRead`,
  `research.cancelNode`), and a write whose item is not on screen with its
  line (a branch or reply that is not selected, a comment on such a
  branch), shows a persistent toast (`role="alert"`) "Not
  sent." with Retry and Discard; while several such writes are unsent it
  reads "N changes not sent." and its Retry and Discard act on all of them
  in outbox order. A reload drops unsent writes and their predictions; typed
  text survives in `drafts` (sessionStorage, §9.4). The desktop's 3-day
  outbox is not built (removed: web-only build; 01 Y10).
- `UPGRADE_REQUIRED` (`426`, 01 S1): the client keeps unsent composer text
  in `drafts`, writes the time of the reload to sessionStorage
  (`session-upgrade-reload-at`, per tab) and reloads the page once. If the
  reloaded tab gets `UPGRADE_REQUIRED` again within 60 s of that time, it
  shows "Session was updated. Reload to continue." with a Reload button
  instead of reloading in a loop; a `426` more than 60 s after it reloads
  again and overwrites the time.
- Client id (01 Y3): `{clientId, userId}` is kept in sessionStorage, so a
  reload of the tab re-attaches the same id with `register` (which returns
  `lastSeq`) instead of registering a new one. On load the tab takes the Web
  Lock `session-client:<clientId>` with `ifAvailable`; a duplicated tab, which
  copies sessionStorage, does not get the lock and registers a new id. A
  stored id of another user, or an expired one (7 days idle), answers
  `WRONG_CLIENT` and the client registers anew. Sign-out clears the stored
  id.
- Online-only actions (new channel, account invites, keys, billing, sign-in)
  show a busy state and inline errors.

**W9.2** Acceptance: a fake server refusing a reply (rolled back, text
restored), answering STALE to a member removal (toast, record reloaded),
answering `queue_full` to an ask (rolled back, text restored, toast),
dropping the connection (Not sent under a reply and in the toast for a save;
the prediction stays; Retry reuses the mutation id; Discard rolls back), and
answering `UPGRADE_REQUIRED` (one reload, draft kept, the time in
sessionStorage; a second answer within 60 s shows the Reload message, one
after 61 s reloads again); 100 reloads of one tab register one client id; a
duplicated tab registers a new one; sign-out clears the stored id.

### 9.3 Per-viewer fields

`replica/viewer.ts` computes `mine`, `saved`, `canWrite` (active account, not
banned in the space, space not frozen), `isOwner(space)`, `canDelete(item)`
(mine, not running, not promoted, nothing by others under it), `showAuthorAvatar`,
`joined(space)` and the scope lists. Acceptance: table-driven unit tests per
field.

### 9.4 UI state (Zustand)

`navigation` (localStorage: scope, applied layout, last channel; sessionStorage:
scroll anchors); the sync client's `{clientId, userId}` and the upgrade
reload time (sessionStorage, per tab; §9.2); `threadUi` (memory: per thread the selected branch or reply, the open
inline composer with kind, parent and quote, collapsed replies; one inline
composer per thread); `drafts` (sessionStorage, per account); `overlays`;
`runStream` (in-flight text keyed by run, attempt, seq; applies only the next
seq, drops lower seqs and older attempts, fetches `GET /api/runs/:id/live` on a
gap or reconnect, clears on the committed turn; 03 T3). **W9.3** Acceptance:
tests for the one-composer rule, a stream gap, a duplicate and an old attempt,
and an account change or sign-out clearing `threadUi`, `drafts` and the
stored client id.

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
| `runOf`, `RUNS`: hashes the thread id to pick a model and effort (the mock no longer shows them) | `model` and `effort` stored on the node and run records (03 §1, K12); not shown anywhere in the UI |
| `likesBase` as save count; `T.count`, `replyCount` as totals | counts record `{ saves, r }` (01 C1, C5) |
| `setTimeout` answers, `pending`, "Step 1 of 4" | run records, `step` and the stream (03 E3, T1-T3) |
| `charge`, `RUNLOG`, `USAGE`, `BILLING`, `ALLOWANCE`, `RESET` | usage procedures and the ledger (03 K1-K7) |
| key status `checking`, set to `working` by a 1.3 s timer, toast "<Provider> key works." | `apiKeys.set` checks the key with the provider during the request (03 K4; refused with `BAD_REQUEST` when rejected, `BAD_GATEWAY` when unreachable); the UI shows "Checking…" while it runs, then "Valid" and the toast (W8.1) |
| `SPACE_META` owner and `vis`, `JOINED`, `memberCount` hash | space and member records; `owner` on the space record (01 C9, C18) |
| `isMod` as owner only | kept: the owner is the only moderator, `isOwner(space)` (04 §4.3, 01 C18) |
| `MEMBERS`, `INVITES`, `newCode`, `inviteState` | account invites and `members.tree` (01 C8, 04 §3) |
| `BRP`, `n.look`, `n.quote`, `addLookup` prompt | comments, `look`, `quote`, server-built `q` (01 C3, C4) |
| `PROMOTED`, `from` | `promoted` on the node, `from` on the thread (03 G5) |
| `MODLOG` seeds, `p.removed` | `modlog` records (removals and bans), the placeholder fields (01 C12) |
| `mentionsIn` toast ("Notified @x.", "@y isn't a member.") and `NOTIFS` | the same toast from the handles the server reports with the confirmation (§4.3, N16); notification records (01 C16) on the notifications page (W2.6) |
| `alignBar()` measuring a row's cells | not built: the bar is full width (§2.2, Placement) |
| `ADMIN`, `MODELS`, `setDefault`, `setDefaultEffort` | `site_settings` through `admin.models.*` (03 K15) |
| `render()` with focus restored by signature | React reconciliation and §10 focus rules |

### 9.8 Scaffolding that does not ship

The top bar (title, variant segment, Fullscreen, theme segment), the mock bar
(persona switcher, Jump to, Tokens), the thesis lines
(`ASK_THESIS`, `TREE_NOTE`), the window frame, hash and Ctrl+letter variant
switching (`go`, `V`, `ORDER`, `variant`), navigation directions B-D
(`navDropTop`, `ddButton`, `spacesMenuItems`, the ⌘K finder, `navRail`,
`navSidebar`, `SP_VARIANTS`, `STARRED`, `VISITS`, `SEEN` unread counts),
unused composer variants (`modeSeg`, `splitBare`, `splitEnds`) and Saved
variants a-d, `previewVariant`, `renderMock`, `X_ACCOUNTS` and the fake X
sign-in, the fixtures, `SEED_RM`, `SEED_POST`, `NOTIFS` and the seeded
moderation log, the timer-driven run and key check, the model prices and
notes in `MODELS`, the mock's fixed `EFFORT_OPTS` list (the real submenu reads the model
registry, §5), the channel rules state and
`.rulesdlg` styles with the "rules gate" and "agent's rule check" named in the
`submitNew` comment, the defined but unused like code (`likeBtn`, `likeBtnK`,
`LIKED`, `I.heart`), the card-avatar variant comments (`V[st.v].av`), and the
`data-theme` switch (the app uses `data-appearance` and
`data-color-theme`). Acceptance: a CI `rg` finds none of "Jump to", "Fullscreen",
"EFFORT_OPTS", "rules gate", "likeBtn" or the variant names in
`packages/client/src`.

## 10. Accessibility

### 10.1 Focus

Tab order follows DOM order: the app bar (home, scope picker, strip chips,
New channel, ring, Saved, layout toggle, account menu), then the main column:
banner, channel header, composer, then each row as card (Branched from,
the title row's "…", citations and passage count buttons, footer: follow-up or Reply, Save) followed by its side column (each
branch tree, the open card's controls, its composer), and last the site
footer's address link. A branch or reply
tree is one tab stop with a roving `tabindex`. Opening a menu, dialog or
composer moves focus as follows:

| Layer | Initial focus | Returns to |
|---|---|---|
| Account and "…" menus | first enabled item (disabled items `aria-disabled`, skipped by arrows) | trigger |
| Scope, channel, model, send menus | the checked item; composer menus keep the field as return target | trigger, or the text field |
| Info dialog | Close | info button |
| About editor | About field | Edit |
| Moderation log | Close | "Moderation log" button |
| Member list, channel invite dialog | Close | the opening row |
| Remove | reason field | the card's "…" button |
| Site Admin settings | the page heading | — |
| Delete confirmation (`alertdialog`) | Cancel (the mock focuses Delete; the plan keeps focus off the destructive button) | "…" button, or the next row if the item is gone |
| New channel | Name | opener, or the new channel's heading |
| Auth dialog | first field or step heading | opener |
| Inline composer, Escape | — | selected tree row, or the button that opened it |
| Citation popover | its link | the citation |
| Selection actions, Escape | — | the answer, selection kept |
| API key form, Escape | — | Add key or Remove |

Route changes to Browse, Invites, Usage, Notifications, Site Admin and Welcome focus the
page heading (`tabindex="-1"`). Branch and reply trees are `role="tree"`
with `treeitem` rows (`aria-level`, `aria-selected`, `aria-expanded` on
collapsible replies); Up/Down move, Left goes to the parent, Right to the first child, Enter or Space
selects. Toasts are `role="status"`; refusals are `role="alert"`. Icon-only
controls have the labels named in §2-§8. **W10.1** Acceptance: one test per
table row; a keyboard-only Playwright spec tabs through a feed row in the order
above, opens and closes every dialog and menu, and checks
`document.activeElement` after each; `eslint-plugin-jsx-a11y` clean (05 M4).

### 10.2 Escape order

Innermost first, one layer per press, as the mock's handler: delete
confirmation; remove dialog; About editor; moderation log; member list and
channel invite dialog (plan additions); info dialog; auth dialog; open menu
(focus to its trigger); citation popover; selection actions; the focused
inline composer (closes it); API key form, then key-removal confirm. The
stacks the UI can produce are an info dialog with one dialog over it (About
editor, moderation log, member list or channel invite dialog), and the
remove or delete dialog over the feed. Base UI handles its nested dialogs, menus and popovers;
selection actions, inline composers and the key form register in
`stores/overlays` (`OVERLAY_PRIORITY` gains `selection`, `inlineComposer`,
`keyForm`) and are dispatched by `AppShell`'s capture handler (07 §4.4). Escape
in a composer with text closes it and keeps the draft. **W10.2** Acceptance: a
test opens the info dialog, then the About editor over it, and presses Escape
twice: the first press closes the editor (focus on Edit), the second the info
dialog (focus on the header's info button); a second test does the same with
the moderation log (focus on "Moderation log", then the info button); a third
opens the remove dialog from a card's "…" menu and checks one press closes it
with focus on that "…" button; a fourth opens an inline composer with a
selection popover and an open menu elsewhere and checks three presses close
the menu, the selection actions and the composer in that order.

### 10.3 Reduced motion

Under `prefers-reduced-motion` or `data-reduce-motion` (08 §7): no bar
`transform` transition (it hides and shows at once), no card fade (`pvFade`),
no notification flash transition, no dialog entrance, instant
scripted scrolls (`scrollIntoPadded`, strip chip centring, `?t=` scroll to a
row, passage count buttons), and a static dot in place of the status pulse
("Step N of 4" carries progress). **W10.3** Acceptance: Playwright with
`reducedMotion: 'reduce'` reads computed `transition-duration` (0s) on the bar
and card and `animation-name` (`none`) on the status dot, and checks that
`scrollTop` reaches its target in the same frame after opening a composer.

## 11. Styling and dark mode tokens

`tokens.css` stays the token source (08 §1). The mock's roles map to existing
tokens; only these are added, each with a dark value and a light override in
both colour themes and exposed through `@theme inline`: `--unread-dot` (the
account avatar's dot and the notification rows' dot),
`--passage-mark` (mock:
light `rgba(60,40,20,.06)`, dark `rgba(255,255,255,.07)`), `--avatar-1`…
`--avatar-6` and `--avatar-fg`, `--tree-rail`, `--tree-rail-on`,
`--tree-dot-selected`, and meter tones where status tokens do not fit.
Typography follows the mockup (decision P22): Inter for the client's text,
title 16.5 px and composer input 15 px as `--fs-title` and `--fs-input`;
the app's font setting is not offered at launch (there is no Settings
entry, P23). 08 §6.5's DM Sans half-pixel offset no longer applies to these
sizes; 08 gets a note.

**W11.1 Tokens.** Acceptance: 08 §6 contract tests pass (light override per
dark token, no colour literals in components or built CSS); visual baselines
in the four theme × appearance combinations.

**W11.2 Contrast.** A unit test resolves token values from `tokens.css` for
each of the four theme × appearance combinations and checks: body, title,
footer meta, site footer, tree-row and chip text against `--workspace-bg`, `--content-card-bg`
and `--popover-bg`, and against `--passage-mark` and the `qsel` tint
composited over the workspace background, at least 4.5:1;
tree rail, dots, the hollow title node, the ring arc and track, the Saved pill
and layout toggle borders, the app bar's bottom divider, the avatar fill against `--avatar-fg`, and `--focus-ring`, at least
3:1 against their background; disabled controls are exempt. Acceptance: the
test passes in CI and names the failing pair when it does not.

## 12. Testing

### 12.1 Unit and component

AVA, jsdom and Testing Library under `packages/client/test/`, on the fixture
replica: `lookPhrase`, `railGeometry`, `placePins`, `useBarAutoHide`,
count and footer-meta formatting, notification text, the site
footer address, viewer fields, scope lists, invite-code parsing, run states,
focus table, Escape stack, contrast pairs, one-composer rule, write rollback,
stream gaps, "Not sent" states, the upgrade reload timer, client id
storage, and each screen's viewer states. Tests of the deleted features go
with them (12 §3.5).

### 12.2 End-to-end (`web/e2e`)

Real server with fixture providers, one login per spec (12 §3.6). These names
are the ones 04 and 05 use; each spec gains steps in the milestone that
delivers them.

| Spec (`web/e2e/`) | Milestone | Drives |
|---|---|---|
| `spaces-shell.spec.ts` | M4 | scope, strip (including on Notifications and Site Admin), bar hide without layout shift, bar alignment per layout and width band, layout toggle, narrow widths, the strip folded into the scope menu at 400 px (W2.5), the site footer (W2.7) on feeds and pages, signed in and out |
| `spaces-feed.spec.ts` | M4, M5a | post, save and the Saved count, the footer meta and no model or effort text, a second context seeing a post without a reload, delete, the removed placeholder; the web's in-flight-only outbox (Not sent, Retry, nothing kept after a reload); from M5a, an ask streaming with a reload mid-stream, the queue-full refusal |
| `spaces-replies.spec.ts` | M4 | reply trees, Reply at root, mentions and the mention toast |
| `spaces-signed-out.spec.ts` | M4 | signed-out reading of a thread, its branches and replies (§9.5); write controls open the auth dialog |
| `spaces-keyboard.spec.ts` | M4 | §10 focus order, Escape order, reduced motion |
| `spaces-channels.spec.ts` | M4, M6 | join, leave, New channel, About (M4); channel invite links, removal with reason, the moderation log, ban (M6; 04 B3, B4, §6.6) |
| `spaces-notifications.spec.ts` | M6 | each notification kind of 01 C16 reaches its recipient, the unread dot, Mark all as read, a row opening the thread in its feed with the item selected and the bar shown (§2.1, W2.6) |
| `spaces-branches.spec.ts` | M5a | follow-up, Continue, Branch, Branch here, Look up, Comment, dot alignment |
| `spaces-runs.spec.ts` | M5a | run states and run notes, Stop and Run again (05 M5a) |
| `spaces-usage.spec.ts` | M5b | usage page, keys with the check during the request (Checking…, Valid, both refusals), billing setting, out-of-tokens refusal |
| `spaces-membership.spec.ts` | M6 | account invite links and codes, waiting accounts, the invite tree (04 I4) |

`visual.spec.ts` is rewritten for Home in `centred` and `wide` at 1440 and
1100 px, a channel at 800 px, an open branch card, the stacked dialogs, Usage,
Invites and the auth dialog. `admin.spec.ts` stays and gains the Site Admin
settings (W8.2): a site admin changes the default model and the default
effort (with the two toasts), a key-only model is not listed, and a
member's composer starts on both after a reload. The `library`, `research`,
`collaboration`, `live` and `widgets` specs are deleted.

### 12.3 Desktop (removed: web-only build)

No desktop client, so no macOS checklist. The browser specs of §12.2 are the
whole end-to-end suite.

## 13. Dependencies on the server and sync work

| Id | Needs | Provided by |
|---|---|---|
| N1 | `@session/sync` client half (replica, outbox, rebase, reactive queries, the memory adapter), `register` re-attaching a stored client id, the recorded `queue_full` refusal, and `@session/mutators` | 01 Y2, Y3, Y9-Y12, U1-U5 |
| N2 | Signed-out and unjoined reading of open channels | 01 Y5, R5; 04 §3.5 |
| N3 | Passage index on ask nodes (block index of the quoted passage, absent for footer asks), over a block structure that is the same for streamed and final text | 01 C3, 03 §1 (`b`) |
| N4 | Counts record `{ th, s, saves, r }` with totals; no likes | 01 C1, C5 |
| N5 | `vis: open \| private`, the roles `owner` and `member`, `frozen`, the All directory | 01 C7, C9, C11, C18; 04 §4 |
| N6 | Comments on ask nodes; look-ups through `research.forkNode` with `look` and a server-built `q` | 01 C3, C4, U5; 03 §2.1, G2-G4 |
| N7 | Account invites, waiting accounts, `members.tree` (online-only) | 01 C8; 04 §3 |
| N8 | Placeholder fields `mod`, `modBy`, `modNote`; `modlog` with ban entries | 01 C12; 04 §6.5 |
| N9 | Run records, `step`, failure reasons, the stop `note`, stream deltas and `/live`, cancel and retry, the queued-run limit | 03 §1, E3, E5, G6, L1, T1-T3; 01 Y7 |
| N10 | `usage.*`, `apiKeys.*` with the key check during `apiKeys.set`, model registry with payers and efforts, `models.list` and `admin.models.*` (default model and default effort) | 03 K4-K8, K11, K12, K15 |
| N11 | GitHub and X sign-in with the profile step, `auth.checkInvite` | 04 §1, §3.4, Z2 |
| N12 | Stored answer and stream format: both Markdown | 01 C3; 03 §1 |
| N13 | `prefs` record and `prefs.set` | 01 C13 |
| N14 | Member list, ban, unban, remove and channel invite link mutators | 04 §4.3, §5, §6.4 |
| N15 | Notification records (`mention`, `reply`, `branch`, `comment`, `removed`, `invite_used`) and `notifications.markRead` and `notifications.markAllRead`, for W2.6 | 01 C16, U5; 04 O2, I4 |
| N16 | The confirmation of a post, reply or comment lists the mentioned handles that were notified and the handles that are not members, for the mention toast (§4.3) | 01 C16, U5 (requested here) |

Shell, feed, side column, composer and dialogs are built against the fixture
replica (§9.6) and do not wait on N1-N16.

## 14. Open questions

1. **Passage index.** Settled: 01 C3 and 03 §1 store `b` on the node, sent
   in `research.forkNode` input (N3).
2. **Stop.** Settled (03 G6, 05 M5a): the mock has no Stop control; §3.3
   places it beside the run status, for the asker only.
3. **Thread addresses.** Decided (P9): `/c/$name?t=&sel=` opens the thread in
   its channel feed scrolled into view; a thread outside the loaded feed is
   fetched and inserted (§2.1).
4. **Removal placeholder author.** Decided (P5): "[deleted]" (04 §6.2).
5. **Notifications inbox.** Decided (P10): a notifications page in the
   account menu and an unread dot on the account avatar (W2.6); no push
   notifications.
6. **Widgets and artifacts.** Decided (P21): not rendered; answers are plain
   Markdown.
7. **Typography.** Decided (P22): as in the mockup (§11).
8. **Settings.** Decided (P23): a Settings entry only once there are
   settings beyond Usage; none at launch.
9. **Effort.** Decided (P13, 03 K12): the submenu lists the efforts of the
   chosen model with no Default item (§5); effort is not capped on included
   tokens and no cost estimate is shown; the per-run token cap (03 L1) bounds
   a single run.
