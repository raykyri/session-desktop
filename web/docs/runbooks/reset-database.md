# Reset the database

How to replace a deployment's database with an empty one built from the
current migrations: on staging after a migration squash, and on production
at the launch wipe (plan `05` §3.5, §3.6 step 4; `runbooks/launch.md`). No
data is migrated. Every account, channel, thread, invite, session, stored
API key and usage row is lost.

Fly and Litestream behaviour marked "unverified" here is checked on staging
in `launch.md` §4.13 (U1-U12) before launch day. Every `aws s3` command
takes `--endpoint-url <endpoint>`, the bucket's S3 endpoint (the app's
`AWS_ENDPOINT_URL_S3`; Fly sets it for Tigris).

## When a reset is needed

M8a squashed the migrations into one generated `0000_initial.sql` (plan `01`
D5). A database created by the earlier history (`0000_initial` with the
research tables, then `0003_api_keys` to `0007_weekly_tokens`) records
migration hashes this build does not know, and `openDatabase()` refuses it.
The server logs one line and exits 1:

```text
Database schema incompatibility: database contains 6 unrecognized migration(s). A newer build made it, or a build from before the M8a migration squash: deploy a build that knows these migrations, or replace the database as web/docs/runbooks/reset-database.md describes.
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
before the machine boots again; with an empty prefix the server starts on a
new empty file (unverified for Litestream 0.5.17, U11).

Litestream starts before the server. A deploy with the new prefix and the
old database still on the volume uploads that database into the new prefix
before the server refuses it: the prefix is then no longer empty, and the
remedy is another empty prefix, staged again (step 2) and checked at the
end of step 4.

## The server is stopped for every step that writes

The server caches records in memory and two processes must never write one
SQLite file (`delete-account.md`, "Why the server must be stopped"). The
reset deletes the database, so it runs with the server stopped, and it
checks that in two ways, as the account-deletion job does
(`web/packages/db/src/sync/running.ts`):

- **The lock.** The script opens `session.db` read-write in exclusive
  locking mode, with no busy timeout, and takes `BEGIN IMMEDIATE`. In WAL
  mode SQLite refuses that lock while any other connection has the file
  open, idle or not: a server (from the moment it opens the database), a
  build without the heartbeat, Litestream, or another operator command. The
  script then refuses and deletes nothing:

  ```text
  The database reset needs the server stopped: another process has the database open (SQLite answered SQLITE_BUSY to an exclusive lock). ...
  ```

  It holds the lock while it deletes, so no server can open the file in
  between. In rollback-journal mode an idle connection holds no lock, so
  there the lock shows only a connection inside a transaction; every
  database of this build and of `main` is in WAL mode.
- **The heartbeat.** A running server writes a heartbeat row
  (`server_heartbeat` in `server_meta`) right after it opens the database
  and every 30 seconds, and deletes it at the end of its shutdown. The
  script refuses while the heartbeat is under 90 seconds old, which covers a
  server that was killed moments ago and may be restarting, on this machine
  or another:

  ```text
  The database reset needs the server stopped: a server (pid 7) wrote its heartbeat 12 s ago. ...
  ```

  A heartbeat dated after this machine's clock is refused as "a heartbeat
  dated N s ahead of this machine's clock".

A database made by a build without `server_meta` (production's, from
`main`) has no heartbeat to read, and neither has a `session.db` that SQLite
cannot read (not a database, or corrupt). The script then refuses unless it
is given `--assume-stopped`, which the operator passes only after checking
that no machine of the app other than the one-off machine of step 4 is
started. The lock is still taken wherever SQLite can open the file; for a
file it cannot lock, the script says so.

With no `session.db` at all, nothing shows that the directory is a data
directory (a wrong `--data-dir`, or an empty `SESSION_DATA_DIR`, which the
script treats as unset). The script lists what it would delete, and deletes
only with `--yes --no-database`. It refuses when `session.db`, `documents`
or `embeds` is a symbolic link.

The script is `web/packages/server/scripts/reset-database.ts`; images built
from the M8a commit on hold it bundled as
`/app/packages/server/dist/reset-database.mjs`. Without `--yes` it lists
what it would delete and deletes nothing; it removes the `-wal` file its
own open creates. It deletes, under `SESSION_DATA_DIR`:

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

Exit codes: 0 done or listed, 1 refused (nothing deleted), 2 usage, 3 any
other error.

## Steps

`<app>` is `session-staging` or `session-dev`; `<config>` is that app's Fly
configuration (`web/fly.staging.toml` or `web/fly.toml`). Run every command
from the repository root at the commit to deploy. The production launch
(`launch.md` §6) runs these steps in its own order, with the current files
moved aside instead of deleted; follow `launch.md` there.

### 1. Record what is there now

```sh
fly image show -a <app>                                          # the running image
fly ssh console -a <app> -C "printenv LITESTREAM_REPLICA_URL"     # the current prefix
fly ssh console -a <app> -C "printenv SESSION_DOCUMENTS_REPLICA_URL"
fly secrets list -a <app>
fly volumes list -a <app>                                        # the volume id and region
```

Keep the image reference, both URLs and the volume id: they are the
rollback point. The old prefix is not deleted by this runbook.

### 2. Stage an empty replica prefix

Choose a prefix that holds nothing and whose name does not start with the
old prefix's name:

```sh
aws s3 ls --endpoint-url <endpoint> s3://<bucket>/<new prefix>/ --recursive   # prints nothing
```

Write `LITESTREAM_REPLICA_URL=s3://<bucket>/<new prefix>` into a file only
its owner can read, with an editor so that the value is on no command line,
and stage it (`--stage` on `import` is unverified, U5):

