# Deployment on Fly.io

## 1. App and hostnames

One production Fly app, `session-dev`, one region (`sjc`), one machine with a
volume. Hostname `session.dev`, certificate via `fly certs add`, DNS `A`/`AAAA`
to the app's IPs plus the `_acme-challenge` CNAME.
`SESSION_PUBLIC_ORIGIN=https://session.dev`.

Staging is a second app, `session-staging`, with its own volume, bucket
prefix, OAuth apps and secrets (plan `05` §3.2). Its configuration file,
`web/fly.staging.toml`, is not yet in the repository; `runbooks/launch.md`
§4.1 makes it from `web/fly.toml`. No CI job deploys staging: it is deployed
by hand, `fly deploy web -c web/fly.staging.toml` (`runbooks/launch.md`
§4.1).

The web build has no widget preview origin. The `artifacts.session.dev`
certificate of the earlier build is removed 30 days after launch
(`runbooks/launch.md` §6 step 9).

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
  SESSION_DATA_DIR = "/data"
  SESSION_RUNS_PER_USER = "2"
  SESSION_QUEUED_PER_USER = "20"
  SESSION_RUNS_GEMINI = "8"
  SESSION_RUNS_OPENROUTER = "8"
  SESSION_RUNS_ANTHROPIC = "2"
  SESSION_RUN_TIMEOUT_SECONDS = "900"
  SESSION_WEEKLY_TOKENS = "2000000"
  SESSION_OVERDRAFT_TOKENS = "200000"
  SESSION_RUN_MAX_TOKENS = "400000"
  SESSION_INVITES_PER_MEMBER = "3"
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
  strategy = "immediate"      # a single machine with a persistent volume cannot use rolling deployments
