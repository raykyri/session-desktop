# Authentication and users

The desktop app is single-user and its GitHub device-flow login gates nothing
(`github_auth.rs`; the token is never read). The web app needs real accounts
because it runs agents on a shared server at the app's expense.

## 1. Model

- `users` — identity from GitHub (`github_id` unique). `is_admin` is a
  flag set manually in the database; it unlocks the gated models and the
  admin user list. There is no in-app promotion.
- `sessions` — server-side sessions; the cookie holds a random 256-bit value,
  the table stores its SHA-256. Sliding expiry: 30 days idle, 90 days
  absolute. `last_seen_at` updated at most once per 5 minutes.
- Everything a user creates references `user_id`; repositories take
  `userId` first and never expose cross-user rows.

## 2. GitHub OAuth (authorization code + PKCE)

Routes (Hono, not tRPC):

1. `GET /auth/github?return_to=/r/...` — creates `oauth_states` row with
   `state`, `code_verifier`, `return_to` (same-origin path only); redirects to
   `https://github.com/login/oauth/authorize` with `scope=read:user` (the
   desktop requested an empty scope; `read:user` is needed for `email`-less
   profile fields and is still read-only).
2. `GET /auth/github/callback?code&state` — validates state (single use, 10
   min TTL), exchanges the code via `arctic`'s GitHub provider with the
   verifier, fetches `https://api.github.com/user`, upserts `users`, applies
   the allowlist (§3), creates a session, sets the cookie, redirects to
   `return_to` or `/`.
3. `POST /auth/logout` — deletes the session, clears the cookie, and ends
   the event streams opened with that session. Also exposed as `auth.logout`
   for the client. An open event stream is also checked against its session
   every 60 s, so one whose session expired or was removed ends within a
   minute (`03-api-and-events.md` §3).

Cookie: `session=<value>; HttpOnly; Secure; SameSite=Lax; Path=/;
Max-Age=2592000`. In development over `http://localhost` the `Secure` flag is
omitted when `NODE_ENV !== "production"`.

Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (Fly secrets). The
callback URL registered in the GitHub OAuth app is
`<SESSION_PUBLIC_ORIGIN>/auth/github/callback`.

## 3. Who may sign in, and admins

Sign-up is open at launch: any GitHub account can create an account. The
schema for later throttling exists from day one (`02` §3.1): per-IP
`signup_attempts`, `users.github_created_at` for an account-age minimum,
and `invites` (sign-up codes) with `users.invites_remaining` defaulting to 0 so codes are
distributed manually when `SESSION_REQUIRE_INVITE=1` is switched on. The
optional `SESSION_ALLOWED_GITHUB_LOGINS` allowlist remains available.

Site admins are set by handle (plan `05` §3.5): `npm run db:admin --
--invite` prints a root invite, the person redeems it and chooses a handle,
and `npm run db:admin -- <handle>` sets `users.is_admin = 1`. The runtime
image holds the same commands as `packages/server/dist/admin.mjs`
(`13-deployment-fly.md` §2, `runbooks/launch.md` §6 step 6). The server
checks `is_admin` on every gated launch; the client only conditionally
hides administrative UI elements.

## 4. Authorization in tRPC

- `protectedProcedure` middleware reads the cookie, loads the session and
  user, rejects with `UNAUTHORIZED` otherwise, and puts `userId` and
  `isAdmin` on `ctx`.
- `adminProcedure` additionally requires `isAdmin`.
- Every repository call receives the caller's id (null for a guest). IDs of
  user-scoped rows (workspaces, folders, drafts, images, settings) are looked
  up with an owner predicate. Thread content is checked against the
  caller's role in the thread (`02-domain-model-and-database.md` §5.16,
  `repos/access.ts`): a thread the caller may not read returns `NOT_FOUND`, the
  same as an id that does not exist (no existence oracle); a thread they may
  read but with a role insufficient for the action returns `FORBIDDEN`. Guests reach the
  public procedures (`research.listTrees`, `getTree`, `getNodeContent`,
  `feed.recentActivity` with `scope: all`, `GET /images/:id`) for public
  threads only.
- `server/test/tenancy.test.ts` is the role × procedure matrix (owner,
  commenter, viewer, signed-in reader of a public thread, stranger to a
  private one, guest).

## 5. CSRF and origin policy

- Mutations and subscriptions reject requests whose `Origin` header is
  present and differs from `SESSION_PUBLIC_ORIGIN`, or whose
  `Sec-Fetch-Site` is `cross-site`.
- The SPA sends `credentials: "include"` and a custom `X-Requested-With:
  session` header that the server requires on mutations (a second, cheap
  CSRF barrier since cross-origin custom headers trigger CORS preflight).
- No CORS allowances; the API is same-origin only. The artifact origin
  serves widget pages by token URL, never reads or sets a cookie, and the
  host-only session cookie is not sent to it. Widget scripts run only when it
  is a different site from the app (`11-artifacts-and-browser.md` §2).

