# 04 — Membership, moderation and security

Status: draft. This file covers who may join Session, how channels admit
their members, how a channel's owner moderates it, what the server serves
to whom, and the limits and authentication the server applies. It schedules
work against the rules fixed in `AGENTS.md` ("Planned: desktop client and sync
core"), ADR-19 to ADR-22 and `web/packages/shared/src/schemas/spaces.ts`, and
records where the members mockup (`docs/mockups/session-web-members.html`)
adds to them or disagrees with them. The server half, record kinds and
contract changes are specified in `01-architecture-and-data.md` (cited as
`01` with its item ids, always prefixed: `01` S2, `01` C12); runs, allowances
in `03-agents-and-research.md`. This file names what it needs from them and
does not redesign them.

Scope: web only (`00-overview.md`, "Scope of this build"). Desktop
authentication (device tokens, pairing, the desktop CORS origin) is not
built. There is no reporting (`05` §6 P6) and no suspension: site admins
have no Session-wide sanction short of deleting an account or a channel by
operator job (`05` §6 P3). Items that existed only for those keep their ids
and are marked "(removed: web-only build)", "(removed: no reporting)" or
"(removed: no suspension)".

Terms: "channel" is the product word; code and wire keep `space`. A channel
has exactly one owner and everyone else in it is a member; there are no
admins or moderators and ownership is not transferable (`01` C18, product
decision). "Site admin" means an account with `users.is_admin`, which runs
Session; it is not a channel role. Test names in parentheses (`inv2`, `R11`,
`H2`, …) without a file prefix are replica-proto tests that the real server
half must pass (`05-delivery.md`, M3); `R…` and `S…` there are the
`review-r1` and `review-r2` test ids, not `01`'s replication or server items.
`review-r2`'s `Q…` tests are always cited with the suite name, so they are
not read as `05` §6's questions.

Work items have ids `I` (accounts and invites), `B` (channels and ownership), `O`
(moderation), `P` (privacy and user logs) and `Z` (limits, authentication,
client security), so that `05-delivery.md` (M4 and M6) can schedule them.

## 1. Precedence and conflicts

| Topic | Mockup | Decision | Reason |
|---|---|---|---|
| Sign-in provider | Sign in with X; a Session handle chosen at sign-up | GitHub and X, both offered from launch (`05` §6 P1, Q8); an account is created with one provider and stays bound to it: no linking of a second provider and no merging of accounts; the handle step is kept | Product decision; amends ADR-5, which names GitHub only (§12 Z2). |
| Account without an invite | "Continue without one" creates a `waiting` member who reads open channels | A `users` row with `status: "waiting"` (`01` C8), with no handle, which owns nothing and cannot write | The overview records invite-only membership. This replaces `06` §3 and the current callback, which deletes a new account whose code fails (`auth/github.ts`); the purpose, no writes and no spend without a code, still holds. |
| Moderators | `isMod` is the owner only | The owner is the only person who moderates a channel; no moderator role and no "Make moderator" (`01` C18) | Product decision (00); agrees with the mockup. The schema's and replica-proto's `mod` role is removed (`01` U6). |
| Admin role and ownership transfer | Absent | Removed: no `admin` role, no `members.setRole`, ownership is not transferable (`01` C18) | Product decision (00). |
| Hide | Not offered | Server keeps `hidden`; no Hide command (`05` §6 P7) | Phase 0 rules and suites cover it. |
| Ban | Not offered (ban entries appear only in the moderation log's fixtures) | Offered to the owner, with unban and a Banned list; a plan addition | `AGENTS.md`: removal in an open space is STALE after leave and rejoin; "the UI offers ban as the tool there". |
| Removal text | One optional free-text field | `moderation.decide { …, note? }` (`01` C12) | Overview product decision. |
| Reporting | None: no Report… item, and the moderation log lists removals and bans only | Not built: no `reports.*`, no report notifications, no report part of the moderation log, no report limits | Agrees with the mockup (`05` §6 P6). The owner's Remove stays; Ban is a plan addition (Ban row). |
| Abuse contact | Site footer "Session · Report abuse: abuse@session.dev" on every feed and page | No site footer: the mailbox `abuse@<host>`, where `<host>` is the hostname of `SESSION_PUBLIC_ORIGIN`, exists and the site admins read it, but the app no longer links it (`05` §6 Q10) | The only way to reach site admins about abuse (§13). |
| Session-wide sanction | None | None: no suspension. Site admins delete an account or a channel by operator job (§8, §4.5) and use the invite tree (§3.3) | Product decision (`05` §6 P3). |
| Removal placeholder | "Removed by @mod", "Reason: …", "Ask by @author in #channel" | The author is withheld: "Removed by the channel owner", "Ask in #channel" (product decision); §6.2 lists exactly what is stored and served | `AGENTS.md` erases content (text and everything under the thread), not the record's attribution; replica-proto's `erase` and `redact` keep `u` on the placeholder. |
| Moderation log excerpt | Quotes a removed thread's title | No text of a removed item | `AGENTS.md`: removed content is erased and never served again (`01` C12 agrees). |
| Channel rules | Removed | Client never sends `rules`; no default rule is stored | Overview product decision. |
| Visibility | Open or Private | Wire `vis: "open" \| "private"`; private is closed, unlisted and invite-only (`01` C9) | Matches the product; the closed-space rules of phase 0 apply unchanged. |
| Private admission | "Ask @owner to add you"; no add flow drawn | One-use channel invite links made by the owner | The contract and phase 0 define them (`inv2`, `inv4`). |
| Join requests | Absent | Not built (`05` §6 P4; `01` C10); their prototype tests stay in the suite | Private channels admit through channel invite links only. |
| Channel deletion | Absent | Not offered at launch; `spaces.delete` stays out of `@session/mutators` v1; a site admin deletes a channel by operator job (§4.5), the only site-admin action on a channel | Nothing in the mockup draws it. |
| Invite link form | `session.app/i/<code>` (code in the path) | `<SESSION_PUBLIC_ORIGIN>/i#<code>` (code in the fragment); a pasted path form is still parsed | A path puts the code in request lines, access logs and `Referer` (§3.2). |
| Showing an open code again | Every open link has Copy | Kept: the code is stored encrypted for its creator until used or revoked (§3.1) | Resolves question 4. |

## 2. Two kinds of invitation

The mockup uses one word for two mechanisms; they are separate records with
separate limits.

1. **Account invites** admit a person to Session. Each active member gets 3
   invites in all (`SESSION_INVITES_PER_MEMBER`), plus any a site admin
   gives them (§3.2); redeeming one activates the account and records the
   inviter. They extend the existing sign-up codes (`invites`,
   `users.invited_by`, `02-domain-model-and-database.md` §3.1; `01` C8) and
   are online-only tRPC calls (ADR-19), not replicated records.
2. **Channel invite links** admit an active account to a private channel. They
   are the replicated `invite` records (`threadInviteSchema`) made by
   `invites.create` and consumed by `spaces.join { invite }`. They do not count
   against a member's account invites.

## 3. Account invites and access to Session

### 3.1 Records

**I1.** In `web/packages/db` (schema, migration) and `web/packages/server`:

- Account invites, on the existing `invites` table (`01` C8, D3): ULID
  `id`, `code_hash` (SHA-256 of the normalized code, unique), `code_enc`
  (AES-256-GCM under `SESSION_SECRET_KEY`, `01` S3; set to null when the
  link is used or revoked), `created_by`, `created_at`, `used_by`, `used_at`, `revoked_at`.
  Today the table stores `code` in plain text and `redeemInvite` matches on
  it (`db/src/repos/auth.ts`); the migration hashes existing codes and drops
  the column. `users.invites_remaining` is dropped: a member's invites are
  counted from their links (§3.2), and the invites site admins gave them are
  `user_limits.extra_invites` (integer, not null, default 0; `01` §2).
- `users.status`: `waiting | active` (`01` C8; there is no `suspended`,
  §3.6). Sign-in identity (`05` §6 P1): `github_id` becomes `provider`
  (`github` or `x`) and `provider_user_id`, unique together; `login` is the
  provider's username, shown nowhere and unique nowhere;
  `github_created_at` becomes `provider_created_at` (the account-age check
  of `06` §3 applies to both providers). An identity belongs to one account
  for its lifetime; there is no second identity per account and no merge.
  `users.email` holds the email address the provider returns, updated on
  every sign-in (null when the provider returns none); it is not unique,
  and emails are never used to match, deduplicate or merge accounts
  (decided, `05` §6 Q7). `users.handle`
  (unique, `^[a-z0-9._]{3,20}$`, the mockup's rule, null while waiting) and `users.display_name`. Handles are the values of
  `spaceHandleSchema` and are never reused; a waiting account gets no handle,
  so the sweep below cannot be used to reserve handles. Account deletion
  (§8) sets `provider` and `provider_user_id` to null and keeps the row with
  its handle, so the handle stays reserved and the same provider identity
  can sign in again as a new waiting account.
- Site admins are set by handle: `npm run db:admin -- <handle>` sets
  `users.is_admin` on the active account with that handle (handles are
  unique; `login` is not). After the wipe there is no active account to
  invite the first admins, so `npm run db:admin -- --invite` prints one root
  account invite (`created_by` null); each person who runs Session redeems
  one, chooses a handle at the profile step and is then promoted by handle
  (`05` §3.5, Q6). These columns, the migration and the command are built
  in M6 with the rest of I1.
- A waiting account owns no records, has no user log, cannot register a sync
  client for writing, and is deleted by the maintenance sweep 90 days after
  creation unless redeemed (decision S4). Waiting accounts created per IP
  key (§10: the hashed address, or its /64 prefix for IPv6) are counted in `signup_attempts` (outcome `waiting`); above 5 per IP per
  day the callback answers the sign-in error page instead of creating one.
- `oauth_states` stores `code_hash`, not the code, in its payload.

Acceptance: `packages/db/test/invites.test.ts`: lookup by hash; no column of
any table holds a plain code after the migration (a test scans the migrated
fixture database for the fixture code); `code_enc` is null after use and
after revoke; two concurrent redemptions of one code, one succeeds and one
gets `CONFLICT`; handle uniqueness and non-reuse after account deletion; a
deleted account's provider identity signing in again gets a new waiting
account and not the old row; the waiting-account sweep; the 6th waiting
account from one IP key in a day is refused; `db:admin -- <handle>` promotes
that account and refuses an unknown handle; a root invite has no
`created_by` and its redeemer has no `invited_by`.

### 3.2 Making, listing and revoking links

**I2.** tRPC `accountInvites.*` (`01` §6), active accounts only:

- `list`: the caller's links (`open | used | revoked`), who used each, the
  code of each open link (decrypted from `code_enc`; served only to its
  creator), and "You invited" (accounts whose `invited_by` is the caller),
  newest first, and the caller's invites: `allowance { total, used, left }`
  (null for a site admin) and `perMember`.
- Invites are a lifetime grant, not a number of open links. A member's
  total is `SESSION_INVITES_PER_MEMBER` (default 3) plus
  `user_limits.extra_invites`, the invites site admins gave them. A used
  link spends one invite; an open link (neither used nor revoked) holds
  one; revoking an unused link gives its invite back. Account links do not
  expire. Left = total − used − open (`accountInvites.allowance`).
- `create`: `PRECONDITION_FAILED` "You have used your <total> invites. An
  admin can give you more." when the caller has 0 left. Count and insert run
  in one immediate transaction, so two concurrent creates with 1 left make
  one link. Site admins (`users.is_admin`) have no limit, so the tree's
  roots can seed it. The 10 created a day (Z1) apply to everyone, site
  admins included: "You can make 10 invite links a day. Try again in N
  hours."
- `revoke`: the caller's own open link; gives its invite back and nulls
  `code_enc`. No restore. A revoked code answers `unusable` from then on.
- `admin.invites.lookup { handle }` and `admin.invites.grant { handle,
  count }` (site admins only, the `admin.models.*` bucket of Z1): the lookup
  answers `{ handle, displayName, total, used, open, left, extra }` for an
  active account, and `NOT_FOUND` "No account with that handle." for an
  unknown or deleted one; the grant adds `count` (an integer from 1 to 100)
  to `extra_invites` and answers the new lookup. Each grant is logged at
  info with the admin's id, the member's id and the count, nothing else.
  The operator's equivalent is `db:admin -- --grant-invites <handle> <n>`
  (also `node dist/admin.mjs --grant-invites <handle> <n>` in the image).
- Codes come from a CSPRNG (`crypto.randomInt`) over the mockup's alphabet
  (no `0`, `O`, `1`, `I`), in the mockup's form `SESS-XXXX-XX` (30 bits,
  decision S2). Input is normalized (upper-cased, spaces and dashes removed)
  before hashing.
- The link is `<SESSION_PUBLIC_ORIGIN>/i#<code>` (in production
  `https://session.dev/i#<code>`): the code stays in the
  fragment and out of request lines, logs and `Referer`, as the existing
  `/invite#<token>` design does (`03-api-and-events.md` `invites.create`,
  `10-home-feed-journal.md` §4b). The client route reads the fragment and
  removes it from the address bar with `history.replaceState`. The code
  field also accepts a pasted `/i/<code>` or a bare code (the mockup strips
  up to the last `/`); the server has no `/i/<code>` route, and the access
  log redacts any path under `/i/`.

The members page (`membersPage`, `invSection`) uses the mockup's copy: the
box "Invite someone" with "<left> of <total> left" ("<n> open" for a site
admin), each open link with Copy and a revoke button ("Revoke this link"),
"Create an invite link" (or "Create a new link" when one is open), and "You
invited" with "Joined <date>" per person. At 0 left the button is replaced
by the line "You have used your <total> invites. An admin can give you
more."; a waiting account sees "You can invite once your account is
active." The tree section is headed "Invite tree" with the line "Session is
invite-only. Each user starts with 3 invites which they can use to add
other members.", its number taken from `SESSION_INVITES_PER_MEMBER`. Links
are shown in the fragment form above, not the mockup's
`session.app/i/<code>`.

Acceptance: server tests that used links spend, open links hold and
revoked links give back an invite, the refusal at 0 left with the member's
total (extras included), the setting, two concurrent creates with 1 left,
site admins unlimited, another account's `list` never containing the
caller's codes, and `admin.invites.*` (non-admins refused, the count bounds,
an unknown or deleted handle, the shared rate limit, the log line); db tests
for `extra_invites` and `db:admin -- --grant-invites`; client tests for the
header, the button replaced by the line at 0 left, and that the address bar
holds no fragment after `/i#<code>` loads; an e2e test in which a site admin
gives invites to a member at 0 left, who then makes a link.

### 3.3 Invite tree

**I3.** `members.tree` (`01` §6, online-only) returns active accounts as `{
handle, displayName, avatar, invitedBy, joinedAt, staff }`; `staff` is
`admin` for `users.is_admin`. The client draws it as `treeA` (depth-first
from the roots, children by `joinedAt`). The mockup's account-level "mod" tag
has no server counterpart and is dropped: there are no site-wide moderators
(question 6, decided).
A deleted account stays as a node "Deleted account" with no
handle, so its invitees keep their place.

`01` C8 leaves the tree's visibility to this file. Decision: active members
see the whole tree (handles, display names, inviter edges); waiting accounts
and signed-out readers get `FORBIDDEN`/`UNAUTHORIZED`. The tree is the main
tool for tracing an abusive account to its inviter (§10), which argues for
showing it to members; its cost is that every member can list every handle.
Above 5,000 nodes, subtrees load on expand.

Acceptance: server tests for the two refusals and the deleted-account node;
a client test rendering a 12-account fixture
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
- **Starting OAuth.** The dialog offers "Continue with GitHub" and "Continue
  with X". The current `GET /auth/github?invite=<code>` puts the code in a
  request line. It is replaced by `POST /auth/<provider>/start` for
  `github` and `x` (JSON `{ code?, returnTo? }`, `X-Requested-With:
  session`, same-origin), which writes the `oauth_states` row with the
  code's hash and the provider, sets the state cookie and answers `{ url }`;
  the client then navigates to `url`. `GET /auth/github` and `GET /auth/x`
  stay for sign-in without a code and ignore an `invite` parameter.
- **OAuth callback.** The account is found by `(provider,
  provider_user_id)`. An existing account signs in and the code is
  untouched; signing in with the other provider is a different identity and
  follows the new-identity path (it does not reach the existing account).
  A new identity with a usable code goes to the profile step (name and handle;
  there is no rules checkbox and no community guidelines page), and `account.create` redeems the code and activates the
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
name, description, owner handle (`owner`, `01` C18), member count (`inv3`:
"a signed-out caller gets open spaces and the landings of closed ones"). The
scope picker offers only "All" (`SCOPES`). Write controls open the sign-in
dialog or the invite page; the server refuses the write regardless (`inv1`).
"All" and Browse list open channels plus the reader's own private channels
(`allVisible`); no listing (`spaces.directory`, `01` C7) returns a private
channel to a non-member.

Acceptance: `inv3`; a server test that `spaces.directory` for a signed-out
caller, a waiting account and a non-member contains no private channel; the
signed-out spec of `02` §12.2 (`e2e/spaces-signed-out.spec.ts`).

### 3.6 Suspension (removed: no suspension)

**I6 (removed: no suspension).** Product decision (`05` §6 P3): there is no
Session-wide sanction short of deletion. `admin.suspend`, the `suspended`
status and suspend controls in `/admin` are not built. An abusive member is
handled by the owners of the channels it writes in (removal and ban, §6), by
a site admin who deletes the account with the account-deletion operator job
(§8) and, where the account has invited others, by tracing the invite tree
(§3.3); members reach site admins at the abuse address (§13).

## 4. Channels

### 4.1 Visibility

| Mockup | Wire (`01` C9) | Who reads content | Who joins |
|---|---|---|---|
| Open | `vis: "open"` | Anyone, signed out included | Any active account (`spaces.join`) |
| Private | `vis: "private"` | Members only | Holders of a channel invite link |

Visibility is set at creation (`01` C11); there is no control to change it.
The New channel dialog's help texts are the mockup's: Open "Anyone can read
and join."; Private reads "Only people invited with a link can read or
post.", where the mockup has "Only people you add can read or post." The help text
does not say that a private channel's name, About and owner stay visible to
anyone with its link or name (§3.5, §13).

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

### 4.3 Ownership

**B2.** A channel has two roles, `owner` and `member` (`01` C18). The
creator is the owner for the channel's lifetime; ownership is not
transferable and there are no admins or moderators. Site admins
(`users.is_admin`) have no role in a channel unless they join it as members.

| Action | Member | Owner |
|---|---|---|
| Read, ask, post, reply, save | yes | yes |
| Remove a thread, read the moderation log | | yes |
| Ban and unban; remove from a private channel | | yes, anyone but themselves |
| Make channel invite links | | yes |
| Edit About (`01` C11) | | yes |

Work items:
- Channel info gains a Members row opening the member list (the owner, then
  members by `joinedAt`). The owner gets a per-row menu on every other
  member: Ban, and in private channels "Remove from #name". This control is
  an addition to the mockup.
- `members.remove` carries `base.adm` and answers STALE when the admission
  id changed (`AGENTS.md`; `R1b`). `members.setRole` does not exist.
- The owner cannot leave (`spaces.leave` answers `PRECONDITION_FAILED`);
  the client offers no Leave to the owner and the channel header shows "Your
  channel". Channel deletion is not offered at launch (§1).
- Nobody can ban or remove the owner; the remedy for an abusive owner is a
  site admin deleting the owner's account or the channel by operator job;
  deleting the account freezes its channels (§4.5).

Acceptance: client tests for the menu items a member and the owner see on
each other; a server test that a member's `members.ban`, `members.remove`
and `invites.create` and the owner's ban of themselves answer `FORBIDDEN`,
and the owner's `spaces.leave` answers `PRECONDITION_FAILED`; `R1b`.

### 4.4 Channel info and About

**B3.** `chInfoDlg`: glyph, name, lock for private, About, "Channel by
@owner", member count, the visibility sentence ("Private: only members can
read or post" / "Open: anyone can read and join"), and for the owner
"Moderation log". The owner's Edit opens `chEditDlg` (heading "Edit #name")
with About only, at most 300 characters; Save closes it with the toast
"Channel updated."

- Save sends `spaces.update { id, desc }` (`01` C11). The server trims,
  bounds (`BAD_REQUEST` above 300, recorded, per `R8`) and checks ownership at
  apply time. No `base`: one person edits, so a save from a second tab
  overwrites.
- An empty About shows "No description yet. Add one" to the owner, nothing to
  others.

Acceptance: client test that only the owner sees Edit and the length error; a
server test that a member's `spaces.update` is refused; a
step in `e2e/spaces-channels.spec.ts` where a member's open channel info
shows the new About without a reload.

### 4.5 A channel whose owner is deleted

**B6.** Ownership cannot move (`01` C18), so a channel whose owner's account
is deleted (§8) has nobody who can remove threads or ban. Rule: the channel
is frozen (a state of the whole channel, distinct from a removed member's
frozen copy, §8). Account deletion by operator job is the only cause; there
is no suspension (§3.6).

- The account-deletion operator job sets `frozen: true` on every space
  record the account owns, in the same transaction as the account's
  deletion. Nothing clears it. The flag is in the space log, so readers get
  it by sync and mutators check it at apply time without reading `users`.
- A frozen channel stays readable as before: an open channel by anyone, a
  private channel by its members.
- Every write in a frozen channel is refused at apply time with
  `FORBIDDEN`, recorded ("#name is unavailable because its owner's account
  is deactivated."), except a person deleting their own threads, follow-ups,
  replies and comments, and leaving. Joins and channel invite links are
  refused too. Saves are user-log records and are unaffected.
- Channel info and the header show the banner "#name is unavailable
  because its owner's account is deactivated. You can read it and delete
  your own posts." The disabled follow-up and Reply buttons have the title
  "#name is unavailable". The user-facing copy says "unavailable"; "frozen"
  is the state's name in the code and the record (`frozen`). The
  composer's channel picker omits the channel.
- The space record keeps `owner`; for a deleted account the client shows
  "Channel by Unavailable", and Browse "Unavailable · N members" (the handle
  stays reserved, §8).
- A site admin may delete a frozen channel with the channel-deletion
  operator job (§1). This is the existing site-admin action, not a new
  channel power. A deleted owner's channels stay frozen and readable
  indefinitely; no job deletes them (question 11, decided).

Acceptance: an operator-job test that, after the owner's account is
deleted, a member's post, a join and a channel link redemption in that
owner's channel answer `FORBIDDEN`, a member's delete of their own thread
succeeds, and the threads are still served to a signed-out reader (open
channel) and to a member (private channel); a client test of the banner.

## 5. Channel invite links

**B4.**
- The owner: channel info → "Invite to #name" → a one-use link
  `<SESSION_PUBLIC_ORIGIN>/c/<name>#<code>` with Copy (channel URLs use the
  name, `01` C14; in production `https://session.dev/c/<name>#<code>`); the
  client route clears the fragment as in §3.2. Expiry 7 days (`invites.create { days: 7
  }`); the server refuses `days: null` and more than 30 days with
  `BAD_REQUEST`. Revoke and Restore use `invites.revoke` and `invites.restore`.
- The server makes the code in `pre` (`inv4` "invite codes are made by the
  server"): 128 bits from a CSPRNG, base32, independent of the link id (the
  mock derives it from the id, which a reader of the id could predict).
- Link records are read by the channel's owner, who is their only maker
  (`access.ts`); the code is never in a record any other reader gets.
- An active account opening the link calls `spaces.join { space, invite }`; a
  signed-out or waiting reader goes through §3.4 first and keeps the channel
  code in memory, not in a URL.
- A link works only while its channel is not frozen (§4.5) and the link has
  not expired; both are checked at apply time (`inv2` "an expired invite
  link is refused at apply time, whatever the client saw"; §4.5). A banned
  person cannot join with a link (`review-r1` ban test).
- A leaked link admits at most one person; the owner sees `usedBy` and can
  remove or ban that person.
- Limits: 20 links per user per day; 50 open per channel (§10).

Acceptance: in `e2e/spaces-channels.spec.ts`, the owner of a private channel
copies a link, a second account opens it and reads the channel, a third
account using the same link gets "This invite link has expired or was
already used."; server tests for the expiry bounds and that a plain member's
snapshot holds no link record.

## 6. Moderation

### 6.1 Reporting (removed: no reporting)

Product decision (`05` §6 P6): there is no reporting, and the mockup has
none. `reports.create`, `reports.resolve`, the
`report` record kind, the `report` and `report_resolved` notifications, the
report rate limit and the report e2e steps are not built (`01` C12, U6).
The text below is kept for reference and is not scheduled.

**O1 (removed: no reporting).**
- Members of the channel other than the owner: "Report…" (`reportopen`)
  opens `rmDlg` in report mode: the clipped title, "What is wrong with it?"
  (optional), and "Reports go to @owner, the owner of #name. @author is not
  told who reported." (as an earlier mockup had it; the mockup at HEAD has
  no reporting).
- `reports.create { id, item, note? }` with `item` the moderation key
  `a:<thread>` (ask) or `p:<thread>` (post) (`moderationKeySchema`, `itemOf` in
  replica-proto), note at most 500 characters (`01` C12). One open report per
  (reporter, item): a second answers `CONFLICT` (`01` C12) and the dialog says
  "You already reported this."
- Threads only at launch; follow-ups (`f:`), replies (`r:`) and comments
  (`c:`, `01` C4) have moderation keys and can follow (question 9).
- A report is readable by its reporter and the channel's owner. The owner
  gets a `report` notification, at most one unread per item, so repeated
  reports on one item do not multiply notifications.

Acceptance: `review-r1` "a report notifies the space's owner, admins and
moderators, and nobody else", rewritten as "… the space's owner, and nobody
else" (`01` U6); `@session/mutators` tests for the one-open rule and a
non-member's report refused; a test that three reports on one item leave
one unread notification for the owner.

### 6.2 Removing

**O2.**
- The owner: "Remove…" (`rmopen`) in the "…" menu of another person's
  thread opens `rmDlg` with the mockup's copy: heading "Remove @author's
  ask" or "Remove @author's post", the thread's text clipped at 120
  characters (shown to the owner, who can read it), the field "Reason, shown
  with the removal" (placeholder "Optional", at most 300 characters), the
  line "Readers see that it was removed. Branches and replies under it go
  with it. @author is notified, with the reason.", and Cancel and Remove.
- `moderation.decide { item, decision: "removed", note? }` writes a
  `modlog` entry and, in the same transaction, a `removed` notification to
  the author with the note and no thread text (`01` C16, written by the
  mutator's `notify` stage).
- `removed`, `hidden` and `members.ban` apply to the record as it
  is, without `base` (`AGENTS.md`; `H1`). Removing an item that is already
  removed answers `PRECONDITION_FAILED` ("This thread is no longer
  available."); the client treats it as done.
- A run in progress ends and writes nothing after the removal
  (`03-agents-and-research.md`). Not reversible: the content no longer
  exists. The author may still delete a removed thread (`R11`), which
  deletes the placeholder.

What the removal commit leaves, and who gets it:

| Data | Stored after removal | Served to |
|---|---|---|
| Thread record: `id`, `s`, kind (ask or post), `createdAt` | kept | every reader of the channel |
| `u` (author) | kept, for the author's right to delete the placeholder (`R11`) and their user log | the author only; every other reader, the owner included, gets `u: null` on the thread record |
| `mod: "removed"`, `modBy`, `modNote` | written | every reader of the channel |
| Thread text: `q`, `t`, `sum`, quotes, look-up phrases | emptied in the same commit | nobody |
| Ask nodes and follow-ups, answers, replies, comments, runs and turns, `run_live` checkpoints, mention notifications about it, saves of it | deleted; tombstones keep key, kind, audience fields and rev | readers get `del` |
| Counts record | `r: 0`, `saves: 0` | every reader |
| `removed` notification | `sp`, `th`, `modNote`; no thread text | the author |
| `modlog` entry | `kind`, `item`, `by`, `author`, `note`, `at` | the owner only; deleted after 180 days |
| `usage_events` of its runs | kept, no text (`03` K1) | the payer |

The client renders the placeholder as "Removed by the channel owner",
"Reason: “…”" when a note exists, and "Ask in #name" or "Post in #name" for
every reader, the author and the owner included (product decision; the
mockup prints "@author" there). The author's replica still
receives `u`, so the author's "…" menu keeps Delete.

Who learns the author of a removed thread: the placeholder names nobody, to
any reader. The thread record's `u` is served to the author only. The
channel's owner, who made the removal, gets the author's handle in the
`author` field of their own `modlog` entry (§6.5: "@owner removed @author's
ask"), until the entry is deleted after 180 days. No other reader can learn
the author from the server after the removal. `00`'s "the author's handle is
served to the author only" refers to the thread record and the placeholder;
the moderation log is the one exception, and only for the owner.

Acceptance: a server test that every reader other than the author, the owner
included, receives `u: null` on a removed thread in snapshot and pull, and
that only the owner receives the `modlog` entry with `author`; a client test
that the placeholder names no author for the author, the owner and another
reader.

Deleting saves of a removed thread is a change to replica-proto's `erase`
(`01` U6), which today keeps them.

Placeholder lifetime: until the author deletes it or the channel is deleted
(`05` §6 P5); tombstones of the erased records are pruned after 30 days.

Acceptance: `inv6` "removing a thread erases it and everything under it from
storage, for good", `R5`, `R11`; a `@session/mutators` test that the
placeholder parses with no field of the table's "emptied" row set and that
the reader's saves are gone; the D4 storage scan of §6.6.

### 6.3 Hiding

**O3.** `moderation.decide { decision: "hidden" | "shown" }` and the
hidden-text rules stay implemented and tested (`inv6`: hidden text to the
author and the owner). `shown` carries `base.rev` and answers STALE when the
author edited after the owner read it (`R2`). The client renders hidden
items (author and owner see the text under "Hidden by the channel owner";
others the placeholder) but offers no Hide command (`05` §6 P7).

Acceptance: `inv6` hide tests, `R2`, `R14`; a client test of both renderings.

### 6.4 Banning

**O4.**
- The owner: "Ban from #name" on the thread menu of any other person and in
  the member list; a Banned list with Unban in channel info. All of these
  are plan additions: the mockup has Remove… only. Nobody can ban the owner
  (§4.3).
- `members.ban` removes any membership and adds the ban. A ban stops every
  write in the channel, the person's own included, and any join by link
  (`inv2`, `review-r1` ban test). In an open channel the banned person can
  still read, because open content is readable by anyone. A person banned
  from a private channel is a removed member there (§8).
- The ban record (`ban:<space>:<user>`: space, person, time) is served to
  the channel's owner and to the banned person, in their user log, and to
  nobody else; it names nobody but the banned person (who banned them is in
  the moderation log, which only the owner reads). The banned person's
  client tells them "You are banned from #name." when that record arrives,
  and not for a membership that ends any other way (a Leave in another tab).
- "Remove from #name" is offered only in private channels. In open channels it
  would be STALE after the person leaves and rejoins (`AGENTS.md`), so Ban is
  the tool there.
- Ban and unban write `modlog` entries (§6.5).

Acceptance: `inv2` "a ban stops writes queued before it, in a closed and in
an open space" and "a ban stops every write in its space, the author's own
included"; a client test that a member sees no Ban and the owner sees none
on their own threads.

### 6.5 Moderation log

**O5.** `modLogDlg`, heading "Moderation log", as the mockup: one list of
the owner's removals and bans, newest first. Each entry shows the kind
("Removed" or "Banned"), the line "@owner removed @author's ask" (or
"post") or "@owner banned @member from #name", "Reason: “…”" when a note
exists, and the relative time. With no entries it shows "Nothing removed
yet. Use “Remove…” in a thread's “…” menu to take it down." Two departures:
the mockup appends the removed thread's clipped text to a removal line, and
the plan does not (§1, "Moderation log excerpt"); the kind "Unbanned" with
the line "@owner unbanned @member from #name" is a plan addition, because
unban is (§6.4).

- Data: the owner-only `modlog` record kind of `01` C12 (`{ id, sp, kind,
  item, by, author, note, at }`) with `kind` `remove`, `ban` or `unban`; for
  bans `item` is null and `author` names the banned person.
- A removed item shows kind, author and channel, never a title or text.
- Entries are deleted 180 days after `at` by the retention job (`01` Y8).

Acceptance: `inv3` "a plain member gets no moderator-only records, in
snapshots or pulls", rewritten for the owner (`01` U6) and extended to
`modlog`; a retention test with an injected
clock; a client test that an entry for a removed item renders no title.

### 6.6 Acceptance

- replica-proto `inv2`, `inv6`, `review-r1`, `review-r2` against the real
  server half (M3).
- `@session/mutators` tests: note bounds; the placeholder holds no field of
  the removed content; a removal writes one `modlog` entry and one `removed`
  notification.
- `e2e/spaces-channels.spec.ts`: the owner removes a member's thread with a
  reason; the member's feed shows the placeholder with the reason and no
  text, also after a reload, and the member's notifications page lists the
  removal with the reason; the owner's moderation log lists the removal
  without a reload; the owner bans a member of an open channel, the log
  lists the ban, and that member's Ask is refused with the ban message.
- The storage scan of `01` D4 after a removal: the question text appears
  nowhere in the SQLite file, the WAL included, nor in the author's
  `removed` notification. There is no effects table (`01` S4, removed: no effect queue).

## 7. Saved threads and user logs

**P1.** Saves and notifications live in the user's own log and follow
current access (`AGENTS.md`; `inv7`). Likes are removed (`01` C1).

- A save is served only while its owner may read the thread's channel.
  Losing access to a private channel removes those saves from Saved; regaining
  it brings them back, because the records were kept and only serving stopped
  (`R4a`: no deletions reach a removed member's log).
- A removed thread's saves are deleted with it (§6.2).
- The Saved count is computed on the client from the user log.
- Notifications (`01` C16: mention, reply, branch, comment, removed, invite
  used) are served only while their person may read the item.

Acceptance: a client test that Saved's count drops when a resync removes a
channel's saves; `R4a`.

## 8. Privacy

**P2.**
- **Erasure.** Removed content is erased and never served again, also not
  through cursors made before the removal (`inv6`: "an old cursor resyncs into
  the current state"). Tombstones keep key, kind, audience fields and rev.
  Notifications are written in the same transaction as the write that
  causes them and carry ids, not record text (the `removed` notification
  carries only the owner's note); server logs carry ids and answer codes,
  not text (`05` §4). Litestream generations hold the text until they expire. Product
  decision: there is no retention requirement for backups, so removed text
  may stay in backups for as long as they are kept; "never served again"
  applies to what the server serves, not to backups (`01` question 3).
  Removal reasons are owner-written text and are kept as §6.2 says.
- **Hidden text** goes to its author and the channel's owner only.
- **Frozen copy.** The server keeps the prototype rule: a member removed or
  banned from a private channel is served nothing further from it, but can
  still delete their own threads there (`inv3` frozen-copy test; `R4b`: the
  delete answers `null` and reveals nothing about later replies). The web
  client persists no replica, so it keeps no frozen copy: on the resync that
  follows the removal it drops the channel and shows "You are no longer a
  member of #name." (`02` W6.10). There is no frozen copy after a voluntary
  Leave either (decision P8). The desktop's frozen copy is not built
  (removed: web-only build).
- **No existence oracle.** A missing target and one the caller may not read
  answer the same (`inv4`); an id collision answers the same `CONFLICT`
  whether or not the caller can read the record (`inv4`). `auth.checkInvite`
  has one failure answer (§3.4).
- **Account deletion** stays an operator job (`06` §7). With spaces it
  deletes the person's threads, follow-ups, replies and comments through the
  author's delete path (a thread with others' replies stays an empty shell,
  `AGENTS.md`, with `u: null`, and a kept branch without its answer, run
  and turns), their user log, member records, sessions and open account
  invites; other people's records that name them as a notification's
  `actor` or a link's `usedBy` get null there. It runs only while the
  server is stopped (a heartbeat row in `server_meta`,
  `runbooks/delete-account.md`) and in one transaction: any refusal aborts
  it. It deletes the provider identity (sets `provider` and
  `provider_user_id` to null) and clears `users.email`; it keeps the
  `users` row with the handle, so the handle stays reserved, `modlog`
  entries naming them until retention, and their node in the invite tree
  as "Deleted account". The same person can sign in again with the same
  provider account and gets a new waiting account with no link to the old
  one. Channels the person owns are not deleted with the account; they are
  frozen (§4.5). This job and channel deletion are the site admins' only
  Session-wide actions against abuse (no suspension, §3.6).

Acceptance: the frozen-copy test, `R4b`; a client test that the removed
member's tab drops the channel and shows the message; an operator-job test
on a fixture account that leaves no record with its `u` except retained
`modlog` entries, leaves the handle taken and `provider_user_id` null, and
lets the same fixture identity sign in again as a new waiting account.

## 9. Permissions at apply time

**B5.** Every check runs when the server applies the envelope, against its
own state (`inv2`). The client predicts with the same mutator, so a write the
replica already knows to be forbidden is refused locally; one that becomes
forbidden while queued is refused by the server, recorded under its seq, and
rolled back. The client renders:

- a removed or banned member's queued post: refused, with the
  composer text restored from the outbox entry;
- a queued write in a channel that froze (§4.5): "#name is unavailable
  because its owner's account is deactivated.", with the composer text restored;
- a link to a frozen channel: the expired-link message;
- STALE on a member removal or `shown`: the target is reloaded and the
  person acts again.

Recorded refusals are shown at once; transient answers retry with backoff,
and a write failing 5 times is shown while the rest of the outbox continues
(`review-r1` R7, `review-r2` Q3). Acceptance: `inv2` on the server; `@session/sync` client tests
for each rollback and the text restoration.

## 10. Abuse limits

**Z1.** Defaults, as server settings validated at boot (`05` §3.4). Rate
refusals answer `TOO_MANY_REQUESTS` unrecorded, and the client backs off
(`R15`, `N10`). Per-IP buckets key on the hashed client address
(`hashClientIp`): the full address for IPv4 and its /64 prefix for IPv6, so
one host cannot rotate through the addresses of its own prefix. The same
key counts waiting accounts in `signup_attempts` (§3.1).

| Limit | Default | Where |
|---|---|---|
| Replicated writes | 60/min per user (the existing mutation bucket; a batch of 20 counts 20) | `/api/sync/apply` (`01` A3) |
| Snapshots | 30/min per user; 30/min per IP signed out | `/api/sync/snapshot` |
| SSE | one connection per client id; 10 per user | `/api/sync/events` |
| `accountInvites.create` | `SESSION_INVITES_PER_MEMBER` (3) invites per member in all, plus those site admins give; site admins unlimited; 10 created per day, site admins included | procedure |
| `accountInvites.list`, `members.tree` | 60/min per user | procedure |
| `auth.checkInvite`, `accountInvites.redeem`, `account.create` | 20/min per IP (the `/auth/*` bucket); 10 failed checks per hour per IP and per user | Hono middleware |
| `POST /auth/github/start`, `POST /auth/x/start` | the `/auth/*` bucket | Hono middleware |
| Waiting accounts | 5 per IP per day (`signup_attempts`) | OAuth callback |
| Handle availability in the profile step | 30/min per user | procedure |
| `spaces.create` | 5/day per user | `pre` |
| `invites.create` (channel) | 20/day per user; 50 open per channel | `pre` |
| `spaces.join` | 60/hour per user | `pre` |
| `spaces.directory` | 60/min per user or IP | procedure |
| Client registration | 50 new client ids per user per day; `register` re-attaching the caller's own stored id is not counted (`01` D2, Y3; `review-r2` S2) | sync server |
| Envelope size | `TOO_LARGE` above 256 KB, unrecorded (`01` Y1) | `/api/sync` |
| Text | About 300, removal note 300 characters; `BAD_REQUEST`, recorded (`R8`) | input schemas |
| Runs | Weekly allowance plus the per-member overdraft limit (`SESSION_OVERDRAFT_TOKENS`, 200,000 a week); 20 queued per user, beyond which `pre` refuses with `PRECONDITION_FAILED` (`reason: "queue_full"`), recorded and not a rate refusal | `03-agents-and-research.md` |
| `admin.models.*`, `admin.invites.*` | 60/min per site admin, one bucket | procedure |

The report row and the device pairing row are removed (no reporting;
web-only build). Buckets are in memory in the single process (`06` §8).
The three `pre` rows count in sliding logs of the person's uses in the
window, so "5/day" is at most 5 in any 24 hours, and a use is taken only
when the write commits a change: a refused write, recorded or not, and one
that changes nothing (a join of a channel already joined) take none. Their
refusal names the limit and when a use is free again ("You can create 5
channels a day. Try again in 22 hours."). The invite tree lets
a site admin find who invited an abusive account. The only `/admin` control
site admins have over accounts is giving a member more invites (§3.2):
deleting an account (which revokes its open
links and sessions) or a channel is an operator job (§8, §4.5); there is no
suspension (§3.6).

Acceptance: a middleware test per row that the limit plus one answers
`TOO_MANY_REQUESTS` and records nothing; `session_rate_limited_total{bucket}`
(`05` §4) counts each bucket.

## 11. Contract items this file depends on

Made by `01`: C8 (account invites on `invites`, `status`, `members.tree`),
C9 (`vis: "private"`), C10 (join requests not built), C11 (`spaces.update {
id, desc }`, owner only), C12 (removal notes, `modlog` with `remove`, `ban`
and `unban`, no reporting), C16 (notification kinds), C18 (roles `owner` and
`member` only, `owner` on the space record, `frozen`). Requested here in
addition (`01` now records the first three, in C12, U6 and C8):

- C12 to state that the removal placeholder keeps `id`, `s`, kind, `u` and
  `createdAt` besides `mod`, `modBy` and `modNote` (replica-proto keeps and
  serves them; §6.2);
- `erase` also deletes saves, comments and mention notifications of the
  removed thread (`01` U6);
- account invites store `code_enc` beside `code_hash`, and `created_by` may
  be null for the root invites of `db:admin -- --invite` (§3.1);
  `users.status` stays `waiting | active` (no `suspended`, §3.6);
- the `pre`-stage limits in §10; `auth.checkInvite` with a single `unusable`
  answer; `POST /auth/<provider>/start`; `users.provider` and
  `provider_user_id` (§3.1);
- `invites.create` codes of 128 bits made in `pre`, `days` between 1 and 30;
- no default rules on `spaces.create`.

## 12. Authentication

**Z2. Web.** GitHub OAuth or X OAuth 2.0, both with PKCE, and database
sessions (`06`). X sign-in is new: an X developer app with the callback
`<SESSION_PUBLIC_ORIGIN>/auth/x/callback`, scopes `users.read`,
`tweet.read` (X requires it to read the signed-in user) and `users.email`,
and `GET /2/users/me` with
`user.fields=created_at,profile_image_url,confirmed_email` for the id,
username, name, avatar, account age and email. GitHub sign-in adds the
`user:email` scope and reads the primary verified address from
`GET /user/emails`. Each sign-in writes the returned address to
`users.email` (§3.1). Configuration
`SESSION_X_CLIENT_ID` and `SESSION_X_CLIENT_SECRET` (a Fly secret),
validated at boot like the GitHub settings; staging has its own X app.
ADR-5 gets an amendment naming both providers. Both are offered from launch
(`05` §6 Q8): X access ready on the staging X app before M6 and on the
production X app before launch is a launch blocker; there is no
GitHub-only launch. Sessions: cookie
`HttpOnly; Secure; SameSite=Lax`, 30 days idle, 90 absolute. CSRF:
`csrfGuard` (`server/src/middleware/csrf.ts`) refuses a cookie request whose
`Origin` differs from `SESSION_PUBLIC_ORIGIN` or whose `Sec-Fetch-Site` is
`cross-site`, and requires `X-Requested-With: session` on every non-GET. It
already covers every POST; its GET guard extends from `/api/trpc` to
`/api/sync/*` and `/api/runs/*`, so a cross-site page cannot open a cookie
SSE stream or snapshot. Logout ends the streams opened with the session.

**Z3. Desktop (removed: web-only build).** Not built. The original text,
kept for a later desktop build: a bearer device token, 256 random bits, stored hashed in
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

**Z4. CORS and credential separation.** The desktop origin allowlist and
bearer tokens are not built (removed: web-only build). The web client is
same-origin, so the server sends no CORS headers on any route, and the
session cookie is the only credential. A request carrying an
`Authorization` header on `/api/sync/*`, `/api/runs/*` or tRPC answers
`400`, so a credential the server does not accept is never ignored
silently.

**Z5. Rendering untrusted text.** Answers, posts, replies, comments, About
and removal reasons are untrusted.
- Plain-text fields (About, reasons, names, handles) render as React text,
  never as HTML.
- Answers are stored as Markdown and the server stores no HTML (`03` §1).
  Answers, posts, replies and comments render through the client's Markdown
  pipeline (`02` §4.4) with raw HTML disabled and DOMPurify on its output;
  the pipeline is the only path from record text to DOM.
- Links pass `safeHref` (`http:`, `https:`, `mailto:` only) and open with
  `rel="noopener noreferrer nofollow ugc"`; remote images stay blocked
  (`07-client-architecture.md` §9), so a post cannot learn a reader's IP.
- Answers are plain Markdown: the widget and artifact rendering of the
  current pipeline is removed (decision P21).
- The web CSP of `07` §9 applies unchanged.

Acceptance (Z2, Z4, Z5): `01` S1 tests, plus: a cookie `GET
/api/sync/events` with `Sec-Fetch-Site: cross-site` is refused; a cookie
`POST /api/sync/apply` without `X-Requested-With` is refused; a request with
an `Authorization` header answers `400`; no response carries an
`Access-Control-Allow-*` header; the X callback test with a fixture X
token endpoint (new account, existing account, an X identity whose GitHub
counterpart has an account stays a separate identity); a client test renders
fixture answers and posts containing `<script>`, `<img onerror>`,
`javascript:` links, a remote image and a widget fence, and the DOM holds
none of them.

## 13. Threat notes

- **Name probing through CONFLICT.** Uniqueness across all channels lets
  anyone learn that a private channel with a given name exists, and then read
  its landing (§3.5). Accepted (`AGENTS.md`, `R10`). The Private option's
  help text ("Only people invited with a link can read or post.") does not
  mention this (§4.1).
- **Invite code enumeration.** `auth.checkInvite` reveals an inviter's name
  for a valid code. Mitigations: one answer for every failure, the per-IP and
  per-user limits, and an alert on failed checks above 100 per hour (`05`
  §4). Codes are 30 bits (decision S2): with 3,000 open codes a guess hits
  with probability about 2.8 × 10^-6, so at 10 failures per hour per IP a
  hit takes about 36,000 IP-hours on average. An attacker with many IPs
  reduces that in proportion; the failed-check alert is the control.
- **Invite link leakage.** Account and channel codes are one-use and travel
  in fragments. A leaked account link admits one person, who appears under
  the inviter in the tree; the inviter can revoke open links at any time;
  channel owners can remove and ban the account it created, and a site
  admin can delete that account by operator job (§8).
- **Handle enumeration.** Handles are public by design (thread rows, the invite tree);
  the availability check is rate-limited only to bound load.
- **No reporting.** Members cannot flag content to the owner or to site
  admins in the app (`05` §6 P6). An owner sees their channel's content
  directly; abuse by an owner, or in a channel its owner does not watch,
  reaches site admins only outside the app, by email to the abuse mailbox
  abuse@<host>, with `<host>` the hostname of `SESSION_PUBLIC_ORIGIN`
  (abuse@session.dev in production; `05` §6 Q10). The mailbox must exist
  before launch and the site admins read it; the app no longer links it
  (there is no site footer). Site admins act on
  such a message with the tools they have: deleting the account or the
  channel by operator job, and the invite tree to find who invited the
  account.
- **Owner exposure.** The removal placeholder says "Removed by the channel
  owner"; the channel's info dialog names the owner to every reader, and the
  owner can ban members who harass them.
- **Abusive or absent owner.** Nobody can ban an owner or take over a
  channel. A site admin either deletes the channel by operator job or
  deletes the owner's account by operator job, which freezes every channel
  the account owns (§4.5); a frozen channel stays readable, with its content
  as the owner left it, until a site admin deletes it by operator job. An
  absent owner whose account is not deleted leaves the channel open to
  writes with nobody moderating it; the abuse address is the remedy.
- **Cursor tokens.** Cursors and SSE ids are AEAD tokens holding log, reader,
  version, serve time and epoch; no version reaches a client. The key is
  configured, the previous key accepted for 30 days. A forged token, another
  reader's, or another server's resyncs (`inv3`, `T1`), so a stolen cursor
  gives its holder nothing. A rotation runbook goes into `web/docs/runbooks/`.
- **CORS.** The server sends no CORS headers (Z4), so no other origin can
  read its responses.
- **Session theft.** The session cookie is `HttpOnly`. XSS in rendered
  answers or posts is the main path to acting as a user, which Z5 and the
  CSP address. The web replica lives in tab memory and is gone when the tab
  closes.
- **Two accounts per person.** Accounts are bound to one provider (§3.1), so
  a person with a GitHub and an X account can hold two Session accounts,
  each admitted by its own invite. The invite tree shows both under their
  inviters. A shared email address does not link them (`05` §6, Q7). Site
  admins act on each account separately (owners' bans, account deletion).
- **CSRF.** Cookie requests need a same-origin `Origin`/`Sec-Fetch-Site` and
  the custom header; sync GETs are guarded too (Z2). Login CSRF is prevented
  by the single-use `oauth_states` row bound to the state cookie.
- **Client-computed state.** Envelopes with extra fields or client-computed
  values are refused (`inv1`); mutation ids are scoped per user (`inv5`);
  stored times and list order are the server's, so a forged ULID time cannot
  reorder a feed (`R13`).

## 14. Dependencies

- `01-architecture-and-data.md`: server half, record kinds and audiences,
  C1, C8–C14, C18, S1–S3, D2, D3, D4, U6, Y3, Y8.
- `02-client-app.md`: the dialogs and pages named here (channel info, edit,
  member list, moderation log, remove dialog, members page, invite flow,
  frozen-channel banner, notifications page, Site Admin page).
- `03-agents-and-research.md`: run cancellation on removal; run limits;
  answers stored as Markdown (§1).
- `05-delivery.md`: M4 schedules I5, B1, B3 and P1; M6 schedules the other
  I, B, O and P items (not O1 or I6) and Z1, Z2, Z4, Z5; Z3, O1 and I6 are
  removed;
  M3 makes the conformance suites that most acceptance checks here rely
  on.

## 15. Open questions

1. Decided: the removal placeholder names no author; `u` is
   served to the author only (§6.2). replica-proto's `erase` and `redact`
   serve `u` to every reader today; `01` U6 changes that.
2. Decided (P5): a removal placeholder stays until the author deletes it.
3. Decided (S2): 30-bit `SESS-XXXX-XX`.
4. Decided (S3): yes, from `code_enc`, readable only by its creator and
   cleared on use or revoke (§3.1).
5. Decided (P8): no frozen copy after a voluntary Leave.
6. Decided: no site-wide moderators and no channel admins or moderators.
   A channel has one owner, not transferable (§4.3, `01` C18);
   `users.is_admin` stays for the people who run Session (tree roots, the
   invite-limit exemption, the Site Admin settings and its invite grants);
   there is no suspension
   (§3.6).
7. Decided (P1): GitHub and X, both at launch (`05` §6 Q8); an account
   stays bound to the provider it was created with; no linking and no
   merging.
8. Decided (S4): a waiting account lives 90 days without a code; one IP may
   create 5 per day.
9. Moot (P6): there is no reporting. Removing follow-ups and replies
   individually is not offered at launch; the owner removes threads.
10. Decided (P7): no Hide for owners.
11. Decided: a deleted owner's channels stay frozen and readable
    indefinitely (§4.5); no job deletes them.
