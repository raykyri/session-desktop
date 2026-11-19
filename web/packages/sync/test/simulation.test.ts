// Deterministic simulation: several clients and one server, a fake network
// (delay as late copies, loss of requests and of answers, duplication,
// reordering, disconnects), device clocks that are slow, fast and reset,
// restarts from storage, and random writes from honest clients and a
// hostile one. Each seed runs `STEPS` random steps, then lets the system go
// quiet, and checks:
// - every replica's open, live log equals the server's scope-filtered
//   projection of it (a full snapshot for that reader);
// - no write was applied twice (across retries, remints, replays and late
//   copies);
// - every write ended applied, refused, expired, or failed or dropped and
//   shown; none is silently gone.
// CI runs 200 seeds × 200 steps; `npm run sim` runs 1,000.

import { ulid, type LogId, type StoredRecord } from "@session/mutators";
import test from "ava";

import {
  InProcessTransport,
  MemoryStorage,
  SyncClient,
  type Answer,
  type Envelope,
  type ServerLike,
} from "../src/client/index.js";
import { PROTOCOL_VERSION, type SyncServer } from "../src/server/index.js";

import { DAY, HOUR, MINUTE, World, rng } from "./helpers.js";

const SEEDS = Number(process.env["SYNC_SIM_SEEDS"] ?? 200);
const STEPS = Number(process.env["SYNC_SIM_STEPS"] ?? 200);
const GROUP = 10;

type Person = "olga" | "mona" | "mel" | "otto";

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: () => number, p: number) => r() < p;

interface Device {
  name: string;
  u: Person;
  storage: MemoryStorage;
  client: SyncClient;
  skew: number;
  down: boolean;
  logs: LogId[];
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
  log: string[];
}

/** The server as the clients reach it: every application is counted, and
 * some envelopes are copied for a late delivery. */
function serverFor(sim: Sim, u: Person): ServerLike {
  const s = sim.w.server;
  return {
    register: (a) => s.register(a),
    apply: (a, e) => {
      const env = e as Envelope;
      const copy = structuredClone(env);
      const out = count(sim, s, a, env);
      // a copy the network delivers again later; often for a CLOCK_SKEW
      // answer, the case where a remint and the old envelope could both
      // apply (review round 2's remint finding)
      const skew = !out.ok && out.error.code === "CLOCK_SKEW";
      if (chance(sim.r, skew ? 0.5 : 0.06)) sim.late.push({ u, e: copy });
      return out;
    },
    snapshot: (a, l, o) => s.snapshot(a, l, o),
    pull: (a, l, c, o) => s.pull(a, l, c, o),
    call: (a, n, i) => s.call(a, n, i),
  };
}

function count(sim: Sim, s: SyncServer, a: { u: string } | null, e: Envelope): Answer {
  const out = s.apply(a, e);
  if (out.ok && !out.replayed) {
    // the entry that holds this mutation id now (it may have been reminted
    // within the flush that sends it), or the one that held it before
    let local = sim.locals.get(`${a?.u}:${e.mutationId}`);
    for (const d of sim.devices)
      if (d.u === a?.u)
        for (const x of d.client.outbox()) if (x.mutationId === e.mutationId) local = x.local;
    if (local !== undefined) sim.applied.set(local, (sim.applied.get(local) ?? 0) + 1);
  }
  return out;
}

function makeDevice(
  sim: Sim,
  name: string,
  u: Person,
  storage = new MemoryStorage(),
  skew = 0,
  logs?: LogId[],
  quiet = false,
): Device {
  const d: Device = {
    name,
    u,
    storage,
    client: undefined as unknown as SyncClient,
    skew,
    down: false,
    logs: logs ?? [],
  };
  const net = {
    plan: () =>
      quiet
        ? {}
        : {
            lost: chance(sim.r, 0.05),
            answerLost: chance(sim.r, 0.05),
            duplicate: chance(sim.r, 0.03),
          },
    wait: () => Promise.resolve(),
    down: () => d.down,
  };
  d.client = new SyncClient({
    user: u,
    transport: new InProcessTransport(serverFor(sim, u), { u }, { net }),
    storage,
    clock: { now: () => sim.w.clock.now() + d.skew },
    random: rng(Math.floor(sim.r() * 2 ** 31)),
  });
  return d;
}

