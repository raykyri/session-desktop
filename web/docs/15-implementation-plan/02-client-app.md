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
`03-agents-and-research.md`; §13 names what this file needs from them.

"The mock" below means the members mockup's behaviour as read from its source;
function names are given in parentheses. Exact user-facing copy is taken from
those functions unless an item says otherwise.

## 1. Package layout

`AGENTS.md` replaces the web client's trees and workspaces with spaces and drops
existing web data. The client keeps its build, design-system layer and Markdown
pipeline, and replaces every feature that reads research trees, workspaces,
folders or the TanStack Query research cache.

| Path in `packages/client/src` | Fate |
|---|---|
| `main.tsx`, `app/providers.tsx`, `app/ThemeEffects.tsx`, `app/RouteBoundary.tsx` | Kept; providers gain `ReplicaProvider`; `QueryClientProvider` stays for online-only calls (ADR-20) |
| `app/router.tsx`, `app/SessionBoot.tsx`, `app/layout/AppShell.tsx` | Rewritten; `app/layout/Sidebar.tsx` deleted (no sidebar) |
| `api/trpc.ts` | Kept for online-only procedures (auth, usage, API keys, settings, invite codes) |
| `api/api.ts`, `cache.ts`, `events.ts`, `queries.ts` | Deleted; replaced by `replica/` (§9) |
| `stores/settings`, `overlays`, `notifications`, `connection`, `localAccount`, `lightboxes` | Kept |
| `stores/navigation`, `drafts` | Rewritten (§9.4) |
| `stores/liveTurns`, `recapPending`, `homeFocus` | Deleted; `replica/runStream.ts` replaces `liveTurns` (ADR-22) |
| `features/markdown` | Kept; gains citation and passage plugins (§4.4) |
| `features/home`, `sidebar`, `thread`, `drafts`, `highlights`, `import`, `journal`, `research`, `sharing`, `palette`, `notifications`, `account`, `widgets` | Deleted at cutover (`widgets` and `notifications` pending open questions 6, 7) |
| `ui/*` | Kept; new `RoundButton`, `SplitButton`, `TreeRail` |
| `styles/tokens.css`, `fonts.css`, `prose.css`, `app.css` | Kept, extended (§11); `feed.css`, `tweet.css` deleted |

New code:

```
src/replica/              ReplicaProvider, adapters/, queries.ts, writes.ts, viewer.ts, runStream.ts, fixtureReplica.ts
src/features/shell/       AppBar, ScopePicker, ChannelStrip, UsageRing, SavedButton, LayoutToggle, AccountMenu, useBarAutoHide
src/features/feed/        FeedPage, FeedRow, ThreadCard, TitleRow, Byline, AnswerProse, CardFooter, RemovedCard, BranchedFrom
src/features/branches/    BranchTree, BranchCard, BranchActions, BranchComments, SelectionActions, lookPhrase.ts, geometry.ts
src/features/replies/     ReplyTree, ReplyCard
src/features/composer/    NewThreadComposer, InlineComposer, SendSplitButton, ChannelPicker, ModelPicker
src/features/channels/    ChannelHeader, ChannelInfoDialog, AboutEditorDialog, ModerationLogDialog, RemoveDialog, ReportDialog, NewChannelDialog, BrowsePage
src/features/membership/  MembersPage, InviteTree, InviteLinks, AuthDialog, InviteRequiredPage
src/features/usage/       UsagePage, RecentRuns, OutOfTokensChoice, ApiKeys
```

**W1.1 Remove the research client.** Acceptance: `npm run check` passes;
`rg "research\.|workspaces\.|folders\." packages/client/src` finds no procedure
calls; the build contains no `tweet.css` or `feed.css` rules.

**W1.2 One web/desktop seam.** `lib/platform.ts` exposes `isDesktop` and the
storage adapter choice. Acceptance: an ESLint `no-restricted-imports` rule
limits `@tauri-apps/*` to `replica/adapters/` and `lib/platform.ts`.

## 2. App shell

### 2.1 Routes

| Path | Screen |
|---|---|
| `/` | Home feed: threads of joined channels |
| `/c/$name` | Channel feed with channel header |
| `/saved` | Saved threads |
| `/browse` | Browse channels |
| `/invites` | Invite tree and invite links (`membersPage`) |
| `/usage` | Usage and API keys |
| `/welcome` | Invite required (`statusPage`) |
| `/i/$code` | Opens the auth dialog in its invite-link flow over `/` |
| `/settings`, `/admin` | Kept from the current client, restyled |

