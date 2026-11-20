# Session spaces client — implementation plan

Status: draft. This plan turns the members mockup
(`docs/mockups/session-web-members.html`, published as an Artifact) into the
shipped Session web client and the server half it needs. It does not restate
the decisions already recorded in `AGENTS.md` ("Planned: desktop client and
sync core"), `web/docs/01-architecture-decisions.md` (ADR-19 to ADR-22) and
`web/packages/shared/src/schemas/spaces.ts`; it schedules the work they
describe and records where the mockup or a product decision changes or adds
to them.

## Scope of this build

- Web only. No desktop (Tauri) client, no device runs (Claude Code or Codex
  on a Mac), no device bearer tokens, no desktop storage adapter, no desktop
  CORS origin, no "Update Session" desktop update prompt, no macOS testing,
  no phone app. The desktop app was never in production, so there is no
  desktop cutover, and no further work happens on the desktop branch.
- Where `AGENTS.md` "Planned: desktop client and sync core" or ADR-19 to
  ADR-22 assume a desktop client, a phone client or device runs, those parts
  are out of scope for this build. The sync core is kept: server authority,
  the outbox, replicas, shared mutators, and the web client's in-memory
  replica. Work items, milestones, risks, tests and questions that existed
  only for the desktop, device runs or the phone are marked "(removed:
  web-only build)" and keep their ids.
- The build happens on a new branch created from the repository's initial
  commit, with the reused files copied in one carry-over commit
  (`05-delivery.md` §3.0: `web/` with `replica-proto`, `shared`, `server`,
  `db` and `client`, the web mockups, the web workflow; `src/`,
  `src-tauri/`, the desktop tests, scripts and documents are left behind).
- The launch replaces the current web app and wipes all of its data,
  accounts included (`05` §3.5).

## Sources, in order of authority

1. `AGENTS.md`, section "Planned: desktop client and sync core": contract,
   architecture, phase 0 rules, replication windows, server decisions (its
   desktop, phone and device-run decisions are out of scope, above).
2. `web/docs/01-architecture-decisions.md`, ADR-19 to ADR-22 (they supersede
   ADR-3 for spaces, ADR-6 and ADR-11, and amend ADR-10).
3. `web/packages/shared/src/schemas/spaces.ts`: the spaces wire types.
4. `web/packages/replica-proto`: the phase 0 prototype server half and its
   adversarial, oracle and mutation suites. The real server half must pass
   them.
5. `docs/mockups/session-web-members.html` (with
   `session-web-spaces-fixtures.js`): the product surface. Where it disagrees
   with 1-4, this plan says which wins and why.
6. `docs/mockups/session-web-spaces.html` and its mock API
   (`session-web-spaces-mock-api.js`, `-jobs.js`, `-scenarios.js`): the first
   draft of the write definitions.

## What the mockup decided (product)

- Names: users see "channels"; the code and wire keep `space`.
- App bar: the app name is the home button; a scope picker (Joined, Channels
  you manage, All) and a scrolling channel strip; usage ring; Saved (with a
  count); a layout toggle (centred main column, or a wider main column); the
  account menu. The bar slides away while the feed scrolls down.
- Feed rows: a post on the left, its branches or replies in a side column.
  Titles are drawn as tree rows (hollow node, regular weight, author avatar on
  the right). The byline reads "N sources · Nk tokens · #channel". The footer
  carries a reply/follow-up count and a save count; there are no likes.
  Answers are plain Markdown; widgets and artifacts appear in the mockup
  only as options and are not built.
- Branches: a tree beside each answer; selecting a row shows its card with
  Comment, Continue and Branch. Selecting 1-4 whole words in an answer offers
  Look up (a branch that describes the phrase) above Branch here.
- Composer: Ask (arrow) or Post (pencil), channel and model pickers.
- Channels: an info dialog (description, owner, members, visibility); owners
  edit only About; owners remove threads with an optional reason, and the
  moderation log lists the owner's removals and bans. The mockup's member
  reports are not built (no reporting). The owner is the only person who
  moderates (`isMod` is the owner). Channel rules were tried and removed.
- Membership: invite-only, with an invite tree and at most 3 open links;
  sign-in with GitHub or X.
- Notifications: a page in the account menu and an unread dot on the
  account avatar.
- Usage and API keys page: weekly allowance, recent runs, what happens when
  included tokens run out, Anthropic/OpenAI keys.
- Site Admin: a page for site admins with two settings, the default model
  and the default effort, on which every member's composer starts.

## Plan files

