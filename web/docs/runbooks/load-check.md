# Load check of the sync server

The M3 load check (`15-implementation-plan/05-delivery.md` M3): 200 event
stream clients and 20 writes a second for 30 minutes against one server, on
the production machine size (`shared-cpu-2x`, 2 GB). It passes with apply
p95 under 50 ms, pull p95 under 100 ms and memory flat after the first
minute, and it records the snapshot size of a space at the web window's cap
(`01` R1: 500 full threads); above 5 MB the window settings
(`SESSION_WEB_WINDOW_*`) are lowered.

The script is `web/packages/server/scripts/load.ts`. It measures, from the
client side:

- `apply`: from the send of `POST /api/sync/apply` (one envelope) to its
  answer, at `--rate` writes a second (posts, replies and saves in 10 open
  channels);
- `pull`: the reads clients make, `--pull-rate` a second from random
  clients: `POST /api/sync/read` of every log the client reads, with its
  cursors and client id (70 %); a `threads` read of one thread, as opening
  a thread does (20 %); `GET /api/sync/pull` of one log (10 %). A resync
  takes a snapshot, as a client does, and is counted apart;
- `delivery`: from the send of a write to its `changes` event on each stream
  that reads the channel (it includes the stream's 100 ms batching);
- `windowSnapshotsUnderLoad`: a `window` snapshot of a client's channel,
  `--snapshot-rate` a second;
- `reconnectStorm`: half way through, every client takes a `window`
  snapshot at once, as after a deploy;
- `memory`: every 10 s, through `/metrics?gc=1` (`session_process_memory_bytes`):
  the heap after garbage collection, the memory outside the heap
  (`external`: buffers and sockets) and the resident set. The server is
  started with `--expose-gc`; without it `?gc=1` does nothing;
- `generatorLag`: the load generator's own event-loop delay, per minute;
- `windowSnapshot`: the bytes of a `window` snapshot of a channel with
  `--window-threads` threads (520 by default, so the window is at its cap of
  500), read by a member who wrote none of them. Half are asks with their
  answer and one branch with its answer (about 1.5 KB of Markdown each), half
  posts with three replies.

Every latency is reported for the whole run and per minute (p50, p95, p99,
max). The report ends with a verdict against these thresholds
(`THRESHOLDS` in the script), and the script exits 1 on a failed check:

| Check | Limit |
|---|---|
| apply p95 | under 50 ms |
| pull p95 | under 100 ms |
| heap after GC, least-squares slope from minute 1 | at most 0.5 MB a minute |
| resident set, least-squares slope from a minute after the reconnect storm | at most 1 MB a minute |
| window snapshot at the cap | at most 5 MB |

The storm raises the resident set to a new plateau once (200 window
snapshots at once), which V8 keeps rather than hands back; the check is on
the slope after it, and the report gives the slope before it too. The run
is reported `INCONCLUSIVE` instead when the generator's event-loop
delay p99 exceeds 50 ms in any minute: the latencies are then the
generator's as much as the server's. It prints progress every 30 s and a
JSON report at the end (`--json <file>` writes it too).

## Locally

From `web/packages/server`:

```sh
npx tsx scripts/load.ts                    # 30 minutes, a server on a temp database, under tsx
npm run build && npx tsx scripts/load.ts --bundle   # the production bundle, dist/server.mjs
npx tsx scripts/load.ts --minutes 10       # shorter
```

The script starts the server itself on a temp data directory and a
loopback origin, with `NODE_ENV=test`, `SESSION_TEST_AUTH=1`,
`SESSION_TEST_ROUTES=1`, a metrics token and the transport limits raised, so
the load is not refused by the limits of `04` Z1 and `01` A3. Accounts are
made with `/auth/test-login`; the run answers of the window's asks are
written with the test route `/api/sync/test/finish`. The load generator runs
in the same machine as the server, so a local run measures both on shared
cores; the generator's lag says how much that mattered.

## On the production machine size

The check needs accounts and run answers that only a test server makes:
`SESSION_TEST_AUTH` is refused in production and `SESSION_TEST_ROUTES` is
refused outside `NODE_ENV=test` and a loopback origin. The deployed staging
app keeps `NODE_ENV=production`. The check runs a second server process from
the same image on a staging machine, on a scratch data directory and a
loopback port, so it measures the production bundle on the production
machine size without changing the deployed app's configuration or data.

1. Build the load script into one file on a workstation, from
   `web/packages/server`:

   ```sh
   npx esbuild scripts/load.ts --bundle --platform=node --format=esm --target=node22 \
     --alias:@session/sync/server=../sync/src/server/index.ts \
     --alias:@session/mutators=../mutators/src/index.ts \
     --alias:@session/shared=../shared/src --outfile=/tmp/load.mjs
   ```

2. Copy it to a staging machine and run it there against a server it
   starts from the image's bundle:

   ```sh
   fly ssh sftp shell -a session-staging   # put /tmp/load.mjs /tmp/load.mjs
   fly ssh console -a session-staging
   # inside:
   cd /app/packages/server
   node /tmp/load.mjs --bundle --minutes 30 --json /tmp/load.json
   ```

   `--bundle` starts `node --expose-gc dist/server.mjs` with the test
   switches above on a temp directory under `/tmp` and a free loopback port;
   the deployed server on port 8080 is not touched, and both share the
   machine's two cores, as a deployed server shares them with its own
   Litestream. Stop the deployed app's machine first (`fly machine stop`)
   for a measurement of the server alone.

3. Record the report (the verdict, the apply, pull, delivery and snapshot
   percentiles per minute, the memory series and its slopes, the reconnect
   storm, the window snapshot's bytes) in the M3 notes.

4. Delete `/tmp/load.json`, `/tmp/load.mjs` and the scratch directory
   (`/tmp/session-load-*`, which the script removes itself unless it was
   killed).

Against a server it did not start (`--url`), the script needs that server's
metrics token (`--metrics-token`) for the memory samples, and the server
must run with the same test switches, which only a local test server can.

## Options

| Option | Default | |
|---|---|---|
| `--url` | none: start a server | the server's origin |
| `--bundle` | off | start `dist/server.mjs` instead of `src/index.ts` under tsx |
| `--minutes` | 30 | length of the measured run |
| `--clients` | 200 | accounts, each with one client id and one event stream |
| `--rate` | 20 | writes a second |
| `--pull-rate` | 20 | reads a second |
| `--snapshot-rate` | 1 | window snapshots a second |
| `--spaces` | 10 | open channels the load writes to; each account reads three |
| `--window-threads` | 520 | threads of the window snapshot's channel |
| `--metrics-token` | the started server's | the bearer token of `/metrics` |
| `--json` | none | also write the report to this file |
