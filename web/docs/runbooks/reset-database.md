# Reset the database

How to replace a deployment's database with an empty one built from the
current migrations: on staging after a migration squash, and on production
at the launch wipe (plan `05` §3.5, §3.6 step 4; `runbooks/launch.md`). No
data is migrated. Every account, channel, thread, invite, session, stored
API key and usage row is lost.

## When a reset is needed

M8a squashed the migrations into one generated `0000_initial.sql` (plan `01`
D5). A database created by the earlier history (`0000_initial` with the
research tables, then `0003_api_keys` to `0007_weekly_tokens`) records
migration hashes this build does not know, and `openDatabase()` refuses it:

```text
Database schema incompatibility: database contains 6 unrecognized migration(s). Update the application to a compatible version.
```

No upgrade path exists, by decision (`01` D5): every development and staging
database made before the squash is reset with this runbook. Production holds
the database of the current web app (`main`), which this build does not
read either; the launch replaces it the same way.

## Why deleting the file is not enough

`web/scripts/entrypoint.sh` runs

```sh
litestream replicate -config /etc/litestream.yml -restore-if-db-not-exists -exec "node …"
```

whenever `LITESTREAM_REPLICA_URL` is set. With `/data/session.db` missing,
Litestream restores the latest replica from that URL before the server
starts, so the old database comes back and the server stops on
`UnknownMigrationError`. The replica URL must point at an empty prefix
before the machine boots again.

## The server is stopped for every step that writes

The server caches records in memory and two processes must never write one
SQLite file (`delete-account.md`, "Why the server must be stopped"). The
reset deletes the database, so it runs with the server stopped, and it
checks that, as the account-deletion job does: a running server writes a
heartbeat row (`server_heartbeat` in `server_meta`) at boot and every 30
seconds and deletes it at the end of its shutdown. The reset script refuses
while the heartbeat is under 90 seconds old and deletes nothing:

```text
The database reset needs the server stopped: a server (pid 7) wrote its heartbeat 12 s ago. Stop it and run this again; ...
```

A database made by a build without `server_meta` (production's, from
`main`) has no heartbeat to read. The script then refuses unless it is given
`--assume-stopped`, which the operator passes only after checking that no
machine of the app other than the one-off machine of step 4 is started.

The script is `web/packages/server/scripts/reset-database.ts`; images built
from the M8a commit on hold it bundled as
`/app/packages/server/dist/reset-database.mjs`. Without `--yes` it lists
what it would delete and deletes nothing. It deletes, under
`SESSION_DATA_DIR`:

- `session.db`, `session.db-wal` and `session.db-shm`;
- `.session.db-litestream/`, Litestream's local state for the deleted file;
- everything in `documents/` (the directory stays; the entrypoint expects
  it);
- `embeds/`, the embedded-post image cache of the earlier build, which
  nothing reads now;
- `tmp/documents-backup.stamp`, so the first documents archive under the new
  prefix is a full one, which `restore.md` §3 needs as its base.

`tmp/vertex-credentials.json` stays; the entrypoint rewrites it at every
boot.

## Steps

`<app>` is `session-staging` or `session-dev`; `<config>` is that app's Fly
configuration (`web/fly.staging.toml` or `web/fly.toml`). Run every command
from the repository root at the commit to deploy.

### 1. Record what is there now

```sh
fly image show -a <app>                                          # the running image
fly ssh console -a <app> -C "printenv LITESTREAM_REPLICA_URL"     # the current prefix
fly ssh console -a <app> -C "printenv SESSION_DOCUMENTS_REPLICA_URL"
fly secrets list -a <app>
```

Keep the image reference and both URLs: they are the rollback point. The old
prefix is not deleted by this runbook.

### 2. Stage an empty replica prefix

```sh
fly secrets set --stage -a <app> LITESTREAM_REPLICA_URL=s3://<bucket>/<new prefix>
```

Staged secrets take effect with the deploy of step 5. Use a prefix that
holds nothing (`aws s3 ls s3://<bucket>/<new prefix>/` prints nothing).
Changing the prefix keeps the old replica for a rollback; wiping the old
prefix instead is not part of this runbook.

The nightly archive of `/data/documents` goes to
`SESSION_DOCUMENTS_REPLICA_URL`, or to `${LITESTREAM_REPLICA_URL}/documents`
when that is unset (`web/scripts/backup-documents.sh`); with the default it
moves with the new prefix. If `SESSION_DOCUMENTS_REPLICA_URL` is set, stage
a new value for it as well, so a later restore does not extract old
archives.

### 3. Build the image and stop the application

Build and push the image of this commit without deploying it, so the reset
runs from an image that holds the script:

```sh
fly deploy web -c <config> --build-only --push --image-label <label>
# prints the image: registry.fly.io/<app>:<label>
fly scale count 0 -a <app>
fly machine list -a <app>         # no machine listed as started
```

### 4. Delete the database and the volume directories

Start a shell on a one-off machine with the volume attached (in the volume's
region, `fly volumes list -a <app>`):

```sh
fly machine run registry.fly.io/<app>:<label> --shell -a <app> -r <region> --volume session_data:/data
# inside:
node /app/packages/server/dist/reset-database.mjs          # lists what it would delete
node /app/packages/server/dist/reset-database.mjs --yes    # deletes it
```

On staging the script reads the heartbeat. On production's database from
`main` it stops with "has no server_meta table"; check `fly machine list -a
session-dev` from the workstation again, then run it with `--yes
--assume-stopped`.

Leave the shell; the one-off machine is destroyed.

### 5. Deploy and start

Deploy the image built in step 3, which also applies the staged secrets,
then bring the machine back:

```sh
fly deploy -c <config> --image registry.fly.io/<app>:<label>
fly scale count 1 -a <app>
fly logs -a <app>
```

The boot log shows a warning `the sync history id was replaced: every
cursor served before this boot resyncs` with `previous: null` (an empty
file has no generation recorded), then `booted` and `session-server
listening`. Check:

```sh
curl -fsS https://<host>/healthz                         # ok
aws s3 ls s3://<bucket>/<new prefix>/ --recursive | head  # Litestream's first files
fly ssh console -a <app>
# inside:
cd /app && node -e 'const d = require("better-sqlite3")("/data/session.db", { readonly: true }); console.log(d.prepare("SELECT count(*) AS migrations FROM __drizzle_migrations").get(), d.prepare("SELECT count(*) AS users FROM users").get())'
# { migrations: 1 } { users: 0 }
```

### 6. Recreate what was in the database

- Site admins: a root invite per person, redeemed, then promoted by handle
  (`launch.md` §6; plan `05` §3.5). On staging, the same commands with
  `-a session-staging`.
- Every account invite and channel invite link is gone; members make new
  ones.
- Every browser session is invalid; people sign in again.

## Local development

Stop `npm run dev` (the reset refuses while its heartbeat is fresh), then,
from `web/packages/server`:

```sh
npx tsx scripts/reset-database.ts --data-dir ../../.data          # lists
npx tsx scripts/reset-database.ts --data-dir ../../.data --yes    # deletes
```

or delete the directory: `rm -rf web/.data`. The next `npm run dev` creates
the database and applies `0000_initial.sql`. The Playwright run deletes its
own data directory before each run, so it needs nothing.