| File | Covers | Item ids |
|---|---|---|
| `01-architecture-and-data.md` | Server half, database, mutators, sync, API surface, the contract changes the mockup needs | `S`, `D`, `U`, `Y`, `R`, `A`, `C` |
| `02-client-app.md` | The web client: app shell, feed, branches, composer, channels, membership, notifications, usage and Site Admin screens, state, accessibility, layout | `W`; `N` for its dependencies |
| `03-agents-and-research.md` | Asks, branches and look-ups as owned runs; models and the site-wide default model and effort; streaming; tokens, allowance and API keys (device runs `V` removed) | `G`, `E`, `V`, `T`, `K`, `L` |
| `04-membership-moderation-security.md` | Invites, sign-in with GitHub or X, channels and ownership, moderation (no reporting), privacy, permissions, abuse limits, authentication | `I`, `B`, `O`, `P`, `Z` |
| `05-delivery.md` | Milestones `M0`-`M8` (M7a, M7b removed), the build branch and carry-over, testing and acceptance, deployment and launch, observability, risks, open questions | milestones `M`; questions `P`, `E`, `S`, `Q` |

Removed items, kept with their ids: `01` S2; `02` W1.2 (replaced by a
check), §12.3; `03` V1-V7, T5, L3; `04` Z3 (web-only build); `04` O1 (no
reporting); milestones M7a and M7b.

Files cite each other's items with the file number ("01 C3", "04 O2").

## Key decisions taken in the plan

- The build is web only, on a new branch from the repository's initial
  commit with the reused files copied in; the sync core stays and the
  desktop, phone and device-run parts are out of scope (above; 05 §3.0).
- Mutators keep the procedure names of `spaces.ts`. Every ask under a thread
  root (Continue, Branch, Branch here, Look up) is `research.forkNode` with
  `kind: "ask" | "lookup"`; the only new names are `comments.*` and
  `prefs.set`, `saved.toggle` becomes `saved.set`, and `reports.*` is
  removed (01 U5, C1, C4, C12, C13; 03 §2.1).
- Replicated records live in one `records` table with JSON bodies validated
  by the shared zod schemas, so the change log, tombstones and erasure stay
  generic (01 D1).
- Likes are removed from the contract; the counts record is
  `{ th, s, saves, r }`, with `r` the total of branches or replies; in
  private channels save counts below 3 are not served (01 C1, C5).
- The web client keeps an in-memory replica loaded by a snapshot on each
  page load, with a smaller window than the desktop's (30 days or 100
  threads, capped at 500 per space), and holds a write only while its
  request is in flight; on a protocol mismatch (`426`) it reloads once
  (01 R1, Y10, S1; 02 §9.2).
- Channels are `open` or `private`; a private channel admits only through
  channel invite links; channel rules, join requests and the surfaces the
  mockup does not show are not built; space ids are ULIDs and URLs use the
  channel name, and a thread's address opens it in its channel feed
  (01 C6, C9, C10, C14; 02 §2.1).
- Removal erases content: the placeholder keeps only attribution and
  moderation fields, and the moderation log shows no text of a removed item
  (01 C12; 04 O2, O5).
- Removal writes a `modlog` entry and notifies the author with the reason;
  there is no reporting; notifications cover mentions, replies to a post,
  branches and comments on an ask, removals and used invites (01 C12, C16;
  02 W2.6; 04 O2, O5).
- Sign-in is GitHub or X; an account is bound to the provider it was
  created with (04 I1, Z2).
- Account invites are online-only tRPC calls, at most 3 open links per
  member, with a 30-bit code (`SESS-XXXX-XX`) in the URL fragment
  (`/i#<code>`), stored hashed and encrypted for its creator, and one
  failure answer for used, revoked and unknown codes; waiting accounts are
  kept 90 days (01 C8; 04 I1-I4).
- Answers are stored and streamed as Markdown; runs, turns and answers are
  records in the space log, and in-flight text travels as ephemeral deltas
  on the sync SSE connection (03 §1, §5).
- Included tokens are a weekly allowance; cached input counts at the
  provider's discount ratio; the server decides the payer in the mutator's
  `pre` stage; members may add Anthropic and OpenAI keys (ADR-23, to be
  written); the Effort submenu lists the chosen model's efforts, with no
  cost hint and no cap (03 K2, K3, K4, K8, K12).
- A site admin sets the default model and the default effort at runtime;
  members' composers start on both. Every registry model stays available to
  every member: there is no availability setting and no per-member override
  (03 K15; 02 W8.2).
- The launch wipes all web data, accounts included, with no export; the
  migrations are squashed into one `0000_initial.sql` and site admins are
  re-seeded (01 D5; 05 §3.5, §3.6).

## Decisions recorded after review

- The weekly allowance is 2,000,000 included tokens per member (03 K3).
- A removed thread's placeholder shows "[deleted]" for its author; the
  author's handle is served to the author only (04 §6.2, 01 C12).
- Backups have no retention requirement: removed text may remain in
  Litestream generations and archives (01 §9 q3, 05 S1).