```sh
install -m 600 /dev/null reset.env
"$EDITOR" reset.env
fly secrets import --stage -a <app> < reset.env
shred -u reset.env
fly secrets list -a <app>
```

Staged secrets take effect with the next deploy, which is that of step 5.
Changing the prefix keeps the old replica for a rollback; wiping the old
prefix instead is not part of this runbook.

The nightly archive of `/data/documents` goes to
`SESSION_DOCUMENTS_REPLICA_URL`, or to `${LITESTREAM_REPLICA_URL}/documents`
when that is unset (`web/scripts/backup-documents.sh`); with the default it
moves with the new prefix. If `SESSION_DOCUMENTS_REPLICA_URL` is set, add a
new value for it to the same file, so a later restore does not extract old
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

Start a shell on a one-off machine with the volume attached, in the
volume's region (`fly volumes list -a <app>`). `--shell` is taken not to
run the entrypoint, so neither Litestream nor the server starts (unverified,
U1):

```sh
fly machine run registry.fly.io/<app>:<label> --shell -a <app> -r <region> --volume session_data:/data
# inside:
ps -e                                                      # no litestream, no node
node /app/packages/server/dist/reset-database.mjs          # lists what it would delete
```

Check the list: `/data/session.db` with its `-wal` and `-shm`,
`/data/.session.db-litestream`, `/data/documents/*`, `/data/embeds` and
`/data/tmp/documents-backup.stamp` where they exist, and nothing outside
`/data`. Then:

```sh
node /app/packages/server/dist/reset-database.mjs --yes    # deletes it
```

On a database without `server_meta` (production's, from `main`) both runs
stop with "has no server_meta table"; check `fly machine list -a <app>`
from the workstation again, then run the listing with `--assume-stopped`
and the deletion with `--yes --assume-stopped`.

Leave the shell; the one-off machine is destroyed. The last command of this
step, from the workstation, checks that the new prefix is still empty; if
it lists anything, do not deploy, and go back to step 2 with another prefix:

```sh
aws s3 ls --endpoint-url <endpoint> s3://<bucket>/<new prefix>/ --recursive   # prints nothing
```

### 5. Deploy and start

Deploy the image built in step 3, which also applies the staged secrets,
then bring the machine back. On an app at zero machines, whether `fly
deploy` starts a machine on the existing volume, and whether `fly scale
count 1` then changes anything, is unverified (U4):

```sh
fly deploy -c <config> --image registry.fly.io/<app>:<label> --ha=false
fly scale count 1 -a <app>          # probably changes nothing
fly volumes list -a <app>           # the volume id of step 1, attached
fly machine list -a <app>           # one machine, started, on that volume
fly logs -a <app>
```

The boot log shows a warning `the sync history id was replaced: every
cursor served before this boot resyncs` with `previous: null` (an empty
file has no generation recorded), then `booted` and `session-server
listening`. Check:

```sh
curl -fsS https://<host>/healthz                         # ok
aws s3 ls --endpoint-url <endpoint> s3://<bucket>/<new prefix>/ --recursive | head  # Litestream's first files
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

Stop `npm run dev` (the reset refuses while it has the database open), then,
from `web/packages/server`:

```sh
npx tsx scripts/reset-database.ts --data-dir ../../.data          # lists
npx tsx scripts/reset-database.ts --data-dir ../../.data --yes    # deletes
```

or delete the directory: `rm -rf web/.data`. The next `npm run dev` creates
the database and applies `0000_initial.sql`. The Playwright run deletes its
own data directory before each run, so it needs nothing.
