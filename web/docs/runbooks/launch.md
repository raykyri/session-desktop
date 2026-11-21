# Launch

The launch of the web build on `session-dev` (`https://session.dev`): the
preparation of plan `05` M8a and the launch sequence of §3.6 (M8b), with the
admin seeding of §3.5, the configuration of §3.4 and the M8b smoke test.
The current web app (`main`) stays in production until step 5 of §6.

Every step here is run by a person with Fly, GitHub, X and bucket access.
None of it has been run. Steps that need outside access or a decision end
with a "Done (time, by):" line; fill it in when the step is done, and commit
this file with the times.

Related runbooks: `reset-database.md` (the wipe), `restore.md` (the restore
rehearsal and rollback), `privacy-check.md`, `load-check.md`,
`rotate-cursor-key.md`, `delete-account.md`.

## 1. Values to record

Fill these in before §4. Later steps refer to them by name.

| Name | Value |
| --- | --- |
| Build branch | `session-web` (on this remote: `claude/session-web`) |
| Launch commit | |
| Staging origin (`SESSION_PUBLIC_ORIGIN` of `session-staging`) | |
| Bucket | |
| Old replica URL (`LITESTREAM_REPLICA_URL` now, `s3://<bucket>/<old prefix>`) | |
| Old `SESSION_DOCUMENTS_REPLICA_URL` (if set) | |
| New replica URL (`s3://<bucket>/<new prefix>`, an empty prefix) | |
| Old production image (`fly image show -a session-dev`) | |
| Launch image (`registry.fly.io/session-dev:<label>`) | |
| Volume region (`fly volumes list -a session-dev`) | `sjc` per `fly.toml` |

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
| `LITESTREAM_REPLICA_URL` | The entrypoint runs the server without replication: no backup | Fly secret, changed: `<new replica URL>` (§4.9). The old prefix is the rollback source |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Litestream and the documents archive cannot write the bucket | Fly secret, kept from the current app unless the bucket changes. `AWS_ENDPOINT_URL_S3` and `AWS_REGION` are honoured when the bucket needs them (Fly sets the endpoint for Tigris) |
| `SESSION_METRICS_TOKEN` | `GET /metrics` answers 404; spend and volume space are not observable | Fly secret, kept or new: `openssl rand -hex 32` |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_VERTEX_PROJECT` | Gemini models are unavailable; thread titles and summaries use them | Secret kept from the current app; `GOOGLE_VERTEX_PROJECT = "session-dev"` in `fly.toml [env]` |
| `OPENROUTER_API_KEY` | DeepSeek V4.1 Flash and GPT-5.6 Luna are unavailable | Fly secret, kept |
| `ANTHROPIC_API_KEY` | Claude Fable 5.1 runs only on members' own keys | Fly secret, kept |
| `PARALLEL_API_KEY`, `TAVILY_API_KEY` | The `web_search` tool is unavailable | Fly secret, kept (either or both) |
| `SENTRY_DSN` | No error reporting | Optional |

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
| `SESSION_RUNS_PER_USER`, `SESSION_QUEUED_PER_USER` | `2`, `20` | Running and queued runs per member |
| `SESSION_RUNS_GEMINI`, `SESSION_RUNS_OPENROUTER`, `SESSION_RUNS_ANTHROPIC` | `8`, `8`, `2` | Concurrent runs per provider |
| `SESSION_RUN_TIMEOUT_SECONDS` | `900` | Wall-clock limit per run |
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
  sign in with GitHub, invite or not. Unset it unless that restriction is
  wanted:

  ```sh
  fly secrets unset --stage -a session-dev SESSION_ALLOWED_GITHUB_LOGINS
  ```

The current app's `[env]` values (`SESSION_ARTIFACT_ORIGIN`,
`SESSION_REQUIRE_INVITE`, `SESSION_ENFORCE_LIMITS`, `SESSION_DAILY_*`,
`SESSION_EMBED_CACHE_BYTES`) come from `main`'s `fly.toml` and are replaced
by the new `fly.toml` at the deploy.

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

## 4. Preparation (M8a)

### 4.1 Staging configuration

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

Done (time, by):

### 4.2 Staging reset after the squash

Follow `reset-database.md` with `<app>` = `session-staging` and `<config>` =
`web/fly.staging.toml`, from a commit that includes the squash. The reset
script reads the staging database's heartbeat; `--assume-stopped` is not
needed there. Record the stop and the first healthy `/healthz`:

| | Time (UTC) |
| --- | --- |
| `fly scale count 0` | |
| `reset-database.mjs --yes` | |
| `/healthz` answers `ok` | |

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
3. Restore to T2 with `restore.md` §2, from the image of §4.2:

   ```sh
   fly scale count 0 -a session-staging
   fly machine run registry.fly.io/session-staging:<label> --shell -a session-staging \
     -r <region> --volume session_data:/data
   # inside (LITESTREAM_REPLICA_URL and the AWS keys as in the app's secrets):
   litestream restore -config /etc/litestream.yml -timestamp <T2> \
     -o /data/session.db.restored "$LITESTREAM_REPLICA_URL"
   cd /app && node -e '
     const d = require("better-sqlite3")("/data/session.db.restored", { readonly: true });
     console.log(d.pragma("integrity_check", { simple: true }));'
   mv /data/session.db /data/session.db.broken
   rm -f /data/session.db-wal /data/session.db-shm
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
6. Delete `/data/session.db.broken` (`fly ssh console -a session-staging -C
   "rm /data/session.db.broken"`).

