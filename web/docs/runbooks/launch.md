# Launch

The launch of the web build on `session-dev` (`https://session.dev`): the
preparation of plan `05` M8a and the launch sequence of §3.6 (M8b), with the
admin seeding of §3.5, the configuration of §3.4 and the M8b smoke test.
The current web app (`main`) stays in production until step 5 of §6.

Every step here is run by a person with Fly, GitHub, X and bucket access.
None of it has been run. Steps that need outside access or a decision end
with a "Done (time, by):" line.

This file in the repository stays a blank template: no names, handles,
bucket URLs or secret values are committed. Before §4, the operator copies
it to the private store where the site admins keep the production secrets
(§4.9) and fills in that copy.

Fly and Litestream behaviour that the repository cannot confirm is marked
"unverified" where a step depends on it; each such item has a row in §4.13
that confirms it on staging before launch day.

Related runbooks: `reset-database.md` (the wipe), `restore.md` (the restore
rehearsal and rollback), `privacy-check.md`, `load-check.md`,
`rotate-cursor-key.md`, `delete-account.md`.

## 1. Values to record

Fill these in, in the private copy, before §4. Later steps refer to them by
name.

| Name | Value |
| --- | --- |
| Build branch | `session-web` (on this remote: `claude/session-web`) |
| Launch commit | |
| Staging origin (`SESSION_PUBLIC_ORIGIN` of `session-staging`) | |
| Bucket | |
| Endpoint (the bucket's S3 endpoint, `AWS_ENDPOINT_URL_S3` of the app; Fly sets it for Tigris) | |
| Old replica URL (`LITESTREAM_REPLICA_URL` now, `s3://<bucket>/<old prefix>`) | |
| Old `SESSION_DOCUMENTS_REPLICA_URL` (if set) | |
| New replica URL (`s3://<bucket>/<new prefix>`, an empty prefix that does not start with the old prefix's name) | |
| Old production image (`fly image show -a session-dev`) | |
| Old image commit (the commit that image was built from) | |
| Launch image (`registry.fly.io/session-dev:<label>`) | |
| Volume id (`fly volumes list -a session-dev`) | |
| Volume region | `sjc` per `fly.toml` |

Every `aws s3` command below takes `--endpoint-url <endpoint>`: without it
the AWS CLI addresses AWS's own S3, not the bucket on Tigris.

## 2. Production configuration

### 2.1 What the server refuses to start without

`web/packages/server/src/config.ts` validates the environment at boot and
exits with every offending variable listed. With `NODE_ENV=production`
(`fly.toml`) it refuses:

| Variable | Rule | Source |
| --- | --- | --- |
| `SESSION_PUBLIC_ORIGIN` | Required in every environment; an `http(s)` origin without path, query or credentials. `https://session.dev` | `fly.toml [env]` |
| `SESSION_SECRET_KEY` | Required unless `NODE_ENV` is `development` or `test`; 32 bytes as 64 hex digits or base64. Seals members' API keys and open invite codes, and keys the hashed IP of the abuse limits | Fly secret, new: `openssl rand -base64 32`. Kept outside Fly too: losing it makes stored API keys and open invite codes unreadable |
| `SESSION_CURSOR_KEY` | Required unless `NODE_ENV` is `development` or `test`; 32 bytes of base64 (44 characters ending in `=`); in production not the public development key and not equal to `SESSION_SECRET_KEY` | Fly secret, new: `openssl rand -base64 32`, a second value. Kept outside Fly for the next rotation (`rotate-cursor-key.md`) |
| `SESSION_CURSOR_KEY_PREVIOUS` | Optional. When set: 32 bytes of base64, different from `SESSION_CURSOR_KEY` in production, and `SESSION_CURSOR_KEY_ROTATED_AT` required | Unset at launch: no earlier key exists |
| `SESSION_CURSOR_KEY_ROTATED_AT` | Required with the previous key; an ISO time with a zone, not in the future | Unset at launch |
| `SESSION_FIXTURE_PROVIDERS`, `SESSION_FIXTURE_OAUTH` | Refused in production when on | Unset |
| `SESSION_TEST_ROUTES` | Refused unless `NODE_ENV=test` with a loopback origin | Unset |
| `SESSION_MIN_PROTOCOL` | Not above the build's protocol (4) | Unset: the default is the build's minimum, 4 |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | When set, one line of JSON | Fly secret, `jq -c . service-account.json` |
| Every numeric setting | An integer in its range; the concurrency caps, the queue bound, the per-run cap and the abuse limits at least 1 | `fly.toml [env]` or defaults |

`SESSION_TEST_AUTH` is ignored in production whatever its value.

### 2.2 Required for the launch, not checked at boot

The server starts without these, but the launch does not work without them:

| Variable | Without it | Source |
| --- | --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `/auth/github` answers 503 "GitHub sign-in is not configured on this deployment" | Fly secret; the production GitHub OAuth app, callback `https://session.dev/auth/github/callback`, scopes `read:user user:email` |
| `SESSION_X_CLIENT_ID`, `SESSION_X_CLIENT_SECRET` | `/auth/x` answers 503; X sign-in is a launch blocker (Q8) | Fly secret, new; the production X app (§4.6), OAuth 2.0 confidential client, callback `https://session.dev/auth/x/callback`, scopes `users.read tweet.read users.email` |
| `LITESTREAM_REPLICA_URL` | The entrypoint runs the server without replication: no backup | Fly secret, changed: `<new replica URL>` (§4.9, staged in §6 step 3). The old prefix is the rollback source |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Litestream and the documents archive cannot write the bucket | Fly secret, kept from the current app unless the bucket changes. `AWS_ENDPOINT_URL_S3` and `AWS_REGION` are honoured when the bucket needs them (Fly sets the endpoint for Tigris) |
| `SESSION_METRICS_TOKEN` | `GET /metrics` answers 404; spend and volume space are not observable | Fly secret, kept or new: `openssl rand -hex 32` |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_VERTEX_PROJECT` | Gemini models are unavailable; thread titles and summaries use them | Secret kept from the current app; `GOOGLE_VERTEX_PROJECT = "session-dev"` in `fly.toml [env]` |
| `OPENROUTER_API_KEY` | DeepSeek V4.1 Flash and GPT-5.6 Luna are unavailable | Fly secret, kept |
| `ANTHROPIC_API_KEY` | Claude Fable 5.1 runs only on members' own keys | Fly secret, kept |
| `PARALLEL_API_KEY`, `TAVILY_API_KEY` | The `web_search` tool is unavailable without both. `SESSION_SEARCH_VENDOR = "parallel"` (§2.3) makes Parallel the first vendor, which needs `PARALLEL_API_KEY`; with only `TAVILY_API_KEY` set, the tool uses Tavily alone | Fly secret, kept (either or both) |

`SENTRY_DSN` is read by `config.ts` (`sentryDsn`) and nothing uses the
value: the build has no error reporting, and setting it changes nothing.

The site admins set the default model and the default effort at runtime
(§6 step 6); a default must be payable with included tokens, so its
provider needs its deployment credential above.

### 2.3 Settings in `fly.toml [env]`

`web/fly.toml` sets these; none is a secret, and each default in
`config.ts` is the same value:

| Variable | Value | Meaning |
| --- | --- | --- |
| `SESSION_WEEKLY_TOKENS` | `2000000` | Included tokens per member per week, reset Fridays 00:00 UTC (`03` K3); a member's own allowance is a `user_limits` row |
| `SESSION_OVERDRAFT_TOKENS` | `200000` | Tokens past the allowance a member's included-token runs may spend in a week together, then they stop (`03` K9) |
| `SESSION_RUN_MAX_TOKENS` | `400000` | Counted tokens one run may spend, whoever pays (`03` L1) |
| `SESSION_INVITES_PER_MEMBER` | `3` | Account invites each member gets in all (`04` I2): a used link spends one, an open link holds one, revoking an unused link gives it back. Site admins have no limit; the invites they give a member are `user_limits.extra_invites`, set on Site Admin or with `db:admin -- --grant-invites <handle> <n>` |
| `SESSION_RUNS_PER_USER`, `SESSION_QUEUED_PER_USER` | `2`, `20` | Running and queued runs per member |
| `SESSION_RUNS_GEMINI`, `SESSION_RUNS_OPENROUTER`, `SESSION_RUNS_ANTHROPIC` | `8`, `8`, `2` | Concurrent runs per provider |
| `SESSION_RUN_TIMEOUT_SECONDS` | `900` | Wall-clock limit per run |
| `SESSION_SEARCH_VENDOR` | `parallel` | The `web_search` vendor tried first; it needs `PARALLEL_API_KEY` (§2.2). The other configured vendor is tried after it |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION` | `session-dev`, `global` | The Vertex AI project and location of the Gemini calls |
| `HOST`, `PORT`, `NODE_ENV`, `SESSION_DATA_DIR` | `0.0.0.0`, `8080`, `production`, `/data` | |

### 2.4 Settings left at their defaults

- The web window: `SESSION_WEB_WINDOW_DAYS` 30, `SESSION_WEB_WINDOW_THREADS`
  100, `SESSION_WEB_WINDOW_CAP` 500 (`01` R1). Set lower values only if the
  load check (§4.5) records a window snapshot above 5 MB.
- The abuse limits `SESSION_LIMIT_*` of `04` Z1 and `01` A3, documented in
  `web/.env.example`.
- The abuse address is not a setting: the site footer shows `abuse@` and
  the hostname of `SESSION_PUBLIC_ORIGIN`, `abuse@session.dev` (Q10).

### 2.5 Secrets of the current app to remove

`fly secrets list -a session-dev` shows the names. The new server ignores
the current app's variables it does not define. Of those it does read, one
changes who can sign in:

- `SESSION_ALLOWED_GITHUB_LOGINS`: when set, only those GitHub logins can
  sign in with GitHub, invite or not. It does not restrict X sign-ins: an X
  identity with an invite signs in whatever the list holds
  (`auth/routes.ts`). §6 step 3 unsets it unless that restriction is
  wanted; §6 step 2 records its value first, for a rollback.

The current app's `[env]` values (`SESSION_ARTIFACT_ORIGIN`,
`SESSION_REQUIRE_INVITE`, `SESSION_ENFORCE_LIMITS`, `SESSION_DAILY_*`,
`SESSION_EMBED_CACHE_BYTES`) come from the `fly.toml` of the old image's
commit and are replaced by the new `fly.toml` at the deploy.

## 3. The migration squash

M8a replaced the migrations `0000_initial`, `0003_api_keys`,
`0004_accounts`, `0005_spaces`, `0006_runs` and `0007_weekly_tokens` with one
`0000_initial.sql` generated by drizzle-kit from
`web/packages/db/src/schema` (plan `01` D5). It creates no research table.

Every database made before the squash (each developer's `web/.data`, the
staging database) is refused at boot with `UnknownMigrationError` and must
be reset with `reset-database.md`; there is no upgrade path. Developers run
the local reset of `reset-database.md` ("Local development") after pulling
the squash. Staging is reset in §4.2. Production is wiped at launch (§6
step 4).

A test pins the sha256 of `0000_initial.sql`
(`web/packages/db/test/migrations.test.ts`, "R10"): every database records
the hash of each migration it applied, and refuses at boot a hash this
build does not know, so after launch the file is never edited, a comment
included. A schema change after launch is a new migration (`0001_…`).

## 4. Preparation (M8a)

### 4.1 Staging configuration and deploys

The repository has no `web/fly.staging.toml` (plan §3.2 names it). Make it
from `web/fly.toml` with the staging app and origin, and commit it:

```sh
sed -e 's/^app = "session-dev"/app = "session-staging"/' \
    -e 's#SESSION_PUBLIC_ORIGIN = "https://session.dev"#SESSION_PUBLIC_ORIGIN = "<staging origin>"#' \
    web/fly.toml > web/fly.staging.toml
```

Staging has its own volume `session_data`, bucket prefix, GitHub and X
OAuth apps (callbacks `<staging origin>/auth/github/callback` and
`<staging origin>/auth/x/callback`), `SESSION_SECRET_KEY` and
`SESSION_CURSOR_KEY` (§2.1, different values from production), and model
credentials with low limits at the provider.

No CI job deploys staging: the build branch's `deploy` job runs only for
`main` until the launch commit (§6 step 1). Staging is deployed by hand,
from the repository root at the commit to deploy:

```sh
fly deploy web -c web/fly.staging.toml
```

Done (time, by):

### 4.2 Staging reset after the squash

Follow `reset-database.md` with `<app>` = `session-staging` and `<config>` =
`web/fly.staging.toml`, from a commit that includes the squash. The reset
script takes an exclusive lock on the staging database and reads its
heartbeat; `--assume-stopped` is not needed there. Record the stop and the
first healthy `/healthz`:

| | Time (UTC) |
| --- | --- |
| `fly scale count 0` | |
| `reset-database.mjs --yes` | |
| `/healthz` answers `ok` | |

In the one-off machine of `reset-database.md` step 4, before the reset,
record for §4.13 (U1):

| In the one-off machine | Output |
| --- | --- |
| `ps -e` (no `litestream` and no `node` process: the entrypoint did not run) | |
| `printenv LITESTREAM_REPLICA_URL` (the deployed value, the staged one, or nothing) | |
| `printenv AWS_ACCESS_KEY_ID \| wc -c` (above 1: the app's secrets are in the environment) | |

Then seed one staging admin as in §6 step 6 with `-a session-staging`.

Done (time, by):

### 4.3 Staging restore rehearsal

Checks that a restore from a Litestream backup works on this build and that
the boot-time generation check replaces the history id (plan `01` D6). On
staging, after §4.2:

1. Signed in, post a thread whose text is `REHEARSAL-A-<time>` in an open
   channel. Wait one minute (Litestream syncs every second), then note the
   time T2 (UTC).
2. Post `REHEARSAL-B-<time>`. Keep this tab open.
3. Restore to T2 with `restore.md` §2, from the image of §4.2. The restore
   command names the database path of `/etc/litestream.yml`, not the replica
   URL: whether Litestream 0.5.17 accepts `-config` with a replica URL, and
   whether it has `-timestamp`, is unverified (U2):

   ```sh
   fly scale count 0 -a session-staging
   fly machine run registry.fly.io/session-staging:<label> --shell -a session-staging \
     -r <region> --vm-memory 2048 --volume session_data:/data
   # inside (LITESTREAM_REPLICA_URL and the AWS keys as in the app's secrets, U1):
   litestream restore -config /etc/litestream.yml -timestamp <T2> \
     -o /data/session.db.restored /data/session.db
   cd /app && node -e '
     const d = require("better-sqlite3")("/data/session.db.restored", { readonly: true });
     console.log(d.pragma("integrity_check", { simple: true }));'
   mv /data/session.db /data/session.db.broken
   rm -f /data/session.db-wal /data/session.db-shm
   rm -rf /data/.session.db-litestream
   mv /data/session.db.restored /data/session.db
   chown session:session /data/session.db
   exit
   ```

4. `fly scale count 1 -a session-staging`, then `fly logs -a
   session-staging`. The boot log shows `the sync history id was replaced:
   every cursor served before this boot resyncs` with `reason:
   "generation"`.
5. In the tab of step 2, the stream reconnects and the client takes a new
   snapshot (a `POST /api/sync/snapshot` in the network log); the feed shows
   `REHEARSAL-A` and not `REHEARSAL-B`.
6. Post `REHEARSAL-C-<time>` and wait one minute. Then check that Litestream
   replicates the restored file and that the latest backup holds the
   post-restore state (U3): stop the app again, restore the latest point to
   a scratch file, and look for the three markers:

   ```sh
   fly scale count 0 -a session-staging
   fly machine run registry.fly.io/session-staging:<label> --shell -a session-staging \
     -r <region> --vm-memory 2048 --volume session_data:/data
   # inside:
   litestream restore -config /etc/litestream.yml -o /data/latest-check.db /data/session.db
   cd /app && node -e '
     const d = require("better-sqlite3")("/data/latest-check.db", { readonly: true });
     const rows = d.prepare("SELECT body FROM records").all();
     for (const m of ["REHEARSAL-A", "REHEARSAL-B", "REHEARSAL-C"])
       console.log(m, rows.some((r) => String(r.body).includes(m)));'
   # REHEARSAL-A true, REHEARSAL-B false, REHEARSAL-C true
   rm -f /data/latest-check.db /data/latest-check.db-wal /data/latest-check.db-shm
   exit
   fly scale count 1 -a session-staging
   ```

7. Delete `/data/session.db.broken` (`fly ssh console -a session-staging -C
   "rm /data/session.db.broken"`).

| | Time (UTC) |
| --- | --- |
| T2 (restore point) | |
| `fly scale count 0` | |
| `litestream restore` finished | |
| `/healthz` answers `ok` | |
| Boot log line with `reason: "generation"` seen | |
| The latest-point restore of step 6 holds A and C, not B | |

Done (time, by):

### 4.4 Privacy check on staging (M6 exit, not yet run)

`privacy-check.md` §1-§2 on `session-staging`: a member's post and reply
with a marker, removed by the channel's owner, then

```sh
fly ssh console -a session-staging
# inside:
cd /app && node packages/server/dist/privacy-check.mjs --thread <id> --text "<marker>"
```

ends with `privacy check passed`. Record the output.

Done (time, by):

### 4.5 Load check on staging (M3 exit, not yet run)

`load-check.md`, "On the production machine size": the script built on a
workstation, copied to a `session-staging` machine, run with `--bundle
--minutes 30 --json /tmp/load.json`. Record the verdict, the apply and pull
p95, the memory slopes and the window snapshot's bytes. Above 5 MB, set the
web window lower (§2.4) before launch.

Done (time, by):

### 4.6 X production app (launch blocker, Q8)

On the X developer portal, for the production X app:

- the access level the sign-in needs at the expected volume, and its cost
  (Q8), confirmed and recorded here: ______;
- OAuth 2.0 enabled, as a confidential client (Web App), with the callback
  `https://session.dev/auth/x/callback` and nothing else;
- the scopes the server asks for, `users.read tweet.read users.email`, with
  email access enabled for the app;
- its client id and secret stored with the production values (§4.9).

X sign-in on production is first exercised by the smoke test (§6 step 7).
There is no GitHub-only launch.

Done (time, by):

### 4.7 GitHub production OAuth app

The GitHub OAuth app whose id is `GITHUB_CLIENT_ID` on `session-dev` has
the callback `https://session.dev/auth/github/callback`.

Done (time, by):

### 4.8 Abuse mailbox (launch blocker, Q10)

`abuse@session.dev` exists and the site admins read it. Send a test message
from an outside address and record when it was received and by whom.

Done (time, by):

### 4.9 Prepare the production secrets

This step makes and stores the values; it does not give them to Fly. They
are staged on launch day (§6 step 3), after the `production` environment's
branch rule is narrowed (§6 step 1.4). A staged secret is applied by the
next deploy of the app, whichever commit it deploys: staged now, a deploy
of `main` before launch day (its `deploy` job, `web.yml`) would start the
current app with the new `LITESTREAM_REPLICA_URL`, which would replicate the
current database into the new prefix, and without
`SESSION_ALLOWED_GITHUB_LOGINS`.

In the private store where the site admins keep production secrets (it is
also the copy outside Fly that §2.1 requires), store:

- `SESSION_SECRET_KEY` and `SESSION_CURSOR_KEY`, each made with `openssl
  rand -base64 32`. They must differ.
- `SESSION_X_CLIENT_ID` and `SESSION_X_CLIENT_SECRET` of the production X
  app (§4.6).
- `LITESTREAM_REPLICA_URL` = `<new replica URL>`. The prefix must be empty:
  `aws s3 ls --endpoint-url <endpoint> <new replica URL>/ --recursive`
  prints nothing. Choose a prefix whose name does not start with the old
  prefix's name, so that no listing or deletion of one matches the other.
- If `SESSION_DOCUMENTS_REPLICA_URL` is set on the current app, a new value
  under the new prefix (`reset-database.md` §2).
- Whether `SESSION_ALLOWED_GITHUB_LOGINS` stays (§2.5): by default it is
  unset at launch.

Keep `GITHUB_CLIENT_*`, the model and search keys, the AWS keys and
`SESSION_METRICS_TOKEN` as they are, or store new values the same way.

Done (time, by):

### 4.10 GitHub `production` environment

The `production` environment (repository settings, Environments) has
required reviewers, so a push of the launch commit waits for approval
before its `deploy` job runs.

Without that, a deploy of the new image before the wipe of §6 step 4 runs
the entrypoint on the current database. Litestream starts before the server
(`web/scripts/entrypoint.sh`): once the new `LITESTREAM_REPLICA_URL` is
staged (§6 step 3), it uploads the current database into the new prefix,
and only then does the server refuse to boot (`UnknownMigrationError`). The
new prefix is then no longer empty, and a deploy after the wipe would
restore that database into `/data` (`-restore-if-db-not-exists`). The
remedy is another empty prefix: choose one, change the stored value (§4.9),
stage it again (§6 step 3) and check it is empty at the end of §6 step 4.
Before §6 step 3 a premature deploy replicates to the old prefix and stops
the current app (the new server refuses its database); redeploy the old
image as in §6 step 8.3.

Done (time, by):

### 4.11 First site admins and first invite recipients (Q6, Q11)

The people who run Session, each with the provider they sign in with and
the handle they will choose at the profile step. Each gets a root invite in
§6 step 6 and is promoted by that handle. At least one signs in with
GitHub and one with X: the smoke test (§6 step 7) needs both.

| Person | Provider (GitHub or X) | Handle | Root invite sent (time) | Promoted (time) |
| --- | --- | --- | --- | --- |
| | | | | |
| | | | | |

The named first group the site admins invite after setting the default
model and effort; each then has 3 invites of their own.

| Person | Invited by (handle) | Invite link sent (time) |
| --- | --- | --- |
| | | |
| | | |

Done (time, by):

### 4.12 Test runs on the launch commit

CI does not run the conformance suite: `ci-pending.patch`, which adds the
`conformance` job, is not applied, and the server's `npm test` leaves
`test/conformance/` out. Run it and the M8a exit test by hand on the launch
commit, from `web/`:

| Run | Result (passed, time, by) |
| --- | --- |
| `npm test --workspace @session/db -- test/migrations.test.ts` (M8a exit) | |
| `SESSION_CONFORMANCE=1 npm test --workspace @session/server` (about 30 minutes) | |

Done (time, by):

### 4.13 Staging checks of unverified Fly and Litestream behaviour

The runbooks depend on these behaviours, which nothing in the repository
confirms. Each is checked on `session-staging` before launch day; a row
whose result differs from the expectation changes the steps that cite it
before they are run on production.

| Id | Behaviour | Cited in | Check on staging | Result (time, by) |
| --- | --- | --- | --- | --- |
| U1 | `fly machine run <image> --shell` does not run the image's entrypoint, and the machine has the app's secrets in its environment | §4.2, §6 steps 4 and 8, `reset-database.md` §4, `restore.md` §2, `delete-account.md` | The rows of §4.2: `ps -e` shows no `litestream` and no `node`; `printenv` shows the AWS keys, and which `LITESTREAM_REPLICA_URL` (deployed or staged) | |
| U2 | `litestream restore -config /etc/litestream.yml [-timestamp T] -o <file> /data/session.db` restores from the configured replica on 0.5.17, and `-timestamp` exists | §4.3, §6 step 4, `restore.md` §2 | §4.3 step 3: the command runs and the restored file passes `integrity_check`; `litestream restore -h` lists `-timestamp` | |
| U3 | After a restore and a boot, Litestream replicates the restored file, and a restore of the latest point returns the post-restore state | §4.3, `restore.md` §5 | §4.3 step 6 | |
| U4 | On an app scaled to zero, `fly deploy --image <image> --ha=false` starts one machine with the existing volume, and `fly scale count 1` after it changes nothing | §6 steps 5 and 8, `reset-database.md` §5 | `reset-database.md` §5 on staging: before, `fly volumes list` gives the volume id; after the deploy, `fly machine list` shows one started machine and `fly volumes list` shows that volume id attached to it; `fly scale count 1` reports no change | |
| U5 | `fly secrets import --stage -a <app> < file` stages `NAME=value` lines without restarting the app, and `fly secrets list` shows them as staged | §6 steps 3 and 8, `reset-database.md` §2, `rotate-cursor-key.md` | Stage one harmless value (`SESSION_STAGE_CHECK=1`) on staging this way; the machine's `fly machine list` start time does not change; `fly secrets list` shows it staged; then unset it with `--stage` and deploy | |
| U6 | `fly secrets set --stage` and `fly secrets unset --stage` do not restart the app; the next `fly deploy`, or a `fly secrets set` or `unset` without `--stage`, applies every staged value | §6 step 3, `reset-database.md` §2, `rotate-cursor-key.md` | As U5, with `set --stage`; then stage a value and run `fly secrets unset` (without `--stage`) of another: both changes are in the restarted machine's `printenv` | |
| U7 | `fly volumes snapshots create <volume id>` takes a snapshot of the volume, listed by `fly volumes snapshots list <volume id>` | §6 step 4 | Run both on the staging volume | |
| U8 | `fly ssh sftp shell -a <app>` uploads a file into a running machine with `put` | `restore.md` §3 | Upload a small file into `/data/tmp` of a staging machine and `ls` it there | |
| U9 | `aws s3 ls --endpoint-url <endpoint> s3://<bucket>/<prefix>/ --recursive` lists the prefix on Tigris, and prints nothing for an empty prefix | §4.9, §6 steps 2, 4, 5, 7 and 9, `reset-database.md` | List the staging prefix (files) and a made-up prefix (nothing) | |
| U10 | `fly machine run … --vm-memory 2048` gives the one-off machine 2 GB, enough for a restore of the production database's size | §4.3, §6 step 4, `restore.md` §2 | `free -m` in the one-off machine shows about 2048 MB total; the restore of §4.3 completes | |
| U11 | With `/data/session.db` absent and an empty replica prefix, `litestream replicate -restore-if-db-not-exists` starts the server on a new empty file | `reset-database.md` "Why deleting the file is not enough", §6 step 5 | `reset-database.md` §5 on staging: the boot log shows `previous: null`, `{ migrations: 1 } { users: 0 }` | |
| U12 | `fly ssh console -a <app> -C "printenv NAME"` prints only the value | §6 step 2 | Run it for `SESSION_PUBLIC_ORIGIN` on staging; the output is the origin alone | |

Done (time, by):

## 5. Rollback point

Until the first member's account invite is redeemed after the launch, the
launch can be undone (§6 step 8). What it needs is kept, not deleted:

- `/data/pre-launch/` on the volume: the current app's `session.db` with its
  `-wal` and `-shm`, its Litestream state `.session.db-litestream/` and its
  `documents/`, moved aside in §6 step 4 and deleted only in step 9; and a
  snapshot of the volume taken before the move (U7);
- the old Litestream prefix, which holds the current app's database, for 30
  days after launch; §6 step 4 restores it to a scratch file and checks it
  before anything is deleted;
- the old documents archives under that prefix (or under the old
  `SESSION_DOCUMENTS_REPLICA_URL`), with an archive forced in §6 step 2;
- the old values of every secret §6 step 3 changes or unsets, recorded in
  §6 step 2 and kept in the private store;
- the old image and its commit, recorded in §1, and the `fly.toml` of that
  commit, which sets the current app's `[env]` (`SESSION_REQUIRE_INVITE`,
  `SESSION_ARTIFACT_ORIGIN` and the daily limits); deploying the old image
  with the new `fly.toml` would start it without them;
- the old deploy path: `main`'s `deploy` job is disabled only in §6 step 1,
  by the `production` environment's branch rule; `main`'s files are not
  changed.

The root invites of §6 step 6 do not count as a member's invite.

## 6. Launch (M8b, plan `05` §3.6)

The order: freeze and build (1), record the rollback point and its values
(2), stage the secrets (3), stop, check the rollback source, set the
current files aside and wipe, ending on an empty new prefix (4), deploy
(5), seed the admins (6), smoke test (7). Step 8 is the rollback; step 9
follows 30 days later.

### Step 1. Freeze

1. Merge the launch commit to the build branch. The launch commit points
   the build branch's `deploy` job at production; in
   `.github/workflows/web.yml`:

   ```yaml
   deploy:
     if: github.ref == 'refs/heads/<build branch>' && github.event_name == 'push'
   ```

2. CI is green on it: `check`, `test`, `e2e`, `docker`. That set does not
   include the conformance suite (§4.12); its manual run on the launch
   commit is recorded in §4.12.
3. The push starts a `deploy` run that waits for the `production`
   environment's approval (§4.10). Reject it; step 5 deploys by hand from
   the image built here. Push nothing else to the build branch until step 5
   is done; each push starts another such run, to be rejected the same way.
4. Set the `production` environment's deployment branch rule to the build
   branch only. From now on a push to `main` cannot deploy.
5. Build and push the launch image without deploying it:

   ```sh
   git checkout <launch commit>
   fly deploy web -c web/fly.toml --build-only --push --image-label launch-<short sha>
   ```

   Record the printed image as the launch image in §1.

Done (time, by):

### Step 2. Record the rollback point

```sh
fly image show -a session-dev
fly releases -a session-dev --image
fly volumes list -a session-dev
aws s3 ls --endpoint-url <endpoint> <old replica URL>/ --recursive | tail -5
```

Record the image and the volume id in §1. The image's commit is the head
commit of the `deploy` run of `main` (GitHub Actions, `web.yml`) whose log
prints that image; record it in §1 and take that commit's `fly.toml`:

```sh
git show <old image commit>:web/fly.toml > ~/fly.old.toml   # outside the repository
```

Record the current value of every secret step 3 changes or unsets, into a
file only its owner can read, then move the file's contents into the private
store and delete it. An unset name prints an empty value (U12):

```sh
( umask 077
  for name in LITESTREAM_REPLICA_URL SESSION_DOCUMENTS_REPLICA_URL \
      SESSION_ALLOWED_GITHUB_LOGINS SESSION_SECRET_KEY SESSION_CURSOR_KEY \
      SESSION_X_CLIENT_ID SESSION_X_CLIENT_SECRET; do
    printf '%s=%s\n' "$name" "$(fly ssh console -a session-dev -C "printenv $name")"
  done > old-secrets.env )
# copy the lines into the private store, then:
shred -u old-secrets.env
```

Record `LITESTREAM_REPLICA_URL` and `SESSION_DOCUMENTS_REPLICA_URL` in §1 as
well. `main`'s `config.ts` (at `f155dd02`) reads neither `SESSION_SECRET_KEY`,
`SESSION_CURSOR_KEY` nor `SESSION_X_CLIENT_*`; if any of them has a value
here, the old app had it and step 8.2 sets it back.

Force a documents archive, so that the old archives hold every image file
the current app has. The script runs as the `session` user (uid 1000): run
as root, it would leave a stamp file owned by root that the server's later
scheduled archives cannot update:

```sh
fly ssh console -a session-dev -C \
  "setpriv --reuid=1000 --regid=1000 --clear-groups /app/scripts/backup-documents.sh"
aws s3 ls --endpoint-url <endpoint> <old replica URL>/documents/ | tail -3   # or the old documents URL
```

The listing shows the archive just made.

Done (time, by):

### Step 3. Stage the secrets

The `production` environment's branch rule allows only the build branch
(step 1.4), and the only pending deploy runs of the build branch were
rejected, so nothing deploys the staged values before step 5.

Write the values of §4.9 into a file only its owner can read, with an
editor, so that no value is on a command line or in the shell history, then
stage the file and delete it (`fly secrets import --stage` is unverified,
U5):

```sh
install -m 600 /dev/null launch.env
"$EDITOR" launch.env
# one NAME=value per line:
#   SESSION_SECRET_KEY=<secret key>
#   SESSION_CURSOR_KEY=<cursor key>
#   SESSION_X_CLIENT_ID=<production X app client id>
#   SESSION_X_CLIENT_SECRET=<production X app client secret>
#   LITESTREAM_REPLICA_URL=<new replica URL>
#   SESSION_DOCUMENTS_REPLICA_URL=<new value>     # only if §4.9 made one
fly secrets import --stage -a session-dev < launch.env
shred -u launch.env
fly secrets unset --stage -a session-dev SESSION_ALLOWED_GITHUB_LOGINS   # §2.5, unless kept
fly secrets list -a session-dev
```

If `fly secrets import --stage` turns out not to stage (U5), use `fly
secrets set --stage -a session-dev NAME=value …` with `HISTCONTROL=ignorespace`
set and the command typed with a leading space, so the shell does not keep
it.

Check that the staging did not restart the current app with the new values:

```sh
fly ssh console -a session-dev -C "printenv LITESTREAM_REPLICA_URL"   # still <old replica URL>
```

Done (time, by):

### Step 4. Stop, check the rollback source, set the current files aside, wipe

`reset-database.md` §3-§4 for `session-dev`, with the launch image, and
with the current files kept on the volume rather than deleted:

```sh
fly scale count 0 -a session-dev
fly machine list -a session-dev          # no machine started
fly volumes snapshots create <volume id>  # unverified, U7
fly machine run <launch image> --shell -a session-dev -r sjc --vm-memory 2048 \
  --volume session_data:/data             # --vm-memory: unverified, U10
```

Inside the one-off machine:

1. Check that the entrypoint did not start (U1), and that the old prefix
   restores to a file that passes `integrity_check` (U2). The restore names
   the old prefix itself, whatever value the machine's environment holds:

   ```sh
   ps -e                                  # no litestream, no node
   LITESTREAM_REPLICA_URL='<old replica URL>' \
     litestream restore -config /etc/litestream.yml -o /data/rollback-check.db /data/session.db
   cd /app && node -e '
     const d = require("better-sqlite3")("/data/rollback-check.db", { readonly: true });
     console.log(d.pragma("integrity_check", { simple: true }));'
   # ok
   rm -f /data/rollback-check.db /data/rollback-check.db-wal /data/rollback-check.db-shm
   ```

   Stop here if it does not print `ok`: the old prefix is not a rollback
   source, and the launch waits until it is understood.
2. List what the reset finds, without deleting. The current app's database
   has no `server_meta` table, so the script needs `--assume-stopped`; it
   still takes an exclusive lock on the file and refuses while another
   process has it open. Check from the workstation that `fly machine list
   -a session-dev` shows only this machine, then:

   ```sh
   node /app/packages/server/dist/reset-database.mjs --assume-stopped
   # no server_meta table: the server is taken as stopped (--assume-stopped)
   # the reset held an exclusive lock on /data/session.db: no other process had it open
   # would delete  /data/session.db   (and its -wal and -shm where they exist)
   # would delete  /data/.session.db-litestream
   # would delete  /data/embeds
   # would delete  /data/tmp/documents-backup.stamp
   # would delete  /data/documents/<owner id>   (one line per entry)
   ```

   The listing must name these paths where they exist, and nothing outside
   `/data`.
3. Move the current app's files aside; step 9 deletes them, step 8 moves
   them back:

   ```sh
   df -h /data                            # room for the new database beside them
   mkdir /data/pre-launch
   for f in session.db session.db-wal session.db-shm .session.db-litestream documents; do
     if [ -e "/data/$f" ]; then mv "/data/$f" /data/pre-launch/; fi
   done
   ls -la /data /data/pre-launch
   ```

4. Delete what is left of the reset's list. With no `session.db` the script
   needs `--no-database`:

   ```sh
   node /app/packages/server/dist/reset-database.mjs --yes --no-database
   # no database at /data/session.db
   # deleted  /data/embeds
   # deleted  /data/tmp/documents-backup.stamp
   exit
   ```

   `embeds/` is the earlier build's cache of embedded-post images; it is
   not kept for a rollback, and the old app fetches the images again.

Then, from the workstation, the last check before the deploy: the new
prefix is still empty (U9). If it lists anything, a deploy started
Litestream with the new value; do not deploy: choose another empty prefix
and repeat step 3 with it (§4.10).

```sh
aws s3 ls --endpoint-url <endpoint> <new replica URL>/ --recursive    # prints nothing
```

Done (time, by):

### Step 5. Deploy and start

```sh
fly deploy -c web/fly.toml --image <launch image> --ha=false
fly scale count 1 -a session-dev          # probably changes nothing: the deploy started the machine (U4)
fly volumes list -a session-dev           # the volume id of §1, attached
fly machine list -a session-dev           # one machine, started, on that volume
fly logs -a session-dev
```

The boot runs `0000_initial.sql` on the empty file, records the file's
generation (the warning `the sync history id was replaced` with `previous:
null`), closes `usage_events` rows still `open` and marks runs still
`running` as `interrupted` (none on an empty file), starts the run
dispatcher and the maintenance jobs, and logs `booted` and
`session-server listening`. Then:

```sh
curl -fsS https://session.dev/healthz                                     # ok
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://session.dev/auth/github
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://session.dev/auth/x
# 302 to github.com and to x.com, each with redirect_uri=https%3A%2F%2Fsession.dev%2Fauth%2F...%2Fcallback
aws s3 ls --endpoint-url <endpoint> <new replica URL>/ --recursive | head    # Litestream's files
fly ssh console -a session-dev
# inside:
cd /app && node -e 'const d = require("better-sqlite3")("/data/session.db", { readonly: true }); console.log(d.prepare("SELECT count(*) AS migrations FROM __drizzle_migrations").get(), d.prepare("SELECT count(*) AS users FROM users").get())'
# { migrations: 1 } { users: 0 }
```

Done (time, by):

### Step 6. Seed the site admins

For each person in the first table of §4.11, print a root invite on the
running machine. The command writes one row of `invites`, which the server
does not cache, so it runs next to the server; `setpriv` runs it as the
`session` user that owns the database files:

```sh
fly ssh console -a session-dev
# inside:
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs --invite
# SESS-XXXX-XX
# https://session.dev/i#SESS-XXXX-XX
```

Send each link to its person over a private channel. They open it, sign in
with their provider, choose the handle of §4.11 at the profile step and are
active with no inviter. Then promote each by handle:

```sh
setpriv --reuid=1000 --regid=1000 --clear-groups node /app/packages/server/dist/admin.mjs <handle>
# @<handle> is now a site admin
```

A site admin then opens Site Admin (`/admin`) and sets the default model and
the default effort, before anyone else is invited (`03` K15). Fill in the
times in §4.11.

Done (time, by):

### Step 7. Smoke test (M8b exit)

In this order; the invite redemption is the first member's invite used,
and from it on failures are fixed forward (step 8 no longer applies).

| Check | Done (time, by) |
| --- | --- |
| `https://session.dev/healthz` answers `ok`; the boot log of step 5 seen | |
| A site admin signed in with GitHub | |
| A site admin signed in with X | |
| The default model and the default effort set on `/admin`; after a reload, the site admin's own composer starts on both (no other member exists yet) | |
| A post in an open channel | |
| An ask paid with included tokens streams an answer; `/usage` shows the tokens | |
| Litestream replicates to the new prefix: `aws s3 ls --endpoint-url <endpoint> <new replica URL>/ --recursive` lists files written after the post above | |
| The site footer reads "Session · Report abuse: abuse@session.dev" | |
| A site admin creates an account invite on `/invites` | |
| A second account redeems it (the first member invite used) | |
| The inviter has the `invite_used` notification on `/notifications` | |
| A channel owner removes a thread with a reason and bans its author | |
| A private channel's invite link redeemed by another account | |

Done (time, by):

### Step 8. Rollback, before the first member invite is used

Only while no member's account invite has been redeemed (root invites do
not count). Nothing written to the new build is kept.

