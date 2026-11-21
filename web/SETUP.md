# Session Web

A shared agentic knowledge graph.

## Quickstart

Prerequisites: Node 22.20+.

First, fill in any of these credentials in .env, based on .env.example.
Models and search providers are reported as "unavailable" if credentials
are missing:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` for sign-in.
- `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_VERTEX_PROJECT` for
  default model, titles and recaps (all Gemini Flash)
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
service account rather than an API key. This one-time setup requires four steps.

**1. Pick or create a project**, and note its id. Save it as `GOOGLE_VERTEX_PROJECT`.

```sh
gcloud projects create session-dev-web --name="Session Web"   # or use an existing one
gcloud config set project session-dev-web
```

Billing must be enabled on the Google Cloud project. Otherwise, Vertex AI
rejects requests when the first question runs rather than during startup.

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

**Configure the key.** The application requires the complete JSON key on one line. For local development:

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

**Verify the configuration.** Start the server with fixture providers disabled
and inspect model availability. Gemini is available only when the credential
resolves successfully:

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

| Command                        | What it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `npm run dev`                  | Server and client with reload                                       |
| `npm run check`                | Types, lint, format, schema drift                                   |
| `npm test`                     | Unit tests across the four packages                                 |
| `npm run test:e2e`             | Playwright, against fixture providers                               |
| `npm run db:admin -- --invite` | Prints a root invite; `-- <handle>` makes that account a site admin |
| `npm run db:studio`            | Browse the database                                                 |

Runtime state is stored in `web/.data`: the database and temp files.
Delete the directory to start clean. A database made before the M8a
migration squash is refused at boot (`UnknownMigrationError`); reset it the
same way (`docs/runbooks/reset-database.md`, "Local development").

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

### 2. DNS and certificate

Fly routes by IP rather than by hostname, so any name pointing at the app's
addresses arrives at it. What Fly does need is a certificate for the name,
since it terminates TLS:

```sh
fly ips list -a session-dev          # the addresses to point DNS at
fly certs add session.dev -a session-dev
```

Add `A` and `AAAA` records pointing at those addresses, plus the
`_acme-challenge` CNAME `fly certs add` prints. Then wait for it to report as
issued:

```sh
fly certs check session.dev -a session-dev
```

DNS alone is not enough — without a certificate the request fails at the TLS
handshake and never reaches the app.

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
  SESSION_METRICS_TOKEN="$(openssl rand -hex 32)" \
  SESSION_X_CLIENT_ID=... \
  SESSION_X_CLIENT_SECRET=... \
  SESSION_SECRET_KEY=<32 bytes of base64> \
  SESSION_CURSOR_KEY=<another 32 bytes of base64>
```

Make the two keys with `openssl rand -base64 32` and keep both outside Fly.
The server refuses to start in production without `SESSION_SECRET_KEY` (it
seals members' API keys and open invite codes; a lost key makes them
unreadable) and without `SESSION_CURSOR_KEY` (it seals sync cursors; it may
not equal `SESSION_SECRET_KEY`). `docs/runbooks/launch.md` §2 lists every
variable production refuses to start without and where each value comes
from.

Three of those are not optional before real traffic. Without
`LITESTREAM_REPLICA_URL` the database has no backup. Without
`SESSION_METRICS_TOKEN` the metrics endpoint is disabled and token spend is
unobservable. `SESSION_SECRET_KEY` also seals open invite codes. Session is invite-only: a new GitHub or X identity without an invite becomes
a waiting account that can only read. The first site admins redeem root
invites printed by `npm run db:admin -- --invite` and are promoted by handle
with `npm run db:admin -- <handle>`.

Edit `fly.toml` before deploying to set `GOOGLE_VERTEX_PROJECT` to your real
project id; it ships with a placeholder. Register the production OAuth
callbacks as `https://session.dev/auth/github/callback` (GitHub OAuth app)
and `https://session.dev/auth/x/callback` (X developer app, OAuth 2.0,
scopes `users.read`, `tweet.read`, `users.email`).

### 4. Deploy

```sh
fly deploy web -c web/fly.toml
```

The positional `web` argument sets the build context. Without it, flyctl uses
the repository root, whose `package.json` defines the desktop application.

The machine runs migrations on boot and reconciles any runs the previous
process left behind. `/healthz` answers 503 until that finishes and again from
the first moment of a drain, so Fly's proxy follows the boot rather than
routing into a process that cannot finish what it accepts.

### 5. Seed the first site admins

Admins are set by handle (plan `05` §3.5). The runtime image has no sources
and no `tsx`, so it holds `npm run db:admin` bundled as
`packages/server/dist/admin.mjs`. Print a root invite per person:

```sh
fly ssh console -a session-dev
# inside:
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs --invite
```

The person opens the printed link, signs in with GitHub or X and chooses a
handle. Then promote that handle:

```sh
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs <handle>
```

A site admin sets the default model and the default effort on `/admin`
before inviting anyone (`docs/runbooks/launch.md` §6 step 6).

### 6. Verify

```sh
curl -fsS https://session.dev/healthz                       # ok
curl -fsS -H "Authorization: Bearer $SESSION_METRICS_TOKEN" \
  https://session.dev/metrics | head                        # gauges
```

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
does not start if the database has a migration unsupported by the image, so redeploying an
older image after a migration will not start. Roll forward instead. The
migration history is one generated `0000_initial.sql` since the M8a squash; a
database made by the earlier migrations is refused at boot and replaced with
`docs/runbooks/reset-database.md`. The launch keeps its own rollback point
until the first member's invite is used (`docs/runbooks/launch.md` §5).

**Limits are on.** Every member, admins included, has a weekly allowance of
included tokens (`SESSION_WEEKLY_TOKENS`) and a per-member overdraft
(`SESSION_OVERDRAFT_TOKENS`), with a queue cap and a per-run token cap
alongside (`docs/06-auth-and-users.md` §8). Raise a single member's allowance
with a `user_limits` row (`weekly_tokens`) rather than the global default.
