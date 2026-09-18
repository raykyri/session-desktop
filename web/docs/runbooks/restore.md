# Restore

How to bring `session-dev` back from its backups: `session.db` from Litestream,
`/data/documents` from the nightly archives, then the checks that say the
restore is real. Source of truth for what is backed up: `13-deployment-fly.md`
§6.

What exists to restore from:

| Data | Mechanism | Retention |
| --- | --- | --- |
| `/data/session.db` | Litestream continuous replication to `LITESTREAM_REPLICA_URL`, snapshot every 6 h (`web/litestream.yml`) | 30 days |
| `/data/documents` | `web/scripts/backup-documents.sh`, nightly tar of files new since the last run | bucket lifecycle |
| `/data/tmp` | nothing; it holds the Vertex credential, rewritten at boot | — |

Everything else (the client bundle, migrations, fonts) is in the image.

## 1. Decide what you are doing

- **The volume is gone or corrupt.** Full restore, below.
- **A bad write went in and you want yesterday.** Point-in-time restore to a
  timestamp, then swap the file in.
- **One document is missing.** Pull the archive that contains it and copy that
  one file; skip the database entirely.

In every case the app is stopped first. Two processes must never hold the same
SQLite file, and a Litestream restore into a live database directory will be
overwritten by the running server.

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

Inspect before swapping — `litestream ltx` lists what the replica holds, and
the restored file answers questions on its own:

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

A restored database must not be older than the image's migrations: the server
applies migrations forward and refuses to start against a database carrying a
migration it does not know (`UnknownMigrationError`). Restoring a 30-day-old
snapshot under today's image is fine; restoring today's database under a
month-old image is not — deploy the matching image instead.

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

Missing documents are survivable: a row in `documents` whose file is gone makes
the preview 404 and the `document_read` tool report the document as
unavailable. A missing *database* with intact files is not — the files are
content-addressed blobs with no names of their own.

## 4. Start and verify

```sh
fly scale count 1 -a session-dev
fly logs -a session-dev
```

The boot sequence to watch for (`13-deployment-fly.md` §5): env validated,
credential written, migrations applied, `reconciled runs from the previous
process`, `session-server listening`. `/healthz` is 503 until that finishes.

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

Interrupted runs resume on their own: nodes left `running` by the crash are
marked `interrupted` with `resume_pending` and re-queued at boot
(`05-run-lifecycle-and-streaming.md` §7). Expect a burst of activity in the
first minute.

## 5. After

- Delete `/data/session.db.broken` once the verification passes, not before.
- Litestream begins replicating the restored file immediately; confirm with
  `fly logs` (a `sync` line within a second or two of the first write).
- Force a documents archive so the next incremental has a marker it can trust:
  `fly ssh console -a session-dev -C "/app/scripts/backup-documents.sh"`.

## 6. Rehearsal (quarterly)

The restore is only real if it has been done recently. Once a quarter, against
a scratch app rather than production:

```sh
fly volumes create session_data_drill -a session-dev-drill -r sjc -s 20
# restore into it with the steps above, start it, verify counts, destroy it
fly volumes destroy session_data_drill -a session-dev-drill
```

Record the date, the restored timestamp, and the row counts in the drill log.
What this catches, and nothing else does: an expired bucket credential, a
retention window shorter than believed, and an image that can no longer open
the database it backed up.