| | Time (UTC) |
| --- | --- |
| T2 (restore point) | |
| `fly scale count 0` | |
| `litestream restore` finished | |
| `/healthz` answers `ok` | |
| Boot log line with `reason: "generation"` seen | |

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
- its client id and secret staged as `SESSION_X_CLIENT_ID` and
  `SESSION_X_CLIENT_SECRET` (§4.9).

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

### 4.9 Stage the production secrets

`--stage` stores the values without restarting the current app; they take
effect with the deploy of §6 step 5. Do not run `fly secrets deploy`: it
would restart the current app with the new `LITESTREAM_REPLICA_URL`, and
the current app would replicate its database into the new prefix.

Make the two keys first, each with `openssl rand -base64 32`, and store
both where the site admins keep production secrets, so a copy exists outside
Fly (§2.1). They must differ.

```sh
fly secrets set --stage -a session-dev \
  SESSION_SECRET_KEY='<secret key>' \
  SESSION_CURSOR_KEY='<cursor key>' \
  SESSION_X_CLIENT_ID=<production X app client id> \
  SESSION_X_CLIENT_SECRET=<production X app client secret> \
  LITESTREAM_REPLICA_URL=<new replica URL>
fly secrets unset --stage -a session-dev SESSION_ALLOWED_GITHUB_LOGINS   # §2.5, unless wanted
fly secrets list -a session-dev
```

Check that `aws s3 ls <new replica URL>/` prints nothing. If
`SESSION_DOCUMENTS_REPLICA_URL` is set, stage a new value under the new
prefix too (`reset-database.md` §2). Keep `GITHUB_CLIENT_*`, the model and
search keys, the AWS keys and `SESSION_METRICS_TOKEN` as they are, or set
new values the same way.

Done (time, by):

### 4.10 GitHub `production` environment

The `production` environment (repository settings, Environments) has
required reviewers, so a push of the launch commit waits for approval
before its `deploy` job runs. Without that, step 1 of §6 would deploy the
new image onto the current database, which it refuses at boot
(`UnknownMigrationError`), before the wipe.

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

## 5. Rollback point

Until the first member's account invite is redeemed after the launch, the
launch can be undone (§6 step 8). What it needs is kept, not deleted:

- the old Litestream prefix, which holds the current app's database, for 30
  days after launch;
- the old documents archives under that prefix (or under the old
  `SESSION_DOCUMENTS_REPLICA_URL`);
- the old image, recorded in §1;
- `main`'s `web/fly.toml`, which sets the current app's `[env]`
  (`SESSION_REQUIRE_INVITE`, `SESSION_ARTIFACT_ORIGIN` and the daily
  limits); deploying the old image with the new `fly.toml` would start it
  without them;
- the old deploy path: `main`'s `deploy` job is disabled only in §6 step 1,
  by the `production` environment's branch rule; `main`'s files are not
  changed.

The root invites of §6 step 6 do not count as a member's invite.

## 6. Launch (M8b, plan `05` §3.6)

### Step 1. Freeze

