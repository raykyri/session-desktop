# Delete an account

How a site admin deletes a Session account: the account-deletion operator
job of plan `04` §8 and B6. There is no in-app deletion and no suspension;
this job and channel deletion are the only Session-wide actions against
abuse (`04` §3.6).

## What the job does

In one transaction (`accounts.deleteAccount`, `web/packages/db`):

- Every thread, branch, reply and comment the person wrote goes through the
  author's delete path, shells they deleted earlier included. A thread,
  branch, reply or comment with other people's content under it stays as an
  empty shell, as when the author deletes it (`AGENTS.md`), and the job
  takes the person off it: its author becomes `null`; a kept branch loses
  its answer, run and turns, a kept thread its root answer and summary.
  Their gone threads keep no author either.
- Their saves (the threads' save counts follow), notifications and layout
  preference, the bans of them (the owner's Banned list loses the entry),
  the channel invite links they made and their member records are deleted.
- Other people's records that name them get `null` there: the `actor` of a
  notification they caused, the `usedBy` of a link they joined with.
- The checkpoints and resume counts of their runs (`run_live`,
  `run_resumes`) are deleted with the runs. The boot sweep would delete the
  checkpoints too (their run is gone), not the resume counts.
- Their stored API keys, billing mode, preferences, limit overrides, sync
  clients and the answers recorded for them are deleted.
- Every channel they own is frozen (`frozen: true` on the space record). A
  frozen channel stays readable (an open one by anyone, a private one by its
  members) and refuses every write except a person deleting their own items
  and leaving; joins and invite links are refused. Nothing unfreezes it.
- Their sessions end and their open account invites are revoked.
- The sign-in identity is removed: `provider`, `provider_user_id`, the email,
  login, names and avatar. The `users` row stays with its handle, so the
  handle stays taken and the account stays in the invite tree as "Deleted
  account". The same provider identity can sign in again and gets a new
  waiting account with no link to the old one.
- Moderation log entries that name the person stay until the 180-day
  retention deletes them; they and the `owner` of the channels the person
  owned are the only records left that name them.
- A refusal or an error in any step aborts the job: it prints the error,
  exits 1 and changes nothing.

Each change in the spaces is a replicated write (log rows and tombstones),
so readers' replicas drop the deleted items and see the channels frozen on
their next pull.

## Why the server must be stopped

The server caches records in memory (`SqliteStore`). A second process
writing to the same database would leave that cache stale: the server would
keep serving the deleted text, a channel the job froze would still take
posts, and the server could write a cached record back over the job's
change. Two processes must never write the same SQLite file
(`reset-database.md` §1).

The job checks it. A running server writes a heartbeat row
(`server_heartbeat` in `server_meta`) at boot and every 30 seconds, and
deletes it at the end of its shutdown. The job refuses while the heartbeat
is under 90 seconds old:

```text
The account-deletion job needs the server stopped: a server (pid 7) wrote its heartbeat 12 s ago. ...
```

After `fly scale count 0` the shutdown deletes the row and the job runs at
once. A server that was killed (out of memory, a host failure) leaves the
row; the job runs 90 seconds after its last heartbeat.

## Steps

1. Find the handle. The invite tree (`/invites`) shows who invited the
   account.
2. Stop the application:

   ```sh
   fly scale count 0 -a <app>
   ```

3. Start a shell on a machine with the volume attached and the entrypoint
   overridden, as in `restore.md` §2. The runtime image holds only the
   built server; `npm run db:admin` needs the sources and dev dependencies
   of the `build` stage of `web/Dockerfile`, built from the deployed commit
   and pushed to the app's registry:

   ```sh
   docker build --target build -t registry.fly.io/<app>:ops-<commit> web
   docker push registry.fly.io/<app>:ops-<commit>
   fly machine run --shell -a <app> --volume session_data:/data registry.fly.io/<app>:ops-<commit>
   # inside:
   cd /app && SESSION_DATA_DIR=/data npm run db:admin -- --delete <handle>
   ```

   The command prints what it did, for example:

   ```text
   deleted the sign-in identity of @someone; 2 session(s) ended, 1 open invite(s) revoked; 14 item(s) deleted, 3 record(s) no longer naming them, 9 record(s) removed, frozen: #their-channel; the handle stays reserved
   ```

4. Leave the shell (the machine is destroyed) and start the application:

   ```sh
   fly scale count 1 -a <app>
   ```

   Litestream replicates the changed database from the first write after
   it starts.
5. Check: signed out, open a channel the person owned; it shows the banner
   "#name is frozen: its owner's account is not active. You can read it and
   delete your own posts." and "Channel by Deleted account".

## Deleting a frozen channel

A deleted owner's channels stay frozen and readable indefinitely; no job
deletes them (`04` §4.5, question 11). The channel-deletion operator job is
the site admins' other action on a channel and is not part of this runbook.