```

Runs are HTTPS streams, so memory is dominated by the Node process, the
record cache and the SQLite page cache; 2 GB is comfortable. Raise the
machine size before raising the per-provider run caps.

Limits that bound spending are set explicitly in `fly.toml` rather than left
to defaults:

- `SESSION_WEEKLY_TOKENS`, `SESSION_OVERDRAFT_TOKENS` and
  `SESSION_RUN_MAX_TOKENS` bound what members spend: a weekly allowance of
  included tokens per member, an overdraft past it shared by the member's
  runs, and a cap per run (`06-auth-and-users.md` §8; plan `03` K3, K9,
  L1). They are always enforced; there is no switch.
- `SESSION_QUEUED_PER_USER = "20"` caps what one account may have queued,
  since `SESSION_RUNS_PER_USER` limits only the runs that are running.

Session is invite-only in every deployment: an identity without an invite
becomes a waiting account that reads open channels (plan `04` I4). There is
no setting for it. `SESSION_INVITES_PER_MEMBER = "3"` is the number of
account invites each member gets in all (plan `04` I2): a used link spends
one, an open link holds one, and revoking an unused link gives it back; site
admins have no limit. A member's own weekly allowance and the extra invites
site admins gave them are a `user_limits` row (`weekly_tokens`,
`extra_invites`), so changing one member's does not change anyone else's.
Site admins give invites on Site Admin; the operator command is
`node /app/packages/server/dist/admin.mjs --grant-invites <handle> <n>`.

Deploying:

```sh
fly deploy web -c web/fly.toml            # — or --remote-only, which CI uses
```

The positional `web` is the build context. Without it, flyctl uses the
repository root, and the build fails because paths lack the `web/` prefix.
CI runs the same command in the `production` environment after `check`,
`test`, `e2e`, and `docker` pass (`12-testing-linting-ci.md` §4).

First-time setup, in order:

```sh
fly apps create session-dev
fly volumes create session_data -a session-dev -r sjc -s 20
fly certs add session.dev -a session-dev             # then the DNS records fly prints
fly secrets set -a session-dev ...                   # §4
fly deploy web -c web/fly.toml
```

`fly.toml`'s `[[mounts]]` sets `initial_size = "20gb"`, from which Fly
creates the volume at the first deploy when the app has none (Fly's
behaviour, not verified here). `fly volumes create` before the first deploy
fixes the volume's region and size explicitly instead.

Site admins are seeded by handle (plan `05` §3.5): a root invite printed on
the machine, redeemed by the person, who chooses a handle, then promoted by
that handle. The runtime image has no sources and no `tsx`; it holds the
operator commands of `packages/db/bin/admin.ts` bundled as
`packages/server/dist/admin.mjs`:

```sh
fly ssh console -a session-dev
# inside:
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs --invite
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs <handle>
```

`runbooks/launch.md` §6 step 6 has the whole sequence.

## 3. Dockerfile (`web/Dockerfile`)

Multi-stage on `node:22-bookworm-slim`: `deps` (`npm ci`, build tools for
`better-sqlite3` only if the platform has no prebuilt binary), `build` (the
Vite client bundle and the esbuild bundles of the server and its operator
scripts; `tsc -b` is CI's `check` job, not the image's), `runtime`
(production `node_modules`, `packages/client/dist/app`,
`packages/server/dist/server.mjs`, the operator bundles
`privacy-check.mjs`, `reset-database.mjs` and `admin.mjs` beside it,
`packages/db/migrations`, the Litestream binary pinned by version and
SHA-256, `tini` as PID 1).

The bundles inline `@session/db`, `@session/shared`, `@session/mutators` and
`@session/sync`, which publish TypeScript sources, and leave every npm
package external, so `better-sqlite3` loads from `node_modules` at runtime.
`main.ts` and `admin.ts` pass the migrations folder explicitly
(`../../db/migrations` relative to the module) because the bundle sits where
the database package's own default would not resolve.

`web/scripts/entrypoint.sh` takes ownership of the volume, writes
`GOOGLE_APPLICATION_CREDENTIALS_JSON` to
`$SESSION_DATA_DIR/tmp/vertex-credentials.json` (0600, the same path the
server writes at boot) and exports `GOOGLE_APPLICATION_CREDENTIALS`, then runs
`litestream replicate -config /etc/litestream.yml -restore-if-db-not-exists
-exec "node /app/packages/server/dist/server.mjs"` when
`LITESTREAM_REPLICA_URL` is set, else the server directly. These initialization
steps require root permissions because mounted Fly volumes default to root
ownership; the entrypoint drops privileges and executes the application process
as user `session` (UID 1000) via `setpriv`. The environment contains no agent CLIs,
browser binaries, or per-user operating system accounts.

`web/.dockerignore` allowlists `web/**` minus `node_modules`, `**/dist`,
`docs`, `.data`, and `.env*`.

## 4. Secrets (`fly secrets set -a session-dev`)

`runbooks/launch.md` §2 lists what the server refuses to start without and
where each value comes from.

| Secret | Purpose |
| --- | --- |
| `SESSION_SECRET_KEY` | 32-byte AES-256-GCM key (`openssl rand -base64 32`) that seals members' API keys and open invite codes; required in production, and backed up outside Fly: losing it makes stored keys and open codes unreadable (ADR-23) |
| `SESSION_CURSOR_KEY` | 32 bytes of base64 that seal sync cursors and event ids; required in production, different from `SESSION_SECRET_KEY`. `SESSION_CURSOR_KEY_PREVIOUS` and `SESSION_CURSOR_KEY_ROTATED_AT` only during a rotation (`runbooks/rotate-cursor-key.md`) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | OAuth app with callback `https://session.dev/auth/github/callback` |
| `SESSION_X_CLIENT_ID`, `SESSION_X_CLIENT_SECRET` | X OAuth 2.0 app with callback `https://session.dev/auth/x/callback` |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | Vertex AI service account key (JSON) |
| `OPENROUTER_API_KEY` | DeepSeek V4.1 Flash and GPT-5.6 Luna; the OpenRouter account has ZDR and no-collection enforced account-wide |
| `ANTHROPIC_API_KEY` | Claude Fable 5.1 (org configured for 30-day retention) |
| `PARALLEL_API_KEY`, `TAVILY_API_KEY` | search vendors for `web_search` (either or both; none = search unavailable) |
| `LITESTREAM_REPLICA_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SQLite backups and document archive |
| `SESSION_DOCUMENTS_REPLICA_URL` | optional; where the documents archive goes, `${LITESTREAM_REPLICA_URL}/documents` when unset (`web/scripts/backup-documents.sh`) |
| `AWS_ENDPOINT_URL_S3`, `AWS_REGION` | the bucket's S3 endpoint and region, read by Litestream and `web/scripts/s3-put.mjs`; Fly sets the endpoint for a Tigris bucket |
| `SESSION_ALLOWED_GITHUB_LOGINS` | optional allowlist of GitHub logins, on top of the invite requirement; it does not restrict X sign-ins; unset at launch |
| `SESSION_METRICS_TOKEN` | bearer token for `GET /metrics` (unset = the route 404s) |
| `SENTRY_DSN` | read by `config.ts` and unused: the build has no error reporting |

## 5. Boot and shutdown

Boot (`main.ts`, `boot.ts`; plan `01` S5): validate env → write the Vertex
credential file → open the database (pragmas) → refuse a database that
records a migration this build does not know (`UnknownMigrationError`: one
log line naming `runbooks/reset-database.md`, exit 1), then `migrate()` →
backfills → the first heartbeat row (operator jobs refuse while it is
fresh, `runbooks/delete-account.md`) → the restore check (plan `01` D6: a file of another
generation, or an operator's request, replaces the sync history id) → close
`usage_events` rows left `open` → mark runs still `running` as `interrupted`
→ start the run dispatcher and the maintenance jobs → listen. `/healthz`
returns 503 (`starting`) until the listen callback runs and 503 (`draining`)
from the first moment of the drain, so Fly's check follows the process
rather than the port.

The migration history is one generated `0000_initial.sql` since the M8a
squash (plan `01` D5). A database made by the earlier migrations is refused
at boot and replaced, not upgraded (`runbooks/reset-database.md`).

Shutdown on `SIGTERM`: the health check fails, later sync envelopes answer
`SERVICE_UNAVAILABLE` and the sync streams close, running attempts are
aborted and record themselves `interrupted`, the HTTP server stops
accepting and closes the connections still open after a short grace, the
heartbeat row in `server_meta` is deleted, the WAL is checkpointed and the
database closed. The drain enforces a 20-second timeout
(`main.ts:SHUTDOWN_DEADLINE_MS`) to reserve ten seconds of the 30-second
`kill_timeout` for connection closure and the checkpoint.

## 6. Backups and restore

- Litestream replicates continuously to Tigris or S3; retention 30 days;
  snapshot every 6 h (`web/litestream.yml`, copied to `/etc/litestream.yml`).
- `/data/documents` is archived to the same bucket by
  `web/scripts/backup-documents.sh` (`tar` of files newer than the last run's
  marker, uploaded with `web/scripts/s3-put.mjs`), to
  `SESSION_DOCUMENTS_REPLICA_URL`, defaulting to
  `${LITESTREAM_REPLICA_URL}/documents`. The server runs it itself
  (`server/src/backups.ts`), skipping it when neither URL is set: at boot
  and then every hour it checks the age of the marker
  `/data/tmp/documents-backup.stamp` and runs the script when the marker is
  missing or a day old. The current build writes nothing under
  `/data/documents`; the archives matter for a database of the earlier build
  (a rollback, `runbooks/launch.md` §6 step 8).
- `session_volume_free_bytes` (§7) is the gauge to alert on: a full volume
  fails every SQLite write at once.
- Restore, including the rehearsal: `web/docs/runbooks/restore.md`.
  Replacing the database with an empty one: `runbooks/reset-database.md`.

## 7. Observability

- Structured JSON logs to stdout; `X-Request-Id` echoed. Logs carry ids and
  answer codes, never record text.
- `/metrics` (Prometheus text, bearer-protected by `SESSION_METRICS_TOKEN`;
  unset = the route 404s): `session_http_request_duration_seconds` by
  method, coarse route and status class, `session_run_failures_total` by
  error class, `session_rate_limited_total` by limit,
  `session_process_memory_bytes`, `session_sse_streams`, `session_ready`,
  `session_volume_free_bytes`, `session_db_size_bytes` (file and WAL),
  `session_daily_tokens` and `session_daily_cost_usd` per provider for the
  current UTC day, and, when an archive target is set,
  `session_documents_backup_age_seconds`. The gauges are read at scrape
  time (`packages/server/src/metrics.ts`).
- Optional Sentry via `SENTRY_DSN`.

## 8. Local development

`npm run dev` in `web/`: server on `http://localhost:8787` (tsx watch),
client on `http://localhost:1480` (Vite, proxying `/api`, `/auth`,
`/healthz`, `/metrics`). `SESSION_DATA_DIR=./.data` (git-ignored).
`SESSION_FIXTURE_PROVIDERS=1` swaps every model for a fixture provider so UI
work needs no credentials. `web/.env.example` documents every variable with
comments (copy it to `web/.env`). A `.data` database made before the M8a
squash is refused at boot; reset it (`runbooks/reset-database.md`, "Local
development").