Feed routes take `?t=<threadId>&sel=<nodeId>`: the feed scrolls to that row and
selects that branch (the mock's `gothread`, `gofrom`). The mock has no
single-thread page (open question 4).

**W2.1 Route tree.** Rewrite `app/router.tsx` with zod-validated search params
and a guard sending a signed-in account without an invite from `/invites` and
`/usage` to `/welcome`. Acceptance: router unit test per path, the guard, and
that malformed `sel` values are dropped.

### 2.2 App bar

Left to right (`appbar`):

1. **Name as home button** (`brandBtn`): agent mark and "Session"; goes to `/`.
2. **Scope picker** (`headerSpaces`, `SCOPES`, `SCOPE_IC`): a menu button with
   `menuitemradio` items Joined (check-circle icon), Channels you manage (person
   icon; only for accounts that can write) and All (compass icon). The scope
   chooses which channels the strip lists; Home always shows joined channels.
3. **Channel strip**: horizontally scrolling `#name` chips with `aria-current`
   on the current one, a join "+" on unjoined chips under All, a trailing New
   channel button for writers, and an empty line. No scrollbar; a mask fades
   40 px at an edge only while content is hidden past it (`--fl`, `--fr`). The
   current chip is scrolled to the centre when it lies within 40 px of an edge.
4. **Usage ring with track** (`meter`): "Nk left", a fill track, and an 18 px
   ring arc over a full-circle track; tone `ok` below 80 % used, `warn` from
   80 %, `bad` from 95 %; the `aria-label` states tokens left and time to reset.
   Below 860 px only the ring shows. Opens `/usage`.
5. **Saved round button with count** (`savedBtn` variant `e`): a 28 px pill,
   bookmark filled when the count is above zero, no number at zero,
   `aria-pressed` on `/saved`.
6. **Layout toggle round button** (`layoutBtn`): switches layout A/B (§3.1); its
   icon shows the target layout; feed routes only.
7. **Account menu**: header with name, `@handle` and role; Invites, Saved,
   Usage and API keys, Sign out. Without an invite: Enter an invite code, Sign
   out.

Items 4-7 are hidden for accounts without an invite except the account menu.
**Signed out** (`appbarOut`): name, strip of open channels with no scope picker
(Joined would equal All), "Join with invite" and "Sign in".

**W2.2 `AppBar` and parts** in `features/shell/` on `ui/Menu` and
`ui/RoundButton`. Acceptance: component tests per viewer state (signed out, no
invite, member, channel owner) for which controls render, the list per scope,
ring tone at 79.9/80/94.9/95 %, no zero counts, fade variables 0 when the strip
does not overflow.

**W2.3 Bar hides on scroll.** `useBarAutoHide(scrollEl)`: shown within 48 px of
the top; past that a downward step over 4 px hides it and an upward step over
4 px shows it, the reference position moving only on such steps. It stays shown
while one of its menus is open and on non-feed screens. Hiding animates
`margin-top` over 0.2 s (none under reduced motion); the hidden bar is `inert`.
Acceptance: reducer unit test over scroll sequences; Playwright reads the bar's
box after wheel 400 px down and 50 px up.

**W2.4 Full window, no fullscreen.** The mock's Fullscreen button, window frame
(`.frame`) and `fs-exit` are scaffolding. The shell fills the viewport or
window, with one scroll container below the bar. On macOS desktop the bar's
empty areas are the Tauri drag region and it reserves the traffic-light inset
under an overlay title bar. Acceptance: no `requestFullscreen` in the client;
desktop smoke check drags the window by the bar.

**W2.5 Phone width.** ≤ 520 px: brand word hidden, composer controls wrap to a
second row under the text (`ncw`), menus right-anchored and capped at
`100vw - 40px`, the Effort submenu inline. ≤ 860 px: feed rows, Invites and
Usage stack to one column. Acceptance: Playwright at 360×740 and 390×844 asserts
`scrollWidth <= innerWidth` on every route and that the send button is visible.

## 3. Feed

### 3.1 Rows and layouts

Each thread is a row `[card | side column]` under, in order, the no-invite
banner, the channel header, the composer and the empty state (`renderNetwork`).

- **Layout A**: ≥ 1321 px a grid `1fr | 600px | 1fr`, card in the middle, side
  column in the right track capped at 330 px, channel header spanning both;
  861-1320 px a centred `600px | 330px` pair.
- **Layout B**: ≥ 861 px a centred `720px | 300px` pair.
- ≤ 860 px: one column, side column after the card with a 12 px inset.

Layout is per device in `navigation`, default A. Empty states: Saved, Home (with
Browse channels link), empty channel, and a closed channel the viewer is not in.

**W3.1 `FeedPage`, `FeedRow`.** Grid utilities keyed on `data-layout`; rows
virtualised with `@tanstack/react-virtual` past 60 rows, measured after the side
column lays out. Acceptance: visual baselines (§12.2); a test per empty state.

### 3.2 Card

- **Title row** (`titleRow`): 11 px hollow node centred on the first line; the
  title in regular weight at the title size (16.5 px in the mock); on the right
  the author's 20 px avatar with tooltip "handle · 3h"; a post shows its channel
  before the avatar; then the "…" menu. An ask's title is the question as typed.
- **Branched from** (`fromln`): on a thread opened from a branch, a link to the
  source row with that branch selected.
- **Byline** (asks): agent mark with tooltip "model · effort" (device runs add
  their label, 03), then "N sources · Nk tokens · #channel", omitting empty
  parts.
- **Answer prose** (§4.4).
- **Footer**: follow-up button (reply-arrow icon) with the branch count for an
  ask, Reply with the reply count for a post, then Save with the save count. A
  zero count is not drawn. No likes anywhere.
- **"…" menu**: own thread, Delete (disabled with "Not available once someone
  else has responded" or "Available when the answer finishes"); another
  member's thread in a channel the viewer moderates, Remove…; otherwise Report…
  for writers.
- **Pending run**: "Researching · Step N of 4" with a pulsing dot; follow-up
  button hidden, selection actions and Delete off; streamed text replaces the
  status (ADR-22); a failed run shows its reason and, for the asker, Run again.
- **Removed thread** (`card.removed`): "Removed by @mod", optional reason,
  "Ask by @u in #channel"; no prose, footer or side column.

Signed out, Reply and Save open sign-in and focus returns to the control on
close; without an invite they are disabled with "… opens once you have an
invite".

**W3.2 `ThreadCard` and parts.** Acceptance: tests for no zero counts, no like
control, byline omissions, Delete eligibility, Remove vs Report by role, the
removed placeholder, and the pending state.

## 4. Side column

### 4.1 Branch tree

Each passage with branches has its own tree in the side column, placed at the
passage's height and pushed down 12 px past the tree above (`pinGroups`,
`place`); ≤ 860 px they stack in reading order. Rows (`outline`):

- depth-first, indented 13 px per level, the question as typed on one line;
- a look-up branch shows a magnifier and its phrase, never its prompt;
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
(Open as its own thread; Delete branch with the thread rules plus "Not available
after it was opened as a thread"); a "Look up <phrase>" header or the quoted
passage clipped at 180 characters; status while pending; prose scrolling within
260 px; actions (`branchActs`) Comment (speech bubble, left, `aria-pressed`; runs
nothing), Continue (down arrow; asks under this answer) and Branch (down-right
arrow; asks beside it, at the parent); "Open thread" instead when promoted; then
comments (`branchReplies`): "N comments", nested 14 px per level up to 3, each
with Reply / Close reply.

The card fades in (0.25 s, 3 px rise) only when the item it shows changes, not on
re-renders from opening a composer, toggling Comment or a count change
(`pvFade`): the fade is keyed on `(threadId, itemKey)` in a ref.

**W4.2 `BranchCard`, `BranchActions`, `BranchComments`.** Acceptance: Continue
opens the composer with parent = node, placeholder "Continue ask"; Branch with
parent = node's parent, "Ask beside this"; Comment ("Comment here") replaces an
open ask composer on that thread and the reverse; fade applied once per change.

### 4.3 Reply trees on posts

A post's side column is sticky (top 58 px, own scroll) and holds a reply tree on
the same rail (`replyLines`): avatar and one line of text per row, "+N" on a
collapsed reply. A selected row shows a card with Delete in "…", `>` quotes and
member `@mentions`, and a Reply / Close reply text button; below the tree "Reply
at root" (signed out "Sign in to reply"). The footer's Reply opens the root
composer and scrolls to it (§4.5).

**W4.3 `ReplyTree`, `ReplyCard`.** Acceptance: formatting tests (quotes,
mentions of members only), collapse counts, Reply toggling, focus into the
opened composer.

### 4.4 Answer text: citations, passages, selection

- **Citations** (`citeReady`, `citeOpen`): each superscript is a button
  "Source N" opening a popover with title, note and host link, and is wrapped
  with its preceding word in a `nowrap` span so it never starts a line alone.
  Built as `rehypeCitations` in `features/markdown`, not by DOM mutation.
- **Passages**: `rehypePassages` gives each top-level block a `data-passage`
  index. Passages with branches get the passage shade with 6 px side bleed; the
  passage an open composer quotes gets the accent tint (`qsel`). The mock's
  word-overlap matching (`groupsFor`, `bestBlock`) does not ship; branches carry
  their passage (D3).
- **Selection actions**: a selection of 3+ characters inside one finished
  answer, for a writer, shows Look up (magnifier) above Branch here, 8 px below
  the selection, equal width, right-aligned to a one-line selection and
  left-aligned otherwise, kept 8 px inside the viewport, removed on scroll. Look
  up shows only for 1-4 whole words (`lookPhrase`: no boundary inside a
  `\p{L}\p{N}` run; edge punctuation trimmed). Branch here opens the thread's
  composer with the selection as quote ("Ask about this passage"; long quotes
  clipped with Show all). Look up creates a look-up branch at once, labelled by
  the phrase with a prompt built by 03, and selects it.

**W4.4 Plugins and `SelectionActions`.** `lookPhrase` moves unchanged to
`features/branches/lookPhrase.ts`. The popover also listens to
`selectionchange` (debounced 120 ms) so keyboard selections work, and registers
in `stores/overlays`. Acceptance: `lookPhrase` table (1, 4, 5 words; partial
word at either end; punctuation; non-Latin letters); a citation shares a nowrap
span with its word; Playwright selects two words, clicks Look up, and the new
row shows the phrase, not the prompt.

### 4.5 Scrolling to a composer

Opening a composer outside the visible area scrolls it in with 24 px below and
60 px above, smoothly or instantly under reduced motion, and focuses it with
`preventScroll` (`focusGlide`). **W4.5** `scrollIntoPadded` in `lib/motion.ts`.
Acceptance: offset unit test; Playwright checks the composer is fully visible
after clicking a footer button near the viewport bottom.

## 5. Composer

The new-thread composer is the mock's `COMPOSERS.split` with `nb-a`:

- a hollow tree node at its start, aligned with the card nodes below; the
  growing text field ("Ask anything" / "Write a post"; 15 px), controls held on
  the last line;
- channel picker on Home and Saved (joined channels, `menuitemradio`); on a
  channel route the name as static text;
- model picker for asks: short names, full names in the menu from the server's
  model list, a model needing a missing key shows "Add a key" linking to
  `/usage`, Effort submenu (Low, Medium, High, Max);
- split send button: main part Ask (arrow) or Post (pencil), disabled while
  empty; the arrow part opens Ask / Post with icons, descriptions and a check;
- ⌘↵ (Ctrl↵ elsewhere) sends, Enter is a newline; a pointer-down on the
  composer outside a control keeps the caret in the field;
- signed out: a disabled `fieldset` at 60 % opacity with a cover button "Sign in
  to ask or post"; no invite, or a channel not joined: not rendered;
- out of included tokens with no usable key (`outOfTokens`): Ask is refused
  before sending with the mock's toast (weekday from the server's reset time);
  Post still sends.

Inline composers (asks on a thread, comments, replies) are one `InlineComposer`
with a text submit ("Ask", "Comment", "Reply") and optional close button.

**W5.1** Replace `features/composer/*` (`ResearchQueryComposer`, `AskNoteSwitch`
deleted). Drafts persist per composer key in `stores/drafts`. Acceptance: tests
for mode switching (icon, label, placeholder, model picker hidden for Post), the
empty-text state, the signed-out cover, out-of-tokens refusal for Ask only,
draft restore across routes, focus back to the field after a menu choice.

## 6. Channels

**W6.1 Channel header** (`spaceHead`): glyph, `#name`, lock for closed channels,
description clipped at 170 characters, info button, and one of: "Your channel"
chip, "Joined" (leaves), "Members only" chip, Join. Acceptance: a test per
viewer relation; join and leave are optimistic writes (§9.2).

**W6.2 Info dialog** (`chInfoDlg`): full description (owner without one sees
"Add one"), Channel by, Members, Visibility; owners get Edit and "Moderation log
(N open)". Acceptance: content per role; focus and Escape per §10.

**W6.3 About editor** (`chEditDlg`): a dialog stacked over the info dialog with
its own scrim; About textarea with a live "N / 300" counter and length error;
Cancel, Save (`spaces.update`); toast "Channel updated."; owners edit only About.
Acceptance: nested Base UI dialog; Escape closes only the editor.

**W6.4 Moderation log** (`modLogDlg`): stacked over the info dialog; tabs "Open
reports (N)" and "Everything"; entries with kind, actor, target, quoted title,
optional reason and time; open reports on live threads offer Dismiss
(`reports.resolve`) and Remove (W6.5). Acceptance: renders from report and
removal records (D8); empty states.

**W6.5 Remove and report dialogs** (`rmDlg`): optional reason; remove explains
that branches and replies go with the thread; report names the channel owner
and says the author is not told who reported. Writes `moderation.decide` and
`reports.create`. Acceptance: the removed placeholder appears optimistically;
the thread's open reports show as resolved.

**W6.6 Browse page** (`browsePage`): search over name and description; cards
with glyph, `#name`, lock, "by @owner · N members", description clipped at 120,
Yours / Joined / Join. Lists open channels and closed channels the viewer is in.
Acceptance: filter test; Join from a card stays on Browse.

**W6.7 New channel dialog** (`newSpaceDlg`): name with `#` prefix checked
against `^[a-z0-9][a-z0-9-]{1,29}$`, "What is it for?", Open / Private radios.
Creating a space is online-only (`AGENTS.md`): busy state until the server
answers; CONFLICT shows "#name already exists."; success navigates to
`/c/$name` with the mock's toast. Acceptance: validation tests; offline keeps the
dialog open with an error.

## 7. Membership and sign-in

**W7.1 Invites page** (`membersPage`). Invite tree (`treeA`): the mock's
explanation of 3 open links, rows from the root account in join order, 18 px
per level, avatar, handle, role suffix and name, the viewer highlighted, drawn
with `TreeRail`. "Invite someone" (`invSection`): "N of 3 left", one row per
open link with Copy and revoke ×, a create button while a slot is free
(otherwise the reason), "You invited" with join dates. Codes come from the
server. Acceptance: tree order and depth from fixtures; no create button at 3
open links; Copy through `lib/clipboard.ts`.

**W7.2 Auth dialog** (`authScreen`): modal with a focus trap, opened from Sign
in, Join with invite, a signed-out write control, or `/i/$code`. Flows: landing;
valid invite link ("<Name> invited you to Session"); dead link; code step "Join
with invite?" accepting a code or a full link (last path segment, upper-cased)
with the mock's four error messages and "Invite from <Name>" on success;
provider explainer; no account for this identity (enter a code, or continue
without one); create account (name, handle 3-20 of `[a-z0-9._]`, rules
checkbox). Focus moves to the first field or the step heading on each step and
returns to the opener on close. Acceptance: a test per flow on a fake auth
procedure; code parser test for `SESS-9TQ2-X8` and
`https://session.app/i/SESS-9TQ2-X8/`.

**W7.3 Invite required** (`statusPage`, `/welcome`): the redeem form, the
three-item checklist, Browse the network; on success the toast "You're in.
<Name> invited you." and `/`. The feed banner for accounts without an invite
links here. Acceptance: redeem success and errors; banner only for signed-in
accounts without an invite.

## 8. Usage and API keys

**W8.1 Usage page** (`usagePage`): "You have N% of usage left this week. Next
reset on Fri, in 2d 5h." with a bar in the ring's tones; Recent runs (question
clipped at 90, share of the weekly allowance or bill label, date); "When
included tokens run out": Pause / Continue on my Anthropic key (disabled without
a valid Anthropic key, with the reason); API keys per provider: masked key,
Valid / Checking… chip, Remove with inline confirm, or "Not set" with Add key
(password field). All online-only (ADR-19), read through TanStack Query; the
bar's ring reads the same query (30 s stale time) and refetches when one of the
viewer's runs finishes. Acceptance: tone thresholds, disabled key radio, key
add/remove, the model picker dropping a model whose key was removed.