1. Merge the launch commit to the build branch. The launch commit points
   the build branch's `deploy` job at production; in
   `.github/workflows/web.yml`:

   ```yaml
   deploy:
     if: github.ref == 'refs/heads/<build branch>' && github.event_name == 'push'
   ```

2. CI is green on it: `check`, `test`, `e2e`, `docker`.
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
fly ssh console -a session-dev -C "printenv LITESTREAM_REPLICA_URL"
fly ssh console -a session-dev -C "printenv SESSION_DOCUMENTS_REPLICA_URL"
aws s3 ls <old replica URL>/ --recursive | tail -5
git show origin/main:web/fly.toml > ~/fly.main.toml   # outside the repository
```

Record the image and both URLs in §1; the bucket listing shows the old
prefix's last writes.

Done (time, by):

### Step 3. Check the staged secrets

`fly secrets list -a session-dev` lists the values staged in §4.9 as
staged. They are applied by the deploy of step 5, not before; do not run
`fly secrets deploy`.

Done (time, by):

### Step 4. Stop and wipe

`reset-database.md` §3-§4 for `session-dev`, with the launch image:

```sh
fly scale count 0 -a session-dev
fly machine list -a session-dev          # no machine started
fly machine run <launch image> --shell -a session-dev -r sjc --volume session_data:/data
# inside:
node /app/packages/server/dist/reset-database.mjs
# refused: the database of main has no server_meta table. Check from the
# workstation that `fly machine list -a session-dev` shows only this machine, then:
node /app/packages/server/dist/reset-database.mjs --yes --assume-stopped
exit
```

The listing must name `/data/session.db` with its `-wal` and `-shm`,
`/data/documents/*`, `/data/embeds` and `/data/tmp/documents-backup.stamp`
where they exist.

Done (time, by):

### Step 5. Deploy and start

```sh
fly deploy -c web/fly.toml --image <launch image>
fly scale count 1 -a session-dev
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
aws s3 ls <new replica URL>/ --recursive | head    # Litestream's files
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
| The default model and the default effort set on `/admin`; a member's composer starts on both after a reload | |
| A post in an open channel | |
| An ask paid with included tokens streams an answer; `/usage` shows the tokens | |
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

1. Stop the new build and delete its database, so that Litestream restores
   the old one at the next boot (the new database has `server_meta`, so the
   script reads its heartbeat):

   ```sh
   fly scale count 0 -a session-dev
   fly machine run <launch image> --shell -a session-dev -r sjc --volume session_data:/data
   # inside:
   node /app/packages/server/dist/reset-database.mjs --yes
   exit
   ```

2. Point replication back at the old prefix (and the old documents URL, if
   it was set), and set `SESSION_ALLOWED_GITHUB_LOGINS` again if §4.9
   unset it:

   ```sh
   fly secrets set --stage -a session-dev LITESTREAM_REPLICA_URL=<old replica URL>
   ```

3. Deploy the old image with `main`'s configuration and start it. Its
   entrypoint restores the old database from the old prefix
   (`-restore-if-db-not-exists`):

   ```sh
   fly deploy -c ~/fly.main.toml --image <old production image>
   fly scale count 1 -a session-dev
   ```

4. Restore `/data/documents` from the old archives (`restore.md` §3): step 4
   deleted the current app's image attachments.
5. Set the `production` environment's branch rule back to `main`.
6. Check `https://session.dev/healthz` and sign in to the current app.

The secrets the new build added (`SESSION_SECRET_KEY`, `SESSION_CURSOR_KEY`,
`SESSION_X_CLIENT_*`) are unknown to the current app and can stay.

Done (time, by):

### Step 9. After 30 days

```sh
aws s3 rm --recursive <old replica URL>
```

Delete the old image from the registry, and the `artifacts.session.dev`
certificate (`fly certs remove artifacts.session.dev -a session-dev`),
which the new build does not use. Delete `~/fly.main.toml`.

Done (time, by):

## 7. After launch: restore rehearsal (M8b exit)

The rehearsal of §4.3 against a post-launch snapshot, on a scratch app
(`restore.md` §6) rather than on `session-dev`: restore the new
production prefix to a point after the smoke test, boot, and check the log
line with `reason: "generation"`. Record the restore point and the times as
in §4.3.

Done (time, by):
