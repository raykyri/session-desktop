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

```toml
app = "session-dev"
primary_region = "sjc"

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
  SESSION_RUNS_GEMINI = "8"
  SESSION_RUNS_OPENROUTER = "8"
  SESSION_RUNS_ANTHROPIC = "2"
  SESSION_RUN_TIMEOUT_SECONDS = "900"
  SESSION_ENFORCE_LIMITS = "0"
  SESSION_DAILY_TOKENS = "1000000"
  SESSION_DAILY_RUNS = "10"
  SESSION_REQUIRE_INVITE = "0"
  SESSION_SEARCH_VENDOR = "parallel"
  GOOGLE_VERTEX_PROJECT = "<project>"
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
  kill_signal = "SIGTERM"
  kill_timeout = "30s"
```

Runs are HTTPS streams, so memory is dominated by the Node process, SQLite
page cache, and document text extraction; 2 GB is comfortable. Raise the
machine size before raising the per-provider run caps.

## 3. Dockerfile (`web/Dockerfile`)

Multi-stage on `node:22-bookworm-slim`: `deps` (`npm ci`, build tools for
`better-sqlite3` if no prebuilt binary), `build` (`npm run build`),
`runtime` (production `node_modules`, `packages/client/dist`,
`packages/server/dist`, `packages/db/migrations`, the Litestream binary,
`tini`). The entrypoint writes `GOOGLE_APPLICATION_CREDENTIALS_JSON` to
`/tmp/vertex-sa.json` and exports `GOOGLE_APPLICATION_CREDENTIALS`, then runs
`litestream replicate -exec "node packages/server/dist/main.js"` when
`LITESTREAM_REPLICA_URL` is set, else the server directly. Runs as user
`session` (uid 1000). No agent CLIs, no browsers, no per-user OS accounts.

`web/.dockerignore` allowlists `web/**` minus `node_modules`, `**/dist`,
`docs`, `.data`. The repo root's Dockerfile, `.dockerignore`, and `fly.toml`
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
| `SESSION_ALLOWED_GITHUB_LOGINS` | optional allowlist (unset = open sign-up) |

## 5. Boot and shutdown

Boot: validate env → write the Vertex credential file → open DB (pragmas) →
`migrate()` (refuse on unknown migrations) → backfills → re-queue
`resume_pending` nodes (`05-run-lifecycle-and-streaming.md` §7) → probe
provider credentials (async; missing ones mark models `unavailable`) →
listen. `/healthz` returns 200 after migrations complete.

Shutdown on `SIGTERM`: stop admitting; abort open provider streams after
persisting their last checkpoint; mark their nodes `interrupted` with
`resume_pending`; close SSE connections; checkpoint WAL; exit. Fits in
`kill_timeout = 30s`. The next boot resumes the runs.

## 6. Backups and restore

- Litestream replicates the WAL continuously to Tigris or S3; retention 30
  days; snapshot every 6 h.
- `/data/documents` archived nightly to the same bucket (`tar` of new files
  by mtime).
- Restore rehearsal (quarterly): new volume, `litestream restore -o
  /data/session.db`, restore documents, start the app, verify counts.

## 7. Observability

- Structured JSON logs to stdout; `X-Request-Id` echoed; per-attempt run
  logs (`nodeId`, `userId`, model, steps, tool calls, tokens, cost estimate,
  outcome).
- `/metrics` (Prometheus text, bearer-protected): request latency, active
  runs by provider, queue depth, SSE clients, DB size, tokens and cost per
  provider per day.
- Optional Sentry via `SENTRY_DSN`.

## 8. Local development

`npm run dev` in `web/`: server on `http://localhost:8787` (tsx watch),
client on `http://localhost:1480` (Vite, proxying `/api`, `/auth`, `/a`,
`/uploads`, `/healthz`). `SESSION_DATA_DIR=./.data` (git-ignored).
`SESSION_FIXTURE_PROVIDERS=1` swaps every model for a fixture provider so UI
work needs no credentials. `web/.env.example` documents every variable with
comments (copy it to `web/.env`); the repo-root `.env.example` loses the
GitHub/OpenRouter lines that belonged to the old site.
