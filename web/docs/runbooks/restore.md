# Restore

How to bring `session-dev` back from its backups: `session.db` from Litestream,
`/data/documents` from the nightly archives, followed by the verification steps required to validate database integrity and application health. Source of truth for what is backed up: `13-deployment-fly.md`
§6.

Available backup sources:

| Data | Mechanism | Retention |
| --- | --- | --- |
| `/data/session.db` | Litestream continuous replication to `LITESTREAM_REPLICA_URL`, snapshot every 6 h (`web/litestream.yml`) | 30 days |
| `/data/documents` | `web/scripts/backup-documents.sh`, nightly tar of files new since the last run | bucket lifecycle |
| `/data/tmp` | nothing; it holds the Vertex credential, rewritten at boot | — |

Everything else (the client bundle, migrations, fonts) is in the image.

## 1. Determine the recovery scenario

- **The volume is gone or corrupt.** Full restore, below.
- **Recover from an incorrect write or data corruption.** Restore to a point
  in time, then replace the active database file.
- **One document is missing.** Pull the archive that contains it and copy that
  one file; skip the database entirely.

Stop the application before performing any restore. Two processes must never
hold the same SQLite file, and a Litestream restore into a live database
directory will be overwritten by the running server.

```sh
fly scale count 0 -a session-dev      # or: fly machine stop <id>
```

## 2. Restore `session.db`

From a machine with the secrets in its environment — easiest is the app's own
image, started with the volume attached and the entrypoint overridden:

```sh
fly machine run --shell -a session-dev --volume session_data:/data <image>
# inside:
export LITESTREAM_REPLICA_URL=...       # already in the environment on the app
litestream restore -config /etc/litestream.yml -o /data/session.db.restored "$LITESTREAM_REPLICA_URL"
```

Point-in-time instead of latest:

```sh
litestream restore -config /etc/litestream.yml \
  -timestamp 2026-03-04T05:00:00Z \
  -o /data/session.db.restored "$LITESTREAM_REPLICA_URL"
```

Inspect the database before replacing the active file: run `litestream ltx` to review available snapshots, and query the restored database directly with `sqlite3` to confirm row counts and table integrity:

```sh
sqlite3 /data/session.db.restored "PRAGMA integrity_check;"
sqlite3 /data/session.db.restored "SELECT count(*) FROM nodes;"
```

Then swap, keeping the old file until the verification below passes:

```sh
mv /data/session.db /data/session.db.broken 2>/dev/null || true
rm -f /data/session.db-wal /data/session.db-shm
mv /data/session.db.restored /data/session.db
chown session:session /data/session.db
```

A restored database must not be newer than the image's migrations: the server
applies migrations forward and refuses to start against a database carrying a
migration it does not know (`UnknownMigrationError`). A current image can use
an older database snapshot and apply pending migrations. An older image cannot
use a newer database; deploy an image that supports the restored schema.

## 3. Restore `/data/documents`

The archives are `documents-<timestamp>-full.tar.gz` and
`...-incremental.tar.gz` under `documents/` in the same bucket. Restore the
most recent `full`, then every `incremental` newer than it, oldest first;
paths inside the archive are relative to the data directory.

```sh
cd /data
for archive in $(ls -1 /tmp/restore/documents-*.tar.gz | sort); do
  tar -xzf "$archive"
done
chown -R session:session /data/documents
```

The application can tolerate missing document files: if a document record lacks an underlying file, document previews return 404 and the `document_read` tool reports an error. Conversely, document files cannot be recovered without the database, because files on disk are content-addressed hashes that rely on database metadata for context.

## 4. Start and verify

```sh
fly scale count 1 -a session-dev
fly logs -a session-dev
```

Monitor the startup logs for the expected boot sequence
(`13-deployment-fly.md` §5): environment validation, credential generation,
migration application, `reconciled runs from the previous process`, and
`session-server listening`. `/healthz` returns 503 until startup completes.

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://session.dev/healthz     # 200
curl -sS -H "Authorization: Bearer $SESSION_METRICS_TOKEN" https://session.dev/metrics \
  | grep -E 'session_(ready|db_size_bytes|queue_depth)'
```

Counts against what you expected before the incident:

```sh
fly ssh console -a session-dev -C \
  "sqlite3 /data/session.db 'SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM trees), (SELECT count(*) FROM nodes), (SELECT count(*) FROM documents);'"
fly ssh console -a session-dev -C "sh -c 'find /data/documents -type f | wc -l'"
```

Then in the app: sign in, open a tree, open a document preview (that exercises
the artifact origin and the restored file), and start one short run (that
exercises the queue, a provider credential, and a write).

Interrupted runs resume automatically: nodes left `running` by the crash are
marked `interrupted` with `resume_pending` and re-queued during startup
(`05-run-lifecycle-and-streaming.md` §7). This can increase activity during the
first minute.

## 5. After

- Delete `/data/session.db.broken` once the verification passes, not before.
- Litestream begins replicating the restored file immediately; confirm with
  `fly logs` (a `sync` line within a second or two of the first write).
- Force a documents archive to establish a reliable baseline marker for subsequent incremental backups:
  `fly ssh console -a session-dev -C "/app/scripts/backup-documents.sh"`.

## 6. Rehearsal (quarterly)

Backup and recovery procedures must be tested on a regular schedule to ensure disaster readiness. Once a quarter, against
a scratch app rather than production:

```sh
fly volumes create session_data_drill -a session-dev-drill -r sjc -s 20
# restore into it with the steps above, start it, verify counts, destroy it
fly volumes destroy session_data_drill -a session-dev-drill
```

Record the date, the restored timestamp, and the row counts in the drill log.
Rehearsals identify failure modes that automated checks miss, such as expired object storage credentials, misconfigured retention policies, or migration incompatibilities between the backup snapshot and current container image.
