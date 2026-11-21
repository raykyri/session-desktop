// The M3 load check (`05-delivery.md` M3; `runbooks/load-check.md`): 200
// event-stream clients and 20 writes a second for 30 minutes against one
// server, measuring
//
// - apply: from the send of `POST /api/sync/apply` (one envelope) to its
//   answer;
// - pull: the reads a client makes: `POST /api/sync/read` of every log it
//   reads with its cursors (70 %), a `threads` read of one thread, as an
//   opened thread is (20 %), and `GET /api/sync/pull` of one log (10 %);
// - delivery: from the send of a write to its `changes` event on each
//   stream that reads the space (it includes the stream's 100 ms batching);
// - window snapshots under load, one a second, and a reconnect storm half
//   way through: every client takes a `window` snapshot of its space at
//   once;
// - the server's memory every 10 s through `/metrics?gc=1`: the heap after
//   garbage collection, the memory outside the heap, and the resident set;
// - the generator's own event-loop delay, so that a slow generator is not
//   taken for a slow server;
// - the size of a `window` snapshot of a space at the web window's cap (`01`
//   R1: 500 full threads), made before the run.
//
// Each latency is reported for the whole run and per minute (p50, p95, p99),
// and the report ends with a verdict against the plan's thresholds
// (`THRESHOLDS`). The script exits 1 when a check fails.
//
// Usage, from `web/packages/server`:
//
//   npx tsx scripts/load.ts                      # a server on a temp database, under tsx
//   npx tsx scripts/load.ts --bundle             # the production bundle (`npm run build` first)
//   npx tsx scripts/load.ts --minutes 10         # a shorter run
//   npx tsx scripts/load.ts --url http://127.0.0.1:8080 --metrics-token T
//
// A started server (either kind) runs with `NODE_ENV=test`,
// `SESSION_TEST_AUTH=1`, `SESSION_TEST_ROUTES=1`, a loopback origin, the
// transport limits raised, a metrics token, and `--expose-gc` for the heap
// samples. A server given with `--url` must have the same switches.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PROTOCOL_VERSION, ulid, type ApplyResult, type Envelope } from "@session/sync/server";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string" },
    bundle: { type: "boolean", default: false },
    minutes: { type: "string", default: "30" },
    clients: { type: "string", default: "200" },
    rate: { type: "string", default: "20" },
    "pull-rate": { type: "string", default: "20" },
    "snapshot-rate": { type: "string", default: "1" },
    spaces: { type: "string", default: "10" },
    "window-threads": { type: "string", default: "520" },
    "metrics-token": { type: "string" },
    json: { type: "string" },
  },
});

const MINUTES = Number(opt.minutes);
const CLIENTS = Number(opt.clients);
const RATE = Number(opt.rate);
const PULL_RATE = Number(opt["pull-rate"]);
const SNAPSHOT_RATE = Number(opt["snapshot-rate"]);
const SPACES = Number(opt.spaces);
const WINDOW_THREADS = Number(opt["window-threads"]);
const MODEL = { model: "claude-fable", effort: "medium" } as const;
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** The plan's thresholds (`05-delivery.md` M3, `01` R1). */
export const THRESHOLDS = {
  applyP95Ms: 50,
  pullP95Ms: 100,
  /** "Memory flat after the first minute": the least-squares slopes of the
   * heap after GC from minute 1 on, and of the resident set from a minute
   * after the reconnect storm on (the storm raises the resident set to a new
   * plateau, which V8 does not hand back; a leak is a slope, not a step). */
  heapSlopeMbPerMinute: 0.5,
  rssSlopeMbPerMinute: 1,
  windowSnapshotBytes: 5_000_000,
  /** Above this the generator itself lagged, and the latencies are not the
   * server's: the run is inconclusive. */
  generatorLagP99Ms: 50,
} as const;

const id = () => ulid(Date.now(), Math.random);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the server ----