- A channel has exactly one owner and no other roles: no admins, moderators
  or other staff. Ownership is not transferable; everyone else in a channel
  is a member. Only the owner removes threads, dismisses reports, reads the
  moderation log, bans and unbans, removes members from a private channel,
  makes channel invite links and edits About; reports go to the owner. The
  contract drops the `admin` and `mod` roles, `members.setRole`, the space's
  `mods` list (replaced by `owner`) and the `invite` setting, and
  replica-proto drops or rewrites the tests for them (01 C18, U6; 04 §4.3).
  `users.is_admin` stays for the people who run Session: site admins seed
  the roots of the invite tree, are exempt from the 3-open-invites limit,
  suspend accounts (04 I6) and delete channels by operator job (04 §1); they
  have no channel role. A channel whose owner is suspended or deleted is
  frozen: readable as before, closed to writes other than deleting one's
  own items and leaving (04 B6). A deleted owner's channels stay frozen
  and readable indefinitely; nothing deletes them on a schedule (05 P24).
- The product owner's answers to `05-delivery.md` §6, recorded there as
  "Decided" and in each file where the question was:
  - Scope: web only (above); no "Run on this Mac" (P15), no phone app
    (P18); the desktop questions P16, P17, E8-E10 and S5 are moot.
  - Repository: a new branch from the initial commit with the reused files
    copied in (05 §3.0); the clone is unshallowed and the branch point
    confirmed with `git rev-list --max-parents=0 HEAD` (Q2). The branch is
    `session-web`, production deploys from it, and the old `main` is kept
    as it is (Q3).
  - Launch: a hard reset; all web data and accounts are wiped, site admins
    are re-seeded, and there is no export (P19, P20; 05 §3.5). The current
    web app is not in use, so there is no launch date, notice period or
    banner; site admins invite a named first group, who then have 3
    invites each (Q11).
  - Sign-in: GitHub or X; one provider per account, no linking, no merging
    (P1; 04 I1, Z2).
  - Private channels: channel invite links only (P4).
  - No reporting: no `reports.*`, report notifications, report part of the
    moderation log, report limits or report e2e cases; the owner's Remove
    stays and the moderation log lists removals and bans (P6 moot; 01 C12;
    04 O1, O5).
  - Notifications: a Notifications page in the account menu and an unread
    dot on the avatar; kinds mention, reply, branch, comment, removed,
    invite used (P10; 01 C16; 02 W2.6).
  - Site Admin page ("Site Admin", "Settings for everyone on Session."):
    exactly two settings, the default model (a key-only model cannot be
    the default) and the default effort (low, medium, high, max), on which
    members' composers start. No model availability control, no prices or
    model descriptions, and no per-member model overrides (replaces P11;
    Q9 decided: no; 03 K15; 02 W8.2).
  - Tokens: cached input at the discount ratio (P12); no cost hint and no
    effort cap (P13); 2,000,000 tokens a week.
  - Widgets and artifacts are not built; answers are plain Markdown (P21).
  - Invite codes are 30-bit `SESS-XXXX-XX` (S2); waiting accounts are kept
    90 days (S4); open codes can be shown again (S3).
  - Placeholder stays until the author deletes it (P5); no Hide (P7); no
    frozen copy after Leave (P8); thread addresses open the thread in its
    channel feed (P9); anyone who can read a branch may open it as a
    thread, shown with the branch's author (P14); typography as in the
    mockup (P22); a Settings entry only once there are settings beyond
    Usage (P23).
  - Engineering: a separate staging Fly app (E1); no protocol window, tabs
    reload (E2); one records table (E3); every applicable mutation fault
    required (E4); the prototype server kept as the reference (E5); a
    boot-time Litestream generation check (E6); a smaller web window (E7).
  - Security: save counts below 3 hidden in private channels (S6).
  - New questions from the web-only scope (05 §6, Q1-Q12): the recommended
    answers are accepted for Q1 (ADR scope notes, web-only `AGENTS.md`), Q2,
    Q4 (in-flight writes only), Q5 (protocol header kept), Q6 (admin
    seeding with `db:admin`), Q8 (staging X app before M6) and Q10 (an abuse
    address in the site footer; no community guidelines page). Q3: the branch is `session-web`
    and `main` is kept as it is. Q7: each account's email from the provider
    is stored and updated on every sign-in, never used to match, deduplicate
    or merge accounts; the handle stays the only unique name (04 I1, Z2).
    Q9: no per-member model overrides. Q11: above. Q12: no weekly spend
    budget and no cost alert; during testing the provider API keys are
    capped at the provider (05 §4, §5).

## Open questions

`05-delivery.md` §6 consolidates the questions of 01-05, grouped by who
decides (Product `P1`-`P24`, Engineering `E1`-`E10`, Security `S1`-`S6`), with
the source and the recorded decision of each. Its subsection "New questions
from the web-only scope" (`Q1`-`Q12`) records the answers to the questions
the web-only scope raised; all are decided. Each file keeps its own list.

## How this plan was produced

A draft outline was expanded by three agents (01 with 03, 02, 04 with 05),
then each file was revised by its own reviewer against the sources above, and
the files were then made consistent with each other (names, ids, cited items
and spec names).
