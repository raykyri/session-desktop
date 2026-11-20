# Session spaces client — implementation plan

Status: draft. This plan turns the members mockup
(`docs/mockups/session-web-members.html`, published as an Artifact) into the
shipped Session client and the server half it needs. It does not restate the
decisions already recorded in `AGENTS.md` ("Planned: desktop client and sync
core"), `web/docs/01-architecture-decisions.md` (ADR-19 to ADR-22) and
`web/packages/shared/src/schemas/spaces.ts`; it schedules the work they
describe and records where the mockup changes or adds to them.

## Sources, in order of authority

1. `AGENTS.md`, section "Planned: desktop client and sync core": contract,
   architecture, phase 0 rules, replication windows, server and desktop
   decisions.
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
- Branches: a tree beside each answer; selecting a row shows its card with
  Comment, Continue and Branch. Selecting 1-4 whole words in an answer offers
  Look up (a branch that describes the phrase) above Branch here.
- Composer: Ask (arrow) or Post (pencil), channel and model pickers.
- Channels: an info dialog (description, owner, members, visibility); owners
  edit only About; owners remove threads and members report them, both with an
  optional reason, in a moderation log. Channel rules were tried and removed.
- Membership: invite-only, with an invite tree and at most 3 open links.
- Usage and API keys page: weekly allowance, recent runs, what happens when
  included tokens run out, Anthropic/OpenAI keys.

## Plan files

| File | Covers | Item ids |
|---|---|---|
| `01-architecture-and-data.md` | Server half, database, mutators, sync, API surface, the contract changes the mockup needs | `S`, `D`, `U`, `Y`, `R`, `A`, `C` |
| `02-client-app.md` | The client: app shell, feed, branches, composer, channels, membership, notifications and usage screens, state, accessibility, layout | `W`; `N` for its dependencies |
| `03-agents-and-research.md` | Asks, branches and look-ups as runs; models; streaming; tokens, allowance and API keys; device runs | `G`, `E`, `V`, `T`, `K`, `L` |
| `04-membership-moderation-security.md` | Invites, channels and roles, moderation, privacy, permissions, abuse limits, authentication | `I`, `B`, `O`, `P`, `Z` |
| `05-delivery.md` | Milestones `M0`-`M8`, testing and acceptance, rollout and cutover, observability, risks, open questions | milestones `M`; questions `P`, `E`, `S` |

Files cite each other's items with the file number ("01 C3", "04 O2").

## Key decisions taken in the plan

- Mutators keep the procedure names of `spaces.ts`. Every ask under a thread
  root (Continue, Branch, Branch here, Look up) is `research.forkNode` with
  `kind: "ask" | "lookup"`; the only new names are `comments.*` and
  `prefs.set`, and `saved.toggle` becomes `saved.set` (01 U5, C1, C4, C13;
  03 §2.1).
- Replicated records live in one `records` table with JSON bodies validated
  by the shared zod schemas, so the change log, tombstones and erasure stay
  generic (01 D1).
- Likes are removed from the contract; the counts record is
  `{ th, s, saves, r }`, with `r` the total of branches or replies (01 C1,
  C5).
- Channels are `open` or `private`; channel rules, join requests and the
  surfaces the mockup does not show are deferred; space ids are ULIDs and
  URLs use the channel name (01 C6, C9, C10, C14).
- Removal erases content: the placeholder keeps only attribution and
  moderation fields, and the moderation log shows no text of a removed item
  (01 C12; 04 O2, O5).
- Account invites are online-only tRPC calls, at most 3 open links per
  member, with the code in the URL fragment (`/i#<code>`), stored hashed and
  encrypted for its creator, and one failure answer for used, revoked and
  unknown codes (01 C8; 04 I1-I4).
- Answers are stored and streamed as Markdown; runs, turns and answers are
  records in the space log, and in-flight text travels as ephemeral deltas
  on the sync SSE connection (03 §1, §5).
- Included tokens are a weekly allowance; the server decides the payer in
  the mutator's `pre` stage; members may add Anthropic and OpenAI keys
  (ADR-23, to be written); the Effort submenu lists the chosen model's
  efforts (03 K3, K4, K8, K12).
- The desktop's device token is held by the Tauri Rust side and never
  reaches the webview's JavaScript (01 S2; 04 Z3).
- The cutover runs migration `0002`: accounts, sessions and invites are
  kept; research tables, `embed_assets` and `tweet_cache` are dropped
  (01 §2, D5; 05 §3.5).

## Decisions recorded after review

- The weekly allowance is 2,000,000 included tokens per member (03 K3).
- A removed thread's placeholder shows "[deleted]" for its author; the
  author's handle is served to the author only (04 §6.2, 01 C12).
- Backups have no retention requirement: removed text may remain in
  Litestream generations and archives (01 §9 q3, 05 S1).

## Open questions

`05-delivery.md` §6 consolidates the open questions of 01-05, grouped by who
decides (Product `P1`-`P23`, Engineering `E1`-`E10`, Security `S1`-`S6`), with
the source of each. Each file keeps its own list.

## How this plan was produced

A draft outline was expanded by three agents (01 with 03, 02, 04 with 05),
then each file was revised by its own reviewer against the sources above, and
the files were then made consistent with each other (names, ids, cited items
and spec names).