1. Stop the new build, delete its files, and move the current app's files
   back from `/data/pre-launch`:

   ```sh
   fly scale count 0 -a session-dev
   fly machine run <launch image> --shell -a session-dev -r sjc --volume session_data:/data
   # inside:
   node /app/packages/server/dist/reset-database.mjs            # lists the new build's files
   node /app/packages/server/dist/reset-database.mjs --yes      # lock and heartbeat checked
   rmdir /data/documents 2>/dev/null || true                   # the new build writes nothing there
   for f in session.db session.db-wal session.db-shm .session.db-litestream documents; do
     if [ -e "/data/pre-launch/$f" ]; then mv "/data/pre-launch/$f" /data/; fi
   done
   ls -la /data /data/pre-launch                                # pre-launch is empty
   rmdir /data/pre-launch
   exit
   ```

   If `/data/pre-launch` is gone (the volume was replaced), leave
   `/data/session.db` absent instead: the old image's entrypoint restores
   it from the old prefix at boot (`-restore-if-db-not-exists` in the old
   commit's `web/scripts/entrypoint.sh`). Then restore `/data/documents`
   from the old archives (`restore.md` §3) in this one-off machine, before
   step 3 starts the old app; until they are restored, every image of the
   old app answers 404.
2. Set the values recorded in step 2 again. In an editor, as in step 3,
   write a file with one line per name that had a value in step 2, then
   stage it:

   ```sh
   install -m 600 /dev/null rollback.env
   "$EDITOR" rollback.env
   #   LITESTREAM_REPLICA_URL=<old replica URL>
   #   SESSION_DOCUMENTS_REPLICA_URL=<old value>          # if step 2 recorded one
   #   SESSION_ALLOWED_GITHUB_LOGINS=<old value>          # if step 2 recorded one
   #   SESSION_SECRET_KEY=<old value>                     # if step 2 recorded one; likewise
   #   SESSION_CURSOR_KEY, SESSION_X_CLIENT_ID, SESSION_X_CLIENT_SECRET
   fly secrets import --stage -a session-dev < rollback.env
   shred -u rollback.env
   ```

   Unset each name that step 3 set and that had no value in step 2:

   ```sh
   fly secrets unset --stage -a session-dev SESSION_DOCUMENTS_REPLICA_URL   # if step 2 recorded none and step 3 set it
   fly secrets list -a session-dev
   ```

   The secrets the new build added that step 2 found empty
   (`SESSION_SECRET_KEY`, `SESSION_CURSOR_KEY`, `SESSION_X_CLIENT_*`) are
   not read by the old app and can stay.
3. Deploy the old image with the `fly.toml` of its commit and start it:

   ```sh
   fly deploy -c ~/fly.old.toml --image <old production image> --ha=false
   fly scale count 1 -a session-dev       # probably changes nothing (U4)
   fly volumes list -a session-dev        # the volume id of §1, attached
   fly machine list -a session-dev        # one machine, started, on that volume
   ```

4. Set the `production` environment's branch rule back to `main`.
5. Check `https://session.dev/healthz`, sign in to the current app and open
   a thread with an image.
6. A later launch needs another empty prefix: the new prefix of this attempt
   holds its database. Prepare the values again (§4.9), with that new
   prefix and new keys, and start again from step 1.

Done (time, by):

### Step 9. After 30 days

List first, with the trailing slash, which keeps the listing and the
deletion inside the old prefix (without it, `s3://<bucket>/session` also
matches `s3://<bucket>/session-v2/…`):

```sh
aws s3 ls --endpoint-url <endpoint> <old replica URL>/ --recursive | tail
aws s3 rm --endpoint-url <endpoint> --recursive <old replica URL>/
fly ssh console -a session-dev -C "rm -rf /data/pre-launch"
```

Delete the old image from the registry, the volume snapshot of step 4, and
the `artifacts.session.dev` certificate (`fly certs remove
artifacts.session.dev -a session-dev`), which the new build does not use.
Delete `~/fly.old.toml`.

Done (time, by):

## 7. After launch: restore rehearsal (M8b exit)

The rehearsal of §4.3 against a post-launch snapshot, on a scratch app
(`restore.md` §6) rather than on `session-dev`: restore the new
production prefix to a point after the smoke test, boot, and check the log
line with `reason: "generation"`. Record the restore point and the times as
in §4.3.

Done (time, by):
