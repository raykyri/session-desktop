# Session Web

A shared agentic knowledge graph.

## Quickstart

Prerequisites: Node 22.20+.

First, fill in any of these credentials in .env, based on .env.example.
Models and search providers are reported as "unavailable" if credentials
are missing:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` for sign-in.
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_VERTEX_PROJECT` for
  default model, titles, recaps, encyclopedia pages (all Gemini Flash)
- `PARALLEL_API_KEY` or `TAVILY_API_KEY` for web search
- `OPENROUTER_API_KEY` for DeepSeek and GPT-5.6 Luna
- `ANTHROPIC_API_KEY` for Claude Fable (admin-only)

For GitHub locally, register the callback as
`http://localhost:1480/auth/github/callback`.

Then run:

```sh
cd web
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:1480`. The API runs on `127.0.0.1:8787` and
Vite proxies to it.

### Getting a Vertex service-account key

Gemini is reached through Vertex AI, which authenticates with a Google Cloud
service account rather than an API key. Four steps, once.

**1. Pick or create a project**, and note its id. Save it as `GOOGLE_VERTEX_PROJECT`.

```sh
gcloud projects create session-dev-web --name="Session Web"   # or use an existing one
gcloud config set project session-dev-web
```

Billing must be enabled on it; Vertex refuses requests otherwise, and the
error arrives at the first question rather than at boot.

**2. Enable the API.**

```sh
gcloud services enable aiplatform.googleapis.com
```

Console equivalent:
`https://console.cloud.google.com/apis/library/aiplatform.googleapis.com`

**3. Create a service account and give it exactly one role.** `Vertex AI User`
(`roles/aiplatform.user`) is enough to call models — do not grant `Vertex AI
Administrator`, which can also manage infrastructure.

```sh
gcloud iam service-accounts create session-dev-web   --display-name="Session Web"

gcloud projects add-iam-policy-binding session-dev-web   --member="serviceAccount:session-dev-web@session-dev-web.iam.gserviceaccount.com"   --role="roles/aiplatform.user"
```

Console equivalent:
`https://console.cloud.google.com/iam-admin/serviceaccounts` → Create service
account → grant `Vertex AI User`.

**4. Download a JSON key.**

```sh
gcloud iam service-accounts keys create vertex-key.json   --iam-account=session-dev-web@session-dev-web.iam.gserviceaccount.com
```

Console equivalent: open the service account → Keys → Add key → Create new key
→ JSON.

That file is a long-lived credential for your project. Keep it out of the
repository, and delete the local copy once it is in `.env` or Fly secrets.

**Putting it in place.** The app wants the whole key as one line. Locally:

```sh
echo "GOOGLE_APPLICATION_CREDENTIALS_JSON=$(jq -c . vertex-key.json | sed "s/'/'\\''/g")" >> .env
echo "GOOGLE_VERTEX_PROJECT=session-dev-web" >> .env
```

In production it is a Fly secret (§3 below). At boot the server writes it to
`$SESSION_DATA_DIR/tmp/vertex-credentials.json` with mode `0600` and points
the Vertex client at that file, so the key never sits in an environment
variable a child process could inherit.

`GOOGLE_VERTEX_LOCATION` defaults to `global`, which is the right answer
unless you have a data-residency requirement; a regional endpoint restricts
which models you can reach.

**Checking it works.** Start the server with fixtures off and look at the
models the client is offered — Gemini appears as available only when the
credential resolved:

```sh
curl -fsS -b jar -H 'x-requested-with: session' \
  'http://localhost:1480/api/trpc/system.runtimeConfig?input=%7B%7D' \
  | jq '.result.data.models[] | {id, available}'
```

A credential that is present but wrong fails at the first question instead,
with the provider's own message on the failed node.

**Rotating it.** Create a second key, replace the secret, redeploy, then
delete the old key with `gcloud iam service-accounts keys delete`. Keys do not
expire on their own.

### Everyday commands

| Command                              | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| `npm run dev`                        | Server and client with reload                              |
| `npm run check`                      | Types, lint, format, schema drift                          |
| `npm test`                           | Unit tests across the four packages                        |
| `npm run test:e2e`                   | Playwright, against fixture providers                      |
| `npm run db:admin -- <github login>` | Grants admin, which unlocks Claude Fable and the user list |
| `npm run db:studio`                  | Browse the database                                        |

State lives in `web/.data` — the database, uploaded documents, temp files.
Delete the directory to start clean.

### Running with no credentials (for testing, etc.)

Set these two in `.env`:

```sh
SESSION_FIXTURE_PROVIDERS=1   # every model replays a recorded stream
SESSION_TEST_AUTH=1           # enables POST /auth/test-login
```

Sign in without GitHub:

```sh
curl -c jar -X POST http://localhost:1480/auth/test-login \
  -H 'content-type: application/json' -H 'x-requested-with: session' \
  -d '{"login":"you","isAdmin":true}'
```

Choose a recorded scenario by prefixing a question with `fixture:<name>` — for
example `fixture:success-with-tools how do bloom filters work?`. The scenarios
live in `packages/server/src/runs/fixtures/`; `paced-answer` is the one to use
when you want to watch text stream in slowly, and `refusal`, `rate-limit` and
`timeout` exercise the failure paths.

---

## Deployment

### 1. Create the app and its volume