## 9. Client state

### 9.1 Replica and queries

`ReplicaProvider` creates the `@session/sync` client with a memory adapter on
the web (no IndexedDB) and SQLite through Tauri on the desktop. Screens read
named reactive queries from `replica/queries.ts`:

| Hook | Screens | Reads |
|---|---|---|
| `useMe()` | all | user, invite status, roles (user log) |
| `useChannels(scope)` | strip, Browse, channel picker | spaces, memberships, roles |
| `useChannel(name)` | header, info dialog | space, owner, member count |
| `useFeed({kind, id?})` | feed | threads of joined channels / one channel / saved set, newest first; summaries outside the window |
| `useThreadCounts(id)` | footer | counts record |
| `useAskTree(id)` | branch trees and cards | nodes, answers, passage anchors, look-up labels |
| `useBranchComments(id, node)` | branch card | comments on a node |
| `useReplies(id)` | reply tree | replies |
| `useRun(id, node)` | pending states | run record plus the stream buffer |
| `useSources(id)` | byline, citation popover | cited pages |
| `useModerationLog(space)` | moderation log | reports, removals |
| `useInvites()` | invites page | invite links, invite tree (or online-only, D7) |

A summary-only thread renders title, byline and counts; opening its side column
requests the full record.

**W9.1 `replica/`.** Acceptance: on the fixture replica, a write to thread A
does not re-render thread B's row (render counter); a query the replica cannot
answer yields `unknown` and a loading row, not an empty state.

