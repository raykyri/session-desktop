// The M3 load check (`05-delivery.md` M3; `runbooks/load-check.md`): 200
// event-stream clients and 20 writes a second for 10 minutes against one
// server, measuring
//
// - apply: the round trip of `POST /api/sync/apply`, one envelope each;
// - pull: the round trip of `GET /api/sync/pull`, 20 a second from random
//   clients on a log they read;
// - delivery: from the moment a write's answer arrives to the moment its
//   `changes` event reaches each stream that reads the space;
// - the server's resident memory every 10 s (a spawned server's, or the pid
//   given with `--pid`);
// - the size of a `window` snapshot of a space at the web window's cap (`01`
//   R1: 500 full threads), made before the run.
//
// Usage, from `web/packages/server`:
//
//   npx tsx scripts/load.ts                      # spawns a server on a temp database
//   npx tsx scripts/load.ts --minutes 3          # a shorter run
//   npx tsx scripts/load.ts --url https://staging.example --minutes 10
//
// A spawned server runs with `NODE_ENV=test`: `/auth/test-login` makes the
// accounts, the test routes write run answers for the snapshot's threads,
// and the transport limits are raised so that the load is not refused.
// Against `--url`, the server must have `SESSION_TEST_AUTH=1` and
// `NODE_ENV=test` (the staging procedure in the runbook) and the limits
// raised the same way.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PROTOCOL_VERSION, ulid, type ApplyResult, type Envelope } from "@session/sync/server";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string" },
    minutes: { type: "string", default: "10" },
    clients: { type: "string", default: "200" },
    rate: { type: "string", default: "20" },
    "pull-rate": { type: "string", default: "20" },
    spaces: { type: "string", default: "10" },
    "window-threads": { type: "string", default: "520" },
    pid: { type: "string" },
    json: { type: "string" },
  },
});

const MINUTES = Number(opt.minutes);
const CLIENTS = Number(opt.clients);
const RATE = Number(opt.rate);
const PULL_RATE = Number(opt["pull-rate"]);
const SPACES = Number(opt.spaces);
const WINDOW_THREADS = Number(opt["window-threads"]);
const MODEL = { model: "claude-fable", effort: "medium" } as const;
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const id = () => ulid(Date.now(), Math.random);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the server ----

let origin = opt.url ?? "";
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
  const big = String(1_000_000_000);
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: PACKAGE,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      SESSION_PUBLIC_ORIGIN: origin,
      SESSION_DATA_DIR: dataDir,
      SESSION_TEST_AUTH: "1",
      SESSION_LIMIT_WRITES_PER_MINUTE: big,
      SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: big,
      SESSION_LIMIT_REGISTER_PER_MINUTE: big,
      SESSION_LIMIT_AUTH_PER_MINUTE: big,
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

