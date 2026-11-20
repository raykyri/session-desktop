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

Admins are set manually: locally, `npm run db:admin -- <github login>` sets
`users.is_admin = 1`; on the deployed machine the script is not in the image, so it
is a SQL update against the volume instead (`13-deployment-fly.md` §2). Admin
unlocks the `claude-fable` model (`04-agent-runtime.md` §1) and
`admin.listUsers`. The server checks `is_admin` on every gated launch; the
client only conditionally hides administrative UI elements.

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

Usage-level (schema now, enforcement later, `SESSION_ENFORCE_LIMITS=1`):
per account per UTC day, `daily_tokens` (input + output across all models,
from `usage_events`) and `daily_runs` (research attempts started, counted
from the `run` rows of `usage_events`, which deleting the research does not
remove). `usage_events`
stores `reasoning_tokens` as a breakdown of `output_tokens` rather than as a
third bucket — that is how the AI SDK reports it (`04-agent-runtime.md` §13) —
so the limit check does not double-count reasoning tokens, matching the cost
estimate recorded on the event. Defaults from env (`SESSION_DAILY_TOKENS=1000000`,
`SESSION_DAILY_RUNS=10`), overridable per user in `user_limits`; admins exempt.
Checked at admission (`research.createTree`, `forkNode`, `retryNode`,
`rerunNode`, `followups.ask`, and the follow-up queue's dispatch), which
answers `TOO_MANY_REQUESTS` as `03-api-and-events.md` §2 specifies, because
displaying an explicit error in the query composer provides clearer feedback
than creating a node that appears queued but cannot execute. Admission counts
the account's queued questions as runs already spent (a reservation), preventing
an account from queueing more runs than its remaining daily allowance. The check,
together with the queued-per-account cap (`SESSION_QUEUED_PER_USER`), runs again inside the
transaction that admits and queues the node (`admitWithinLimits`), synchronously
with no asynchronous yield, preventing race conditions where concurrent requests passing
preliminary checks prior to link resolution might otherwise both be admitted.

The dispatcher checks the payer's limits once more before a queued node's
fresh attempt starts, without the reservation, verifying whether limits were
lowered or tokens were spent while the node was queued. A node refused there
stays `queued`; its `run_queue` row is held (`not_before`) until the next UTC
midnight, and its run `error` is set to "Queued until the daily research limit resets
at midnight UTC." (or "daily token limit"), which the thread shows in place of its
queue position. `admin.setLimits` releases the account's held rows at once; the
dispatcher holds them again if the new limits still refuse them. Starting the run
clears the error message. A 429 re-queue and a resume continue an existing attempt
and are not subjected to the midnight hold.

Sign-up throttling (later): per-IP attempts per hour, minimum GitHub account
age (`github_created_at`), and sign-up codes as described in §3.
