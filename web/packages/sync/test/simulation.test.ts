// Deterministic simulation: several clients and one server, a fake network
// (delay as late copies, loss of requests and of answers, duplication,
// reordering, disconnects), device clocks that are slow, fast, reset and
// days off, restarts from storage, random writes from honest clients and a
// hostile one, and the client's other paths: overlapping syncs and flushes,
// a write during a flush, Send again and discard, a tiered replica that
// hydrates threads, live updates, UPDATE_REQUIRED, WRONG_CLIENT, TOO_LARGE
// and writes dropped after days offline. Each seed runs `STEPS` random
// steps, then lets the system go quiet, and checks:
// - every replica's view (its open logs through the overlay) equals the
//   server's scope-filtered projection of its live logs; a tiered log holds
//   every record the server's tiered read serves, except under the threads
//   it holds as summaries, and nothing the server does not serve;
// - a frozen copy holds the user's own threads and what they wrote under
//   them, and nothing else the server would not serve them;
// - no write was applied twice (across retries, remints, replays and late
//   copies), and no two reads of one log were in flight at once;
// - every write ended applied, refused, expired, or failed or dropped and
//   shown; none is silently gone; every id an answered write's input made
//   exists on the server, and no write was refused for an input it changed
//   after sending it.
// CI runs 200 seeds × 200 steps and checks that they reach each path above;
// `npm run sim` runs 1,000. `SYNC_SIM_STATS=1` prints what each seed reached;
// `SYNC_SIM_ONLY=<seed>` runs one seed and prints its steps, with
// `SYNC_SIM_DEBUG=1` each write queued and each application no write claims.

import { MUTATORS, ulid, type LogId, type StoredRecord } from "@session/mutators";
import test from "ava";

import {
  InProcessTransport,
  MemoryStorage,
  Offline,
  SyncClient,
  type Answer,
  type Envelope,
  type ServerLike,
  type StorageAdapter,
  type TierOptions,
  type Transport,
} from "../src/client/index.js";
import { PROTOCOL_VERSION, openStream, type SyncServer } from "../src/server/index.js";

import { DAY, HOUR, MINUTE, World, rng } from "./helpers.js";

const SEEDS = Number(process.env["SYNC_SIM_SEEDS"] ?? 200);
const STEPS = Number(process.env["SYNC_SIM_STEPS"] ?? 200);
const GROUP = 10;

type Person = "olga" | "mona" | "mel" | "otto";

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: () => number, p: number) => r() < p;

/** What the simulation must reach over the CI run. */
const REACH = [
  "two syncs at once",
  "a pull while a flush is in flight",
  "a write during a flush",
  "Send again",
  "discard",
  "hydrate",
  "listen",
  "a poke",
  "a tiered snapshot",
  "UPDATE_REQUIRED",
  "WRONG_CLIENT",
  "TOO_LARGE",
  "a write dropped",
  "a frozen copy",
  "a remint",
  "a replayed answer",
] as const;
type Reach = (typeof REACH)[number];
const reached = new Map<string, number>();

interface Device {
  name: string;
  u: Person;
  storage: MemoryStorage;
  client: SyncClient;
  skew: number;
  down: boolean;
  logs: LogId[];
  tier: TierOptions;
  /** This version is below the server's minimum (UPDATE_REQUIRED). */
  old: boolean;
  /** The next write answers WRONG_CLIENT (the client record expired). */
  wrong: boolean;
  listening: AbortController | null;
  flushing: boolean;
  /** Reads of each log in flight. */
  reading: Map<LogId, number>;
  /** The process was replaced (a restart): it sends and stores nothing. */
  dead: boolean;
}

/** The storage as one process sees it: once the process is dead, its
 * writes are dropped (what it did not store before it died is lost). */
function processStorage(d: Device): StorageAdapter {
  const s = d.storage;
  const live =
    <A extends unknown[]>(f: (...a: A) => Promise<void>) =>
    (...a: A) =>
      d.dead ? Promise.resolve() : f(...a);
  return {
    persistent: true,
    loadMeta: () => s.loadMeta(),
    saveMeta: live((m) => s.saveMeta(m)),
    logs: () => s.logs(),
    loadLog: (l) => s.loadLog(l),
    saveLog: live((l, c) => s.saveLog(l, c)),
    dropLog: live((l) => s.dropLog(l)),
    loadOutbox: () => s.loadOutbox(),
    saveOutbox: live((e) => s.saveOutbox(e)),
    clear: live(() => s.clear()),
  };
}

