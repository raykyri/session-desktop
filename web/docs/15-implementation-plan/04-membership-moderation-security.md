# 04 — Membership, moderation and security

Status: draft. This file covers who may join Session, how channels admit and
rank their members, how a channel's staff moderate it, what the server serves
to whom, and the limits and authentication the server applies. It schedules
work against the rules fixed in `AGENTS.md` ("Planned: desktop client and sync
core"), ADR-19 to ADR-22 and `web/packages/shared/src/schemas/spaces.ts`, and
records where the members mockup (`docs/mockups/session-web-members.html`)
adds to them or disagrees with them. The server half, record kinds and
contract changes are specified in `01-architecture-and-data.md` (cited as
`01` with its item ids, always prefixed: `01` S2, `01` C12); runs, allowances
and device runs in `03-agents-and-research.md`. This file names what it needs
from them and does not redesign them.

Terms: "channel" is the product word; code and wire keep `space`. "Staff" of
a channel means its owner, admins and moderators (`RANK >= mod` in
`replica-proto/src/access.ts`). Test names in parentheses (`inv2`, `R11`,
`H2`, …) without a file prefix are replica-proto tests that the real server
half must pass (`05-delivery.md`, M3); `R…` and `S…` there are the
`review-r1` and `review-r2` test ids, not `01`'s replication or server items.

Work items have ids `I` (accounts and invites), `B` (channels and roles), `O`
(moderation), `P` (privacy and user logs) and `Z` (limits, authentication,
client security), so that `05-delivery.md` (M4, M6 and M7a) can schedule them.

## 1. Precedence and conflicts

| Topic | Mockup | Decision | Reason |
|---|---|---|---|
| Sign-in provider | Sign in with X; a Session handle chosen at sign-up | GitHub OAuth (ADR-5, `06-auth-and-users.md`); the handle step is kept | ADR-5 is in force; the overview records no provider decision. X is question 7. |
| Account without an invite | "Continue without one" creates a `waiting` member who reads open channels | A `users` row with `status: "waiting"` (`01` C8), with no handle, which owns nothing and cannot write | The overview records invite-only membership. This replaces `06` §3 and the current callback, which deletes a new account whose code fails (`auth/github.ts`); the purpose, no writes and no spend without a code, still holds. |
| Moderators | `isMod` is the owner only | Staff per `spaceMemberRoleSchema` and the phase 0 read rules; the client adds "Make moderator" | The schema and replica-proto define the roles. `01` question 5 asks whether v1 grants them; this plan proposes yes (§4.3). |
| Admin role | Absent | Rendered, not granted: an ownership transfer makes the previous owner `admin` (`review-r1` "an ownership transfer leaves exactly one owner, and the old owner an admin") | The client must label and permit it even though no control assigns it. |
| Hide | Not offered | Server keeps `hidden`; no Hide command at launch | Phase 0 rules and suites cover it. |
| Ban | Not offered | Offered to staff | `AGENTS.md`: removal in an open space is STALE after leave and rejoin; "the UI offers ban as the tool there". |
| Report and removal text | One optional free-text field each | `reports.create { item, note? }`; `moderation.decide { …, note? }` (`01` C12) | Overview product decision. |
| Who may report | Any active account (`canWrite()`) | Members of the channel (`reports.create` is `who: "member"` in replica-proto); a non-member in an open channel sees "Join #name to report." | Keeps the tested rule and ties each report to a person the staff can ban. |
| Removal placeholder | "Removed by @mod", "Reason: …", "Ask by @author in #channel" | The author shows as "[deleted]" (product decision); §6.2 lists exactly what is stored and served | `AGENTS.md` erases content (text and everything under the thread), not the record's attribution; replica-proto's `erase` and `redact` keep `u` on the placeholder. |
| Moderation log excerpt | Quotes a removed thread's title | No text of a removed item | `AGENTS.md`: removed content is erased and never served again (`01` C12 agrees). |
| Channel rules | Removed | Client never sends `rules`; no default rule is stored | Overview product decision. |
| Visibility | Open or Private | Wire `vis: "open" \| "private"`; private is closed, unlisted and invite-only (`01` C9) | Matches the product; the closed-space rules of phase 0 apply unchanged. |
| Private admission | "Ask @owner to add you"; no add flow drawn | Staff-made one-use channel invite links | The contract and phase 0 define them (`inv2`, `inv4`). |
| Join requests | Absent | Deferred (`01` C10); their prototype tests stay in the suite | `01` question 6. |
| Channel deletion | Absent | Not offered at launch; `spaces.delete` stays out of `@session/mutators` v1; an admin deletes a channel by operator job | Nothing in the mockup draws it. |
| Invite link form | `session.app/i/<code>` (code in the path) | `<SESSION_PUBLIC_ORIGIN>/i#<code>` (code in the fragment); a pasted path form is still parsed | A path puts the code in request lines, access logs and `Referer` (§3.2). |
| Showing an open code again | Every open link has Copy | Kept: the code is stored encrypted for its creator until used or revoked (§3.1) | Resolves question 4. |

## 2. Two kinds of invitation

The mockup uses one word for two mechanisms; they are separate records with
separate limits.

1. **Account invites** admit a person to Session. Each active member holds at
   most 3 open links; redeeming one activates the account and records the
   inviter. They extend the existing sign-up codes (`invites`,
   `users.invited_by`, `02-domain-model-and-database.md` §3.1; `01` C8) and
   are online-only tRPC calls (ADR-19), not replicated records.
2. **Channel invite links** admit an active account to a private channel. They
   are the replicated `invite` records (`threadInviteSchema`) made by
   `invites.create` and consumed by `spaces.join { invite }`. They do not count
   against the 3 account-invite slots.

## 3. Account invites and access to Session

### 3.1 Records

**I1.** In `web/packages/db` (schema, migration) and `web/packages/server`:

- Account invites, on the existing `invites` table (`01` C8, D3): ULID
  `id`, `code_hash` (SHA-256 of the normalized code, unique), `code_enc`
  (AES-256-GCM under `SESSION_SECRET_KEY`, `01` S3; set to null when the
  link is used or revoked), `created_by`, `created_at`, `used_by`, `used_at`, `revoked_at`.
  Today the table stores `code` in plain text and `redeemInvite` matches on
  it (`db/src/repos/auth.ts`); the migration hashes existing codes and drops
  the column. `users.invites_remaining` is dropped in favour of the open-slot
  rule.
- `users.status`: `waiting | active | suspended` (`01` C8 plus `suspended`,
  §3.6). `users.handle` (unique, `^[a-z0-9._]{3,20}$`, the mockup's rule,
  null while waiting) and `users.display_name`. Handles are the values of
  `spaceHandleSchema` and are never reused; a waiting account gets no handle,
  so the sweep below cannot be used to reserve handles.
- A waiting account owns no records, has no user log, cannot register a sync
  client for writing, and is deleted by the maintenance sweep 14 days after
  creation unless redeemed (question 8). Waiting accounts created per hashed
  IP are counted in `signup_attempts` (outcome `waiting`); above 5 per IP per
  day the callback answers the sign-in error page instead of creating one.
- `oauth_states` stores `code_hash`, not the code, in its payload.

Acceptance: `packages/db/test/invites.test.ts`: lookup by hash; no column of
any table holds a plain code after the migration (a test scans the migrated
fixture database for the fixture code); `code_enc` is null after use and
after revoke; two concurrent redemptions of one code, one succeeds and one
gets `CONFLICT`; handle uniqueness and non-reuse after account deletion; the
waiting-account sweep; the 6th waiting account from one IP hash in a day is
refused.

### 3.2 Making, listing and revoking links

**I2.** tRPC `accountInvites.*` (`01` §6), active accounts only:

- `list`: the caller's links (`open | used | revoked`), who used each, the
  code of each open link (decrypted from `code_enc`; served only to its
  creator), and "You invited" (accounts whose `invited_by` is the caller),
  newest first.
- `create`: `PRECONDITION_FAILED` when the caller has 3 open links. Count and
  insert run in one transaction, so concurrent creates cannot reach 4. Admins
  (`users.is_admin`) are exempt, so the tree's roots can seed it.
- `revoke`: the caller's own open link; frees the slot and nulls `code_enc`.
  No restore. A revoked code answers `unusable` from then on.
- Codes come from a CSPRNG (`crypto.randomInt`) over the mockup's alphabet
  (no `0`, `O`, `1`, `I`). The mockup's `SESS-XXXX-XX` holds 30 bits; this
  plan proposes `SESS-XXXXX-XXXXX` (50 bits), question 3. Input is
  normalized (upper-cased, spaces and dashes removed) before hashing.
- The link is `<SESSION_PUBLIC_ORIGIN>/i#<code>` (in production
  `https://session.dev/i#<code>`): the code stays in the
  fragment and out of request lines, logs and `Referer`, as the existing
  `/invite#<token>` design does (`03-api-and-events.md` `invites.create`,
  `10-home-feed-journal.md` §4b). The client route reads the fragment and
  removes it from the address bar with `history.replaceState`. The code
  field also accepts a pasted `/i/<code>` or a bare code (the mockup strips
  up to the last `/`); the server has no `/i/<code>` route, and the access
  log redacts any path under `/i/`.

The members page (`membersPage`, `invSection`) shows "N of 3 left", each open
link with Copy and revoke, "Create an invite link", and "You invited"; a
waiting account sees "You can invite once your account is active."

Acceptance: server tests for 3 open and a 4th refused, revoke and use each
freeing a slot, two concurrent creates at 2 open, the admin exemption,
another account's `list` never containing the caller's codes; a client test
that the button becomes the explanation at 3 open and that the address bar
holds no fragment after `/i#<code>` loads.

### 3.3 Invite tree

**I3.** `members.tree` (`01` §6, online-only) returns active accounts as `{
handle, displayName, avatar, invitedBy, joinedAt, staff }`; `staff` is
`admin` for `users.is_admin`. The client draws it as `treeA` (depth-first
from the roots, children by `joinedAt`). The mockup's account-level "mod" tag
has no server counterpart and is dropped unless question 6 adds the role.
Suspended accounts appear as ordinary nodes to members and are marked only
for admins. A deleted account stays as a node "Deleted account" with no
handle, so its invitees keep their place.

`01` C8 leaves the tree's visibility to this file. Decision: active members
see the whole tree (handles, display names, inviter edges); waiting accounts
and signed-out readers get `FORBIDDEN`/`UNAUTHORIZED`. The tree is the main
tool for tracing an abusive account to its inviter (§10), which argues for
showing it to members; its cost is that every member can list every handle.
Above 5,000 nodes, subtrees load on expand.

Acceptance: server tests for the two refusals, the deleted-account node and
the admin-only suspended mark; a client test rendering a 12-account fixture
in the mockup's order.

### 3.4 The "Join with invite?" step

**I4.** Flows from `authScreen`:

- **From a link.** `/i#<code>` keeps the code in memory and opens the sign-in
  dialog. `auth.checkInvite { code }` (public tRPC mutation, so the code is
  in a POST body, rate-limited, §10) answers `open` with the inviter's
  display name and handle, or one `unusable` answer for used, revoked and
  unknown codes. The mockup's three distinct error strings are merged into
  "This invite code doesn't work. Ask the person who invited you for a new
  one." so a probe cannot separate a used code from a made-up one (§13). An
  empty field is checked on the client ("Enter the code from your invite.").
  The dialog shows "<name> invited you to Session".
- **Code step** (`CODE_COPY`): "Join with invite?", "Paste the code or link a
  member sent you.", "Continue"; on `open`, "Invite from <name>" and the
  sign-in button.
- **Starting OAuth.** The current `GET /auth/github?invite=<code>` puts the
  code in a request line. It is replaced by `POST /auth/github/start` (JSON
  `{ code?, returnTo? }`, `X-Requested-With: session`, same-origin), which
  writes the `oauth_states` row with the code's hash, sets the state cookie
  and answers `{ url }`; the client then navigates to `url`. `GET
  /auth/github` stays for sign-in without a code and ignores an `invite`
  parameter.
- **OAuth callback.** An existing account signs in and the code is untouched.
  A new identity with a usable code goes to the profile step (name, handle,
  the Session-wide community-rules checkbox; these are a static page, not
  channel rules), and `account.create` redeems the code and activates the
  account in one transaction. A new identity without a usable code becomes a
  waiting account. `SESSION_REQUIRE_INVITE` is removed: invite-only is the
  only mode.
- **Waiting accounts** see the mockup's "Invite required" page with the
  redeem form (`accountInvites.redeem { code }`, then the profile step), read
  like signed-out readers, and any write control explains that an invite is
  needed. Redeeming sets `status: "active"`, the handle and `invited_by`.

Acceptance: `e2e/spaces-membership.spec.ts` (`02` §12.2): a member creates a
link; a second context opens it signed out, completes the test sign-in
(`SESSION_TEST_AUTH=1`) and the profile step, and appears in the first
member's "You invited" and tree; a third context signs in without a code,
reads an open channel, cannot ask, redeems a code on the status page and can
ask; a used code and an unknown code show the same message. Server tests:
`checkInvite` answers byte-identical bodies for used, revoked and unknown
codes; after the e2e run, no line of the server's request log contains a
code issued during it.

### 3.5 Signed-out and waiting readers

**I5.** They read every open channel with its threads, branches, replies and
member list, and the landing of a private channel reached by its name or id:
name, description, owner and staff handles (`mods`), member count (`inv3`:
"a signed-out caller gets open spaces and the landings of closed ones"). The
scope picker offers only "All" (`SCOPES`). Write controls open the sign-in
dialog or the invite page; the server refuses the write regardless (`inv1`).
"All" and Browse list open channels plus the reader's own private channels
(`allVisible`); no listing (`spaces.directory`, `01` C7) returns a private
channel to a non-member.

Acceptance: `inv3`; a server test that `spaces.directory` for a signed-out
caller, a waiting account and a non-member contains no private channel; the
signed-out spec of `02` §12.2 (`e2e/spaces-signed-out.spec.ts`).

### 3.6 Suspension

**I6.** The mockup has no Session-wide sanction; without one an abusive
active account must be banned channel by channel. `admin.suspend { user,
on }` (admin only, in `/admin`) sets `users.status` to `suspended` or back to
`active`. A suspended account is refused every write at apply time (the same
check as a waiting account, `FORBIDDEN`, recorded), its open account invites
are revoked, its sessions and device tokens are revoked (streams end within
60 seconds), and it reads like a waiting account after signing in again.
Records it wrote stay; staff remove them as usual.

Acceptance: a server test that a queued envelope from a suspended user is
refused, its open links answer `unusable`, and its device token answers
`401`; unsuspending restores writes but not the revoked links.

## 4. Channels

### 4.1 Visibility

| Mockup | Wire (`01` C9) | Who reads content | Who joins |
|---|---|---|---|
| Open | `vis: "open"` | Anyone, signed out included | Any active account (`spaces.join`) |
| Private | `vis: "private"` | Members only | Holders of a channel invite link |

Visibility is set at creation (`01` C11); there is no control to change it.
The Private option's help text says what stays public: "The name, About,
owner and moderators are visible to anyone with the link or name."

### 4.2 Names and creation

**B1.**
- One validator in `@session/mutators`, used by the dialog and the mutator:
  `^[a-z0-9][a-z0-9-]{1,29}$` after lowercasing and stripping a leading `#`
  (`01` C14).
- Names are unique across all channels, private ones included; the server
  owns uniqueness (`inv4`). A taken name answers `CONFLICT` naming only the
  name sent (`R10`); the dialog shows "#name already exists."
- Creation is online-only (`inv4`: a queued `spaces.create` answers
  `EXPIRED`). The New channel dialog disables Create while the sync connection
  is down: "Creating a channel needs a connection."
- The creator is owner and only member. The client sends `name`, `desc` and
  `vis`; never `rules`.

Acceptance: `inv4` "space ids are ULIDs and names are unique, after
normalization" and the online-only tests; `R10`; a validator table test shared
by the dialog and the mutator.

### 4.3 Roles

**B2.** Roles are `owner`, `admin`, `mod`, `member`. The client assigns only
`mod` and `member`. `admin` exists after an ownership transfer and is shown
in the member list as "Admin"; it has moderator rights and may also act on
other admins and set roles up to its own (`actsOn`, `members.setRole` in
replica-proto).

| Action | Member | Mod | Admin | Owner |
|---|---|---|---|---|
| Read, ask, post, reply, save | yes | yes | yes | yes |
| Report a thread | yes | — | — | — |
| Remove a thread, dismiss a report, read the moderation log | | yes | yes | yes |
| Ban and unban; remove from a private channel | | members | members, mods, admins | everyone else |
| Make channel invite links | | yes | yes | yes |
| Edit About (`01` C11: owner only) | | | | yes |
| Make or remove moderators | | | yes | yes |
| Transfer ownership | | | | yes |

Work items:
- Channel info gains a Members row opening the member list (owner, staff,
  then members by `joinedAt`). Staff get a per-row menu on people ranked
  below them: Ban, and in private channels Remove from channel. Admins and
  the owner also get Make moderator / Remove moderator; the owner gets
  Transfer ownership. These controls are additions to the mockup; if `01`
  question 5 drops moderators from v1, the owner is the only staff and
  nothing else here changes.
- `members.setRole` carries `base.rev` and answers STALE on a changed member
  record; `members.remove` carries `base.adm` and answers STALE when the
  admission id changed (`AGENTS.md`; `inv2`, `R1b`).
- The sole owner cannot leave (`spaces.leave` answers `PRECONDITION_FAILED`);
  the confirmation says to transfer ownership first.

Acceptance: client tests for the menu items each of the four roles sees on
each of the four roles; `inv2` "a queued role change, show, or edit acts only
on the state it was made from", `R1b`, and the `review-r1`
ownership-transfer test on the server.

### 4.4 Channel info and About

**B3.** `chInfoDlg`: glyph, name, lock for private, About, "Channel by
@owner", member count, the visibility sentence ("Private: only members can
read or post" / "Open: anyone can read and join"), and for staff "Moderation
log (N open)". The owner's Edit opens `chEditDlg` with About only, at most
300 characters.

- Save sends `spaces.update { id, desc }` (`01` C11). The server trims,
  bounds (`BAD_REQUEST` above 300, recorded, per `R8`) and checks ownership at
  apply time. No `base`: one person edits, so a second device's save
  overwrites.
- An empty About shows "No description yet. Add one" to the owner, nothing to
  others.

Acceptance: client test that only the owner sees Edit and the length error; a
server test that a moderator's and an admin's `spaces.update` are refused; a
step in `e2e/spaces-channels.spec.ts` where a member's open channel info
shows the new About without a reload.

## 5. Channel invite links

**B4.**
- Staff: channel info → "Invite to #name" → a one-use link
  `<SESSION_PUBLIC_ORIGIN>/c/<name>#<code>` with Copy (channel URLs use the
  name, `01` C14; in production `https://session.dev/c/<name>#<code>`); the
  client route clears the fragment as in §3.2. Expiry 7 days (`invites.create { days: 7
  }`); the server refuses `days: null` and more than 30 days with
  `BAD_REQUEST`. Revoke and Undo use `invites.revoke` and `invites.restore`.
- The server makes the code in `pre` (`inv4` "invite codes are made by the
  server"): 128 bits from a CSPRNG, base32, independent of the link id (the
  mock derives it from the id, which a reader of the id could predict).
- Link records are read by the channel's staff and by their maker while a
  member (`access.ts`); the code is never in a record any other reader gets.
- An active account opening the link calls `spaces.join { space, invite }`; a
  signed-out or waiting reader goes through §3.4 first and keeps the channel
  code in memory, not in a URL.
- A link works only while its maker may make links, and again once the maker
  regains the right; expiry is checked at apply time (`inv2`, three tests). A
  banned person cannot join with a link (`review-r1` ban test).
- A leaked link admits at most one person; the maker and staff see `usedBy`
  and can remove or ban that person.
- Limits: 20 links per user per day; 50 open per channel (§10).

Acceptance: in `e2e/spaces-channels.spec.ts`, the owner of a private channel
copies a link, a second account opens it and reads the channel, a third
account using the same link gets "This invite link has expired or was
already used."; server tests for the expiry bounds and that a plain member's
snapshot holds no link record.

## 6. Moderation

### 6.1 Reporting

**O1.**
- Members of the channel who are not staff: "Report…" (`reportopen`) opens
  `rmDlg` in report mode: the clipped title, "What is wrong with it?"
  (optional), and "Reports go to the moderators of #name. @author is not told
  who reported." (The mockup names the owner; with moderators the copy names
  the channel.)
