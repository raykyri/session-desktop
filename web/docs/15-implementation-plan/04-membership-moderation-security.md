# 04 — Membership, moderation and security

Status: draft. This file covers who may join Session, how channels admit and
rank their members, how a channel's staff moderate it, what the server serves
to whom, and the limits and authentication the server applies. It schedules
work against the rules already fixed in `AGENTS.md` ("Planned: desktop client
and sync core"), ADR-19 to ADR-22 and `web/packages/shared/src/schemas/spaces.ts`,
and records where the members mockup (`docs/mockups/session-web-members.html`)
adds to them or disagrees with them. The server half, the change log and the
mutator stages are specified in `01-architecture-and-data.md`; runs, allowances
and device runs in `03-agents-and-research.md`. This file names the mutators,
records and checks it needs from them and does not redesign them.

Terms: "channel" is the product word; code and wire keep `space`. "Staff" of a
channel means its owner, admins and moderators (`RANK >= mod` in
`replica-proto/src/access.ts`).

## 1. Precedence and conflicts

The overview's order of authority applies. Where the mockup and the earlier
sources disagree, this plan decides as follows.

| Topic | Mockup | Decision | Reason |
|---|---|---|---|
| Sign-in provider | Sign in with X; Session handle chosen at sign-up | GitHub OAuth (`06-auth-and-users.md`, ADR-5). The handle step is kept. | ADR-5 is in force; the overview records no provider decision. X is an open question (§15). |
| Account without an invite | "Continue without one" creates a `waiting` account | No `users` row without a redeemed code; a pending sign-up record holds the GitHub identity (§3.4) | `06` §3 and `13` §2: an account is created only against a code. The reading experience the mockup shows is kept. |
| Moderators | `isMod` is the owner only | Owner, admins and moderators are staff, per `spaceMemberRoleSchema` and the phase 0 read rules | The schema and replica-proto define roles; the mockup collapsed them for brevity. The UI exposes owner, moderator and member (§4.3). |
| Hide | Not offered | Server keeps `hidden`; the client does not offer Hide at launch | The phase 0 rules and suites cover `hidden`; dropping it would fail them. |
| Ban | Not offered | Offered to staff | `AGENTS.md`: in open spaces a removal is STALE after leave and rejoin, "the UI offers ban as the tool there". |
| Report reason | One optional free-text field | `reports.create.why` becomes optional; the free text goes in `note` | Overview: "both with an optional reason". Contract change, listed in §11. |
| Removal reason | Free text shown on the placeholder | Added as `reason` on the moderation record, never on the erased content | Overview product decision; the erasure rule is unchanged. |
| Moderation log excerpt | Shows the clipped title of a removed thread | No excerpt for removed items | `AGENTS.md`: removed content is erased and never served again. |
| Channel rules | Removed | Client never sends `rules`; server stores none for new channels | Overview product decision. `rules` stays optional in the schema so replica-proto's suites keep passing. |
| Private channel admission | "Ask @owner to add you"; no add flow drawn | Staff-made one-use channel invite links (`invites.create`) | The contract and replica-proto already define them (`inv2`: links work only while the maker may make them). |
| Join requests | Absent | Kept in the contract and mutators, not exposed in the client | replica-proto's suites exercise `joinRequests.*`; private channels use `policy: "invite"`. |

## 2. Two kinds of invitation

The mockup uses one word for two mechanisms. They are separate records with
separate limits.

1. **Account invites** admit a person to Session. Each active member holds at
   most 3 open links; redeeming one creates the account and records the
   inviter. These are the existing sign-up codes (`invites`, `users.invited_by`
   in `02-domain-model-and-database.md` §3.1), extended. They are online-only
   account calls (ADR-19: "Online-only account calls ... stay tRPC
   procedures"), not replicated records.
2. **Channel invite links** admit an existing account to a private channel.
   They are the replicated `links` records (`threadInviteSchema`) made by
   `invites.create` and consumed by `spaces.join { invite }`. They do not count
   against the 3 account-invite slots.

## 3. Account invites and access to Session

### 3.1 Records

Work items, in `web/packages/db` (schema and migration) and
`web/packages/server` (procedures):

- Extend `invites` with `id` (ULID), `revoked_at`, `expires_at` (null at
  launch) and keep `code`, `created_by`, `created_at`, `used_by`, `used_at`.
  Store `code_hash` (SHA-256), not the code. Whether the creator can see a
  code again after creation is §15 question 4.
- `users.invited_by` is the tree edge. `users.invites_remaining` is replaced by
  the open-slot rule and dropped in the reset migration (`05-delivery.md`, M8).
- Add `users.handle` (unique, `^[a-z0-9._]{3,20}$`, chosen at sign-up, the
  mockup's rule) and `users.display_name`. `spaceHandleSchema` values are these
  handles. A handle is never reused after account deletion (same rule as ids).

Acceptance: `packages/db/test/invites.test.ts` covers the hash lookup, single
use under two concurrent redemptions (one succeeds, one gets `CONFLICT`), and
handle uniqueness.

### 3.2 Making, listing and revoking links

Procedures (tRPC, `protectedProcedure`, active accounts only):

- `account.invites.list`: the caller's links with state `open | used |
  revoked`, the person who used each, and "You invited" (accounts whose
  `invited_by` is the caller), newest first.
- `account.invites.create`: refused with `PRECONDITION_FAILED` when the
  caller already has 3 open links. The count and the insert run in one
  transaction, so two concurrent creates cannot reach 4. Returns the code
  once. Admins (`users.is_admin`) are exempt from the slot limit, so the root
  of the tree can seed it.
- `account.invites.revoke`: the caller's own open link; frees the slot.
  There is no restore for account invites (the mockup has none).
- Code format: the server generates it from a CSPRNG over the mockup's
  alphabet (no `0`, `O`, `1`, `I`). The mockup's `SESS-XXXX-XX` holds 30 bits;
  the plan uses `SESS-XXXXX-XXXXX` (50 bits) unless §15 question 3 decides
  otherwise. The link form is `https://session.dev/i#<code>`: the code stays
  in the fragment, so it is in no request line, access log or `Referer`,
  matching the earlier `/invite#<token>` design (`12` §3.5). The code step
  also accepts a pasted `/i/<code>` path or a bare code, as the mockup's parser
  does (it strips everything up to the last `/`).

The members page (mockup `membersPage`, `invSection`) shows "N of 3 left",
each open link with Copy and a revoke button, "Create an invite link", and
"You invited". Copy for a member who cannot invite: "You can invite once your
account is active."

Acceptance: server tests for the slot limit (3 open, a 4th refused, revoke
frees one, a used link frees one), concurrency (two creates at 2 open), and
admin exemption; client test that the button is replaced by the explanation
at 3 open.

### 3.3 Invite tree

`account.inviteTree` returns active accounts as `{ handle, displayName,
avatar, invitedBy, joinedAt, staff }`, where `staff` is `admin` for
`users.is_admin` and absent otherwise. The client draws it as the mockup's
`treeA` (depth-first from the roots, children by `joinedAt`). The mockup's
"mod" tag on accounts has no server counterpart: Session-level moderators do
not exist in `06`. The tag is dropped unless §15 question 6 adds the role.

The tree is visible to active members only (not to pending sign-ups or
signed-out readers), because it lists every account's handle and inviter.
Pagination: the procedure returns the whole tree while it has fewer than
5,000 nodes; above that, subtrees load on expand.

Acceptance: server test that a pending sign-up and a guest get
`UNAUTHORIZED`/`FORBIDDEN`; client test that the tree renders inviter edges
for a fixture of 12 accounts in the mockup's order.

### 3.4 The "Join with invite?" step and pending sign-ups

Flows, from `authScreen`:

- **From a link.** `/i#<code>` stores the code in memory and opens the sign-in
  dialog. `auth.checkInvite { code }` (public, rate-limited, §9) answers
  `open` with the inviter's display name and handle, or a single `unusable`
  answer for used, revoked, expired and unknown codes (the mockup's three
  error strings are merged so a probe cannot tell a used code from a made-up
  one; see §13). The dialog shows "<name> invited you to Session" and
  "Continue with GitHub".
- **Code step** (`CODE_COPY`): heading "Join with invite?", "Paste the code or
  link a member sent you.", button "Continue"; on `open`, "Invite from <name>"
  and the sign-in button.
- **OAuth callback.** The code travels in the `oauth_states` row (server-side,
  never in a URL). On callback: an existing account signs in and the code is
  untouched; a new identity with a valid code goes to the profile step (name,
  handle, community-rules checkbox), and `account.create` redeems the code and
  creates the user in one transaction; a new identity without a code becomes a
  **pending sign-up**.
- **Pending sign-up.** A `pending_signups` row (`github_id`, login, avatar,
  created, expires 14 days later) and a cookie bound to it. It is not a
  `users` row, owns nothing, and has no replica user log. The client treats it
  as a signed-out reader plus the mockup's "Invite required" page with the
  redeem form. Redeeming creates the account as above. Expired rows are
  deleted by the maintenance sweep.

The profile step's "community rules" are Session-wide terms (a static page),
not channel rules.

Acceptance: e2e spec `e2e/invites.spec.ts` (new): a member creates a link, a
second browser context opens it signed out, completes the test sign-in
(`SESSION_TEST_AUTH=1`) and the profile step, and appears in the first
member's "You invited" and tree; a third context signs in without a code,
reads an open channel, cannot ask, then redeems a code on the status page and
can ask; a used code shows the "no longer works" screen.

### 3.5 Signed-out and pending readers

A signed-out caller (and a pending sign-up) reads every open channel, its
threads, branches, replies and member list, and the landing of a private
channel (name, description, owner, member count; replica-proto `inv3`: "a
signed-out caller gets open spaces and the landings of closed ones"). The
scope picker offers only "All" (mockup `SCOPES`). Any write control (Ask,
Post, Save, Report, Join) opens the sign-in dialog; the server refuses a
write from a signed-out caller regardless (`inv1`: "a signed-out caller and an
old protocol version are refused").

Browse and "All" list open channels and the reader's own private channels
(`allVisible`). A private channel's landing is reachable only by its id; it is
in no listing served to a non-member. Whether `snapshot` for a non-member
includes unlisted landings at all is decided in `01-architecture-and-data.md`;
this file requires only that no listing endpoint returns them.

## 4. Channels

### 4.1 Visibility

The mockup's two choices map onto the schema:

| Mockup | Stored | Who reads content | Who joins |
|---|---|---|---|
| Open | `vis` absent (`open`) | Anyone, signed out included | Any active account, `spaces.join` |
| Private | `vis: "unlisted"`, `policy: "invite"`, `invite: "mods"` | Members only | Holders of a channel invite link |

`listed` and `policy: "request"` stay in the contract and the mutators but
the client never sets them. Changing visibility after creation is not offered
(the mockup has no control); `spaces.update { vis }` exists and resyncs every
reader (`inv3`: "a space that becomes closed resyncs every reader").

### 4.2 Names and creation

- Names: the shared rule `^[a-z0-9][a-z0-9-]{1,29}$` after normalization
  (lowercase, strip a leading `#`), defined once in `@session/mutators` and
  used by the dialog for inline validation. The mock API's 32-character slice
  is replaced by this rule.
- Uniqueness is across all channels, private ones included, and is the
  server's (`inv4`: "space ids are ULIDs and names are unique, after
  normalization"). A taken name answers `CONFLICT` naming only the name sent
  (`R10`). The dialog shows "#name already exists."
- Creation is online-only (`inv4`: "spaces.create is online only"; an
  envelope that waited in an outbox answers `EXPIRED`). The New channel
  dialog disables Create while the sync connection is down and says
  "Creating a channel needs a connection."
- The creator becomes owner and only member. `spaces.create` from the client
  sends `name`, `desc`, `vis`, and for private `policy: "invite"`,
  `invite: "mods"`; never `rules`, `qs` or `faq`.

### 4.3 Roles

Roles are `owner`, `admin`, `mod`, `member` (`spaceMemberRoleSchema`). The
client at launch assigns only `mod` and `member`; `admin` stays valid on the
wire and in the mutators, so the server rules and suites are unchanged, but no
UI path creates one. In practice the owner is the only admin-rank person,
which gives the overview's "owners edit only About".

| Action | Member | Mod | Owner |
|---|---|---|---|
| Read, ask, post, reply, save | yes | yes | yes |
| Report a thread | yes | — (removes instead) | — |
| Remove a thread, dismiss a report, see the moderation log | | yes | yes |
| Ban, unban, remove a member ranked below | | yes | yes |
| Make channel invite links (private) | | yes | yes |
| Edit About | | | yes |
| Appoint or demote moderators | | | yes |
| Transfer ownership | | | yes |

Work items:
- Channel info gains a Members row that opens a member list (owner first,
  then staff, then members by `joinedAt`). Staff see a per-row menu with
  Remove from channel and Ban; the owner also sees Make moderator / Remove
  moderator and Transfer ownership. This is an addition to the mockup, which
  has no role controls.
- `members.setRole` carries `base.rev` and answers STALE when the member
  record changed (`AGENTS.md` stale-intent rule; `inv2`: "a queued role
  change, show, or edit acts only on the state it was made from").
  `members.remove` compares the admission id (`R1b`).
- The sole owner cannot leave (`spaces.leave` answers
  `PRECONDITION_FAILED`); the Leave confirmation tells them to transfer
  ownership first.

Acceptance: client tests for the menu items each role sees; on the server,
replica-proto's `inv2` and `review-r1` (ownership transfer).

### 4.4 Channel info and About

Channel info (`chInfoDlg`): glyph, name, lock for private, About text,
"Channel by @owner", member count, visibility sentence ("Private: only members
can read or post" / "Open: anyone can read and join"), and for staff the
"Moderation log (N open)" link. The owner's Edit opens `chEditDlg` with one
field, About, at most 300 characters (`DESC_MAX`).

- Save sends `spaces.update { id, set: { desc } }`. The server bounds `desc`
  to 300 characters (`BAD_REQUEST` above, recorded, per `R8`), trims it, and
  checks rank at apply time.
- About edits are last-write-wins: the mockup has no conflict prompt and
  `spaces.update` compares `base` only for rules. Two owners cannot exist, so
  the only concurrent writer is the same person on two devices.
- An empty About shows "No description yet. Add one" to the owner and nothing
  to others.

Acceptance: client test that only the owner sees Edit and the 300-character
error; e2e step in `e2e/moderation.spec.ts` (§6.6) that a member's open
channel info shows the owner's new About without a reload.

## 5. Channel invite links (private channels)

- Staff open channel info → "Invite to #name" → a one-use link
  `https://session.dev/c/<space id>#<code>` with Copy. Default expiry 7 days
  (`invites.create { days: 7 }`); the server makes the code (`inv4`: "invite
  codes are made by the server").
- Revoke and Undo use `invites.revoke` and `invites.restore`.
- Opening the link as an active account calls `spaces.join { space, invite }`;
  as a signed-out or pending reader, the sign-in or invite flow runs first and
  the join follows.
- A link works only while its maker may make links, and works again once the
  maker regains the right (`AGENTS.md`; `inv2` two tests). Expiry is checked
  at apply time (`inv2`: "an expired invite link is refused at apply time").
- A banned person cannot join with a link (`members.ban` note; `review-r1`
  "a ban takes the membership away, and neither an approval nor the space
  opening lets the banned person in").
- Limit: 20 channel links per user per day, and at most 50 open per channel.

Acceptance: e2e in `e2e/moderation.spec.ts`: the owner of a private channel
copies a link, a second account opens it and reads the channel, a third
account opening the same link gets "This invite link has expired or was
already used."

## 6. Moderation

### 6.1 Reporting

- Thread menu for non-staff members: "Report…" (`reportopen`) opens `rmDlg` in
  report mode: the clipped title, "What is wrong with it?" (optional), and
  "Reports go to the moderators of #name. @author is not told who reported."
  The mockup's "Reports go to @owner" names one person; with moderators it
  names the channel.
- Mutator `reports.create { id, item: "thread:<id>", note? }` with the
  contract change in §11 (`why` optional). `note` is at most 500 characters.
- Only threads are reportable from the client at launch; follow-ups and
  replies have moderation keys in the contract and can be added later (§15 question 9).
- One open report per (reporter, item): a second answers
  `PRECONDITION_FAILED` and the dialog says "You already reported this."
- Readers of a report: the reporter and the channel's staff (`access.ts`).
  Staff are notified; the notification is served only while they are staff
  (`R4c`, `H2`).

### 6.2 Removing

- Thread menu for staff: "Remove…" (`rmopen`), also reachable from the
  moderation log. `rmDlg` in remove mode: "Reason, shown with the removal"
  (optional, at most 300 characters) and "Readers see that it was removed.
  Branches and replies under it go with it."
- Mutator: `moderation.decide { item, decision: "removed", reason? }`, or
  `reports.resolve { report, outcome: "removed", reason? }` from the log. Both
  resolve every open report on the item as `removed` and send
  `report_resolved` to each reporter.
- Effect: the thread and everything under it (follow-ups, replies, branches,
  runs and their turns, its counts record, saves and likes of it) are erased
  from storage in the same commit (`inv6`: "removing a thread erases it and
  everything under it from storage, for good"; `R5`: "a removed thread's text
  is in no value at rest, tombstones included"). A run in progress is
  cancelled and writes nothing after the removal (`03-agents-and-research.md`).
- The **moderation record** for the item (the `modSt` entry, keyed by
  moderation key) holds `{ state: "removed", by, reason, at, kind, space }`
  and is what the placeholder renders: "Removed by @mod", "Reason: “…”",
  "Ask in #name" / "Post in #name". The mockup also prints the author's
  handle; whether the moderation record keeps the author is §15 question 1.
  The default is that it does not, because the erasure rule removes the
  thread record and the author is part of it.
- Removal is not reversible: the content no longer exists. There is no Undo.
  `reports.resolve { outcome: "open" }` after a removal reopens the report
  only; it restores nothing.
- `hidden`, `removed`, `decline` and `members.ban` apply to the record as it
  is, without `base` (`AGENTS.md`; `H1`: "a restricting decision applies
  whatever the target does in between"). Removing an item already removed is
  a no-op success.
- The author may still delete a thread a moderator removed (`R11`); that
  deletes the placeholder's moderation record too.
- Placeholder lifetime: the placeholder exists while the moderation record
  does. Tombstones of the erased records are pruned after 30 days; the
  moderation record is kept for 90 days, after which the item is absent from
  the feed (§15 question 2).

### 6.3 Hiding

`moderation.decide { decision: "hidden" | "shown" }` and the hidden text rules
stay implemented and tested (`inv6`: "after a hide, its author and the space's
moderators get the text; everyone else the placeholder"; "a demoted moderator
stops getting hidden text"). `shown` carries `base.rev` and answers STALE when
the author edited the text after the moderator read it (`R2`). The client
renders hidden items (the author and staff see the text under a "Hidden by
moderators" bar; others see a placeholder) but offers no Hide command at
launch.

### 6.4 Banning

- Staff: "Ban from #name" in the thread menu (on another person's thread) and
  in the member list; "Banned" list with Unban in channel info.
- `members.ban` removes the membership if any and adds the ban. A ban stops
  every write in the space, the person's own included (`inv2`: "a ban stops
  every write in its space, the author's own included"). In an open channel
  the banned person can still read, because open content is readable by
  anyone, signed out included.
- Removal from an open channel is not offered as a separate command: it is
  STALE after the person leaves and joins again, by design (`AGENTS.md`).
  Remove from channel is offered for private channels; Ban for both.

### 6.5 Moderation log

`modLogDlg`: two tabs, "Open reports (N)" and "Everything"; each entry shows
the kind (Report, Dismissed, Removed), "@reporter reported @author's ask" or
"@mod removed …", the note or reason, and the relative time; open reports
carry Dismiss and Remove.

- Data: the channel's `reports` (staff-readable) plus moderation records and a
  new staff-only `modlog` record per moderator action (`{ id, sp, action:
  "removed" | "dismissed" | "banned" | "unbanned", item?, user?, by, reason?,
  at }`). The record kind and its audience (staff of `sp`) are added in
  `01-architecture-and-data.md`; reading it follows the same rule as
  `report`.
- Excerpts: an entry shows the item's current title when the reader's replica
  has it. A removed item has none; the entry reads "@mod removed an ask by
  @author" only if the author is kept (question 1), else "@mod removed an ask".
  A report's `note` is the reporter's own text and is kept.
- Dismiss: `reports.resolve { outcome: "dismissed" }`. The reporter gets
  `report_resolved` with `outcome: "dismissed"`.
- The "(N open)" count in channel info counts open reports in the replica.
- Retention: `modlog` records and resolved reports are kept 180 days.

### 6.6 Acceptance

- replica-proto's suites (`inv2`, `inv6`, `review-r1`, `review-r2`) pass
  against the real server half (`05-delivery.md`, M3).
- New mutator tests in `@session/mutators`: `reason` and `note` bounds; one
  open report per reporter and item; resolve-on-remove marks every open report
  on the item; the moderation record holds no text field of the thread.
- New e2e `e2e/moderation.spec.ts`: a member reports a thread with a note; the
  owner's channel info shows "Moderation log (1 open)" without a reload; the
  owner removes it with a reason; the member's feed shows the placeholder
  with the reason and no text; a reload of the member's page still has no
  text; a second report is dismissed and the reporter sees the resolved
  notification; the owner bans a member in an open channel and that member's
  Ask is refused with the ban message.
- A storage scan test (replica-proto `R5` pattern) over the real SQLite file
  after removal: the thread's question text appears in no table, the change
  log and idempotency answers included.

## 7. Saved threads and user logs

Saves, likes and notifications live in the user's own log and follow current
access (`AGENTS.md`; `inv7`: "other people's likes, saves, requests and
notifications stay in their replicas"):

- A save is served only while its owner may read the thread's channel.
  Leaving or being removed from a private channel removes those saves from
  Saved; rejoining brings them back, because the records were kept and only
  their serving stopped (`R4a`: no deletions are sent to a removed member's
  log).
- A removed thread's saves and likes are erased with it, so the Saved count
  drops.
- Saved's count is computed on the client from the user log (the counts
  record does not hold per-viewer state).
- Report notifications are served only while the person is staff of the
  channel; join requests stay with their person.

Acceptance: client test that Saved updates its count when a resync removes a
channel's saves; replica-proto `R4a`, `R4c`, `H2`.

## 8. Privacy

- **Erasure.** Removed content is erased from storage and never served again,
  including through cursors made before the removal (`inv6`: "an old cursor
  resyncs into the current state, never the content it last saw"). Tombstones
  keep key, kind, audience fields and rev, no text. Effects carry ids, not
  text (`AGENTS.md`), so the effect queue never holds a copy. Litestream
  generations still hold the text until they age out (30 days, `13` §6); the
  privacy page states this.
- **Hidden text** is served to its author and the channel's staff only, and
  stops being served to a moderator on demotion.
- **Frozen copy.** A member removed from a private channel keeps the copy on
  their desktop, frozen; the server serves them nothing further from that
  channel, but they can still delete their own threads there (`inv3`: "a
  removed member's device keeps a frozen copy of their threads, and can still
  delete them"; `R4b`: the delete answers `null` and reveals nothing about
  later replies). The client marks the channel "You are no longer a member.
  This is the copy on this device." and offers only Delete on the person's
  own threads. The web client's in-memory adapter has no frozen copy after a
  reload. On voluntary Leave, the desktop drops the copy (§15 question 5).
- **Reporter identity** is served to the reporter and staff only; the author
  never receives it.
- **No existence oracle**: a missing target and one the caller may not read
  answer the same (`inv4`); an id collision answers the same `CONFLICT`
  whether or not the caller can read the record.
- **Account deletion** remains an operator job (`06` §7); with spaces, it
  also erases the person's threads in every channel by the removal path, and
  keeps their handle reserved.

## 9. Permissions at apply time

Every check runs when the server applies the envelope, against its own state,
never against what the client saw when it queued the write (`inv2`). The
client predicts with the same mutator, so a write the replica already knows
to be forbidden is refused locally; a write that becomes forbidden while
queued is refused by the server, recorded under its seq, and rolled back on
the client. Cases the client must render:

- Demoted moderator: a queued removal answers `FORBIDDEN`; the outbox entry
  shows "You are no longer a moderator of #name."
- Removed or banned member: queued posts answer `FORBIDDEN`; the composer
  draft is restored from the outbox entry so the text is not lost.
- Inviter lost the right: a channel link answers "This invite link has
  expired or was already used."
- STALE: role changes and `shown` made against an old rev; the UI reloads the
  target and asks the person to act again.

A refused write is shown at once (it is recorded, not transient); transient
answers retry with backoff, and a write that fails 5 times is shown while the
rest of the outbox continues (`R7`, `Q3`).

Acceptance: replica-proto `inv2` against the real server; client tests in
`@session/sync` for rollback of each refusal and draft restoration.

## 10. Abuse limits

Limits are server settings with these defaults. Rate-limit refusals answer
`TOO_MANY_REQUESTS`, are not recorded, and the client retries with backoff
(`R15`, `N10`).

| Limit | Default | Where |
|---|---|---|
| Replicated writes | 60/min per user (the existing mutation bucket) | apply endpoint |
| `reports.create` | 20/hour per user | pre-check |
| `account.invites.create` | 3 open; 10 created per day | procedure |
| `auth.checkInvite` and redemption | 20/min per IP (the `/auth/*` bucket); 10 failed checks per hour per IP | Hono middleware |
| `spaces.create` | 5/day per user | pre-check |
| `invites.create` (channel) | 20/day per user, 50 open per channel | pre-check |
| `spaces.join` | 60/hour per user | pre-check |
| Client registration | 20/day per user (`S2`) | sync server |
| Envelope size | `TOO_LARGE` above the configured maximum, unrecorded | apply endpoint |
| Text bounds | About 300, removal reason 300, report note 500 characters; larger is `BAD_REQUEST`, recorded (`R8`) | mutator input schema |
| Runs | Weekly included allowance, queued-per-user cap 20, device runs 100/hour and 200 KB per answer | `03-agents-and-research.md` |

The buckets are in memory in the single process (`06` §8); a restart resets
them, which is accepted on one machine.

## 11. Contract changes this file needs

To be made in `spaces.ts` and the mutators by the owners of
`01-architecture-and-data.md`:

1. `reports.create`: `why` optional; `note` bounded to 500.
2. `moderation.decide` and `reports.resolve`: optional `reason` (300) on
   `removed`; the moderation state record gains `by`, `reason`, `at`, `kind`.
3. New staff-only `modlog` record kind with audience `(space, staff)`.
4. Account invites, the tree, `auth.checkInvite`, `account.create` and
   pending sign-ups as online-only tRPC procedures, outside the replicated
   contract.
5. `spaces.create` from the client never carries `rules`; the server stores
   none when absent (the mock API's default rule is removed).

## 12. Authentication

- **Web**: GitHub OAuth with PKCE and database sessions as in
  `06-auth-and-users.md` (cookie `HttpOnly; Secure; SameSite=Lax`, 30 days
  idle, 90 days absolute; `Origin` and `X-Requested-With` checks on
  mutations). The sync endpoints (apply, snapshot, pull, SSE) accept the
  cookie under the same CSRF rules. Logout ends the SSE streams opened with
  that session.
- **Desktop**: a bearer device token stored in the macOS Keychain under the
  `dev.session.desktop` service. Sign-in opens the system browser on
  `/auth/device/start` (GitHub OAuth, same callback), which ends by
  redirecting to the app's registered URL scheme with a one-time code; the
  app exchanges the code plus its PKCE verifier for the token. The server
  stores `device_tokens (id, user_id, token_hash, name, created_at,
  last_used_at, revoked_at)`; the token is 256 random bits. Sliding expiry 90
  days. Account menu → Devices lists and revokes them; revocation ends that
  device's streams within 60 seconds (same check as `06` §2).
- **Replica ownership**: a replica and its outbox belong to one user. Sign-out
  on the desktop deletes the local replica database and outbox; an outbox
  queued by one person and flushed after another signs in is refused (`inv7`).
  The sync `clientId` is registered under the token's user.
- **CORS**: an allowlist admitting the desktop's origin only, for
  bearer-authenticated requests, without credentials. The cookie path keeps
  same-origin only. Requests with a bearer token skip the cookie CSRF checks
  because the browser never attaches the token automatically.

Acceptance: server tests for token issue, hashing, expiry, revocation ending a
stream, a cookie request from a foreign origin refused, a bearer request from
the allowlisted origin accepted and from another origin refused by CORS
preflight.

## 13. Threat notes

- **Name probing through CONFLICT.** Names are unique across all channels, so
  anyone can learn that a private channel named `x` exists. Accepted
  (`AGENTS.md`, `R10`). The private option's help text says "Channel names
  are visible to anyone who tries the same name." The CONFLICT names only the
  name sent.
- **Invite code enumeration.** `auth.checkInvite` reveals an inviter's name
  for a valid code. Mitigations: 50-bit codes, one `unusable` answer for every
  failure, the per-IP limits in §10, and a metric and alert on failed checks.
- **Cursor tokens.** Cursors and SSE ids are AEAD tokens holding log, reader,
  version, serve time and epoch; no version reaches a client. The key is
  configured (`SESSION_CURSOR_KEY`), not per process; the previous key is
  accepted for 30 days after rotation. A forged token, another reader's token
  or one from another server resyncs (`inv3`, `T1`). The rotation procedure
  goes into `web/docs/runbooks/`.
- **CORS allowlist.** Only the desktop origin; a misconfigured wildcard would
  expose bearer endpoints to any page that obtains a token, so the allowlist
  is a parsed list of exact origins with a startup check that refuses `*`.
- **Token theft on the device.** The Keychain item is readable by the app's
  signed identity only. The frozen copy and replica live in the app's data
  directory; FileVault is the disk protection. Remote revocation stops further
  reads.
- **Client-computed state.** The server never accepts client state: an
  envelope with extra fields or client-computed values is refused (`inv1`).
- **Idempotency and ids.** Mutation ids are scoped per user (`inv5`); stored
  times and list order are the server's, so a forged ULID time cannot reorder
  a feed (`inv4`, `R13`).

## 14. Dependencies

- `01-architecture-and-data.md`: the server half (apply, snapshot, pull, SSE,
  change log, tombstones, effects worker), the record kinds and audiences, and
  the contract changes in §11.
- `02-client-app.md`: the dialogs and pages named here (channel info, edit,
  moderation log, remove/report, members page, invite flow, frozen channel
  banner).
- `03-agents-and-research.md`: run cancellation on removal, run caps and
  device-run limits referenced in §10.
- `05-delivery.md`: milestone M6 schedules this file; M3 makes the real server
  pass replica-proto's suites, which most acceptance checks here rely on.

## 15. Open questions

1. Does the removed placeholder show the author's handle, as the mockup does?
   That requires keeping the author on the moderation record after the thread
   is erased. Default: no.
2. How long does a removal placeholder stay in the feed: 30 days (tombstone
   lifetime), 90 days (proposed), or for good?
3. Account invite code format: the mockup's `SESS-XXXX-XX` (30 bits) or the
   proposed 50-bit `SESS-XXXXX-XXXXX`.
4. Can a member see the codes of their own open links again after creation
   (needs reversible storage), or only copy them at creation?
5. On voluntary Leave from a private channel, does the desktop keep a frozen
   copy as it does on removal? Default: drop it.
6. Does Session need site-wide moderators (the mockup's "mod" tag in the tree)
   with powers across channels, or only `users.is_admin`?
7. Sign in with X (mockup) in addition to or instead of GitHub (ADR-5).
8. Is a pending sign-up's 14-day lifetime right, and should pending sign-ups
   count toward per-IP throttling?
9. Should follow-ups and replies be reportable and removable individually at
   launch (the contract supports it; the mockup shows threads only)?
10. Should Hide be offered to staff, given the server supports it?