interface Sim {
  r: () => number;
  w: World;
  open: string;
  closed: string;
  devices: Device[];
  /** Envelopes held by the network, delivered later (delay, reordering). */
  late: { u: Person; e: Envelope }[];
  /** Every mutation id an outbox entry had, by the entry's local id. */
  locals: Map<string, string>;
  /** Applications (ok, not replayed) by local id. */
  applied: Map<string, number>;
  /** The local ids of every write queued, and their answers. */
  writes: Map<string, { dev: Device; name: string; answer: Answer | null | undefined }>;
  /** The input of every write the client holds as answered ok. */
  answered: Map<string, { u: Person; name: string; input: unknown }>;
  /** What broke an invariant while the steps ran. */
  bad: string[];
  reach: Map<string, number>;
  log: string[];
}

const hit = (sim: Sim, what: Reach) => sim.reach.set(what, (sim.reach.get(what) ?? 0) + 1);

/** The server as a device reaches it: every application is counted, some
 * envelopes are copied for a late delivery, and the device's own state
 * (an old version, an expired client record) is answered. */
function serverFor(sim: Sim, d: Device): ServerLike {
  const s = sim.w.server;
  const u = d.u;
  const no = (code: "UPDATE_REQUIRED" | "WRONG_CLIENT") => ({
    ok: false as const,
    error: { code, message: code },
    serverTime: sim.w.clock.now(),
  });
  return {
    register: (a) => (d.old ? no("UPDATE_REQUIRED") : s.register(a)),
    apply: (a, e) => {
      if (d.old) {
        hit(sim, "UPDATE_REQUIRED");
        return no("UPDATE_REQUIRED");
      }
      if (d.wrong) {
        d.wrong = false;
        hit(sim, "WRONG_CLIENT");
        return no("WRONG_CLIENT");
      }
      const env = e as Envelope;
      const copy = structuredClone(env);
      const out = count(sim, s, a, env);
      if (!out.ok && out.error.code === "TOO_LARGE") hit(sim, "TOO_LARGE");
      if (out.replayed) hit(sim, "a replayed answer");
      // a copy the network delivers again later; often for a CLOCK_SKEW
      // answer, the case where a remint and the old envelope could both
      // apply (review round 2's remint finding)
      const skew = !out.ok && out.error.code === "CLOCK_SKEW";
      if (skew) hit(sim, "a remint");
      if (chance(sim.r, skew ? 0.5 : 0.06)) sim.late.push({ u, e: copy });
      return out;
    },
    snapshot: (a, l, o) => {
      if (d.old) return no("UPDATE_REQUIRED");
      if (o?.threads) hit(sim, "hydrate");
      else if (o?.tier && o.tier.window !== "full") hit(sim, "a tiered snapshot");
      return s.snapshot(a, l, o);
    },
    pull: (a, l, c, o) => (d.old ? no("UPDATE_REQUIRED") : s.pull(a, l, c, o)),
    call: (a, n, i) => s.call(a, n, i),
  };
}

function count(sim: Sim, s: SyncServer, a: { u: string } | null, e: Envelope): Answer {
  const out = s.apply(a, e);
  if (out.ok && !out.replayed) {
    // the entry that holds this mutation id now, or had it (it may have been
    // reminted within the flush that sent it: `replaces` lists it), or the
    // one that held it before
    let local = sim.locals.get(`${a?.u}:${e.mutationId}`);
    for (const d of sim.devices)
      if (d.u === a?.u)
        for (const x of d.client.outbox())
          if (x.mutationId === e.mutationId || x.replaces.includes(e.mutationId)) local = x.local;
    if (local !== undefined) sim.applied.set(local, (sim.applied.get(local) ?? 0) + 1);
    else if (process.env["SYNC_SIM_DEBUG"])
      sim.log.push(
        `  (applied ${e.name} ${e.mutationId} replaces ${e.replaces.join(",")}: no entry; ${sim.devices
          .filter((d) => d.u === a?.u)
          .map(
            (d) =>
              `${d.name}: ${d.client
                .outbox()
                .map((x) => `${x.local}/${x.mutationId}/${x.state}`)
                .join(" ")}`,
          )
          .join("; ")})`,
      );
  }
  return out;
}