let origin = opt.url ?? "";
let metricsToken = opt["metrics-token"] ?? "";
let child: ChildProcess | null = null;
let dataDir: string | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<void> {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "session-load-"));
  origin = `http://127.0.0.1:${port}`;
  metricsToken = randomBytes(16).toString("hex");
  const big = String(1_000_000_000);
  // the bundle of the package the script is run from (`web/packages/server`,
  // or `/app/packages/server` in the image), so a bundled copy of this
  // script finds it too
  const bundle = join(process.cwd(), "dist", "server.mjs");
  if (opt.bundle && !existsSync(bundle))
    throw new Error(`no ${bundle}: run npm run build --workspace @session/server first`);
  const args = opt.bundle
    ? ["--expose-gc", bundle]
    : ["--expose-gc", "--import", "tsx", "src/index.ts"];
  child = spawn(process.execPath, args, {
    cwd: opt.bundle ? process.cwd() : PACKAGE,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SESSION_PUBLIC_ORIGIN: origin,
      SESSION_DATA_DIR: dataDir,
      SESSION_TEST_AUTH: "1",
      SESSION_TEST_ROUTES: "1",
      SESSION_METRICS_TOKEN: metricsToken,
      SESSION_LIMIT_WRITES_PER_MINUTE: big,
      SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: big,
      SESSION_LIMIT_THREAD_READS_PER_MINUTE: big,
      SESSION_LIMIT_REGISTER_PER_MINUTE: big,
      SESSION_LIMIT_AUTH_PER_MINUTE: big,
      SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: big,
      TSX_TSCONFIG_PATH: "tsconfig.json",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let k = 0; k < 300; k++) {
    try {
      if ((await fetch(`${origin}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error("the server did not start");
}

/** The server's memory from `/metrics?gc=1`, in bytes, or null. */
async function memoryOf(): Promise<{ heap: number; external: number; rss: number } | null> {
  if (!metricsToken) return null;
  try {
    const res = await fetch(`${origin}/metrics?gc=1`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    const text = await res.text();
    const kind = (k: string) =>
      Number(new RegExp(`session_process_memory_bytes\\{kind="${k}"\\} (\\d+)`).exec(text)?.[1]);
    const out = { heap: kind("heap_used"), external: kind("external"), rss: kind("rss") };
    return Number.isFinite(out.heap) ? out : null;
  } catch {
    return null;
  }
}

// ---- accounts and requests ----

const HEADERS = {
  "X-Requested-With": "session",
  "Session-Protocol": String(PROTOCOL_VERSION),
  "Content-Type": "application/json",
};

class Account {
  cookie = "";
  clientId = "";
  seq = 0;
  handle = "";
  /** The logs this account's stream reads, with their cursors. */
  readonly cursors = new Map<string, string>();

  constructor(readonly login: string) {}

  headers(): Record<string, string> {
    return { ...HEADERS, Origin: origin, Cookie: `session=${this.cookie}` };
  }

  async signIn(): Promise<void> {
    const res = await fetch(`${origin}/auth/test-login`, {
      method: "POST",
      headers: { ...HEADERS, Origin: origin },
      body: JSON.stringify({ login: this.login }),
    });
    if (!res.ok) throw new Error(`test-login: ${res.status} ${await res.text()}`);
    const cookie = /session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!cookie) throw new Error("no session cookie");
    this.cookie = cookie;
    this.handle = ((await res.json()) as { handle: string }).handle;
    const reg = await this.post("/api/sync/register", {});
    const r = (await reg.json()) as { ok: boolean; clientId: string };
    if (!r.ok) throw new Error(`register: ${JSON.stringify(r)}`);
    this.clientId = r.clientId;
  }

  post(path: string, body: unknown): Promise<Response> {
    return fetch(`${origin}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  envelope(name: string, input: unknown): Envelope {
    const now = Date.now();
    return {
      clientId: this.clientId,
      seq: ++this.seq,
      mutationId: id(),
      name,
      input,
      protocolVersion: PROTOCOL_VERSION,
      clientTime: now,
      queuedAt: now,
    };
  }

  /** The account's writes are sent one after another, as a client's outbox
   * sends them, so that two of them never race on the seq. */
  private writes: Promise<unknown> = Promise.resolve();

  /** One write when the account's earlier ones are answered; `onSend` is
   * called as it is sent. */
  write(name: string, input: unknown, onSend?: () => void): Promise<ApplyResult> {
    const next = this.writes.then(() => {
      onSend?.();
      return this.send(name, input);
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async send(name: string, input: unknown): Promise<ApplyResult> {
    const res = await this.post("/api/sync/apply", { envelopes: [this.envelope(name, input)] });
    const a = ((await res.json()) as { answers?: ApplyResult[] }).answers?.[0];
    if (!a) {
      this.seq -= 1;
      throw new Error(`apply: ${res.status}`);
    }
    if (!a.ok && a.error.code === "OUT_OF_ORDER")
      this.seq = (a.error.expectedSeq ?? this.seq + 1) - 1;
    return a;
  }

  async ok(name: string, input: unknown): Promise<unknown> {
    const a = await this.write(name, input);
    if (!a.ok) throw new Error(`${name}: ${JSON.stringify(a.error)}`);
    return a.result;
  }

  async snapshot(
    log: string,
    tier?: string,
  ): Promise<{ bytes: number; ms: number; cursor: string }> {
    const t0 = performance.now();
    const res = await this.post("/api/sync/snapshot", {
      log,
      clientId: this.clientId,
      ...(tier ? { tier } : {}),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    return {
      bytes: Buffer.byteLength(text),
      ms,
      cursor: (JSON.parse(text) as { cursor: string }).cursor,
    };
  }
}

// ---- measurements ----

const round = (x: number) => Math.round(x * 10) / 10;

function percentiles(values: readonly number[]) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
  return {
    n: v.length,
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    p99: round(q(0.99)),
    max: round(v.at(-1) ?? 0),
  };
}

/** Latencies, for the whole run and by the minute of the run they began in. */
class Series {
  readonly values: number[] = [];
  readonly byMinute = new Map<number, number[]>();
  errors = 0;
  constructor(readonly start: () => number) {}
  add(ms: number, at = performance.now()) {
    this.values.push(ms);
    const minute = Math.max(0, Math.floor((at - this.start()) / 60_000));
    const list = this.byMinute.get(minute) ?? [];
    list.push(ms);
    this.byMinute.set(minute, list);
  }
  summary() {
    return {
      ...percentiles(this.values),
      errors: this.errors,
      perMinute: [...this.byMinute.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([minute, v]) => ({ minute, ...percentiles(v) })),
    };
  }
}

/** The least-squares slope of `y` over `x`. */
function slope(points: readonly { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

/** A stream reader: calls `onEvent` with each `changes` event's data. */
async function stream(
  a: Account,
  onEvent: (data: string, at: number) => void,
  stop: AbortSignal,
): Promise<void> {
  const res = await fetch(`${origin}/api/sync/events?clientId=${a.clientId}`, {
    headers: { ...a.headers(), "Session-Cursors": JSON.stringify(Object.fromEntries(a.cursors)) },
    signal: stop,
  });
  if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      for (let at = buf.indexOf("\n\n"); at >= 0; at = buf.indexOf("\n\n")) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (block.includes("event: changes")) {
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          onEvent(data, performance.now());
        }
      }
    }
  } catch (e) {
    if (!stop.aborted) throw e;
  }
}

async function main(): Promise<boolean> {
  if (!origin) await startServer();
  const started = Date.now();
  console.log(`server ${origin}${opt.bundle ? " (production bundle)" : ""}`);

  // ---- setup: spaces, members, and the window snapshot's space ----
  const owner = new Account(`load-owner-${started}`);
  await owner.signIn();
  const spaces: string[] = [];
  for (let k = 0; k < SPACES; k++) {
    const sp = id();
    await owner.ok("spaces.create", { id: sp, name: `load-${started.toString(36)}-${k}` });
    spaces.push(sp);
  }
  const accounts: Account[] = [];
  for (let k = 0; k < CLIENTS; k++) {
    const a = new Account(`load-${started}-${k}`);
    await a.signIn();
    // each account reads three spaces and its own user log
    for (let j = 0; j < 3; j++) {
      const sp = spaces[(k + j * 3) % SPACES] ?? "";
      if (!a.cursors.has(`space:${sp}`)) {
        await a.ok("spaces.join", { space: sp });
        a.cursors.set(`space:${sp}`, "");
      }
    }
    a.cursors.set(`user:${a.handle}`, "");
    for (const log of a.cursors.keys()) a.cursors.set(log, (await a.snapshot(log)).cursor);
    accounts.push(a);
  }
  console.log(
    `setup: ${SPACES} spaces, ${CLIENTS} accounts in ${Math.round((Date.now() - started) / 1000)} s`,
  );

  // a space at the web window's cap: 500 full threads (asks with an answer
  // and a branch with its answer, posts with replies)
  const big = id();
  await owner.ok("spaces.create", { id: big, name: `load-window-${started.toString(36)}` });
  const answer = "An answer with some length to it, as a run writes. ".repeat(30);
  const reply = "A reply of a few sentences, as members write them. ".repeat(6);
  const writer = accounts[0] ?? owner;
  await writer.ok("spaces.join", { space: big });
  const testRoutes = (await owner.post("/api/sync/test/finish", { key: "none", text: "" })).ok;
  for (let k = 0; k < WINDOW_THREADS; k++) {
    const th = id();
    if (k % 2 === 0) {
      await writer.ok("threads.create", {
        id: th,
        space: big,
        kind: "ask",
        q: `Question ${k}: why does the tide turn?`,
        ...MODEL,
      });
      if (testRoutes) {
        await owner.post("/api/sync/test/finish", { key: `thread:${th}`, text: answer });
        const node = id();
        await owner.ok("research.forkNode", {
          id: node,
          thread: th,
          parent: "r",
          kind: "ask",
          q: "And then?",
          ...MODEL,
        });
        await owner.post("/api/sync/test/finish", { key: `node:${node}`, text: answer });
      }
    } else {
      await writer.ok("threads.create", {
        id: th,
        space: big,
        kind: "post",
        q: `Post ${k}: a note for the channel.`,
      });
      for (let r = 0; r < 3; r++)
        await owner.ok("research.createPostFollowUp", { id: id(), thread: th, t: reply });
    }
  }
  // read by a member who wrote none of them: the window, not their own
  const reader = accounts[1] ?? owner;
  await reader.ok("spaces.join", { space: big });
  const win = await reader.snapshot(`space:${big}`, "window");
  const full = await reader.snapshot(`space:${big}`);
  console.log(
    `window snapshot of ${WINDOW_THREADS} threads (cap 500): ${(win.bytes / 1e6).toFixed(2)} MB in ${Math.round(win.ms)} ms; full: ${(full.bytes / 1e6).toFixed(2)} MB`,
  );

  // ---- the run ----
  const stop = new AbortController();
  let runStarted = performance.now();
  const since = () => runStarted;
  const apply = new Series(since);
  const pull = new Series(since);
  const delivery = new Series(since);
  const snapshots = new Series(since);
  const storm = new Series(since);
  const lag = monitorEventLoopDelay({ resolution: 10 });
  const lagByMinute: { minute: number; p50: number; p99: number; max: number }[] = [];
  const memory: { s: number; heapMb: number; externalMb: number; rssMb: number }[] = [];
  const sentAt = new Map<string, number>();
  let events = 0;
  let resyncs = 0;
  const refusals = new Map<string, number>();
  const streams = accounts.map((a) =>
    stream(
      a,
      (data, at) => {
        events += 1;
        for (const m of data.matchAll(/LOADMARK-([0-9A-Z]{26})/g)) {
          const t = sentAt.get(m[1] ?? "");
          if (t !== undefined) delivery.add(at - t, t);
        }
      },
      stop.signal,
    ).catch((e: unknown) => {
      if (!stop.signal.aborted) console.error("stream ended:", e);
    }),
  );
  await sleep(2000);
  runStarted = performance.now();
  const wallStarted = Date.now();
  const end = wallStarted + MINUTES * 60_000;
  lag.enable();
  const sample = async () => {
    const m = await memoryOf();
    if (m)
      memory.push({
        s: Math.round((Date.now() - wallStarted) / 1000),
        heapMb: round(m.heap / 1e6),
        externalMb: round(m.external / 1e6),
        rssMb: round(m.rss / 1e6),
      });
  };
  await sample();
  const sampler = setInterval(() => void sample(), 10_000);
  const lagSampler = setInterval(() => {
    lagByMinute.push({
      minute: lagByMinute.length,
      p50: round(lag.percentile(50) / 1e6),
      p99: round(lag.percentile(99) / 1e6),
      max: round(lag.max / 1e6),
    });
    lag.reset();
  }, 60_000);
  const threads = new Map<string, string[]>(spaces.map((s) => [s, []]));
  const writers = accounts.slice(0, 40);
  let inFlight = 0;
  const oneWrite = async () => {
    const a = writers[Math.floor(Math.random() * writers.length)] ?? owner;
    const sp =
      [...a.cursors.keys()].find((l) => l.startsWith("space:"))?.slice(6) ?? spaces[0] ?? "";
    const list = threads.get(sp) ?? [];
    const mark = id();
    const r = Math.random();
    const [name, input] =
      r < 0.4 || list.length === 0
        ? ["threads.create", { id: mark, space: sp, kind: "post", q: `LOADMARK-${mark} a post` }]
        : r < 0.8
          ? [
              "research.createPostFollowUp",
              {
                id: mark,
                thread: list[Math.floor(Math.random() * list.length)],
                t: `LOADMARK-${mark} a reply`,
              },
            ]
          : [
              "saved.set",
              {
                kind: "thread",
                id: list[Math.floor(Math.random() * list.length)],
                on: Math.random() < 0.5,
              },
            ];
    inFlight += 1;
    let t0 = performance.now();
    try {
      // apply and delivery are timed from the send
      const res = await a.write(name, input, () => {
        t0 = performance.now();
        sentAt.set(mark, t0);
      });
      apply.add(performance.now() - t0, t0);
      if (!res.ok) {
        sentAt.delete(mark);
        apply.errors += 1;
        refusals.set(res.error.code, (refusals.get(res.error.code) ?? 0) + 1);
      } else if (name === "threads.create") list.push(mark);
    } catch {
      sentAt.delete(mark);
      apply.errors += 1;
    } finally {
      inFlight -= 1;
    }
  };
  /** A client's read: every log it reads with its cursors (70 %), one
   * thread (20 %), or one log by `GET /pull` (10 %). */
  const onePull = async () => {
    const a = accounts[Math.floor(Math.random() * accounts.length)] ?? owner;
    const logs = [...a.cursors.keys()];
    const r = Math.random();
    const t0 = performance.now();
    try {
      if (r < 0.7) {
        const res = await a.post("/api/sync/read", {
          reads: logs.map((log) => ({ log, cursor: a.cursors.get(log) ?? "" })),
          clientId: a.clientId,
        });
        const body = (await res.json()) as { answers?: { cursor?: string; resync?: boolean }[] };
        pull.add(performance.now() - t0, t0);
        if (!body.answers) throw new Error(`read: ${res.status}`);
        for (const [k, p] of body.answers.entries()) {
          const log = logs[k] ?? "";
          if (p.cursor) a.cursors.set(log, p.cursor);
          if (p.resync) {
            resyncs += 1;
            a.cursors.set(log, (await a.snapshot(log)).cursor);
          }
        }
      } else if (r < 0.9) {
        const sp = logs.find((l) => l.startsWith("space:")) ?? "";
        const list = threads.get(sp.slice(6)) ?? [];
        const th = list[Math.floor(Math.random() * list.length)];
        if (!th) return;
        const res = await a.post("/api/sync/read", {
          reads: [{ log: sp, tier: "threads", threads: [th] }],
          clientId: a.clientId,
        });
        await res.text();
        if (!res.ok) throw new Error(`read: ${res.status}`);
        pull.add(performance.now() - t0, t0);
      } else {
        const log = logs[Math.floor(Math.random() * logs.length)] ?? "";
        const q = new URLSearchParams({
          log,
          cursor: a.cursors.get(log) ?? "",
          clientId: a.clientId,
        });
        const res = await fetch(`${origin}/api/sync/pull?${q.toString()}`, {
          headers: a.headers(),
        });
        const p = (await res.json()) as { cursor?: string; resync?: boolean };
        pull.add(performance.now() - t0, t0);
        if (p.cursor) a.cursors.set(log, p.cursor);
        if (p.resync) {
          resyncs += 1;
          a.cursors.set(log, (await a.snapshot(log)).cursor);
        }
      }
    } catch {
      pull.errors += 1;
    }
  };
  const oneSnapshot = async (series: Series, a: Account) => {
    const sp = [...a.cursors.keys()].find((l) => l.startsWith("space:")) ?? "";
    const t0 = performance.now();
    try {
      const s = await a.snapshot(sp, "window");
      series.add(s.ms, t0);
    } catch {
      series.errors += 1;
    }
  };
  // open-loop schedules: a write every 1/RATE s, a read every 1/PULL_RATE s
  // and a window snapshot every 1/SNAPSHOT_RATE s
  const tick = (rate: number, fn: () => Promise<void>) =>
    (async () => {
      for (let next = Date.now(); next < end; next += 1000 / rate) {
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        void fn();
      }
    })();
  // the reconnect storm: every client takes a window snapshot at once
  const stormAt = wallStarted + (MINUTES * 60_000) / 2;
  const stormed = (async () => {
    await sleep(Math.max(0, stormAt - Date.now()));
    const t0 = performance.now();
    await Promise.all(accounts.map((a) => oneSnapshot(storm, a)));
    return round(performance.now() - t0);
  })();
  const progress = setInterval(() => {
    const s = Math.round((Date.now() - wallStarted) / 1000);
    const m = memory.at(-1);
    console.log(
      `${s} s: ${apply.values.length} writes (p95 ${percentiles(apply.values).p95} ms), ${pull.values.length} reads (p95 ${percentiles(pull.values).p95} ms), ${events} events, heap ${m?.heapMb ?? "?"} MB, rss ${m?.rssMb ?? "?"} MB, in flight ${inFlight}`,
    );
  }, 30_000);
  await Promise.all([
    tick(RATE, oneWrite),
    tick(PULL_RATE, onePull),
    tick(SNAPSHOT_RATE, () =>
      oneSnapshot(snapshots, accounts[Math.floor(Math.random() * accounts.length)] ?? owner),
    ),
  ]);
  const stormMs = await stormed;
  while (inFlight > 0) await sleep(50);
  await sleep(1000);
  clearInterval(progress);
  clearInterval(sampler);
  clearInterval(lagSampler);
  lag.disable();
  await sample();
  stop.abort();
  await Promise.all(streams);

  // ---- the verdict ----
  const after = memory.filter((m) => m.s >= 60);
  const heapSlope = round(slope(after.map((m) => ({ x: m.s / 60, y: m.heapMb }))) * 100) / 100;
  const externalSlope =
    round(slope(after.map((m) => ({ x: m.s / 60, y: m.externalMb }))) * 100) / 100;
  const stormS = (stormAt - wallStarted) / 1000;
  const settled = memory.filter((m) => m.s >= stormS + 60);
  const rssSlope = round(slope(settled.map((m) => ({ x: m.s / 60, y: m.rssMb }))) * 100) / 100;
  const before = after.filter((m) => m.s < stormS);
  const rssBeforeStorm = round(slope(before.map((m) => ({ x: m.s / 60, y: m.rssMb }))) * 100) / 100;
  const applyS = apply.summary();
  const pullS = pull.summary();
  const generatorLagP99 = Math.max(0, ...lagByMinute.map((m) => m.p99));
  const checks = [
    {
      check: "apply p95",
      value: applyS.p95,
      limit: THRESHOLDS.applyP95Ms,
      pass: applyS.p95 < THRESHOLDS.applyP95Ms,
    },
    {
      check: "pull p95",
      value: pullS.p95,
      limit: THRESHOLDS.pullP95Ms,
      pass: pullS.p95 < THRESHOLDS.pullP95Ms,
    },
    {
      check: "heap after GC, slope from minute 1 (MB/min)",
      value: heapSlope,
      limit: THRESHOLDS.heapSlopeMbPerMinute,
      pass: memory.length > 2 && heapSlope <= THRESHOLDS.heapSlopeMbPerMinute,
    },
    {
      check: "resident set, slope from a minute after the storm (MB/min)",
      value: rssSlope,
      limit: THRESHOLDS.rssSlopeMbPerMinute,
      pass: settled.length > 2 && rssSlope <= THRESHOLDS.rssSlopeMbPerMinute,
    },
    {
      check: "window snapshot bytes",
      value: win.bytes,
      limit: THRESHOLDS.windowSnapshotBytes,
      pass: win.bytes <= THRESHOLDS.windowSnapshotBytes,
    },
  ];
  const conclusive = generatorLagP99 <= THRESHOLDS.generatorLagP99Ms;
  const pass = conclusive && checks.every((c) => c.pass);
  const report = {
    origin,
    bundle: opt.bundle,
    minutes: MINUTES,
    clients: CLIENTS,
    writesPerSecond: RATE,
    readsPerSecond: PULL_RATE,
    apply: applyS,
    applyRefusals: Object.fromEntries(refusals),
    pull: pullS,
    pullResyncs: resyncs,
    delivery: delivery.summary(),
    windowSnapshotsUnderLoad: snapshots.summary(),
    reconnectStorm: { clients: accounts.length, totalMs: stormMs, ...storm.summary() },
    events,
    windowSnapshot: {
      threads: WINDOW_THREADS,
      bytes: win.bytes,
      ms: Math.round(win.ms),
      fullBytes: full.bytes,
      answers: testRoutes,
    },
    memory,
    heapAfterGcSlopeMbPerMinute: heapSlope,
    rssSlopeMbPerMinute: { beforeStorm: rssBeforeStorm, afterStorm: rssSlope },
    externalSlopeMbPerMinute: externalSlope,
    generatorLag: { p99MaxMs: generatorLagP99, perMinute: lagByMinute },
    verdict: { pass, conclusive, checks },
  };
  console.log(JSON.stringify(report, null, 2));
  if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2));
  console.log(
    pass ? "PASS" : conclusive ? "FAIL" : "INCONCLUSIVE: the generator lagged",
    checks
      .map((c) => `${c.check}: ${String(c.value)} (limit ${c.limit}) ${c.pass ? "ok" : "over"}`)
      .join("; "),
  );
  return pass;
}

let passed = false;
try {
  passed = await main();
} finally {
  const started = child as ChildProcess | null;
  if (started) {
    started.kill("SIGTERM");
    await new Promise((r) => started.once("exit", r));
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
process.exitCode = passed ? 0 : 1;