function rssOf(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
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

  async write(name: string, input: unknown): Promise<ApplyResult> {
    const res = await this.post("/api/sync/apply", { envelopes: [this.envelope(name, input)] });
    const a = ((await res.json()) as { answers?: ApplyResult[] }).answers?.[0];
    if (!a) throw new Error(`apply: ${res.status}`);
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

class Series {
  readonly values: number[] = [];
  errors = 0;
  add(v: number) {
    this.values.push(v);
  }
  summary() {
    const v = [...this.values].sort((a, b) => a - b);
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0;
    const r = (x: number) => Math.round(x * 10) / 10;
    return {
      n: v.length,
      errors: this.errors,
      p50: r(q(0.5)),
      p95: r(q(0.95)),
      p99: r(q(0.99)),
      max: r(v.at(-1) ?? 0),
    };
  }
}

/** A stream reader: records when each marked write's event arrives. */
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

async function main() {
  if (!origin) await startServer();
  const pid = child?.pid ?? (opt.pid ? Number(opt.pid) : null);
  const started = Date.now();
  console.log(`server ${origin}${pid ? ` (pid ${pid})` : ""}`);

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
  const testRoutes = !opt.url || process.env["SESSION_LOAD_TEST_ROUTES"] === "1";
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
  const apply = new Series();
  const pull = new Series();
  const delivery = new Series();
  const rss: { s: number; mb: number }[] = [];
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
          if (t !== undefined) delivery.add(at - t);
        }
      },
      stop.signal,
    ).catch((e: unknown) => {
      if (!stop.signal.aborted) console.error("stream ended:", e);
    }),
  );
  await sleep(2000);
  const runStarted = Date.now();
  const end = runStarted + MINUTES * 60_000;
  const sample = () => {
    if (pid === null) return;
    const v = rssOf(pid);
    if (v !== null)
      rss.push({ s: Math.round((Date.now() - runStarted) / 1000), mb: Math.round(v / 1e5) / 10 });
  };
  sample();
  const sampler = setInterval(sample, 10_000);
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
    const t0 = performance.now();
    try {
      const res = await a.write(name, input);
      const t1 = performance.now();
      apply.add(t1 - t0);
      if (!res.ok) {
        apply.errors += 1;
        refusals.set(res.error.code, (refusals.get(res.error.code) ?? 0) + 1);
      } else {
        sentAt.set(mark, t1);
        if (name === "threads.create") list.push(mark);
      }
    } catch {
      apply.errors += 1;
    } finally {
      inFlight -= 1;
    }
  };
  const onePull = async () => {
    const a = accounts[Math.floor(Math.random() * accounts.length)] ?? owner;
    const logs = [...a.cursors.keys()];
    const log = logs[Math.floor(Math.random() * logs.length)] ?? "";
    const q = new URLSearchParams({ log, cursor: a.cursors.get(log) ?? "", clientId: a.clientId });
    const t0 = performance.now();
    try {
      const res = await fetch(`${origin}/api/sync/pull?${q.toString()}`, { headers: a.headers() });
      const p = (await res.json()) as { cursor?: string; resync?: boolean };
      pull.add(performance.now() - t0);
      if (p.cursor) a.cursors.set(log, p.cursor);
      // a resync (the setup's joins after a user log's snapshot): take a
      // snapshot, as a client does
      if (p.resync) {
        resyncs += 1;
        a.cursors.set(log, (await a.snapshot(log)).cursor);
      }
    } catch {
      pull.errors += 1;
    }
  };
  // open-loop schedules: a write every 1/RATE s and a pull every 1/PULL_RATE s
  const tick = (rate: number, fn: () => Promise<void>) =>
    (async () => {
      for (let next = Date.now(); next < end; next += 1000 / rate) {
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
        void fn();
      }
    })();
  let lastLog = Date.now();
  const progress = setInterval(() => {
    const s = Math.round((Date.now() - runStarted) / 1000);
    console.log(
      `${s} s: ${apply.values.length} writes (p95 ${apply.summary().p95} ms), ${pull.values.length} pulls (p95 ${pull.summary().p95} ms), ${events} events, rss ${rss.at(-1)?.mb ?? "?"} MB, in flight ${inFlight}`,
    );
    lastLog = Date.now();
  }, 30_000);
  await Promise.all([tick(RATE, oneWrite), tick(PULL_RATE, onePull)]);
  while (inFlight > 0) await sleep(50);
  await sleep(1000);
  void lastLog;
  clearInterval(progress);
  clearInterval(sampler);
  sample();
  stop.abort();
  await Promise.all(streams);

  const firstMinute = rss.filter((x) => x.s <= 60).at(-1)?.mb ?? null;
  const report = {
    origin,
    minutes: MINUTES,
    clients: CLIENTS,
    writesPerSecond: RATE,
    pullsPerSecond: PULL_RATE,
    apply: apply.summary(),
    applyRefusals: Object.fromEntries(refusals),
    pull: pull.summary(),
    pullResyncs: resyncs,
    delivery: delivery.summary(),
    events,
    windowSnapshot: {
      threads: WINDOW_THREADS,
      bytes: win.bytes,
      ms: Math.round(win.ms),
      fullBytes: full.bytes,
      answers: testRoutes,
    },
    rss,
    rssAfterFirstMinuteMb: firstMinute,
    rssEndMb: rss.at(-1)?.mb ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (opt.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(opt.json, JSON.stringify(report, null, 2));
  }
}

try {
  await main();
} finally {
  const started = child as ChildProcess | null;
  if (started) {
    started.kill("SIGTERM");
    await new Promise((r) => started.once("exit", r));
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}