/** The device's transport, watched: no two reads of one log in flight, and
 * whether a read overlaps a flush. */
function watch(sim: Sim, d: Device, inner: Transport): Transport {
  const dead = () => Promise.reject(new Offline("the process is gone"));
  const read = async <T>(log: LogId, f: () => Promise<T>): Promise<T> => {
    if (d.dead) return dead();
    const n = (d.reading.get(log) ?? 0) + 1;
    d.reading.set(log, n);
    if (n > 1) sim.bad.push(`${d.name}: two reads of ${log} in flight`);
    if (d.flushing) hit(sim, "a pull while a flush is in flight");
    try {
      return await f();
    } finally {
      d.reading.set(log, (d.reading.get(log) ?? 1) - 1);
    }
  };
  return {
    register: () => (d.dead ? dead() : inner.register()),
    push: (es) => (d.dead ? Promise.resolve([null]) : inner.push(es)),
    pull: (l, c, o) => read(l, () => inner.pull(l, c, o)),
    snapshot: (l, o) => read(l, () => inner.snapshot(l, o)),
    listen: (c, e, s) =>
      inner.listen(
        c,
        (ev, id) => {
          if (ev.type === "poke") hit(sim, "a poke");
          e(ev, id);
        },
        s,
      ),
    call: (n, i) => inner.call(n, i),
  };
}

function makeDevice(
  sim: Sim,
  name: string,
  u: Person,
  o: {
    storage?: MemoryStorage;
    skew?: number;
    logs?: LogId[];
    tier?: TierOptions;
    quiet?: boolean;
  } = {},
): Device {
  const d: Device = {
    name,
    u,
    storage: o.storage ?? new MemoryStorage(),
    client: undefined as unknown as SyncClient,
    skew: o.skew ?? 0,
    down: false,
    logs: o.logs ?? [],
    tier: o.tier ?? { window: "full" },
    old: false,
    wrong: false,
    listening: null,
    flushing: false,
    reading: new Map(),
    dead: false,
  };
  const net = {
    plan: () =>
      o.quiet
        ? {}
        : {
            lost: chance(sim.r, 0.05),
            answerLost: chance(sim.r, 0.05),
            duplicate: chance(sim.r, 0.03),
            delay: chance(sim.r, 0.3) ? 1 : 0,
          },
    wait: () => Promise.resolve(),
    down: () => d.down,
  };
  const transport = new InProcessTransport(
    serverFor(sim, d),
    { u },
    {
      net,
      stream: (a, c, s) =>
        openStream(sim.w.server, a, c, s, { setInterval: () => 0, clearInterval: () => {} }),
    },
  );
  d.client = new SyncClient({
    user: u,
    transport: watch(sim, d, transport),
    storage: processStorage(d),
    clock: { now: () => sim.w.clock.now() + d.skew },
    monotonic: () => sim.w.clock.now(),
    random: rng(Math.floor(sim.r() * 2 ** 31)),
    timer: null,
  });
  return d;
}

async function startDevice(d: Device) {
  await d.client.init();
  for (const l of d.logs) await d.client.open(l, l.startsWith("space:") ? d.tier : undefined);
}

/** Remember every mutation id each entry has had (they change on remint),
 * and the input of every write answered ok. */
function note(sim: Sim) {
  for (const d of sim.devices)
    for (const e of d.client.outbox()) {
      for (const m of [e.mutationId, ...e.replaces]) sim.locals.set(`${d.u}:${m}`, e.local);
      if (e.state === "answered")
        sim.answered.set(e.local, { u: d.u, name: e.name, input: e.input });
    }
}

/** A flush that the simulation sees in flight. */
async function flush(sim: Sim, d: Device) {
  d.flushing = true;
  try {
    await d.client.flush();
  } finally {
    d.flushing = false;
    note(sim);
  }
}

/** The client's view's rev of a record (what its UI puts in `base`). */
const revOf = (d: Device, key: string) => d.client.get(key)?.rev ?? 0;

function threadsOf(d: Device, sp: string): StoredRecord[] {
  return d.client.view().list("thread", (p) => p.s === sp && !p.del && p.mod === null);
}

