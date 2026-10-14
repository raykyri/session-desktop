# Reset the database

How to replace `session-dev`'s database with an empty one built from the
current migrations. Use it when the migration history has been squashed
(phase 2.0 of the desktop parity plan replaced `0000`–`0002` with a single
`0000_initial.sql`): a database created by the old migrations records hashes
the new image does not know, and `openDatabase()` refuses to start with
`UnknownMigrationError`. No data is migrated. Every account, thread, highlight,
session and invite is lost.

## Why deleting the file is not enough

`web/scripts/entrypoint.sh` runs

```sh
litestream replicate -config /etc/litestream.yml -restore-if-db-not-exists -exec "node …"
```

whenever `LITESTREAM_REPLICA_URL` is set. With `/data/session.db` missing,
Litestream restores the latest replica from that URL before the server
starts, so the old database comes back and the server stops on
`UnknownMigrationError`. The replica must point somewhere empty before the
machine boots again.

## 1. Stop the application

```sh
fly scale count 0 -a session-dev
```

Two processes must never hold the same SQLite file, and a running server would
write to the database being deleted.

## 2. Point replication at an empty prefix

Either option works. Changing the prefix keeps the old replica for 30 days in
case the reset has to be undone with an older image.

- **New prefix (recommended).** Stage the secret now; it takes effect with the
  deploy in step 4.

  ```sh
  fly secrets set --stage -a session-dev LITESTREAM_REPLICA_URL=s3://<bucket>/session-v2
  ```

- **Wipe the old prefix.** With the bucket credentials in the environment:

  ```sh
  aws s3 rm --recursive "s3://<bucket>/session"
  ```

The nightly archive of `/data/documents` goes to `SESSION_DOCUMENTS_REPLICA_URL`,
or to `${LITESTREAM_REPLICA_URL}/documents` when that is unset
(`web/scripts/backup-documents.sh`). With the default it moves with the new
prefix. If `SESSION_DOCUMENTS_REPLICA_URL` is set, change or wipe it the same
way, so a later restore does not extract old archives.

## 3. Delete the database and the volume directories

Start a shell on a machine with the volume attached and the entrypoint
overridden, as in `restore.md` §2:

```sh
fly machine run --shell -a session-dev --volume session_data:/data <image>
# inside:
rm -f /data/session.db /data/session.db-wal /data/session.db-shm
rm -rf /data/documents/* /data/embeds/*
rm -f /data/tmp/documents-backup.stamp
```

- `-wal` and `-shm` belong to the deleted database and must not sit next to
  the new one.
- `/data/documents` held uploaded documents, which were removed in phase 2.0.
  Its files are named by hash and mean nothing without the old rows.
- `/data/embeds` is the cache behind `embed_assets`. Its files are only found
  through those rows, so without them the embed sweep never removes them.
- The backup stamp makes the next archive incremental. Removing it makes the
  first archive under the new prefix a full one, which `restore.md` §3 needs
  as its base.
- `/data/tmp/vertex-credentials.json` is rewritten at boot and can stay.

Exit the shell and destroy that one-off machine.

## 4. Deploy and start

Deploy the image that carries the squashed migration (this also applies the
staged secret), then bring the machine back:

```sh
fly deploy web -c web/fly.toml
fly scale count 1 -a session-dev
fly logs -a session-dev
```

The boot log should show the single initial migration being applied and
`session-server listening`. Then check:

```sh
curl -fsS https://session.dev/healthz                      # ok
```

and that Litestream reports replicating to the new prefix in the same log.

## 5. Recreate what was in the database

- Sign in through the browser so the first account exists, then grant admin
  as in `SETUP.md` §5.
- With `SESSION_REQUIRE_INVITE=1`, every invite code is gone; issue new ones
  (`06-auth-and-users.md` §3).
- Every browser session is invalid; users sign in again.

## Local development

Stop `npm run dev`, then delete the data directory and start again:

```sh
rm -rf web/.data
npm run dev
```

`.data` holds the database, its `-wal`/`-shm` files, `documents/`, `embeds/`
and `tmp/`; the server recreates the directories and applies the migration on
boot. The Playwright run deletes its own data directory before each run, so
it needs nothing.