### 9.2 Writes from the outbox

`replica/writes.ts` wraps the mutators the screens call: `threads.create`,
`threads.delete`, `followups.ask` (follow-up, Continue, Branch, Branch here,
Look up), `research.createPostFollowUp`, branch comments (D6), `saved.set`,
`spaces.join`, `spaces.leave`, `spaces.update`, `reports.create`,
`reports.resolve`, `moderation.decide`, Open as its own thread
(`threads.create` with `from`), `research.cancelNode`, `research.retryNode`.
Each makes its ULIDs, applies the prediction to the replica and enqueues the
envelope.

- Unconfirmed writes render as final, without spinners.
- A refusal rolls the prediction back and shows a toast for the error code
  (STALE, FORBIDDEN, CONFLICT, …); typed text returns to its composer.
- Web: the outbox holds a write only while its request is in flight; a network
  failure marks the item "Not sent" with Retry (same mutation id) and Discard.
- Desktop: writes are kept 3 days in server time; one that failed 5 times or was
  dropped is listed with its text in a "Not sent" toast while the outbox
  continues (`AGENTS.md`).
- Online-only actions (new channel, invite links, keys, usage settings,
  sign-in) show a busy state and inline errors.

**W9.2** Acceptance: a fake server refusing a reply (rolled back, text
restored), answering STALE to a moderation decision (toast, record unchanged),
and dropping the web connection (Not sent; Retry reuses the mutation id).