/** A random honest write of `d`'s person. */
function honest(sim: Sim, d: Device): [string, unknown] | null {
  const r = sim.r;
  const c = d.client;
  const sp = d.u === "otto" || chance(r, 0.6) ? sim.open : sim.closed;
  const ths = threadsOf(d, sp);
  const th = ths.length ? pick(r, ths) : undefined;
  const roll = r();
  if (chance(r, 0.01))
    // too large for the server (TOO_LARGE): shown as failed
    return ["threads.create", { id: c.newId(), space: sp, kind: "post", q: "x".repeat(300_000) }];
  if (roll < 0.2 || !th)
    return [
      "threads.create",
      { id: c.newId(), space: sp, kind: pick(r, ["ask", "post"]), q: `q${Math.floor(r() * 1e6)}` },
    ];
  if (th.kind !== "thread") return null;
  if (roll < 0.35) return ["likes.set", { thread: th.id, on: chance(r, 0.7) }];
  if (roll < 0.45) return ["saved.set", { kind: "thread", id: th.id, on: chance(r, 0.7) }];
  if (roll < 0.55 && th.k === "ask")
    return ["followups.ask", { id: c.newId(), thread: th.id, q: `f${Math.floor(r() * 1e6)}` }];
  if (roll < 0.55)
    return [
      "research.createPostFollowUp",
      { id: c.newId(), thread: th.id, t: `r${Math.floor(r() * 1e6)}` },
    ];
  if (roll < 0.65 && th.u === d.u) {
    const seen = revOf(d, `thread:${th.id}`);
    return [
      "threads.update",
      {
        id: th.id,
        q: `e${Math.floor(r() * 1e6)}`,
        base: { rev: chance(r, 0.8) ? seen : Math.max(0, seen - 1) },
      },
    ];
  }
  if (roll < 0.72 && th.u === d.u) return ["threads.delete", { id: th.id }];
  if (roll < 0.8 && (d.u === "mona" || d.u === "olga")) {
    const hidden = c.get(`hide:thread:${th.id}`);
    return hidden
      ? [
          "moderation.decide",
          {
            item: `${th.k === "ask" ? "a" : "p"}:${th.id}`,
            decision: "shown",
            base: { rev: hidden.rev },
          },
        ]
      : [
          "moderation.decide",
          {
            item: `${th.k === "ask" ? "a" : "p"}:${th.id}`,
            decision: pick(r, ["hidden", "hidden", "removed"]),
          },
        ];
  }
  // scope changes: otto leaves and joins the open space; olga removes and
  // lets mel back into the closed one; mel leaves it now and then
  if (roll < 0.86 && d.u === "otto")
    return [chance(r, 0.5) ? "spaces.leave" : "spaces.join", { space: sim.open }];
  if (roll < 0.9 && d.u === "olga") {
    const m = c.get(`member:${sim.closed}:mel`);
    if (m?.kind === "member")
      return ["members.remove", { space: sim.closed, user: "mel", base: { adm: m.adm } }];
    const req = c.get(`request:${sim.closed}:mel`);
    if (req?.kind === "request" && req.st === "open")
      return [
        "joinRequests.decide",
        { space: sim.closed, users: ["mel"], decision: "approve", base: { mel: req.rev } },
      ];
  }
  if (roll < 0.91 && d.u === "mel" && c.get(`member:${sim.closed}:mel`))
    return ["spaces.leave", { space: sim.closed }];
  if (roll < 0.94 && d.u === "mel" && !c.get(`member:${sim.closed}:mel`))
    return ["joinRequests.create", { space: sim.closed, rulesAccepted: true }];
  return ["likes.set", { thread: th.id, on: chance(r, 0.5) }];
}

/** A hostile envelope: eve's, or someone's, with forged parts. */
function hostile(sim: Sim): string {
  const r = sim.r;
  const w = sim.w;
  const victim = pick(r, sim.devices);
  const theirs = victim.client.outbox()[0];
  const now = w.clock.now();
  const e: Envelope = {
    clientId: chance(r, 0.5) ? (victim.client.clientId ?? "x") : "made-up",
    seq: 1 + Math.floor(r() * 5),
    mutationId: theirs && chance(r, 0.5) ? theirs.mutationId : ulid(now, r),
    name: pick(r, ["threads.create", "likes.set", "members.setRole", "moderation.decide"]),
    input: chance(r, 0.5)
      ? { thread: theirs?.mutationId ?? "x", on: true }
      : { space: sim.closed, user: "eve", role: "owner", base: { rev: 0 } },
    protocolVersion: PROTOCOL_VERSION,
    clientTime: now + pick(r, [0, 0, 2 * MINUTE, -3 * DAY]),
    queuedAt: now,
    replaces: theirs && chance(r, 0.3) ? [theirs.mutationId] : [],
  };
  const who = chance(r, 0.7) ? "eve" : victim.u;
  const a = count(sim, w.server, { u: who }, e);
  return `hostile ${who} ${e.name}: ${a.ok ? "ok" : a.error.code}`;
}

