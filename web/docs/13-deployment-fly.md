# Deployment on Fly.io

## 1. App and hostnames

One Fly app, `session-dev`, one region (`sjc` unless the team is elsewhere),
one machine with a volume. Hostnames `session.dev` (app) and
`artifacts.session.dev` (document preview origin), both certificates via
`fly certs add`, DNS `A`/`AAAA` to the app's IPs plus the `_acme-challenge`
CNAMEs.

`SESSION_PUBLIC_ORIGIN=https://session.dev`,
`SESSION_ARTIFACT_ORIGIN=https://artifacts.session.dev`.

## 2. `web/fly.toml`

The file is `web/fly.toml`; `kill_signal` and `kill_timeout` are top-level
keys (Fly's schema has no `[deploy]` entry for them).

```toml
app = "session-dev"
primary_region = "sjc"
kill_signal = "SIGTERM"
kill_timeout = "30s"

[build]
  dockerfile = "Dockerfile"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"
  NODE_ENV = "production"
  SESSION_PUBLIC_ORIGIN = "https://session.dev"
  SESSION_ARTIFACT_ORIGIN = "https://artifacts.session.dev"
  SESSION_DATA_DIR = "/data"
  SESSION_RUNS_PER_USER = "2"
  SESSION_QUEUED_PER_USER = "20"
  SESSION_RUNS_GEMINI = "8"
  SESSION_RUNS_OPENROUTER = "8"
  SESSION_RUNS_ANTHROPIC = "2"
  SESSION_RUN_TIMEOUT_SECONDS = "900"
  SESSION_ENFORCE_LIMITS = "1"
  SESSION_DAILY_TOKENS = "1000000"
  SESSION_DAILY_RUNS = "10"
  SESSION_REQUIRE_INVITE = "1"
  SESSION_SEARCH_VENDOR = "parallel"
  GOOGLE_VERTEX_PROJECT = "session-dev"
  GOOGLE_VERTEX_LOCATION = "global"

[[mounts]]
  source = "session_data"
  destination = "/data"
  initial_size = "20gb"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "requests"
    soft_limit = 200
    hard_limit = 400
  [[http_service.checks]]
    grace_period = "20s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "/healthz"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"

[deploy]
  strategy = "immediate"      # one machine with a volume cannot roll
```

Runs are HTTPS streams, so memory is dominated by the Node process, SQLite
page cache, and document text extraction; 2 GB is comfortable. Raise the
machine size before raising the per-provider run caps.

The cost ceiling and the sign-up gate are **on**. This origin pays a provider
per token, so both are deployment settings rather than code defaults, and both
are deliberately visible in the file:

- `SESSION_ENFORCE_LIMITS = "1"` makes `SESSION_DAILY_TOKENS` and
  `SESSION_DAILY_RUNS` refuse rather than merely record. With it at `0` the
  usage rows are still written and nothing is ever refused, which is the right
  default for local development and the wrong one for a public origin.
- `SESSION_REQUIRE_INVITE = "1"` means an account is created only against a
  code an admin minted (`06-auth-and-users.md` §3). `SESSION_ALLOWED_GITHUB_LOGINS`
  is the narrower alternative; with neither, sign-up is open to anyone who can
  reach the host.
- `SESSION_QUEUED_PER_USER = "20"` caps what one account may have *waiting*.
  `SESSION_RUNS_PER_USER` bounds only what is running at once, so without this
  a script can admit a thousand questions and the deployment is committed to
  paying for all of them, two at a time. Refused at launch with
  `TOO_MANY_REQUESTS`; admins are exempt; enforced whatever
  `SESSION_ENFORCE_LIMITS` says, because it bounds the queue itself rather
  than the day's spend.

Per-account overrides for the daily limits live in `user_limits` and are set
from `/admin`, so raising one account's ceiling does not mean turning
enforcement off.

Deploying:

```sh
fly deploy web -c web/fly.toml            # — or --remote-only, which CI uses
```

The positional `web` is the build context. Without it flyctl hands Docker the
repository root, where `package.json` is the desktop's and the build fails on a
missing `web/` prefix. CI runs the same command in the `production`
environment after `check`, `test`, `e2e`, and `docker` pass
(`12-testing-linting-ci.md` §4).

First-time setup, in order:

```sh
fly apps create session-dev
fly volumes create session_data -a session-dev -r sjc -s 20
fly certs add session.dev -a session-dev
fly certs add artifacts.session.dev -a session-dev   # then the DNS records fly prints
fly secrets set -a session-dev ...                   # §4
fly deploy web -c web/fly.toml
```

`fly volumes create` before the first deploy, because `strategy = "immediate"`
stops the old machine before the new one claims the volume and a deploy with no
volume to claim fails.

Granting admin — which is what unlocks `claude-fable` and `/admin`
(`06-auth-and-users.md` §3) — happens after the account's first sign-in, and
differs by environment. Locally it is `npm run db:admin -- <github login>`. On
the machine it is not: the runtime image carries the server bundle and
production `node_modules` only, so neither `packages/db/bin/admin.ts` nor `tsx`
is there to run. Use the driver that is:

```sh
fly ssh console -a session-dev -C "node -e \"
  const db = require('better-sqlite3')('/data/session.db');
  const r = db.prepare('update users set is_admin = 1 where login = ?').run('<github login>');
  if (r.changes === 0) throw new Error('no account with that login');
\""
```

## 3. Dockerfile (`web/Dockerfile`)

Multi-stage on `node:22-bookworm-slim`: `deps` (`npm ci`, build tools for
`better-sqlite3` only if the platform has no prebuilt binary), `build` (the
Vite client bundle and the esbuild server bundle; `tsc -b` is CI's `check`
job, not the image's), `runtime` (production `node_modules`,
`packages/client/dist/app`, `packages/server/dist/server.mjs`,
`packages/server/assets/fonts`, `packages/db/migrations`, the Litestream
binary pinned by version and SHA-256, `tini` as PID 1).

The server bundle inlines `@session/db` and `@session/shared`, which publish
TypeScript sources, and leaves every npm package external, so `better-sqlite3`
and the extraction libraries (`unpdf`, `mammoth`, `linkedom`) load from
`node_modules` at runtime. `main.ts` passes the migrations folder explicitly
(`../../db/migrations` relative to the module) because the bundle sits where
the database package's own default would not resolve.

`web/scripts/entrypoint.sh` takes ownership of the volume, writes
`GOOGLE_APPLICATION_CREDENTIALS_JSON` to
`$SESSION_DATA_DIR/tmp/vertex-credentials.json` (0600, the same path the
server writes at boot) and exports `GOOGLE_APPLICATION_CREDENTIALS`, then runs
`litestream replicate -config /etc/litestream.yml -restore-if-db-not-exists
-exec "node /app/packages/server/dist/server.mjs"` when
`LITESTREAM_REPLICA_URL` is set, else the server directly. Those steps need
root — a Fly volume arrives owned by root — so the entrypoint re-execs the
process itself as `session` (uid 1000) with `setpriv`. No agent CLIs, no
browsers, no per-user OS accounts.

`web/.dockerignore` allowlists `web/**` minus `node_modules`, `**/dist`,
`docs`, `.data`, and `.env*`. The repo root's Dockerfile, `.dockerignore`, and `fly.toml`
are removed (`14-legacy-inventory.md` §3).

## 4. Secrets (`fly secrets set -a session-dev`)

| Secret | Purpose |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | OAuth app with callback `https://session.dev/auth/github/callback` |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Vertex AI service account key (JSON) |
| `OPENROUTER_API_KEY` | DeepSeek V4.1 Flash and GPT-5.6 Luna; the OpenRouter account has ZDR and no-collection enforced account-wide |
| `ANTHROPIC_API_KEY` | Claude Fable 5.1 (org configured for 30-day retention) |
| `PARALLEL_API_KEY`, `TAVILY_API_KEY` | search vendors for `web_search` (either or both; none = search unavailable) |
| `LITESTREAM_REPLICA_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SQLite backups and document archive |
| `SESSION_ALLOWED_GITHUB_LOGINS` | optional allowlist, narrower than the invite gate (unset = any GitHub account with a valid invite) |
| `SESSION_METRICS_TOKEN` | bearer token for `GET /metrics` (unset = the route 404s) |
| `SENTRY_DSN` | optional error reporting |

Sign-up is gated by `SESSION_REQUIRE_INVITE = "1"` in `[env]` (§2), not by a
secret. Mint codes from `/admin` as an admin; the first admin is granted with
the `fly ssh console` snippet at the end of §2. `SESSION_ALLOWED_GITHUB_LOGINS`
narrows it further and applies on top of the invite check rather than instead
of it.

## 5. Boot and shutdown

Boot: validate env → write the Vertex credential file → open DB (pragmas) →
`migrate()` (refuse on unknown migrations) → backfills → re-queue
`resume_pending` nodes (`05-run-lifecycle-and-streaming.md` §7) → probe
provider credentials (async; missing ones mark models `unavailable`) →
listen. `/healthz` returns 503 (`starting`) until the listen callback runs and
503 (`draining`) from the first moment of the drain, so Fly's check follows
the process rather than the port.

Shutdown on `SIGTERM`: stop admitting; abort open provider streams after
persisting their last checkpoint; mark their nodes `interrupted` with
`resume_pending`; close SSE connections; checkpoint WAL; exit. The next boot
resumes the runs.

The drain is raced against a 20-second deadline (`main.ts:SHUTDOWN_DEADLINE_MS`)
rather than awaited outright, leaving ten seconds of `kill_timeout = 30s` for
the close and the WAL checkpoint. A provider that has stopped sending without
closing its stream would otherwise hold the drain past the timeout, and the
SIGKILL that follows would land before the checkpoint — leaving an unclean WAL
for the next boot to open. What the deadline cuts short is recovered on boot
anyway: `reconcileOnBoot` marks anything still `running` as `interrupted` with
`resume_pending` and re-queues it. A drain that runs long costs a resume; a
SIGKILL costs the checkpoint.

Boot also repairs the two states a crash between two transactions can leave and
that no client can act on afterwards: a `queued` node with no `run_queue` row
(re-queued at the back), and a `complete` `document` node with no snapshot
(failed, so it can be deleted or re-imported).

## 6. Backups and restore

- Litestream replicates continuously to Tigris or S3; retention 30 days;
  snapshot every 6 h (`web/litestream.yml`, copied to `/etc/litestream.yml`).
- `/data/documents` archived to the same bucket by
  `web/scripts/backup-documents.sh` (`tar` of files newer than the last run's
  marker, uploaded with `web/scripts/s3-put.mjs`). The archive target is
  `SESSION_DOCUMENTS_REPLICA_URL`, defaulting to
  `${LITESTREAM_REPLICA_URL}/documents`. The server runs it itself once a day
  (`main.ts:DAILY_INTERVAL_MS`), skipping it when neither URL is set. In
  process rather than from an external scheduler because the deployment is one
  machine holding one volume: a Fly scheduled machine would need the volume
  this one has, and an operator-run cron is a step that gets documented and
  then not done. A failed run is logged and the next day tries again; the
  marker moves only on success, so nothing is skipped.
- The volume is reconciled with the `documents` table on the maintenance
  interval (`main.ts:MAINTENANCE_INTERVAL_MS`, 15 min): files under
  `/data/documents` that no row points at are unlinked. Deleting a document or
  an account unlinks its bytes directly; removing a workspace or a thread
  cascades the rows away inside SQLite with no path to hand over, and the sweep
  is what stops those from filling the mount. `session_volume_free_bytes` (§7)
  is the gauge to alert on — a full volume fails every SQLite write at once.
- Restore, including the quarterly rehearsal:
  `web/docs/runbooks/restore.md`.

## 7. Observability

- Structured JSON logs to stdout; `X-Request-Id` echoed; per-attempt run
  logs (`nodeId`, `userId`, model, steps, tool calls, tokens, cost estimate,
  outcome).
- `/metrics` (Prometheus text, bearer-protected by `SESSION_METRICS_TOKEN`;
  unset = the route 404s): `session_http_request_duration_seconds` by method,
  coarse route, and status class, `session_active_runs` by provider,
  `session_queue_depth`, `session_sse_clients`, `session_db_size_bytes`,
  `session_volume_free_bytes` (free space on the data volume; alert on it —
  see §6),
  `session_daily_tokens` and `session_daily_cost_usd` per provider for the
  current UTC day, `session_ready`. The gauges are read out of SQLite at
  scrape time (`packages/server/src/metrics.ts`).
- Optional Sentry via `SENTRY_DSN`.

## 8. Local development

`npm run dev` in `web/`: server on `http://localhost:8787` (tsx watch),
client on `http://localhost:1480` (Vite, proxying `/api`, `/auth`, `/a`,
`/uploads`, `/healthz`). `SESSION_DATA_DIR=./.data` (git-ignored).
`SESSION_FIXTURE_PROVIDERS=1` swaps every model for a fixture provider so UI
work needs no credentials. `web/.env.example` documents every variable with
comments (copy it to `web/.env`); the repo-root `.env.example` loses the
GitHub/OpenRouter lines that belonged to the old site.
