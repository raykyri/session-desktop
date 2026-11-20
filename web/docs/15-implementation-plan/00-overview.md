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

| File | Covers |
|---|---|
| `01-architecture-and-data.md` | Server half, database, mutators, sync, API surface, the contract changes the mockup needs |
| `02-client-app.md` | The client: app shell, feed, branches, composer, channels, membership and usage screens, state, accessibility, layout |
| `03-agents-and-research.md` | Asks, branches and look-ups as runs; models; streaming; tokens, allowance and API keys; device runs |
| `04-membership-moderation-security.md` | Invites, channels and roles, moderation, privacy, permissions, abuse limits |
| `05-delivery.md` | Phases and milestones, testing and acceptance, rollout and cutover, risks, open questions |

## How this plan was produced

A draft outline was expanded by three agents (01 with 03, 02, 04 with 05),
then each file was revised by its own reviewer against the sources above.