- `reports.create { id, item, note? }` with `item` the moderation key
  `a:<thread>` (ask) or `p:<thread>` (post) (`moderationKeySchema`, `itemOf` in
  replica-proto), note at most 500 characters (`01` C12). One open report per
  (reporter, item): a second answers `CONFLICT` (`01` C12) and the dialog says
  "You already reported this."
- Threads only at launch; follow-ups (`f:`), replies (`r:`) and comments
  (`c:`, `01` C4) have moderation keys and can follow (question 9).
- A report is readable by its reporter and the channel's staff. Staff get a
  `report` notification, served only while they are staff (`R4c`, `H2`); the
  effect writes at most one unread notification per (staff member, item), so
  repeated reports on one item do not multiply notifications.

Acceptance: `review-r1` "a report notifies the space's owner, admins and
moderators, and nobody else"; `@session/mutators` tests for the one-open rule
and a non-member's report refused; an effect test that three reports on one
item leave one unread notification per staff member.

### 6.2 Removing

**O2.**
- Staff: "Remove…" (`rmopen`) in the thread menu and the moderation log;
  `rmDlg` in remove mode: "Reason, shown with the removal" (optional, at most
  300 characters, with the hint "Readers see this. Do not quote the removed
  text.") and "Readers see that it was removed. Branches and replies under it
  go with it."
- `moderation.decide { item, decision: "removed", note? }` or
  `reports.resolve { report, outcome: "removed", note? }`. Either resolves
  every open report on the item as `removed`, sends `report_resolved` to each
  reporter, and writes a `modlog` entry.
- `removed`, `hidden`, `decline` and `members.ban` apply to the record as it
  is, without `base` (`AGENTS.md`; `H1`). Removing an item that is already
  removed answers `PRECONDITION_FAILED` ("This item was removed.", as
  replica-proto does); the client treats it as done.
- A run in progress ends and writes nothing after the removal
  (`03-agents-and-research.md`). Not reversible: the content no longer
  exists. `reports.resolve { outcome: "open" }` after a removal reopens the
  report only. The author may still delete a removed thread (`R11`), which
  deletes the placeholder.

What the removal commit leaves, and who gets it:

| Data | Stored after removal | Served to |
|---|---|---|
| Thread record: `id`, `s`, kind (ask or post), `createdAt` | kept | every reader of the channel |
| `u` (author) | kept, for the author's right to delete the placeholder (`R11`) and their user log | the author only; every other reader gets `u: null` |
| `mod: "removed"`, `modBy`, `modNote` | written | every reader of the channel |
| Thread text: `q`, `t`, `sum`, quotes, look-up phrases | emptied in the same commit | nobody |
| Ask nodes and follow-ups, answers, replies, comments, runs and turns, `run_live` checkpoints, mention notifications about it, saves of it | deleted; tombstones keep key, kind, audience fields and rev | readers get `del` |
| Counts record | `r: 0`, `saves: 0` | every reader |
| Reports on the item | kept with `st: "removed"` and their notes | reporter and staff; deleted after 180 days |
| `modlog` entry | `kind`, `item`, `by`, `author`, `note`, `at` | staff; deleted after 180 days |
| `usage_events` of its runs | kept, no text (`03` K1) | the payer |

The client renders the placeholder as "Removed by @mod", "Reason: “…”" when
a note exists, and "Ask by [deleted] in #name" or "Post by [deleted] in
#name" for every reader, the author included (product decision). The author's
replica still receives `u`, so the author's "…" menu keeps Delete. Acceptance:
a server test that a reader other than the author receives `u: null` on a
removed thread in snapshot and pull, and a client test that the placeholder
prints "[deleted]" for both the author and another reader. Deleting saves of a removed thread is a change to
replica-proto's `erase` (`01` U6), which today keeps them.

Placeholder lifetime: until the author deletes it or the channel is deleted;
tombstones of the erased records are pruned after 30 days (question 2).

Acceptance: `inv6` "removing a thread erases it and everything under it from
storage, for good", `R5`, `R11`; a `@session/mutators` test that the
placeholder parses with no field of the table's "emptied" row set and that
the reader's saves are gone; the D4 storage scan of §6.6.

### 6.3 Hiding

**O3.** `moderation.decide { decision: "hidden" | "shown" }` and the
hidden-text rules stay implemented and tested (`inv6`: hidden text to the
author and staff; a demoted moderator stops getting it). `shown` carries
`base.rev` and answers STALE when the author edited after the moderator read
it (`R2`). The client renders hidden items (author and staff see the text
under "Hidden by moderators"; others the placeholder) but offers no Hide
command (question 10).

Acceptance: `inv6` hide tests, `R2`, `R14`; a client test of both renderings.

### 6.4 Banning

**O4.**
- Staff: "Ban from #name" on the thread menu of a person ranked below them
  and in the member list; a Banned list with Unban in channel info.
- `members.ban` removes any membership and adds the ban. A ban stops every
  write in the channel, the person's own included, and any join by link
  (`inv2`, `review-r1` ban test). In an open channel the banned person can
  still read, because open content is readable by anyone. A person banned
  from a private channel is a removed member there: frozen copy, §8.
- Remove from channel is offered only in private channels. In open channels it
  would be STALE after the person leaves and rejoins (`AGENTS.md`), so Ban is
  the tool there.
- Ban and unban write `modlog` entries (§6.5).

Acceptance: `inv2` "a ban stops writes queued before it, in a closed and in
an open space" and "a ban stops every write in its space, the author's own
included"; a client test that a moderator sees no Ban on another moderator.

### 6.5 Moderation log

**O5.** `modLogDlg`: tabs "Open reports (N)" and "Everything"; each entry
shows the kind (Report, Dismissed, Removed, Banned, Unbanned), "@reporter
reported @author's ask" or "@mod removed @author's ask", the note, and the
relative time; open reports carry Dismiss and Remove.

- Data: the channel's reports plus the staff-only `modlog` record kind of
  `01` C12 (`{ id, sp, kind, item, by, author, note, at }`), whose `kind`
  includes `ban` and `unban`, with `item` null and `author` naming the banned
  person.
- An entry shows the item's current title only when the item exists and is
  not removed in the reader's replica. For a removed item it shows kind,
  author and channel.
- Dismiss sends `reports.resolve { outcome: "dismissed" }`; the reporter gets
  `report_resolved` with that outcome.
- "(N open)" counts open reports in the replica. `modlog` entries and resolved
  reports are deleted 180 days after `at` by the retention job (`01` Y8).

Acceptance: `inv3` "a plain member gets no moderator-only records, in
snapshots or pulls" extended to `modlog`; a retention test with an injected
clock; a client test that an entry for a removed item renders no title.

### 6.6 Acceptance

- replica-proto `inv2`, `inv6`, `review-r1`, `review-r2` against the real
  server half (M3).
- `@session/mutators` tests: note bounds; one open report per reporter and
  item; a removal resolves every open report on the item; the placeholder
  holds no field of the removed content.
- `e2e/spaces-channels.spec.ts`: a member reports a thread with a note; the
  owner's channel info shows "Moderation log (1 open)" without a reload; the
  owner removes it with a reason; the member's feed shows the placeholder
  with the reason and no text, also after a reload; a second report is
  dismissed and the reporter sees the resolved notification; the owner bans a member of an
  open channel and that member's Ask is refused with the ban message.
- The storage scan of `01` D4 after a removal: the question text appears
  nowhere in the SQLite file, the WAL included, nor in the `effects` table.

## 7. Saved threads and user logs

**P1.** Saves and notifications live in the user's own log and follow
current access (`AGENTS.md`; `inv7`). Likes are removed (`01` C1).

- A save is served only while its owner may read the thread's channel.
  Losing access to a private channel removes those saves from Saved; regaining
  it brings them back, because the records were kept and only serving stopped
  (`R4a`: no deletions reach a removed member's log).
- A removed thread's saves are deleted with it (§6.2).
- The Saved count is computed on the client from the user log.
- Report notifications are served only while the person is staff (`R4c`,
  `H2`).

Acceptance: a client test that Saved's count drops when a resync removes a
channel's saves; `R4a`, `R4c`, `H2`.

## 8. Privacy

**P2.**
- **Erasure.** Removed content is erased and never served again, also not
  through cursors made before the removal (`inv6`: "an old cursor resyncs into
  the current state"). Tombstones keep key, kind, audience fields and rev.
  Effects carry ids, not text; server logs carry ids and answer codes, not
  text (`05` §4). Litestream generations hold the text until they expire. Product
  decision: there is no retention requirement for backups, so removed text
  may stay in backups for as long as they are kept; "never served again"
  applies to what the server serves, not to backups (`01` question 3). Report notes and removal
  reasons are moderator- or reporter-written text and are kept as §6.2 says.
- **Hidden text** goes to its author and the channel's staff only.
- **Frozen copy.** A member removed or banned from a private channel keeps
  the copy on their desktop, frozen: the server serves them nothing further
  from it, but they can still delete their own threads there (`inv3`
  frozen-copy test; `R4b`: the delete answers `null` and reveals nothing about
  later replies). The client marks the channel "You are no longer a member of
  #name. This is the copy on this device." and offers only Delete on the
  person's own threads. The web client has no frozen copy after a reload. On
  a voluntary Leave the desktop drops the copy (question 5).
- **Reporter identity** goes to the reporter and staff only.
- **No existence oracle.** A missing target and one the caller may not read
  answer the same (`inv4`); an id collision answers the same `CONFLICT`
  whether or not the caller can read the record (`inv4`). `auth.checkInvite`
  has one failure answer (§3.4).
- **Account deletion** stays an operator job (`06` §7). With spaces it
  deletes the person's threads, follow-ups, replies and comments through the
  author's delete path (a thread with others' replies stays an empty shell,
  `AGENTS.md`), their user log, member records and device tokens; it keeps
  their handle reserved, reports and `modlog` entries naming them until
  retention, and their node in the invite tree as "Deleted account".

Acceptance: the frozen-copy test, `R4b`; a client test of the frozen banner
and that only own threads offer Delete; an operator-job test on a fixture
account that leaves no record with its `u` except retained reports and
`modlog` entries.

## 9. Permissions at apply time

**B5.** Every check runs when the server applies the envelope, against its
own state (`inv2`). The client predicts with the same mutator, so a write the
replica already knows to be forbidden is refused locally; one that becomes
forbidden while queued is refused by the server, recorded under its seq, and
rolled back. The client renders:

- a demoted moderator's queued removal: "You are no longer a moderator of
  #name.";
- a removed, banned or suspended member's queued post: refused, with the
  composer text restored from the outbox entry;
- a channel link whose maker lost the right: the expired-link message;
- STALE on a role change, a member removal or `shown`: the target is
  reloaded and the person acts again.

Recorded refusals are shown at once; transient answers retry with backoff,
and a write failing 5 times is shown while the rest of the outbox continues
(`R7`, `Q3`). Acceptance: `inv2` on the server; `@session/sync` client tests
for each rollback and the text restoration.

## 10. Abuse limits

**Z1.** Defaults, as server settings validated at boot (`05` §3.4). Rate
refusals answer `TOO_MANY_REQUESTS` unrecorded, and the client backs off
(`R15`, `N10`). Per-IP buckets key on the hashed client IP
(`hashClientIp`).

| Limit | Default | Where |
|---|---|---|
| Replicated writes | 60/min per user (the existing mutation bucket; a batch of 20 counts 20) | `/api/sync/apply` (`01` A3) |
| Snapshots | 30/min per user; 30/min per IP signed out | `/api/sync/snapshot` |
| SSE | one connection per client id; 10 per user | `/api/sync/events` |
| `reports.create` | 20/hour per user; one open per (reporter, item) | `pre` stage |
| `accountInvites.create` | 3 open; 10 created per day | procedure |
| `accountInvites.list`, `members.tree` | 60/min per user | procedure |
| `auth.checkInvite`, `accountInvites.redeem`, `account.create` | 20/min per IP (the `/auth/*` bucket); 10 failed checks per hour per IP and per user | Hono middleware |
| `POST /auth/github/start` | the `/auth/*` bucket | Hono middleware |
| Waiting accounts | 5 per IP per day (`signup_attempts`) | OAuth callback |
| Handle availability in the profile step | 30/min per user | procedure |
| `spaces.create` | 5/day per user | `pre` |
| `invites.create` (channel) | 20/day per user; 50 open per channel | `pre` |
| `spaces.join` | 60/hour per user | `pre` |
| `spaces.directory` | 60/min per user or IP | procedure |
| Client registration | 20/day per user (`01` D2, Y3; `review-r2` S2) | sync server |
| Device pairing codes | 5 created per hour per user; 5 failed redemptions invalidate a code | `devices.*` |
| Envelope size | `TOO_LARGE` above 256 KB, unrecorded (`01` Y1) | `/api/sync` |
| Text | About 300, removal note 300, report note 500 characters; `BAD_REQUEST`, recorded (`R8`) | input schemas |
| Runs | Weekly allowance, 20 queued per user, 100 device runs/hour, 200 KB per device answer | `03-agents-and-research.md` |

Buckets are in memory in the single process (`06` §8). The invite tree lets
an admin find who invited an abusive account; suspension (§3.6) and revoking
that member's open links are admin actions in `/admin`.

Acceptance: a middleware test per row that the limit plus one answers
`TOO_MANY_REQUESTS` and records nothing; `session_rate_limited_total{bucket}`
(`05` §4) counts each bucket.

## 11. Contract items this file depends on

Made by `01`: C8 (account invites on `invites`, `status`, `members.tree`),
C9 (`vis: "private"`), C10 (join requests deferred), C11 (`spaces.update {
id, desc }`, owner only), C12 (report and removal notes, `modlog` with `ban`
and `unban`, one open report per person and item). Requested here in
addition (`01` now records the first three, in C12, U6 and C8):

- C12 to state that the removal placeholder keeps `id`, `s`, kind, `u` and
  `createdAt` besides `mod`, `modBy` and `modNote` (replica-proto keeps and
  serves them; §6.2);
- `erase` also deletes saves, comments and mention notifications of the
  removed thread (`01` U6);
- `users.status` gains `suspended` (§3.6); account invites store
  `code_enc` beside `code_hash` (§3.1);
- the `pre`-stage limits in §10; `auth.checkInvite` with a single `unusable`
  answer; `POST /auth/github/start`;
- `invites.create` codes of 128 bits made in `pre`, `days` between 1 and 30;
- no default rules on `spaces.create`.

## 12. Authentication

**Z2. Web.** GitHub OAuth with PKCE and database sessions (`06`): cookie
`HttpOnly; Secure; SameSite=Lax`, 30 days idle, 90 absolute. CSRF:
`csrfGuard` (`server/src/middleware/csrf.ts`) refuses a cookie request whose
`Origin` differs from `SESSION_PUBLIC_ORIGIN` or whose `Sec-Fetch-Site` is
`cross-site`, and requires `X-Requested-With: session` on every non-GET. It
already covers every POST; its GET guard extends from `/api/trpc` to
`/api/sync/*` and `/api/runs/*`, so a cross-site page cannot open a cookie
SSE stream or snapshot. Logout ends the streams opened with the session.

**Z3. Desktop.** A bearer device token, 256 random bits, stored hashed in
`device_tokens` and in the macOS Keychain under the app's
`dev.session.desktop` identity (`01` S2).
- Pairing: a signed-in web session creates a one-time code (8 characters
  from the invite alphabet, 10-minute TTL, single use, invalid after 5 failed
  redemptions); the person types it into the desktop, which exchanges it for
  the token. The web page says "Enter this code only in the Session app on
  your own Mac." Each pairing adds a row to the account menu's device list.
- The token never reaches the webview's JavaScript: the Rust side holds it
  and adds the `Authorization` header to requests for the configured server
  origin's `/api/sync/*`, `/api/runs/*` and tRPC paths, so script injected
  into the client (Z5) cannot read it.
- Tokens unused for 90 days expire. A revoked or expired token answers
  `401`, its streams end within 60 seconds (the session check of `06` §2),
  and on that `401` the desktop deletes the replica database and outbox.
- **One replica per user.** Sign-out on the desktop deletes the replica
  database and outbox; an outbox queued by one person and flushed after
  another signs in is refused (`inv7`). The sync client id is registered
  under the token's user.

**Z4. CORS and credential separation.** An allowlist of exact desktop origins
(`tauri://localhost`, and the dev origin in development; `01` S2), parsed at
boot; boot refuses `*` and any `http:` origin in production. Responses never
send `Access-Control-Allow-Credentials`, so no allowed origin can make cookie
requests. A request carrying `Authorization: Bearer` is authenticated by the
token alone and skips `csrfGuard`'s cookie checks, because a browser never
attaches the token by itself; a request carrying both a bearer token and a
session cookie answers `400`, so the server never falls back from one to the
other.

**Z5. Rendering untrusted text.** Answers (from included runs and from
device runs, which are text from a user's own CLI), posts, replies, comments,
About, report notes and removal reasons are untrusted.
- Plain-text fields (About, notes, reasons, names, handles) render as React
  text, never as HTML.
- Answers are stored as Markdown and the server stores no HTML (`03` §1).
  Answers, posts, replies and comments render through the client's Markdown
  pipeline (`02` §4.4) with raw HTML disabled and DOMPurify on its output;
  the pipeline is the only path from record text to DOM.
- Links pass `safeHref` (`http:`, `https:`, `mailto:` only) and open with
  `rel="noopener noreferrer nofollow ugc"`; remote images stay blocked
  (`07-client-architecture.md` §9), so a post cannot learn a reader's IP.
- The web CSP of `07` §9 applies unchanged; the Tauri window sets the same
  policy with `connect-src` limited to the server origin.

Acceptance (Z2–Z5): `01` S1 and S2 tests, plus: a cookie `GET
/api/sync/events` with `Sec-Fetch-Site: cross-site` is refused; a cookie
`POST /api/sync/apply` without `X-Requested-With` is refused; a bearer
request from `tauri://localhost` is accepted without that header; a request
with both credentials answers `400`; a response to an allowed origin has no
`Access-Control-Allow-Credentials`; a revoked token's open stream ends and the
desktop wipes its replica (`05` M7a checklist); a pairing code fails after 10
minutes and after 5 wrong attempts; a client test renders fixture answers and
posts containing `<script>`, `<img onerror>`, `javascript:` links and a remote
image, and the DOM holds none of them; a Tauri test that no command returns
the token.

## 13. Threat notes

- **Name probing through CONFLICT.** Uniqueness across all channels lets
  anyone learn that a private channel with a given name exists, and then read
  its landing (§3.5). Accepted (`AGENTS.md`, `R10`). The Private option's
  help text says so (§4.1).
- **Invite code enumeration.** `auth.checkInvite` reveals an inviter's name
  for a valid code. Mitigations: 50-bit codes, one answer for every failure,
  the per-IP and per-user limits, and an alert on failed checks above 100 per
  hour (`05` §4). At 10 failures per hour per IP, a 50-bit space with at most
  a few thousand open codes takes on the order of 10^8 IP-hours per hit.
- **Invite link leakage.** Account and channel codes are one-use and travel
  in fragments. A leaked account link admits one person, who appears under
  the inviter in the tree; the inviter can revoke open links at any time, and
  an admin can suspend the account it created (§3.6).
- **Handle enumeration.** Handles are public by design (bylines, the tree);
  the availability check is rate-limited only to bound load.
- **Report abuse.** One open report per reporter and item, 20 per hour,
  coalesced staff notifications (§6.1), reports only from channel members,
  and reporters visible to staff, who can ban a reporter who abuses reports.
- **Moderator exposure.** "Removed by @mod" names the moderator to every
  reader, as the mockup decides; staff can ban members who harass them.
- **Cursor tokens.** Cursors and SSE ids are AEAD tokens holding log, reader,
  version, serve time and epoch; no version reaches a client. The key is
  configured, the previous key accepted for 30 days. A forged token, another
  reader's, or another server's resyncs (`inv3`, `T1`), so a stolen cursor
  gives its holder nothing. A rotation runbook goes into `web/docs/runbooks/`.
- **CORS allowlist.** A wildcard would let any page make bearer requests to
  the API; hence exact origins, the boot check, and no credentialed CORS
  (Z4).
- **Token theft.** A device token is held by the Rust side and the Keychain
  item is bound to the app's signing identity (Z3); a web session cookie is
  `HttpOnly`. XSS in rendered answers or posts is the main path to acting as
  a user, which Z5 and the CSP address. A stolen Mac: the replica and frozen
  copies rely on FileVault; revocation stops further reads and wipes the
  replica on the next connection, but cannot erase a copy read offline.
- **CSRF.** Cookie requests need a same-origin `Origin`/`Sec-Fetch-Site` and
  the custom header; sync GETs are guarded too (Z2). Login CSRF is prevented
  by the single-use `oauth_states` row bound to the state cookie.
- **Client-computed state.** Envelopes with extra fields or client-computed
  values are refused (`inv1`); mutation ids are scoped per user (`inv5`);
  stored times and list order are the server's, so a forged ULID time cannot
  reorder a feed (`R13`).

## 14. Dependencies

- `01-architecture-and-data.md`: server half, record kinds and audiences,
  C1, C8–C14, S1–S3, D2, D3, D4, U6, Y3, Y8.
- `02-client-app.md`: the dialogs and pages named here (channel info, edit,
  member list, moderation log, remove/report, members page, invite flow,
  frozen-channel banner).
- `03-agents-and-research.md`: run cancellation on removal; run limits;
  answers stored as Markdown (§1).
- `05-delivery.md`: M4 schedules I5, B1, B3 and P1; M6 schedules the other
  I, B, O and P items and Z1, Z2, Z4, Z5; M7a schedules Z3; M3 makes the conformance suites that most acceptance checks
  here rely on.

## 15. Open questions

1. Decided: the removal placeholder shows "[deleted]" for the author; `u` is
   served to the author only (§6.2). replica-proto's `erase` and `redact`
   serve `u` to every reader today; `01` U6 changes that.
2. Does a removal placeholder stay until the author deletes it, or expire (for
   example after 90 days)?
3. Account invite codes: the mockup's 30-bit `SESS-XXXX-XX` or 50-bit
   `SESS-XXXXX-XXXXX`?
4. Can a member see an open code again after creating it? Proposed in §3.1:
   yes, from `code_enc`, readable only by its creator and cleared on use or
   revoke.
5. Does the desktop keep a frozen copy after a voluntary Leave? Proposed: no.
6. Site-wide moderators (the mockup's "mod" tag in the tree), or only
   `users.is_admin`?
7. Sign in with X in addition to or instead of GitHub (ADR-5).
8. How long does a waiting account live without a code (proposed 14 days),
   and how many may one IP create (proposed 5 per day)?
9. Report and remove follow-ups and replies individually at launch?
10. Offer Hide to staff, given the server supports it?