/** Queue an honest write of `d` (sent or not), recording it. */
function queue(sim: Sim, d: Device, send: boolean): string | null {
  const wr = honest(sim, d);
  if (!wr) return null;
  const [name, input] = wr;
  const { local, answer } = d.client.write(name, input, { send });
  const rec: { dev: Device; name: string; answer: Answer | null | undefined } = {
    dev: d,
    name,
    answer: undefined,
  };
  sim.writes.set(local, rec);
  if (process.env["SYNC_SIM_DEBUG"]) sim.log.push(`  (queued ${name} ${local} on ${d.name})`);
  void answer.then((a) => {
    rec.answer = a;
    note(sim);
  });
  note(sim);
  return name;
}

async function step(sim: Sim, k: number): Promise<string> {
  const r = sim.r;
  const d = pick(r, sim.devices);
  const roll = r();
  if (roll < 0.3) {
    const name = queue(sim, d, false);
    if (!name) return "skip";
    await flush(sim, d);
    return `${d.name} ${name}`;
  }
  if (roll < 0.4) {
    await flush(sim, d);
    return `${d.name} flush`;
  }
  if (roll < 0.5) {
    await d.client.sync();
    return `${d.name} sync`;
  }
  if (roll < 0.55) {
    // overlapping: a flush, two syncs, and a write while they run
    const f = flush(sim, d);
    const s1 = d.client.sync();
    const s2 = d.client.sync(pick(r, d.logs));
    hit(sim, "two syncs at once");
    await Promise.resolve();
    if (d.flushing && queue(sim, d, true)) hit(sim, "a write during a flush");
    await Promise.all([f, s1, s2]);
    note(sim);
    return `${d.name} overlap`;
  }
  if (roll < 0.6 && sim.late.length) {
    // a late copy arrives, out of order
    const [x] = sim.late.splice(Math.floor(r() * sim.late.length), 1);
    if (x) {
      const a = count(
        sim,
        sim.w.server,
        { u: x.u },
        { ...x.e, clientTime: sim.w.clock.now() + d.skew },
      );
      return `late ${x.u} ${x.e.name}: ${a.ok ? (a.replayed ? "replay" : "ok") : a.error.code}`;
    }
  }
  if (roll < 0.65) {
    d.down = !d.down;
    return `${d.name} ${d.down ? "offline" : "online"}`;
  }
  if (roll < 0.7) {
    d.skew = pick(r, [0, 0, 20_000, -20_000, 2 * MINUTE, -2 * MINUTE, -HOUR]);
    return `${d.name} clock ${d.skew}`;
  }
  if (roll < 0.74) {
    // a restart: a new client over the stored state, the clock maybe reset
    const i = sim.devices.indexOf(d);
    d.listening?.abort();
    d.dead = true;
    const nd = makeDevice(sim, d.name, d.u, {
      storage: d.storage,
      skew: chance(r, 0.5) ? 0 : d.skew,
      logs: d.logs,
      tier: d.tier,
    });
    nd.down = d.down;
    nd.old = d.old;
    await startDevice(nd);
    sim.devices[i] = nd;
    // answers of the old client's writes are known from here only by state
    for (const rec of sim.writes.values()) if (rec.dev === d) rec.dev = nd;
    return `${d.name} restart`;
  }
  if (roll < 0.77) {
    sim.w.server.work();
    return "work";
  }
  if (roll < 0.82) {
    // now and then days pass (a device offline over a weekend)
    sim.w.clock.advance(
      chance(r, 0.08)
        ? pick(r, [DAY, 2 * DAY, 3.5 * DAY])
        : pick(r, [1000, 10_000, MINUTE, 10 * MINUTE, HOUR]),
    );
    return "time";
  }
  if (roll < 0.85) {
    const e = pick(r, d.client.problems().length ? d.client.problems() : [null]);
    if (!e) return "skip";
    if (chance(r, 0.6)) {
      d.client.sendAgain(e.local);
      hit(sim, "Send again");
      await flush(sim, d);
      return `${d.name} send again ${e.name}`;
    }
    d.client.discard(e.local);
    hit(sim, "discard");
    sim.writes.delete(e.local);
    return `${d.name} discard ${e.name}`;
  }
  if (roll < 0.88) {
    const log = pick(
      r,
      d.logs.filter((l) => l.startsWith("space:")),
    );
    const ths = d.client.view().list("thread", (p) => `space:${p.s}` === log);
    const th = ths.length ? pick(r, ths) : null;
    if (!th) return "skip";
    await d.client.hydrate(log, th.id);
    return `${d.name} hydrate`;
  }
  if (roll < 0.91) {
    if (d.listening) {
      d.listening.abort();
      d.listening = null;
      return `${d.name} stop listening`;
    }
    const ctl = new AbortController();
    d.listening = ctl;
    void d.client
      .listen(ctl.signal)
      .catch((e: unknown) => sim.bad.push(`${d.name} listen: ${String(e)}`));
    hit(sim, "listen");
    return `${d.name} listen`;
  }
  if (roll < 0.93) {
    d.old = !d.old;
    if (!d.old) await d.client.updated();
    return `${d.name} ${d.old ? "below the minimum version" : "updated"}`;
  }
  if (roll < 0.95) {
    d.wrong = true;
    return `${d.name} client record expires`;
  }
  void k;
  return hostile(sim);
}