### 9.3 Per-viewer fields

`replica/viewer.ts` computes `mine`, `saved`, `canWrite` (invite, not banned in
the space), `canModerate(space)`, `canDelete(item)` (mine, not pending, not
promoted, nothing by others under it), `showAuthorAvatar`, `joined(space)` and
the scope lists. Acceptance: table-driven unit tests per field.

### 9.4 UI state (Zustand)

`navigation` (localStorage: scope, layout, last channel; sessionStorage: scroll
anchors); `threadUi` (memory: per thread the selected branch or reply, the open
inline composer with kind, parent and quote, collapsed replies; one inline
composer per thread); `drafts` (sessionStorage, per account); `overlays`;
`runStream` (in-flight text keyed by run, attempt, seq; drops duplicates,
refetches on a gap, clears on the committed turn; ADR-22). **W9.3** Acceptance:
tests for the one-composer rule, stream gaps, and account change clearing
`threadUi` and `drafts`.

### 9.5 Signed-out reading

No user log and no outbox. Open channels are read through the public read path
01 defines (D2), into a read-only replica or TanStack Query pages depending on
its form. Acceptance: a signed-out Playwright spec reads a thread and its
branches; every write control opens sign-in.

### 9.6 Fixture replica

`replica/fixtureReplica.ts` loads `docs/mockups/session-web-spaces-fixtures.js`
into a replica running the real mutators with a fake clock and a scripted run
executor. It serves unit tests, `/dev/ui`, and screen work before the server
lands. Acceptance: no fixture strings in `vite build` output.