## 6. Per-user settings

The desktop stored `AppSettings` in localStorage (`src/lib/settings.ts`) and
several preferences in a local file. On the web:

- `settings.get/update` persist `UserSettings` server-side so settings
  follow the account across browsers. The client also mirrors them in a
  Zustand `persist` store for instant first paint and applies the server copy
  when it loads (the server version takes precedence during conflicts; `settings.updated` events synchronize changes across tabs).
- There are no user-supplied provider keys; the desktop's OpenRouter key
  setting and the `openrouter_*` commands are dropped. `defaultModel` is a
  user setting (default `gemini-flash`).
- `researchLaunchInstruction` is stored on `user_preferences` with the 4 KiB
  cap enforced by the shared `clampResearchLaunchInstruction`.
- Dropped settings: `useLoginShell`, `worktreeLocation`, `codeMode`,
  `showTabDirectories`, `stickyUserMessages`, `preventSleep`,
  show/hide shortcut, `tabTitleProvider`, `openRouterKey`, `openRouterModel`
  (titles are always generated on `gemini-flash`).

## 7. Account deletion

Not implemented. There is no `account.delete` procedure: the router has no
`account` namespace, and nothing in the client offers deletion. The planned
procedure cancels active runs for the account, deletes the user record with
cascading foreign key deletion, and purges stored files under
`/data/documents/<userId>`. Until an automated procedure is implemented, account
deletion requires manual operator execution.

## 8. Rate limits

Request-level (from launch): per user 60 mutations/min; per user 120 image
uploads/hour (`POST /api/images`); per IP on `/auth/*` 20/min, except the
test-only `/auth/test-login`, which an e2e run calls dozens of times a minute.
Dedicated rate-limit buckets separate from the mutation budget: `artifacts.*` 600/min
per user,
`events.setInterest` 120/min per user (renewed by open tabs every 30 s);
and user-requested titles and recaps (`research.generateTitle`,
`recaps.generateCandidate`) at 30 per 10 minutes per user, each billed as a
metadata run. Thread invitations by GitHub login: one pending per account
and thread, at most 100 created per inviter per day.
In-memory token buckets in Hono middleware (single process).

Usage-level: a weekly allowance of included tokens per member, replacing the
daily token and run limits this section described before
(`15-implementation-plan/03-agents-and-research.md` §6, K1-K10). Every member is
metered, admins included.

- Tokens are recorded as they are spent, one `usage_events` row per provider
  call (the ledger, K1): opened when the call starts, its output checkpointed
  at most every 2 s, closed however the call ends. Input plus output count,
  with reasoning tokens inside output as the AI SDK reports them, and cached
  input at the model's `cachedInputRatio` (K2). Tokens paid by a member's own
  key are recorded and do not count. Every allowance check reads the ledger
  including open rows, so a member's concurrent runs see each other's
  spending.
- The allowance is `SESSION_WEEKLY_TOKENS` (2,000,000) per member per week,
  reset Fridays 00:00 UTC, or the member's own allowance in `user_limits`
  (`weekly_tokens`; K3). `usage.get`, the `pre` stage, the dispatcher and the
  run loop all read it through one function (`weeklyAllowance`).
- Who pays for a run is decided when the write that queues it applies, in the
  mutator's `pre` stage (K8): included tokens while any are left; once they
  are spent, the member's Anthropic key when the Usage page's setting is
  "Continue on my Anthropic key" (billing `key`) and the model may run on it;
  otherwise nothing can pay, and the write still applies: the thread or node
  is created and its run is written `failed { why: "tokens" }`, so the ask is
  kept and can run again after the reset. A key-only model's payer is the
  member's key for it (K11); without a valid one its run ends
  `failed { why: "key" }` when it is claimed. The client applies the same
  rule to `usage.get` before sending and sends nothing while out of tokens.
  Posts, replies and comments are never affected. The run record carries the
  payer (`pay`, null when nothing could pay).
- The dispatcher decides the payer again with the same rule when it claims a
  queued run (K10); a run nothing can pay for then ends
  `failed { why: "tokens" }` without a provider call and is not run again at
  the reset until the member presses Run again.
- A run on included tokens that crosses the allowance continues at its next
  step on the member's Anthropic key (billing `key`), or on overdraft (K9).
  The overdraft is `SESSION_OVERDRAFT_TOKENS` (200,000) per member per week,
  shared by all of the member's included-token runs; when it is reached each
  of them stops at its next ledger checkpoint and ends `complete` with
  "Stopped: this week's included tokens ran out." It does not carry over.
- Per run: `SESSION_RUN_MAX_TOKENS` (400,000), whoever pays, and at most
  `SESSION_QUEUED_PER_USER` (20) queued runs per member (L1).

Sign-up throttling (later): per-IP attempts per hour, minimum GitHub account
age (`github_created_at`), and sign-up codes as described in §3.
