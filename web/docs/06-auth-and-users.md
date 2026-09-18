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
3. `POST /auth/logout` — deletes the session, clears the cookie. Also exposed
   as `auth.logout` for the client.

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
and `invites` with `users.invites_remaining` defaulting to 0 so codes are
distributed manually when `SESSION_REQUIRE_INVITE=1` is switched on. The
optional `SESSION_ALLOWED_GITHUB_LOGINS` allowlist remains available.

Admins are set manually: `npm run db:admin -- <github login>` flips
`users.is_admin` (or a direct SQL update on the volume). Admin unlocks the
`claude-fable` model (`04-agent-runtime.md` §1) and
`admin.listUsers`. The server checks `is_admin` on every gated launch; the
client only hides UI.

## 4. Authorization in tRPC

- `protectedProcedure` middleware reads the cookie, loads the session and
  user, rejects with `UNAUTHORIZED` otherwise, and puts `userId` and
  `isAdmin` on `ctx`.
- `adminProcedure` additionally requires `isAdmin`.
- Every repository call receives `ctx.userId`; ids from the client are looked
  up with a `user_id` predicate so a foreign id is `NOT_FOUND`, never
  `FORBIDDEN` (no existence oracle).

## 5. CSRF and origin policy

- Mutations and subscriptions reject requests whose `Origin` header is
  present and differs from `SESSION_PUBLIC_ORIGIN`, or whose
  `Sec-Fetch-Site` is `cross-site`.
- The SPA sends `credentials: "include"` and a custom `X-Requested-With:
  session` header that the server requires on mutations (a second, cheap
  CSRF barrier since cross-origin custom headers trigger CORS preflight).
- No CORS allowances; the API is same-origin only. The artifact origin
  (Phase 7) uses token URLs and never sees the session cookie.

## 6. Per-user settings

The desktop kept `AppSettings` in localStorage (`src/lib/settings.ts`) and a
few values in a Rust preferences file. On the web:

- `settings.get/update` persist `UserSettings` server-side so settings
  follow the account across browsers. The client also mirrors them in a
  Zustand `persist` store for instant first paint and applies the server copy
  when it loads (server wins on conflict; `settings.updated` events keep tabs
  in sync).
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

- `account.delete` cancels active runs, removes the user row (FKs cascade),
  and deletes the user's documents from the volume.

## 8. Rate limits

Request-level (from launch): per user 60 mutations/min, 10
`journal.fetchTweet`/min, 20 uploads/hour; per IP on `/auth/*` 20/min.
In-memory token buckets in Hono middleware (single process).

Usage-level (schema now, enforcement later, `SESSION_ENFORCE_LIMITS=1`):
per account per UTC day, `daily_tokens` (input + output + reasoning across
all models, from `usage_events`) and `daily_runs` (research attempts).
Defaults from env (`SESSION_DAILY_TOKENS=1000000`, `SESSION_DAILY_RUNS=10`),
overridable per user in `user_limits`; admins exempt.
Checked at admission: a node over limit stays `queued` with a
`limitReached` flag in `research.node.updated` and is admitted after
midnight UTC or when the limit is raised, so nothing is lost.

Sign-up throttling (later): per-IP attempts per hour, minimum GitHub account
age (`github_created_at`), and invite codes as described in §3.