### 9.7 Mock behaviours and their real sources

| Mock | Real |
|---|---|
| `PROMPTS` replaces fixture text with typed text | stored `q` as sent |
| passage by word overlap (`groupsFor`) | stored passage anchor (D3) |
| `runOf` hashes the id to pick a model | `model`, effort, device label on the record |
| `likesBase` as save count; `T.count`, `replyCount` as totals | counts record with saves and total branches/replies, not `r` (D4) |
| `setTimeout` answers, `pending` | run records and stream (D9) |
| `charge`, `RUNLOG`, `USAGE`, `BILLING` | usage procedures (D10) |
| `SPACE_META` owner and `vis`, `JOINED` | space, member and role records (D5) |
| `MEMBERS`, `INVITES`, `newCode` | accounts and server-made invites (D7) |
| `BRP`, `n.look`, `n.quote` | comments, look-up phrase, quote on nodes (D6, D3) |
| `PROMOTED`, `from` | `promoted` on the node, `from` on the thread |
| `MODLOG`, `p.removed` | reports, removal records and tombstones (D8) |
| `mentionsIn` toast | server mention notifications; no client prediction |
| `render()` with focus restored by signature | React reconciliation and §10 focus rules |

### 9.8 Scaffolding that does not ship

The top bar (title, variant segment, Fullscreen, theme segment), the mock bar
(persona switcher, Layout A/B, Jump to, Tokens), the thesis line, the window
frame, hash and Ctrl+letter variant switching (`go`, `V`, `ORDER`), navigation
directions B-D (`navDropTop`, `navRail`, `navSidebar`, stars, unread dots),
unused composer and Saved variants, `previewVariant`, `renderMock`,
`X_ACCOUNTS`, and the `data-theme` switch (the app uses `data-appearance`).
Acceptance: a CI `rg` finds none of "View as", "Jump to", "Fullscreen" or the
variant names in `packages/client/src`.

