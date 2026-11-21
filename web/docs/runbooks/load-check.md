# Load check of the sync server

The M3 load check (`15-implementation-plan/05-delivery.md` M3): 200 event
stream clients and 20 writes a second for 10 minutes against one server, on
the production machine size (`shared-cpu-2x`, 2 GB). It passes with apply
p95 under 50 ms, pull p95 under 100 ms and resident memory flat after the
first minute, and it records the snapshot size of a space at the web
window's cap (`01` R1: 500 full threads); above 5 MB the window settings
(`SESSION_WEB_WINDOW_*`) are lowered before M4's end-to-end work.

The script is `web/packages/server/scripts/load.ts`. It measures, from the
client side:

- `apply`: the round trip of `POST /api/sync/apply`, one envelope each, at
  `--rate` writes a second (posts, replies and saves in 10 open channels);
- `pull`: the round trip of `GET /api/sync/pull`, `--pull-rate` a second,
  from random clients on a log they read (a resync takes a snapshot, as a
  client does, and is counted apart);
- `delivery`: from a write's answer to its `changes` event on each stream
  that reads the channel (it includes the stream's 100 ms batching);
- `rss`: the server's resident memory every 10 s, read from
  `/proc/<pid>/status` (a server the script started, or `--pid`);
- `windowSnapshot`: the bytes of a `window` snapshot of a channel with
  `--window-threads` threads (520 by default, so the window is at its cap of
  500), read by a member who wrote none of them. Half are asks with their
  answer and one branch with its answer (about 1.5 KB of Markdown each), half
  posts with three replies.

It prints progress every 30 s and a JSON report at the end (`--json <file>`
writes it too).

## Locally

From `web/packages/server`:

```sh
npx tsx scripts/load.ts                # 10 minutes, a server on a temp database
npx tsx scripts/load.ts --minutes 3    # shorter
```

The script starts the server itself (`src/index.ts` under tsx) with
`NODE_ENV=test`, `SESSION_TEST_AUTH=1` and the transport limits raised, so
the load is not refused by the limits of `04` Z1 and `01` A3. Accounts are
made with `/auth/test-login`; the run answers of the window's asks are
written with the test route `/api/sync/test/finish`. The load generator runs
in the same machine as the server, so a local run measures both on shared
cores.

## On staging

Staging runs the production image on the production machine size
(`05` §3.2). The check needs accounts and run answers that only a test
server makes, so it runs against a staging deploy started for it, and the
database is reset afterwards.

While `NODE_ENV=test` is set, the server mounts the acceptance suite's test
routes (`/api/sync/test/*`, unauthenticated, one of them a dump of every
table) and the test sign-in. Staging holds no real data, but keep the window
short and never set these on production (`loadConfig` refuses the test
sign-in there; the test routes follow `NODE_ENV`).

1. Deploy the build to staging with the test switches for the check:

   ```sh
   fly secrets set -a session-staging --stage \
     NODE_ENV=test SESSION_TEST_AUTH=1 \
     SESSION_LIMIT_WRITES_PER_MINUTE=1000000000 \
     SESSION_LIMIT_SNAPSHOTS_PER_MINUTE=1000000000 \
     SESSION_LIMIT_REGISTER_PER_MINUTE=1000000000 \
     SESSION_LIMIT_AUTH_PER_MINUTE=1000000000
   fly deploy -a session-staging
   ```

2. Run the script on the staging machine, so that the latency measured is the
   server's and not the network's, with the server's pid for the memory
   samples:

   ```sh
   fly ssh console -a session-staging
   # inside:
   cd /app/packages/server
   pid=$(pgrep -f 'node .*server.mjs' | head -1)
   npx tsx scripts/load.ts --url http://127.0.0.1:8080 --pid "$pid" --minutes 10 --json /tmp/load.json
   ```

   The image has no `tsx` and no sources: copy `scripts/load.ts` and run it
   with a Node that has `tsx` (`npm i -g tsx` in the machine's shell), or run
   it from a workstation against the staging URL (`--url
   https://session-staging.fly.dev`, without `--pid`; read memory from
   `fly machine status` and `/metrics` instead) and note that the latencies
   include the network round trip.

3. Record the report (apply, pull and delivery percentiles, the memory
   series, the window snapshot's bytes) in the M3 notes.

4. Remove the test switches and reset the database
   (`runbooks/reset-database.md`):

   ```sh
   fly secrets unset -a session-staging NODE_ENV SESSION_TEST_AUTH \
     SESSION_LIMIT_WRITES_PER_MINUTE SESSION_LIMIT_SNAPSHOTS_PER_MINUTE \
     SESSION_LIMIT_REGISTER_PER_MINUTE SESSION_LIMIT_AUTH_PER_MINUTE
   ```

## Options

| Option | Default | |
|---|---|---|
| `--url` | none: start a server | the server's origin |
| `--minutes` | 10 | length of the measured run |
| `--clients` | 200 | accounts, each with one client id and one event stream |
| `--rate` | 20 | writes a second |
| `--pull-rate` | 20 | pulls a second |
| `--spaces` | 10 | open channels the load writes to; each account reads three |
| `--window-threads` | 520 | threads of the window snapshot's channel |
| `--pid` | the started server | the process whose memory is sampled |
| `--json` | none | also write the report to this file |