```sh
fly apps create session-dev
fly volumes create session_data -a session-dev -r sjc -s 20
```

Create the volume before the first deploy. A machine that boots without one
writes its database to the container filesystem and loses it on the next
release.

### 2. DNS and certificates, for both hostnames

The app is reached by two names: `session.dev` for the app, and
`artifacts.session.dev` for document previews. They must be **different
hostnames on the same Fly app**, because the session cookie is scoped to the
app host and must never reach the origin the preview iframe is same-origin
with. The server enforces this by comparing the `Host` header against
`SESSION_ARTIFACT_ORIGIN`, so both names have to resolve to the same machines
and the database they share.

Fly routes by IP rather than by hostname, so any name pointing at the app's
addresses arrives at it, and the original `Host` is passed through untouched.
What Fly does need is a certificate per name, since it terminates TLS:

```sh
fly ips list -a session-dev          # the addresses to point DNS at
fly certs add session.dev -a session-dev
fly certs add artifacts.session.dev -a session-dev
```

Add `A` and `AAAA` records for both names pointing at those addresses, plus
the `_acme-challenge` CNAME each `fly certs add` prints. Then wait for both to
report as issued:

```sh
fly certs check session.dev -a session-dev
fly certs check artifacts.session.dev -a session-dev
```

DNS alone is not enough — without a certificate the second hostname fails at
the TLS handshake and the request never reaches the app.

### 3. Set the secrets

Non-secret configuration is already in `fly.toml`. Everything below is a
secret:

```sh
fly secrets set -a session-dev \
  GITHUB_CLIENT_ID=... \
  GITHUB_CLIENT_SECRET=... \
  GOOGLE_APPLICATION_CREDENTIALS_JSON="$(jq -c . service-account.json)" \
  OPENROUTER_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  PARALLEL_API_KEY=... \
  LITESTREAM_REPLICA_URL=s3://your-bucket/session \
  AWS_ACCESS_KEY_ID=... \
  AWS_SECRET_ACCESS_KEY=... \
  SESSION_METRICS_TOKEN="$(openssl rand -hex 32)"
```

Three of those are not optional before real traffic. Without
`LITESTREAM_REPLICA_URL` the database has no backup. Without
`SESSION_METRICS_TOKEN` the metrics endpoint is disabled and token spend is
unobservable. And sign-up is open to any GitHub account unless you gate it —
`SESSION_REQUIRE_INVITE=1` is already set in `fly.toml`, and
`SESSION_ALLOWED_GITHUB_LOGINS` is the stricter alternative.

Edit `fly.toml` before deploying to set `GOOGLE_VERTEX_PROJECT` to your real
project id; it ships with a placeholder. Register the production OAuth
callback as `https://session.dev/auth/github/callback`.

### 4. Deploy

```sh
fly deploy web -c web/fly.toml
```

The positional `web` is the build context and matters: without it flyctl hands
Docker the repository root, where `package.json` belongs to the desktop app.

The machine runs migrations on boot and reconciles any runs the previous
process left behind. `/healthz` answers 503 until that finishes and again from
the first moment of a drain, so Fly's proxy follows the boot rather than
routing into a process that cannot finish what it accepts.

### 5. Grant the first admin

Sign in once through the browser so the account exists, then flip the flag on
the machine. `npm run db:admin` does not work there — the runtime image
carries the server bundle and production dependencies only, with no sources
and no `tsx`:

```sh
fly ssh console -a session-dev -C "node -e \"
  const db = require('better-sqlite3')('/data/session.db');
  const r = db.prepare('update users set is_admin = 1 where login = ?').run('<github login>');
  if (r.changes === 0) throw new Error('no account with that login');
\""
```

Admin unlocks Claude Fable, the user list, and per-account limit overrides.

### 6. Verify

```sh
curl -fsS https://session.dev/healthz                       # ok
curl -fsS -H "Authorization: Bearer $SESSION_METRICS_TOKEN" \
  https://session.dev/metrics | head                        # gauges
curl -sS -o /dev/null -w '%{http_code}\n' https://artifacts.session.dev/   # 404
```

That last one should be 404, not the app's HTML. The artifact host
only serves document previews.

### 7. Remaining setup

- **Add document backups.** The server archives `/data/documents` daily on its own
  once `LITESTREAM_REPLICA_URL` or `SESSION_DOCUMENTS_REPLICA_URL` is set.
  Confirm an archive appears in the bucket after the first day.
- **Run a restore drill.** See `docs/runbooks/restore.md`.
- **Alerting.** Scrape `/metrics`. At minimum alert on
  `session_daily_cost_usd` and `session_volume_free_bytes`.

---

## Operating notes

**Deploys interrupt runs, briefly.** One machine holds the volume, so a
release stops it before starting the next. In-flight runs are checkpointed,
marked `interrupted`, re-queued at the head and resumed automatically on boot.
Users see a pause, not a loss.

**There is no rollback path.** Migrations run forward on boot and the server
refuses a database carrying a migration it does not know, so redeploying an
older image after a migration will not start. Roll forward instead.

**Limits are on.** `SESSION_ENFORCE_LIMITS=1` in `fly.toml` caps daily tokens
and runs per account, with a queue cap alongside. Admins are exempt. Raise a
single account through the `user_limits` table rather than the global default.