## 10. Accessibility

### 10.1 Focus

| Layer | Initial focus | Returns to |
|---|---|---|
| Account and "…" menus | first enabled item (disabled items `aria-disabled`, skipped) | trigger |
| Scope, channel, model, send menus | menu items; composer menus keep the field as return target | trigger, or the text field |
| Info dialog | Close | info button |
| About editor | About field | Edit |
| Moderation log | Close | "Moderation log" link |
| Remove / report | reason field | the card's "…" button |
| Delete confirmation (`alertdialog`) | Cancel (the mock focuses Delete) | "…" button, or the next row if the item is gone |
| New channel | Name | opener, or the new channel's heading |
| Auth dialog | first field or step heading | opener |
| Inline composer, Escape | — | selected tree row, or the button that opened it |
| Citation popover | its link | the citation |

Route changes to Browse, Invites, Usage and Welcome focus the page heading.
Branch and reply trees are `role="tree"` with `treeitem` rows (`aria-level`,
`aria-selected`, `aria-expanded` on collapsible replies); Up/Down move, Left
goes to the parent, Right to the first child, Enter selects. Toasts are
`role="status"`. **W10.1** Acceptance: one test per table row; a keyboard-only
Playwright spec opens and closes every dialog and menu and checks
`document.activeElement`.

### 10.2 Escape order

Innermost first: delete confirmation; remove/report; About editor; moderation
log; info dialog; auth dialog; open menu; citation popover; selection popover;
the focused inline composer; API key form or key-removal confirm. Base UI
handles its nested layers; the rest register in `stores/overlays` with these
priorities and are dispatched by `AppShell`'s capture handler (07 §4.4).
**W10.2** Acceptance: a test stacks all layers and presses Escape repeatedly.

### 10.3 Reduced motion

Under `prefers-reduced-motion` or `data-reduce-motion`: no bar transition, no
card fade or dialog entrance, instant scripted scrolls, no status pulse.
**W10.3** Acceptance: Playwright with `reducedMotion: 'reduce'` reads computed
`transition-duration` and `animation-name`.

## 11. Styling and dark mode tokens

`tokens.css` stays the token source (08 §1). The mock's roles map to existing
tokens; only these are added, each with a dark value and a light override and
exposed through `@theme inline`: `--passage-mark` (mock: light
`rgba(60,40,20,.06)`, dark `rgba(255,255,255,.07)`), `--avatar-1`…`--avatar-6`
and `--avatar-fg`, `--tree-rail`, `--tree-rail-on`, `--tree-dot-selected`, and
meter tones where status tokens do not fit. Title and input sizes become
`--fs-title` and `--fs-input` with the DM Sans half-pixel offset. **W11.1**
Acceptance: 08 §6 contract tests pass (light override per dark token, no colour
literals in components or built CSS); visual baselines in both colour themes
and appearances.