/** Remember every mutation id each entry has had (they change on remint). */
function note(sim: Sim) {
  for (const d of sim.devices)
    for (const e of d.client.outbox()) sim.locals.set(`${d.u}:${e.mutationId}`, e.local);
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
  // lets mel back into the closed one
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

async function step(sim: Sim, k: number): Promise<string> {
  const r = sim.r;
  const d = pick(r, sim.devices);
  const roll = r();
  if (roll < 0.35) {
    const wr = honest(sim, d);
    if (!wr) return "skip";
    const [name, input] = wr;
    const { local, answer } = d.client.write(name, input);
    const rec: { dev: Device; name: string; answer: Answer | null | undefined } = {
      dev: d,
      name,
      answer: undefined,
    };
    sim.writes.set(local, rec);
    void answer.then((a) => {
      rec.answer = a;
    });
    note(sim);
    await d.client.flush();
    note(sim);
    return `${d.name} ${name}`;
  }
  if (roll < 0.5) {
    await d.client.flush();
    note(sim);
    return `${d.name} flush`;
  }
  if (roll < 0.62) {
    await d.client.sync();
    return `${d.name} sync`;
  }
  if (roll < 0.68 && sim.late.length) {
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
  if (roll < 0.74) {
    d.down = !d.down;
    return `${d.name} ${d.down ? "offline" : "online"}`;
  }
  if (roll < 0.8) {
    d.skew = pick(r, [0, 0, 20_000, -20_000, 2 * MINUTE, -2 * MINUTE, -HOUR]);
    return `${d.name} clock ${d.skew}`;
  }
  if (roll < 0.85) {
    // a restart: a new client over the stored state, the clock maybe reset
    const i = sim.devices.indexOf(d);
    const nd = makeDevice(sim, d.name, d.u, d.storage, chance(r, 0.5) ? 0 : d.skew, d.logs);
    nd.down = d.down;
    await nd.client.init();
    for (const l of d.logs) await nd.client.open(l, { window: "full" });
    sim.devices[i] = nd;
    // answers of the old client's writes are known from here only by state
    for (const rec of sim.writes.values()) if (rec.dev === d) rec.dev = nd;
    return `${d.name} restart`;
  }
  if (roll < 0.9) {
    sim.w.server.work();
    return "work";
  }
  if (roll < 0.95) {
    sim.w.clock.advance(pick(r, [1000, 10_000, MINUTE, 10 * MINUTE, HOUR]));
    return "time";
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
  }
  // the healed network delivers every late copy
  for (const x of sim.late.splice(0))
    count(sim, sim.w.server, { u: x.u }, { ...x.e, clientTime: sim.w.clock.now() });
  for (const [i, d] of sim.devices.entries()) {
    const nd = makeDevice(sim, d.name, d.u, d.storage, 0, d.logs, true);
    await nd.client.init();
    for (const l of d.logs) await nd.client.open(l, { window: "full" });
    for (const rec of sim.writes.values()) if (rec.dev === d) rec.dev = nd;
    sim.devices[i] = nd;
  }
  sim.late = [];
  for (let k = 0; k < 12; k++) {
    sim.w.clock.advance(11 * MINUTE);
    for (const d of sim.devices) {
      await d.client.flush();
      note(sim);
    }
    sim.w.server.work();
    if (!sim.devices.some((d) => d.client.outbox().some((e) => e.state === "queued"))) break;
  }
  sim.w.server.work();
  for (let k = 0; k < 2; k++) for (const d of sim.devices) await d.client.sync();
}

function check(sim: Sim): string | null {
  const out: string[] = [];
  for (const [local, n] of sim.applied) if (n > 1) out.push(`write ${local} applied ${n} times`);
  for (const d of sim.devices) {
    for (const e of d.client.outbox())
      if (e.state === "queued" || e.state === "held")
        out.push(`${d.name}: ${e.name} ${e.local} still ${e.state}`);
    for (const log of d.client.openLogs()) {
      if (d.client.isFrozen(log)) continue;
      const want = new Map(
        sim.w.server
          .snapshot({ u: d.u }, log, { tier: { window: "full" } })
          .records.map((x) => [x.key, x.record]),
      );
      const got = d.client.records(log);
      for (const [k, v] of want)
        if (JSON.stringify(got.get(k)) !== JSON.stringify(v))
          out.push(
            `${d.name} ${log}: ${k} is ${JSON.stringify(got.get(k))?.slice(0, 120)}, want ${JSON.stringify(v).slice(0, 120)}`,
          );
      for (const k of got.keys()) if (!want.has(k)) out.push(`${d.name} ${log}: extra ${k}`);
    }
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
    }
  }
  return out.length ? out.slice(0, 6).join("\n") : null;
}

async function runSeed(seed: number): Promise<string | null> {
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
    log: [],
  };
  for (const [name, u] of [
    ["olga@mac", "olga"],
    ["mona@mac", "mona"],
    ["mel@mac", "mel"],
    ["mel@web", "mel"],
    ["otto@mac", "otto"],
  ] as const) {
    const logs: LogId[] = [
      `space:${open}`,
      `user:${u}`,
      ...(u === "olga" || u === "mel" ? [`space:${closed}` as LogId] : []),
    ];
    const d = makeDevice(sim, name, u, new MemoryStorage(), 0, logs);
    await d.client.init();
    for (const l of logs) await d.client.open(l, { window: "full" });
    sim.devices.push(d);
  }
  for (let k = 0; k < STEPS; k++) {
    const what = await step(sim, k);
    sim.log.push(what);
  }
  await quiesce(sim);
  const bad = check(sim);
  if (process.env["SYNC_SIM_STATS"]) {
    const shown = sim.devices.flatMap((d) =>
      d.client.problems().map((e) => e.state + ":" + (e.error?.code ?? "")),
    );
    const by = new Map<string, number>();
    for (const x of shown) by.set(x, (by.get(x) ?? 0) + 1);
    console.log(
      `seed ${seed}: writes ${sim.writes.size}, applied ${[...sim.applied.values()].filter((n) => n > 0).length}, shown ${JSON.stringify([...by])}, records ${sim.w.server.records().size}`,
    );
  }
  return bad ? `seed ${seed}: ${bad}\nlast steps: ${sim.log.slice(-8).join("; ")}` : null;
}

for (let g = 0; g < Math.ceil(SEEDS / GROUP); g++) {
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