/** Let the system go quiet: the network heals, clocks are right, every
 * outbox is sent and every replica pulled. */
async function quiesce(sim: Sim) {
  for (const d of sim.devices) {
    d.down = false;
    d.skew = 0;
    d.old = false;
    d.wrong = false;
    d.listening?.abort();
    d.listening = null;
  }
  await new Promise((r) => setImmediate(r));
  note(sim);
  // the healed network delivers every late copy
  for (const x of sim.late.splice(0))
    count(sim, sim.w.server, { u: x.u }, { ...x.e, clientTime: sim.w.clock.now() });
  for (const [i, d] of sim.devices.entries()) {
    d.dead = true;
    const nd = makeDevice(sim, d.name, d.u, {
      storage: d.storage,
      logs: d.logs,
      tier: d.tier,
      quiet: true,
    });
    await startDevice(nd);
    for (const rec of sim.writes.values()) if (rec.dev === d) rec.dev = nd;
    sim.devices[i] = nd;
    // a write held by UPDATE_REQUIRED before the restart is sent again
    await nd.client.updated();
    note(sim);
  }
  sim.late = [];
  for (let k = 0; k < 12; k++) {
    sim.w.clock.advance(11 * MINUTE);
    for (const d of sim.devices) await flush(sim, d);
    sim.w.server.work();
    if (!sim.devices.some((d) => d.client.outbox().some((e) => e.state === "queued"))) break;
  }
  sim.w.server.work();
  for (let k = 0; k < 2; k++) for (const d of sim.devices) await d.client.sync();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const threadOfRec = (x: StoredRecord) =>
  x.kind === "thread"
    ? x.id
    : x.kind === "followup" || x.kind === "reply" || x.kind === "run"
      ? x.th
      : null;

async function check(sim: Sim): Promise<string | null> {
  const out: string[] = [...sim.bad];
  const s = sim.w.server;
  for (const [local, n] of sim.applied) if (n > 1) out.push(`write ${local} applied ${n} times`);
  for (const d of sim.devices) {
    const c = d.client;
    for (const e of c.outbox())
      if (e.state === "queued" || e.state === "held")
        out.push(`${d.name}: ${e.name} ${e.local} still ${e.state}`);
    // the view: every live log through the overlay equals the server's
    const want = new Map<string, StoredRecord>();
    const frozen = new Set<string>();
    for (const log of c.openLogs()) {
      const full = new Map(
        s
          .snapshot({ u: d.u }, log, { tier: { window: "full" } })
          .records.map((x) => [x.key, x.record]),
      );
      if (c.isFrozen(log)) {
        hit(sim, "a frozen copy");
        // the user's own threads and what they wrote under them; else only
        // what the server serves them
        const mine = new Set(
          [...c.records(log).values()].flatMap((x) =>
            x.kind === "thread" && x.u === d.u ? [x.id] : [],
          ),
        );
        for (const [k, x] of c.records(log)) {
          frozen.add(k);
          const th = threadOfRec(x);
          const own = th !== null && mine.has(th) && "u" in x && x.u === d.u;
          if (!own && !full.has(k)) out.push(`${d.name} frozen ${log}: ${k} is not the user's`);
        }
        continue;
      }
      const tiered = log.startsWith("space:") && d.tier.window !== "full";
      if (!tiered) {
        for (const [k, v] of full) want.set(k, v);
        for (const k of c.records(log).keys())
          if (!full.has(k)) out.push(`${d.name} ${log}: extra ${k}`);
        continue;
      }
      const meta = await d.storage.loadMeta();
      const opened = Object.keys(meta?.opened?.[log] ?? {});
      const served = s.snapshot({ u: d.u }, log, { tier: { ...d.tier, opened } }).records;
      const summaries = c.summaries(log);
      for (const { key, record } of served) {
        const th = threadOfRec(record);
        const under = record.kind !== "thread" && record.kind !== "counts" && th !== null;
        if (under && summaries.has(th)) continue;
        want.set(key, record);
      }
      // records under a thread that left the full tier are not served
      // again: present on the server, not checked for freshness
      for (const [k, x] of c.records(log)) {
        if (!full.has(k)) out.push(`${d.name} ${log}: extra ${k}`);
        else if (!want.has(k) && threadOfRec(x) === null)
          out.push(`${d.name} ${log}: unserved ${k}`);
        else if (!want.has(k)) frozen.add(k);
      }
    }
    for (const [k, v] of want)
      if (!same(c.get(k), v))
        out.push(
          `${d.name} view: ${k} is ${JSON.stringify(c.get(k))?.slice(0, 120)}, want ${JSON.stringify(v).slice(0, 120)}`,
        );
    for (const k of c.keys())
      if (!want.has(k) && !frozen.has(k)) out.push(`${d.name} view: extra ${k}`);
  }
  // every write ended: applied (answered, or applied by the server's
  // count), or shown; never silently gone
  for (const [local, rec] of sim.writes) {
    const shown = sim.devices.some((d) => d.client.problems().some((e) => e.local === local));
    const pending = sim.devices.some((d) =>
      d.client.outbox().some((e) => e.local === local && e.state === "answered"),
    );
    const applied = (sim.applied.get(local) ?? 0) > 0 || rec.answer?.ok === true || pending;
    const refused = rec.answer !== undefined && rec.answer !== null && !rec.answer.ok;
    if (!shown && !applied && !refused) {
      // a write whose answer was a replay of an application under an id it
      // replaced counts as applied; one whose client restarted before its
      // answer ended in the restored outbox
      const known = sim.devices.some((d) => d.client.outbox().some((e) => e.local === local));
      if (!known) out.push(`${rec.name} ${local} of ${rec.dev.name} left with no end`);
      if (!known && process.env["SYNC_SIM_DEBUG"]) {
        const ids = [...sim.locals].filter(([, l]) => l === local).map(([m]) => m.split(":")[1]);
        const answers = s.store.dump().answers.filter((x) => ids.includes(x.mutationId ?? ""));
        console.log(local, "mutation ids", ids, "answers", JSON.stringify(answers).slice(0, 400));
      }
    }
    // a refusal is the server's verdict on the write as it was made: never
    // for an input the client changed after sending it
    const err = rec.answer && !rec.answer.ok ? rec.answer.error : null;
    if (err?.code === "BAD_REQUEST" && err.issues?.some((x) => x.includes("already used")))
      out.push(
        `${rec.name} ${local} of ${rec.dev.name} refused: its input changed after it was sent`,
      );
  }
  // every id an answered write made exists on the server
  for (const [local, a] of sim.answered) {
    const def = MUTATORS.get(a.name);
    const parsed = def?.input.safeParse(a.input);
    if (!def || !parsed?.success) continue;
    for (const id of def.ids(parsed.data))
      if (s.store.transaction((tx) => tx.registryGet(id)) === undefined)
        out.push(`${a.name} ${local} of ${a.u} answered ok, but the server has no ${id}`);
  }
  return out.length ? out.slice(0, 6).join("\n") : null;
}

async function runSeed(seed: number, trace = false): Promise<string | null> {
  const w = new World("memory", seed);
  const open = w.id();
  const closed = w.id();
  const must = (a: Answer) => {
    if (!a.ok) throw new Error(JSON.stringify(a.error));
  };
  must(w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  must(
    w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "listed", policy: "request" }),
  );
  for (const u of ["mona", "mel", "otto"]) must(w.as(u, "spaces.join", { space: open }));
  must(
    w.as("olga", "members.setRole", {
      space: open,
      user: "mona",
      role: "mod",
      base: { rev: w.rev(`member:${open}:mona`) },
    }),
  );
  must(w.as("mel", "joinRequests.create", { space: closed, rulesAccepted: true }));
  must(
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["mel"],
      decision: "approve",
      base: { mel: w.rev(`request:${closed}:mel`) },
    }),
  );
  const sim: Sim = {
    r: rng(seed * 7919 + 1),
    w,
    open,
    closed,
    devices: [],
    late: [],
    locals: new Map(),
    applied: new Map(),
    writes: new Map(),
    answered: new Map(),
    bad: [],
    reach: new Map(),
    log: [],
  };
  for (const [name, u, tier] of [
    ["olga@mac", "olga", "full"],
    ["mona@mac", "mona", "full"],
    ["mel@mac", "mel", "full"],
    ["mel@web", "mel", "full"],
    ["otto@mac", "otto", "full"],
    // a replica holding every thread it did not write, save or open as a
    // summary
    ["otto@phone", "otto", "summary"],
  ] as const) {
    const logs: LogId[] = [
      `space:${open}`,
      `user:${u}`,
      ...(u === "olga" || u === "mel" ? [`space:${closed}` as LogId] : []),
    ];
    const d = makeDevice(sim, name, u, { logs, tier: { window: tier } });
    await startDevice(d);
    sim.devices.push(d);
  }
  for (let k = 0; k < STEPS; k++) {
    const what = await step(sim, k);
    sim.log.push(what);
  }
  await quiesce(sim);
  const bad = await check(sim);
  for (const d of sim.devices)
    if (d.client.problems().some((e) => e.state === "dropped")) hit(sim, "a write dropped");
  for (const [k, n] of sim.reach) reached.set(k, (reached.get(k) ?? 0) + n);
  if (process.env["SYNC_SIM_STATS"]) {
    const shown = sim.devices.flatMap((d) =>
      d.client.problems().map((e) => e.state + ":" + (e.error?.code ?? "")),
    );
    const by = new Map<string, number>();
    for (const x of shown) by.set(x, (by.get(x) ?? 0) + 1);
    console.log(
      `seed ${seed}: writes ${sim.writes.size}, applied ${[...sim.applied.values()].filter((n) => n > 0).length}, shown ${JSON.stringify([...by])}, records ${sim.w.server.records().size}, reached ${JSON.stringify([...sim.reach])}`,
    );
  }
  if (trace) console.log(sim.log.map((x, k) => `${k}: ${x}`).join("\n"));
  return bad ? `seed ${seed}: ${bad}\nlast steps: ${sim.log.slice(-8).join("; ")}` : null;
}

// one seed, with every step it took (debugging): SYNC_SIM_ONLY=<seed>
const ONLY = process.env["SYNC_SIM_ONLY"];
if (ONLY)
  test.serial(`simulation: seed ${ONLY} alone`, async (t) => {
    const bad = await runSeed(Number(ONLY), true);
    if (bad) t.fail(bad);
    else t.pass();
  });

for (let g = 0; g < (ONLY ? 0 : Math.ceil(SEEDS / GROUP)); g++) {
  const from = g * GROUP + 1;
  const to = Math.min(SEEDS, from + GROUP - 1);
  test.serial(
    `simulation: seeds ${from} to ${to}, ${STEPS} steps each: replicas converge, no write applies twice, every write ends`,
    async (t) => {
      for (let s = from; s <= to; s++) {
        const bad = await runSeed(s);
        if (bad) return t.fail(bad);
      }
      t.pass();
    },
  );
}

test.serial("simulation: the seeds reach every path the checks are for", (t) => {
  if (SEEDS < 200 || STEPS < 200) return t.pass();
  if (process.env["SYNC_SIM_STATS"]) console.log(JSON.stringify([...reached]));
  t.deepEqual(
    REACH.filter((x) => !reached.get(x)),
    [],
  );
});