## 12. Testing

### 12.1 Unit and component

AVA, jsdom and Testing Library under `packages/client/test/`, on the fixture
replica: `lookPhrase`, `railGeometry`, `placePins`, `useBarAutoHide`, count and
byline formatting, viewer fields, scope lists, invite-code parsing, focus table,
Escape stack, one-composer rule, write rollback, stream gaps, and each screen's
viewer states.

### 12.2 End-to-end (`web/e2e`)

Real server with fixture providers, one login per spec (12 §3.6):
`spaces-shell` (scope, strip, bar hide, Saved, layout, phone widths),
`spaces-feed` (ask and post, pending to answered, counts, save, delete,
removed), `spaces-branches` (follow-up, Continue, Branch, Branch here, Look up,
Comment, dot alignment), `spaces-replies`, `spaces-channels` (create, join,
info, About editor, report to removal), `spaces-membership` (link and code
flows, welcome, 3-link limit), `spaces-usage` (keys, out-of-tokens),
`spaces-keyboard` (§10), `spaces-signed-out`. `visual.spec.ts` is rewritten for Home in
A and B at 1440 and 1100 px, a channel at 800 px, an open branch card, the
stacked dialogs, Usage, Invites and the auth dialog. The `library`, `research`,
`collaboration`, `live` and `widgets` specs are deleted.

### 12.3 Desktop

A macOS smoke check (CI when available, documented manual step until then):
sign in with a device token, quit, relaunch offline, the feed renders from
SQLite, a reply queued offline sends on reconnect.

## 13. Dependencies on the server and sync work

| Id | Needs | From |
|---|---|---|
| D1 | `@session/sync` client half (reactive queries, memory and SQLite adapters) and `@session/mutators` for §9.2 | 01 |
| D2 | A read path for signed-out readers of open channels | 01, 04 |
| D3 | Passage anchor (block index, quote) on ask nodes, over a stable block structure | 01, 03 |
| D4 | Counts record with total branches/replies and saves; no thread likes | 01 |
| D5 | Mapping of Open / Private onto `vis` and `policy`; roles behind "Channels you manage" | 01, 04 |
| D6 | Comments on ask nodes; look-up nodes storing phrase apart from prompt | 01, 03 |
| D7 | Network invites (tree, 3 links, codes, redeem), replicated or online-only | 04 |
| D8 | Removal records with remover and reason; moderation log readable by owners | 01, 04 |
| D9 | Run stream events, run step, failure reasons, Run again | 03 |
| D10 | Usage, API keys, billing choice, model list with key needs and effort levels | 03 |
| D11 | Identity provider, account creation with handle, desktop device tokens | 04 |
| D12 | Answer format (Markdown or HTML) and sanitisation | 03 |

Shell, feed, side column, composer and dialogs are built against the fixture
replica (W9.6) and do not wait on D1-D12.

## 14. Open questions

1. **Identity provider.** The mock signs in with X; the server uses GitHub
   OAuth (`06-auth-and-users.md`). The auth flows depend on it (D11).
2. **Private channel membership.** The mock says the owner adds people to a
   private channel but has no screen for it; the Invites page is the network
   invite tree. A channel member list or channel invite links is needed.
3. **Branch comments.** Not in `spaces.ts`, which has replies on posts only (D6).
4. **Thread addresses.** Notifications and shared links need one; the plan uses
   `/c/$name?t=&sel=`, which needs a single-thread fallback for threads outside
   the loaded feed.
5. **Removal reason.** `AGENTS.md` erases removed content and keeps no text in
   tombstones; the mock shows the reason on the placeholder (D8).
6. **Notifications inbox.** The schema has notifications; the mock has none.
7. **Widgets and artifacts** in answers, which the current Markdown pipeline
   renders and the mock does not show.
8. **Typography.** The mock uses Inter; the client keeps the app's font setting
   and needs title and input sizes decided.
9. **Settings.** The account menu has no Settings entry for appearance, theme,
   reduced motion and the send shortcut.
10. **Channel moderators.** The mock treats only the owner as moderator; the
    schema has Owner, Admin and Moderator.
