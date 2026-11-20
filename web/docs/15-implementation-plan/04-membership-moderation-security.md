# 04 — Membership, moderation and security

Status: draft. This file covers who may join Session, how channels admit and
rank their members, how a channel's staff moderate it, what the server serves
to whom, and the limits and authentication the server applies. It schedules
work against the rules fixed in `AGENTS.md` ("Planned: desktop client and sync
core"), ADR-19 to ADR-22 and `web/packages/shared/src/schemas/spaces.ts`, and
records where the members mockup (`docs/mockups/session-web-members.html`)
adds to them or disagrees with them. The server half, record kinds and
contract changes are specified in `01-architecture-and-data.md` (cited as
`01` with its item ids: S1–S4, D1–D6, C1–C14); runs, allowances and device
runs in `03-agents-and-research.md`. This file names what it needs from them
and does not redesign them.

Terms: "channel" is the product word; code and wire keep `space`. "Staff" of
a channel means its owner, admins and moderators (`RANK >= mod` in
`replica-proto/src/access.ts`). Test names in parentheses (`inv2`, `R11`, …)
are replica-proto tests that the real server half must pass (`05-delivery.md`,
M3).

## 1. Precedence and conflicts

| Topic | Mockup | Decision | Reason |
|---|---|---|---|
| Sign-in provider | Sign in with X; a Session handle chosen at sign-up | GitHub OAuth (ADR-5, `06-auth-and-users.md`); the handle step is kept | ADR-5 is in force; the overview records no provider decision. X is question 7. |
| Account without an invite | "Continue without one" creates a `waiting` member who reads open channels | A `users` row with `status: "waiting"` (`01` C8), which owns nothing and cannot write | The overview records invite-only membership; this amends `06` §3 ("an account is created only against a code"), whose purpose, no writes and no spend without a code, still holds. |
| Moderators | `isMod` is the owner only | Staff per `spaceMemberRoleSchema` and the phase 0 read rules; the client adds "Make moderator" | The schema and replica-proto define the roles. `01` question 5 asks whether v1 grants them; this plan proposes yes (§4.3). |
| Hide | Not offered | Server keeps `hidden`; no Hide command at launch | Phase 0 rules and suites cover it. |
| Ban | Not offered | Offered to staff | `AGENTS.md`: removal in an open space is STALE after leave and rejoin; "the UI offers ban as the tool there". |
| Report and removal text | One optional free-text field each | `reports.create { item, note? }`; `moderation.decide { …, note? }` (`01` C12) | Overview product decision. |
| Moderation log excerpt | Quotes a removed thread's title | No text of a removed item | `AGENTS.md`: removed content is erased and never served again (`01` C12 agrees). |
| Channel rules | Removed | Client never sends `rules`; no default rule is stored | Overview product decision. |
| Visibility | Open or Private | Wire `vis: "open" \| "private"`; private is closed, unlisted and invite-only (`01` C9) | Matches the product; the closed-space rules of phase 0 apply unchanged. |
| Private admission | "Ask @owner to add you"; no add flow drawn | Staff-made one-use channel invite links | The contract and phase 0 define them (`inv2`). |
| Join requests | Absent | Deferred (`01` C10); their prototype tests stay in the suite | `01` question 6. |

## 2. Two kinds of invitation

The mockup uses one word for two mechanisms; they are separate records with
separate limits.

1. **Account invites** admit a person to Session. Each active member holds at
   most 3 open links; redeeming one activates the account and records the
   inviter. They extend the existing sign-up codes (`invites`,
   `users.invited_by`, `02-domain-model-and-database.md` §3.1; `01` C8, D3) and
   are online-only tRPC calls (ADR-19), not replicated records.
2. **Channel invite links** admit an active account to a private channel. They
   are the replicated `links` records (`threadInviteSchema`) made by
   `invites.create` and consumed by `spaces.join { invite }`. They do not count
   against the 3 account-invite slots.

## 3. Account invites and access to Session

### 3.1 Records

In `web/packages/db` (schema, migration) and `web/packages/server`:

- Account invites (`01` C8): ULID `id`, `code_hash` (SHA-256; the code itself
  is not stored, see question 4), `created_by`, `created_at`, `used_by`,
  `used_at`, `revoked_at`. `users.invites_remaining` is dropped in favour of
  the open-slot rule.
- `users.status`: `waiting | active` (`01` C8). `users.handle` (unique,
  `^[a-z0-9._]{3,20}$`, the mockup's rule) and `users.display_name`. Handles
  are the values of `spaceHandleSchema` and are never reused.
- A waiting account owns no records, has no user log, cannot register a sync
  client for writing, and is deleted by the maintenance sweep 14 days after
  creation unless redeemed (question 8).

Acceptance: `packages/db/test/invites.test.ts`: hash lookup; two concurrent
redemptions of one code, one succeeds and one gets `CONFLICT`; handle
uniqueness; the waiting-account sweep.

### 3.2 Making, listing and revoking links

tRPC `accountInvites.*` (`01` §6), active accounts only:

- `list`: the caller's links (`open | used | revoked`), who used each, and
  "You invited" (accounts whose `invited_by` is the caller), newest first.
- `create`: `PRECONDITION_FAILED` when the caller has 3 open links. Count and
  insert run in one transaction, so concurrent creates cannot reach 4. Returns
  the code once. Admins (`users.is_admin`) are exempt, so the tree's roots can
  seed it.
- `revoke`: the caller's own open link; frees the slot. No restore.
- Codes come from a CSPRNG over the mockup's alphabet (no `0`, `O`, `1`, `I`).
  The mockup's `SESS-XXXX-XX` holds 30 bits; this plan proposes
  `SESS-XXXXX-XXXXX` (50 bits), question 3. The link is
  `https://session.dev/i#<code>`: the code stays in the fragment and out of
  request lines, logs and `Referer`, as the earlier `/invite#<token>` design
  did (`12` §3.5). The code field also accepts a pasted `/i/<code>` or a bare
  code (the mockup strips up to the last `/`).

The members page (`membersPage`, `invSection`) shows "N of 3 left", each open
link with Copy and revoke, "Create an invite link", and "You invited"; a
waiting account sees "You can invite once your account is active."

Acceptance: server tests for 3 open and a 4th refused, revoke and use each
freeing a slot, two concurrent creates at 2 open, the admin exemption; a
client test that the button becomes the explanation at 3 open.

### 3.3 Invite tree

`members.tree` (`01` §6, online-only) returns active accounts as `{ handle,
displayName, avatar, invitedBy, joinedAt, staff }`; `staff` is `admin` for
`users.is_admin`. The client draws it as `treeA` (depth-first from the roots,
children by `joinedAt`). The mockup's account-level "mod" tag has no server
counterpart and is dropped unless question 6 adds the role.

`01` C8 leaves the tree's visibility to this file. Decision: active members
see the whole tree (handles, display names, inviter edges); waiting accounts
and signed-out readers get `FORBIDDEN`/`UNAUTHORIZED`. The tree is the main
tool for tracing an abusive account to its inviter (§10), which argues for
showing it to members. Above 5,000 nodes, subtrees load on expand.

Acceptance: server test for the refusals; client test rendering a 12-account
fixture in the mockup's order.

### 3.4 The "Join with invite?" step

Flows from `authScreen`:

- **From a link.** `/i#<code>` keeps the code in memory and opens the sign-in
  dialog. `auth.checkInvite { code }` (public, rate-limited, §10) answers
  `open` with the inviter's display name and handle, or one `unusable` answer
  for used, revoked and unknown codes. The mockup's three distinct error
  strings are merged so a probe cannot separate a used code from a made-up one
  (§13). The dialog shows "<name> invited you to Session".
- **Code step** (`CODE_COPY`): "Join with invite?", "Paste the code or link a
  member sent you.", "Continue"; on `open`, "Invite from <name>" and the
  sign-in button.
- **OAuth callback.** The code travels in the `oauth_states` row, never in a
  URL. An existing account signs in and the code is untouched. A new identity
  with a valid code goes to the profile step (name, handle, the Session-wide
  community-rules checkbox; these are a static page, not channel rules), and
  `account.create` redeems the code and creates an active account in one
  transaction. A new identity without a code becomes a waiting account.
- **Waiting accounts** see the mockup's "Invite required" page with the redeem
  form, read like signed-out readers, and any write control explains that an
  invite is needed. Redeeming activates the account and sets `invited_by`.

Acceptance: `e2e/invites.spec.ts` (new): a member creates a link; a second
context opens it signed out, completes the test sign-in
(`SESSION_TEST_AUTH=1`) and the profile step, and appears in the first
member's "You invited" and tree; a third context signs in without a code,
reads an open channel, cannot ask, redeems a code on the status page and can
ask; a used code shows "This invite link no longer works".

### 3.5 Signed-out and waiting readers

They read every open channel with its threads, branches, replies and member
list, and the landing of a private channel reached by its id (name,
description, owner, member count; `inv3`: "a signed-out caller gets open
spaces and the landings of closed ones"). The scope picker offers only "All"
(`SCOPES`). Write controls open the sign-in dialog or the invite page; the
server refuses the write regardless (`inv1`). Browse and "All" list open
channels plus the reader's own private channels (`allVisible`); no listing
(`spaces.directory`, `01` C7) returns a private channel to a non-member.

## 4. Channels

### 4.1 Visibility

| Mockup | Wire (`01` C9) | Who reads content | Who joins |
|---|---|---|---|
| Open | `vis: "open"` | Anyone, signed out included | Any active account (`spaces.join`) |
| Private | `vis: "private"` | Members only | Holders of a channel invite link |

Visibility is set at creation (`01` C11); there is no control to change it.

### 4.2 Names and creation

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

### 4.3 Roles

Roles are `owner`, `admin`, `mod`, `member`. The client assigns only `mod` and
`member`; `admin` stays valid on the wire and in the suites but no screen
grants it.

| Action | Member | Mod | Owner |
|---|---|---|---|
| Read, ask, post, reply, save | yes | yes | yes |
| Report a thread | yes | — | — |
| Remove a thread, dismiss a report, read the moderation log | | yes | yes |
| Ban and unban; remove a member ranked below (private channels) | | yes | yes |
| Make channel invite links | | yes | yes |
| Edit About (`01` C11: owner only) | | | yes |
| Make or remove moderators; transfer ownership | | | yes |

Work items:
- Channel info gains a Members row opening the member list (owner, staff,
  then members by `joinedAt`). Staff get a per-row menu: Ban, and in private
  channels Remove from channel. The owner also gets Make moderator / Remove
  moderator and Transfer ownership. These controls are additions to the
  mockup; if `01` question 5 drops moderators from v1, the owner is the only
  staff and nothing else here changes.
- `members.setRole` carries `base.rev` and answers STALE on a changed member
  record; `members.remove` compares the admission id (`AGENTS.md`; `inv2`,
  `R1b`).
- The sole owner cannot leave (`spaces.leave` answers `PRECONDITION_FAILED`);
  the confirmation says to transfer ownership first.

Acceptance: client tests for the menu items each role sees; `inv2` and the
`review-r1` ownership-transfer test on the server.

### 4.4 Channel info and About

`chInfoDlg`: glyph, name, lock for private, About, "Channel by @owner",
member count, the visibility sentence ("Private: only members can read or
post" / "Open: anyone can read and join"), and for staff "Moderation log (N
open)". The owner's Edit opens `chEditDlg` with About only, at most 300
characters.

- Save sends `spaces.update { id, desc }` (`01` C11). The server trims,
  bounds (`BAD_REQUEST` above 300, recorded, per `R8`) and checks ownership at
  apply time. No `base`: one person edits, so a second device's save
  overwrites.
- An empty About shows "No description yet. Add one" to the owner, nothing to
  others.

Acceptance: client test that only the owner sees Edit and the length error;
a step in `e2e/moderation.spec.ts` where a member's open channel info shows
the new About without a reload.

## 5. Channel invite links

- Staff: channel info → "Invite to #name" → a one-use link
  `https://session.dev/c/<space id>#<code>` with Copy; default expiry 7 days
  (`invites.create { days: 7 }`); the server makes the code (`inv4`). Revoke
  and Undo use `invites.revoke` and `invites.restore`.
- An active account opening the link calls `spaces.join { space, invite }`; a
  signed-out or waiting reader goes through §3.4 first.
- A link works only while its maker may make links, and again once the maker
  regains the right; expiry is checked at apply time (`inv2`, three tests). A
  banned person cannot join with a link (`review-r1`, ban test).
- Limits: 20 links per user per day; 50 open per channel.

Acceptance: in `e2e/moderation.spec.ts`, the owner of a private channel copies
a link, a second account opens it and reads the channel, a third account using
the same link gets "This invite link has expired or was already used."

## 6. Moderation

### 6.1 Reporting

- Non-staff members: "Report…" (`reportopen`) opens `rmDlg` in report mode:
  the clipped title, "What is wrong with it?" (optional), and "Reports go to
  the moderators of #name. @author is not told who reported." (The mockup
  names the owner; with moderators the copy names the channel.)
- `reports.create { item: "thread:<id>", note? }`, note at most 500
  characters (`01` C12). One open report per (reporter, item): a second
  answers `PRECONDITION_FAILED` and the dialog says "You already reported
  this."
- Threads only at launch; follow-ups and replies have moderation keys and can
  follow (question 9).
- A report is readable by its reporter and the channel's staff; staff are
  notified, and the notification is served only while they are staff (`R4c`,
  `H2`).

### 6.2 Removing

- Staff: "Remove…" (`rmopen`) in the thread menu and the moderation log;
  `rmDlg` in remove mode: "Reason, shown with the removal" (optional, at most
  300 characters) and "Readers see that it was removed. Branches and replies
  under it go with it."
- `moderation.decide { item, decision: "removed", note? }` or
  `reports.resolve { report, outcome: "removed", note? }`. Either resolves
  every open report on the item as `removed`, sends `report_resolved` to each
  reporter, and writes a `modlog` entry.
- The thread's content and everything under it (follow-ups, replies,
  branches, runs and turns, its counts record, saves and likes of it) are
  erased in the same commit (`inv6`, `R5`). A run in progress ends and writes
  nothing after the removal (`03-agents-and-research.md`). Per `01` C12 the
  placeholder keeps `mod`, `modBy` and `modNote` and nothing else, and renders
  "Removed by @mod", "Reason: “…”", and "Ask in #name" or "Post in #name". The
  mockup also prints the author's handle; that is question 1.
- Not reversible: the content no longer exists. `reports.resolve { outcome:
  "open" }` after a removal reopens the report only.
- `removed`, `hidden`, `decline` and `members.ban` apply to the record as it
  is, without `base` (`AGENTS.md`; `H1`). Removing an already removed item is
  a no-op success. The author may still delete a removed thread (`R11`),
  which deletes the placeholder.
- Placeholder lifetime: until the author deletes it or the channel is
  deleted; tombstones of the erased records are pruned after 30 days
  regardless (question 2).

### 6.3 Hiding

`moderation.decide { decision: "hidden" | "shown" }` and the hidden-text rules
stay implemented and tested (`inv6`: hidden text to the author and staff; a
demoted moderator stops getting it). `shown` carries `base.rev` and answers
STALE when the author edited after the moderator read it (`R2`). The client
renders hidden items (author and staff see the text under "Hidden by
moderators"; others the placeholder) but offers no Hide command (question 10).

### 6.4 Banning

- Staff: "Ban from #name" on another person's thread menu and in the member
  list; a Banned list with Unban in channel info.
- `members.ban` removes any membership and adds the ban. A ban stops every
  write in the channel, the person's own included (`inv2`). In an open channel
  the banned person can still read, because open content is readable by
  anyone.
- Remove from channel is offered only in private channels. In open channels it
  would be STALE after the person leaves and rejoins (`AGENTS.md`), so Ban is
  the tool there.

### 6.5 Moderation log

`modLogDlg`: tabs "Open reports (N)" and "Everything"; each entry shows the
kind (Report, Dismissed, Removed), "@reporter reported @author's ask" or
"@mod removed @author's ask", the note, and the relative time; open reports
carry Dismiss and Remove.

- Data: the channel's reports plus the staff-only `modlog` record kind of
  `01` C12 (`{ id, sp, kind, item, by, author, note, at }`). This file asks
  `01` to add `ban` and `unban` to `kind`, with `item` absent and `author`
  naming the banned person.
- An entry shows the item's current title only when the item exists in the
  reader's replica. For a removed item it shows kind, author and channel.
- Dismiss sends `reports.resolve { outcome: "dismissed" }`; the reporter gets
  `report_resolved` with that outcome.
- "(N open)" counts open reports in the replica. `modlog` entries and resolved
  reports are kept 180 days.

### 6.6 Acceptance

- replica-proto `inv2`, `inv6`, `review-r1`, `review-r2` against the real
  server half (M3).
- `@session/mutators` tests: note bounds; one open report per reporter and
  item; a removal resolves every open report on the item; the placeholder
  holds no field of the removed content.
- `e2e/moderation.spec.ts`: a member reports a thread with a note; the owner's
  channel info shows "Moderation log (1 open)" without a reload; the owner
  removes it with a reason; the member's feed shows the placeholder with the
  reason and no text, also after a reload; a second report is dismissed and
  the reporter sees the resolved notification; the owner bans a member of an
  open channel and that member's Ask is refused with the ban message.
- The storage scan of `01` D4 after a removal: the question text appears
  nowhere in the SQLite file.

## 7. Saved threads and user logs

Saves, likes and notifications live in the user's own log and follow current
access (`AGENTS.md`; `inv7`):

- A save is served only while its owner may read the thread's channel.
  Losing access to a private channel removes those saves from Saved; regaining
  it brings them back, because the records were kept and only serving stopped
  (`R4a`: no deletions reach a removed member's log).
- A removed thread's saves and likes are erased with it.
- The Saved count is computed on the client from the user log.
- Report notifications are served only while the person is staff.

Acceptance: a client test that Saved's count drops when a resync removes a
channel's saves; `R4a`, `R4c`, `H2`.

## 8. Privacy

- **Erasure.** Removed content is erased and never served again, also not
  through cursors made before the removal (`inv6`: "an old cursor resyncs into
  the current state"). Tombstones keep key, kind, audience fields and rev.
  Effects carry ids, not text. Litestream generations hold the text until they
  expire; the bound and the privacy copy are `01` question 3.
- **Hidden text** goes to its author and the channel's staff only.
- **Frozen copy.** A member removed from a private channel keeps the copy on
  their desktop, frozen: the server serves them nothing further from it, but
  they can still delete their own threads there (`inv3` frozen-copy test;
  `R4b`: the delete answers `null` and reveals nothing about later replies).
  The client marks the channel "You are no longer a member of #name. This is
  the copy on this device." and offers only Delete on the person's own
  threads. The web client has no frozen copy after a reload. On a voluntary
  Leave the desktop drops the copy (question 5).
- **Reporter identity** goes to the reporter and staff only.
- **No existence oracle.** A missing target and one the caller may not read
  answer the same; an id collision answers the same `CONFLICT` whether or not
  the caller can read the record (`inv4`).
- **Account deletion** stays an operator job (`06` §7); with spaces it erases
  the person's threads through the removal path and keeps their handle
  reserved.

## 9. Permissions at apply time

Every check runs when the server applies the envelope, against its own state
(`inv2`). The client predicts with the same mutator, so a write the replica
already knows to be forbidden is refused locally; one that becomes forbidden
while queued is refused by the server, recorded under its seq, and rolled
back. The client renders:

- a demoted moderator's queued removal: "You are no longer a moderator of
  #name.";
- a removed or banned member's queued post: refused, with the composer text
  restored from the outbox entry;
- a channel link whose maker lost the right: the expired-link message;
- STALE on a role change or `shown`: the target is reloaded and the person
  acts again.

Recorded refusals are shown at once; transient answers retry with backoff,
and a write failing 5 times is shown while the rest of the outbox continues
(`R7`, `Q3`). Acceptance: `inv2` on the server; `@session/sync` client tests
for each rollback and the text restoration.

## 10. Abuse limits

Defaults, as server settings. Rate refusals answer `TOO_MANY_REQUESTS`
unrecorded, and the client backs off (`R15`, `N10`).

| Limit | Default | Where |
|---|---|---|
| Replicated writes | 60/min per user (the existing mutation bucket) | `/api/sync` (`01` S1) |
| `reports.create` | 20/hour per user | `pre` stage |
| `accountInvites.create` | 3 open; 10 created per day | procedure |
| `auth.checkInvite`, redemption | 20/min per IP (the `/auth/*` bucket); 10 failed checks per hour per IP | Hono middleware |
| `spaces.create` | 5/day per user | `pre` |
| `invites.create` (channel) | 20/day per user; 50 open per channel | `pre` |
| `spaces.join` | 60/hour per user | `pre` |
| Client registration | 20/day per user (`S2`) | sync server |
| Envelope size | `TOO_LARGE` above the maximum, unrecorded | `/api/sync` |
| Text | About 300, removal note 300, report note 500 characters; `BAD_REQUEST`, recorded (`R8`) | input schemas |
| Runs | Weekly allowance, 20 queued per user, 100 device runs/hour, 200 KB per device answer | `03-agents-and-research.md` |

Buckets are in memory in the single process (`06` §8). The invite tree lets
an admin find who invited an abusive account; revoking that member's open
links is an admin action in `/admin`.

## 11. Contract items this file depends on

Made by `01`: C8 (account invites, `status`, `members.tree`), C9 (`vis:
"private"`), C10 (join requests deferred), C11 (`spaces.update { id, desc }`,
owner only), C12 (report and removal notes, `modlog`). Requested here in
addition: `ban` and `unban` `modlog` kinds; one open report per reporter and
item; the `pre`-stage limits in §10; `auth.checkInvite` with a single
`unusable` answer; no default rules on `spaces.create`.

## 12. Authentication

- **Web**: GitHub OAuth with PKCE and database sessions (`06`): cookie
  `HttpOnly; Secure; SameSite=Lax`, 30 days idle, 90 absolute; `Origin` and
  `X-Requested-With` checks on cookie requests. Logout ends the streams opened
  with the session.
- **Desktop**: a bearer device token, 256 random bits, stored hashed in
  `device_tokens` and in the macOS Keychain under the app's
  `dev.session.desktop` identity, issued through a one-time pairing code from
  a signed-in web session and revocable from the account menu (`01` S2). A
  revoked token answers `401`, and its streams end within 60 seconds (the
  session check of `06` §2).
- **One replica per user.** Sign-out on the desktop deletes the replica
  database and outbox; an outbox queued by one person and flushed after
  another signs in is refused (`inv7`). The sync client id is registered
  under the token's user.
- **CORS**: an allowlist of exact desktop origins (`01` S2), parsed at boot;
  boot refuses `*`. Cookie requests stay same-origin. Bearer requests skip the
  cookie CSRF checks because a browser never attaches the token by itself.

Acceptance: `01` S1 and S2 tests, plus: a revoked token's open stream ends; a
cookie request from a foreign origin is refused.

## 13. Threat notes

- **Name probing through CONFLICT.** Uniqueness across all channels lets
  anyone learn that a private channel with a given name exists. Accepted
  (`AGENTS.md`, `R10`). The Private option's help text says "Channel names are
  visible to anyone who tries the same name."
- **Invite code enumeration.** `auth.checkInvite` reveals an inviter's name
  for a valid code. Mitigations: 50-bit codes, one answer for every failure,
  the per-IP limits, and an alert on failed checks (`05-delivery.md` §4).
- **Cursor tokens.** Cursors and SSE ids are AEAD tokens holding log, reader,
  version, serve time and epoch; no version reaches a client. The key is
  configured, the previous key accepted for 30 days. A forged token, another
  reader's, or another server's resyncs (`inv3`, `T1`). A rotation runbook
  goes into `web/docs/runbooks/`.
- **CORS allowlist.** A wildcard would expose bearer endpoints to any page
  holding a token; hence exact origins and the boot check.
- **Device theft.** The Keychain item is bound to the app's signing identity;
  the replica and frozen copies rely on FileVault. Revocation stops further
  reads but cannot erase the local copy.
- **Client-computed state.** Envelopes with extra fields or client-computed
  values are refused (`inv1`); mutation ids are scoped per user (`inv5`);
  stored times and list order are the server's, so a forged ULID time cannot
  reorder a feed (`R13`).

## 14. Dependencies

- `01-architecture-and-data.md`: server half, record kinds and audiences,
  C8–C12, S1–S2, D4.
- `02-client-app.md`: the dialogs and pages named here (channel info, edit,
  member list, moderation log, remove/report, members page, invite flow,
  frozen-channel banner).
- `03-agents-and-research.md`: run cancellation on removal; run limits.
- `05-delivery.md`: M6 schedules this file; M3 makes the conformance suites
  that most acceptance checks here rely on.

## 15. Open questions

1. Does the removal placeholder show the author's handle, as the mockup does?
   `01` C12 keeps the author on the `modlog` entry (staff only) but not on the
   placeholder.
2. Does a removal placeholder stay until the author deletes it, or expire (for
   example after 90 days)?
3. Account invite codes: the mockup's 30-bit `SESS-XXXX-XX` or 50-bit
   `SESS-XXXXX-XXXXX`?
4. Can a member see an open code again after creating it? That needs the code
   stored reversibly; the plan stores only its hash.
5. Does the desktop keep a frozen copy after a voluntary Leave? Proposed: no.
6. Site-wide moderators (the mockup's "mod" tag in the tree), or only
   `users.is_admin`?
7. Sign in with X in addition to or instead of GitHub (ADR-5).
8. How long does a waiting account live without a code (proposed 14 days),
   and does it count toward per-IP sign-up throttling?
9. Report and remove follow-ups and replies individually at launch?
10. Offer Hide to staff, given the server supports it?
