# Privacy check after a removal

How to check, on staging, that a removed thread's text is gone: the M6 exit
check of `05-delivery.md` and plan `04` P2, by script. After a removal the
text must be absent from:

- the SQLite file and its WAL, after a checkpoint (the D4 scan of `01`),
  and Litestream's local state beside them (`.session.db-litestream/`), when
  it is there;
- the snapshot and pull answers for the channel's owner, a member, a
  non-member, a signed-out reader and the author; each pull of a reader who
  may read the thread must carry its removal;
- the author's `removed` notification, which carries only the owner's
  reason.

The script is `web/packages/server/scripts/privacy-check.ts`; the image
holds it bundled as `packages/server/dist/privacy-check.mjs`. It reads the
records through a read-only connection and runs next to the live server.
The only write is a WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`), which
SQLite allows from any connection.

The files are searched for the text as given and as a record body stores
it, JSON-escaped (a quote, a backslash or a line break in the text is
escaped there); served answers are searched string by string.

## 1. Make a removal to check

Signed in on staging as two accounts in one channel:

1. As a member, post a thread whose text holds a marker that appears nowhere
   else, for example `PRIVACY-<date>-<random>`, and reply to it with the
   marker as well.
2. As the channel's owner, open the thread's "…" menu, choose Remove…, give a
   reason, and Remove.
3. Note the thread's id: the `t` parameter of the thread's address
   (`/c/<name>?t=<id>`), copied before the removal.

## 2. Run the check on the machine

```sh
fly ssh console -a session-staging
# inside:
cd /app && node packages/server/dist/privacy-check.mjs --thread <id> --text "<marker>"
```

The configuration is the server's own environment: `SESSION_DATA_DIR` names
the database and `SESSION_CURSOR_KEY` seals the cursor of each pull, which
starts at the version just before the removal, as a reader who had read the
thread holds. The non-member reads as the handle `privacy.check`, which
needs no account; `--outsider <handle>` names another.

Output, one line per check, then the verdict; the exit status is 1 when any
check fails:

```text
pass  the WAL was checkpointed
pass  the text is not in /data/session.db
pass  the text is not in /data/session.db-wal
pass  the text is not in /data/.session.db-litestream
pass  the thread is removed (mod: removed)
pass  the owner's snapshot holds no removed text
…
pass  the owner's pull from before the removal carries the removal
…
pass  the removed notification holds no removed text
privacy check passed
```

## 3. If a check fails

- **The WAL was checkpointed (busy).** A reader held the WAL open, so the
  checkpoint could copy the WAL into the file but not reset it. Litestream
  replicates by holding a read transaction on the database between its
  syncs, so with Litestream running the checkpoint may stay busy on every
  run: running the script again a minute later is not expected to help.
  (Litestream's documentation is not in this repository; this behaviour is
  that of the releases up to 0.3 and is unverified for the image's 0.5.)
  The check fails only when the scans of the file or the WAL also find the
  text: a busy checkpoint with a clean file and WAL passes. When the WAL
  still holds the text, wait for Litestream's own checkpoint (when 0.5 runs
  one is unverified), or stop Litestream for the run on a staging machine,
  then run the script again.
- **The text is in the file or the WAL after a completed checkpoint.**
  `secure_delete` did not take effect, or a table outside `records` holds
  the text (a run's stream rows, `usage_events`). Find it with
  `sqlite3 /data/session.db .dump | grep -n "<marker>"` and treat it as a
  privacy incident.
- **A reader's snapshot or pull holds the text.** The erase or the read
  rules are wrong; the conformance suite (`inv6`) should have caught it.
  Treat it as a privacy incident.
- **The pull answered resync: FAIL.** A resync carries no change, so it
  proves nothing about the removal. The cursor key in the environment is not
  the server's, the log's history was replaced, or the reader's membership
  changed after the removal (the member the script picked joined later).
  Fix the environment, or name another reader, and run the script again.
- **A pull does not carry the removal.** The removal's change did not reach
  a reader who had read the thread: the change log is wrong. Treat it as a
  privacy incident.
- **The text is in `.session.db-litestream`.** Litestream's local state
  (its shadow WAL up to 0.3, its LTX files under 0.5) still holds pages from
  before the removal until Litestream compacts or removes them. The scan is
  of the raw bytes: 0.5 may store LTX pages compressed, in which case a pass
  here proves less than a pass on the file and WAL (unverified).

The replica's generations in object storage keep the text until their
retention expires; there is no retention requirement for backups (`01` §9
question 3), so the remote replica is not part of this check.

## Running it locally

`web/packages/server/test/privacyCheck.test.ts` runs the same check against
a temp database after a removal made through the sync routes, and shows it
finds the text before the removal. Against a local database:

```sh
cd web/packages/server
SESSION_DATA_DIR=<dir> NODE_ENV=test SESSION_PUBLIC_ORIGIN=http://localhost:8787 \
  npx tsx scripts/privacy-check.ts --thread <id> --text "<marker>"
```
