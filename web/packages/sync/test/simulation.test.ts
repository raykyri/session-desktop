// Deterministic simulation: several clients and one server, a fake network
// (delay as late copies, loss of requests and of answers, responses that are
// not answers, duplication, reordering, disconnects), device clocks that are
// slow, fast, reset and days off, restarts from storage (also with a request
// in flight, and between a write's persist and its send), random writes from
// honest clients and a hostile one, writes that name an id another write
// derives, sessions that end and are signed in again, and the client's other
// paths: overlapping syncs and flushes, a write during a flush, Send again
// and discard, a tiered replica that hydrates threads, live updates,
// UPDATE_REQUIRED (and a restart while held), WRONG_CLIENT, TOO_LARGE and
// writes dropped after days offline. Each seed runs `STEPS` random steps,
// then lets the system go quiet, and checks:
// - every replica's view (its open logs through the overlay) equals the
//   server's scope-filtered projection of its live logs; a tiered log holds
//   every record the server's tiered read serves, except under the threads
//   it holds as summaries, and nothing the server does not serve; what it
//   still holds under a thread that left the full tier is current;
// - a frozen copy holds the user's own threads and what they wrote under
//   them, and nothing else the server would not serve them;
// - no write was applied twice (across retries, remints, replays and late
//   copies), and no two reads of one log were in flight at once;
// - no log changed while its device's session had ended;
// - every write ended applied, refused, expired, or failed or dropped and
//   shown; none is silently gone. A write ends failed, EXPIRED or dropped
//   only for a reason the simulation made: failed after 5 transient answers
//   or responses that were not answers (or TOO_LARGE), EXPIRED and dropped
//   only by the time it waited or a device clock it set. Every id an
//   answered write's input made exists on the server; no write was refused
//   for an input it changed after sending it, or refused NOT_FOUND for
//   naming an id derived from a mutation id other than the one its maker
//   applied under.
// CI runs 200 seeds × 200 steps and checks that they reach each path above;
// `npm run sim` runs 1,000. `SYNC_SIM_STATS=1` prints what each seed reached;
// `SYNC_SIM_ONLY=<seed>` runs one seed and prints its steps, with
// `SYNC_SIM_DEBUG=1` each write queued and each application no write claims.

import {
  MUTATORS,
  derivedFrom,
  isUlid,
  ulid,
  ulidTime as decodeTime,
  type LogId,
  type StoredRecord,
} from "@session/mutators";
import test from "ava";

import {
  ID_MAX_AGE,
  InProcessTransport,
  MAX_TRIES,
  MemoryStorage,
  NO_RESPONSE,
  OUTBOX_TTL,
  Offline,
  RETRY_MAX,
  SyncClient,
  UNRECORDED,
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
  "a restart with a request in flight",
  "a restart between a persist and its send",
  "a write naming a derived id",
  "a device clock days off",
  "a session that ends",
  "a restart while held",
  "a thread that left the full tier",
  "no response",
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
  /** The process ends at its next write request: after the server applied
   * it (a request in flight), or before it left (after its persist). */
  crash: "in flight" | "before send" | null;
  /** The person's session holds (false: the server takes the device's
   * requests as nobody's). */
  session: boolean;
  /** Its logs once the client knows the session ended (it signed out, with
   * no read in flight): none may change until it is signed in again. */
  frozenLogs: string | null;
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
  /** The local ids of every write queued, their answers, when they were
   * made (or sent again) in server time, the client's clock then against the
   * server's (`off`), and when they ended shown. */
  writes: Map<string, Rec>;
  /** The input of every write the client holds as answered ok. */
  answered: Map<string, { u: Person; name: string; input: unknown }>;
  /** Mutation ids the hostile party sent as their own person. */
  forged: Set<string>;
  /** Transient answers and responses that were not answers, by local id:
   * the reasons a write may end failed. */
  excuses: Map<string, number>;
  /** By local id, the mutation id it applied under and when (an order
   * counter), and when the server refused it NOT_FOUND. */
  appliedAs: Map<string, { mid: string; at: number }>;
  notFound: Map<string, number>;
  /** Writes a late copy of which the server answered EXPIRED. */
  lateExpired: Set<string>;
  order: number;
  /** What broke an invariant while the steps ran. */
  bad: string[];
  reach: Map<string, number>;
  log: string[];
}

interface Rec {
  dev: Device;
  name: string;
  answer: Answer | null | undefined;
  /** When its ids were made (server time): its age for EXPIRED. */
  madeAt: number;
  /** When it was queued, or sent again: its wait for the 3-day drop. */
  queuedAt: number;
  /** The most the client's clock was off when it made the ids or queued
   * it (a clock the simulation set). */
  off: number;
  endedAt?: number;
}

const hit = (sim: Sim, what: Reach) => sim.reach.set(what, (sim.reach.get(what) ?? 0) + 1);

/** The local id of the entry of `u`'s devices that holds or held a mutation
 * id. */
function localOf(sim: Sim, u: string | undefined, mid: string): string | undefined {
  let local = sim.locals.get(`${u}:${mid}`);
  for (const d of sim.devices)
    if (d.u === u)
      for (const x of d.client.outbox())
        if (x.mutationId === mid || x.replaces.includes(mid)) local = x.local;
  return local;
}

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
  // a session that ended: the request is nobody's
  const who = <A>(a: A) => (d.session ? a : null);
  return {
    register: (a) => (d.old ? no("UPDATE_REQUIRED") : s.register(who(a))),
    apply: (a0, e) => {
      const a = who(a0);
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
      return s.snapshot(who(a), l, o);
    },
    pull: (a, l, c, o) => {
      if (d.old) return no("UPDATE_REQUIRED");
      const p = s.pull(who(a), l, c, o);
      // a summary thread the replica holds more of than a summary
      if ("changes" in p && p.summaries?.length) {
        const ths = new Set(p.summaries);
        for (const x of d.client.records(l).values())
          if ((x.kind === "reply" || x.kind === "followup") && ths.has(x.th))
            hit(sim, "a thread that left the full tier");
      }
      return p;
    },
    call: (a, n, i) => s.call(who(a), n, i),
  };
}

function count(
  sim: Sim,
  s: SyncServer,
  a: { u: string } | null,
  e: Envelope,
  late = false,
): Answer {
  const out = s.apply(a, e);
  const at = sim.order++;
  // a late copy the network delivered with a clock it set: its EXPIRED is
  // the write's answer from then on
  if (late && !out.ok && !out.replayed && out.error.code === "EXPIRED") {
    const local = localOf(sim, a?.u, e.mutationId);
    if (local !== undefined) sim.lateExpired.add(local);
  }
  if (!out.ok && out.error.code === "NOT_FOUND" && !out.replayed) {
    const local = localOf(sim, a?.u, e.mutationId);
    if (local !== undefined && !sim.notFound.has(local)) sim.notFound.set(local, at);
  }
  if (out.ok && !out.replayed) {
    // the entry that holds this mutation id now, or had it (it may have been
    // reminted within the flush that sent it: `replaces` lists it), or the
    // one that held it before
    const local = localOf(sim, a?.u, e.mutationId);
    if (local !== undefined) {
      sim.applied.set(local, (sim.applied.get(local) ?? 0) + 1);
      sim.appliedAs.set(local, { mid: e.mutationId, at });
    } else if (process.env["SYNC_SIM_DEBUG"])
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
    push: async (es) => {
      if (d.dead) return [NO_RESPONSE];
      // the process ends with this request in flight (the server gets it),
      // or after its persist and before it leaves
      const crash = d.crash;
      if (crash) {
        d.crash = null;
        if (crash === "in flight") {
          await inner.push(es);
          hit(sim, "a restart with a request in flight");
        } else hit(sim, "a restart between a persist and its send");
        d.dead = true;
        return [NO_RESPONSE];
      }
      const out = await inner.push(es);
      if (process.env["SYNC_SIM_DEBUG"])
        for (const [k, a] of out.entries()) {
          const env = es[k];
          if (env)
            sim.log.push(
              `  (${d.name} sent ${env.name} ${localOf(sim, d.u, env.mutationId)} ${env.mutationId} at ${env.clientTime - sim.w.clock.now()} off, id ahead ${Number(BigInt(0)) + (decodeTime(env.mutationId) - env.clientTime)}: ${a === null ? "null" : a === NO_RESPONSE ? a : a.ok ? "ok" : a.error.code})`,
            );
        }
      for (const [k, a] of out.entries()) {
        if (a === NO_RESPONSE) hit(sim, "no response");
        // what the simulation made the write fail by: a response that is
        // not an answer, or a transient answer
        if (a === null || (a && a !== NO_RESPONSE && !a.ok && UNRECORDED.has(a.error.code))) {
          const env = es[k];
          const local = env && localOf(sim, d.u, env.mutationId);
          if (local !== undefined) sim.excuses.set(local, (sim.excuses.get(local) ?? 0) + 1);
        }
      }
      return out;
    },
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
    crash: null,
    session: true,
    frozenLogs: null,
  };
  const net = {
    plan: () =>
      o.quiet
        ? {}
        : {
            lost: chance(sim.r, 0.05),
            answerLost: chance(sim.r, 0.05),
            notAnswer: chance(sim.r, 0.03),
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
  if (roll < 0.55 && th.k === "ask") {
    const fs = c.view().list("followup", (f) => f.th === th.id && !f.del && f.mod === null);
    const parent = fs.length && chance(r, 0.5) ? pick(r, fs) : null;
    return parent
      ? [
          "research.forkNode",
          { id: c.newId(), thread: th.id, parent: parent.id, q: `k${Math.floor(r() * 1e6)}` },
        ]
      : ["followups.ask", { id: c.newId(), thread: th.id, q: `f${Math.floor(r() * 1e6)}` }];
  }
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
  // the victim's own mutation id with another input, sent as the victim:
  // their real write is then refused as a reused id, legitimately
  if (who === victim.u) sim.forged.add(e.mutationId);
  const a = count(sim, w.server, { u: who }, e);
  return `hostile ${who} ${e.name}: ${a.ok ? "ok" : a.error.code}`;
}

/** Two writes of `d`'s person, the second naming an id the first derives: a
 * thread branched from a follow-up of theirs that has one of theirs below
 * it (its copy has a derived id), and an ask under that copy. Null when no
 * such follow-up is in the view. */
function derived(sim: Sim, d: Device): string | null {
  const c = d.client;
  const live = (f: { del: boolean; mod: unknown }) => !f.del && f.mod === null;
  const mine = () => c.view().list("followup", (f) => f.u === d.u && live(f));
  // the follow-ups the branch needs, made first when the view has none
  let from = mine().filter((f) => mine().some((g) => g.par === f.id && g.th === f.th));
  if (!from.length) {
    const asks = threadsOf(
      d,
      d.u === "otto" ? sim.open : pick(sim.r, [sim.open, sim.closed]),
    ).flatMap((p) => (p.kind === "thread" && p.k === "ask" ? [p] : []));
    const th = asks.length ? pick(sim.r, asks) : null;
    if (!th) return null;
    let f = mine().find((x) => x.th === th.id);
    if (!f) {
      queueWrite(sim, d, "followups.ask", { id: c.newId(), thread: th.id, q: "a" }, false);
      f = mine().find((x) => x.th === th.id);
    }
    if (!f) return "ask";
    queueWrite(
      sim,
      d,
      "research.forkNode",
      { id: c.newId(), thread: th.id, parent: f.id, q: "c" },
      false,
    );
    from = mine().filter((x) => mine().some((g) => g.par === x.id && g.th === x.th));
    if (!from.length) return "follow-ups";
  }
  const f = pick(sim.r, from);
  const src = c.view().get("thread", f.th);
  if (!src || src.del || src.mod !== null) return null;
  const N = c.newId();
  queueWrite(
    sim,
    d,
    "threads.create",
    { id: N, space: src.s, kind: "ask", q: "b", from: { th: f.th, node: f.id }, branch: "all" },
    false,
  );
  const copy = c.view().list("followup", (x) => x.th === N)[0];
  if (!copy) return "branch";
  hit(sim, "a write naming a derived id");
  queueWrite(
    sim,
    d,
    "research.forkNode",
    { id: c.newId(), thread: N, parent: copy.id, q: `u${Math.floor(sim.r() * 1e6)}` },
    false,
  );
  return "branch and an ask under its copy";
}

/** Queue a write of `d` (sent or not), recording it. */
function queueWrite(sim: Sim, d: Device, name: string, input: unknown, send: boolean) {
  const { local, answer } = d.client.write(name, input, { send });
  const now = sim.w.clock.now();
  const rec: Rec = {
    dev: d,
    name,
    answer: undefined,
    madeAt: now,
    queuedAt: now,
    off: d.client.now() - now,
  };
  sim.writes.set(local, rec);
  if (process.env["SYNC_SIM_DEBUG"]) sim.log.push(`  (queued ${name} ${local} on ${d.name})`);
  void answer.then((a) => {
    rec.answer = a;
    note(sim);
  });
  note(sim);
}

/** Queue an honest write of `d` (sent or not), recording it. */
function queue(sim: Sim, d: Device, send: boolean): string | null {
  const wr = honest(sim, d);
  if (!wr) return null;
  const [name, input] = wr;
  queueWrite(sim, d, name, input, send);
  return name;
}

/** The writes shown since the last look: when they ended (server time). */
function ended(sim: Sim) {
  const now = sim.w.clock.now();
  for (const d of sim.devices)
    for (const e of d.client.problems()) {
      const rec = sim.writes.get(e.local);
      if (rec && rec.endedAt === undefined) rec.endedAt = now;
    }
}

/** The logs of `d` as its client holds them. */
const logsOf = (d: Device) =>
  JSON.stringify(d.client.openLogs().map((l) => [l, [...d.client.records(l)]]));

async function step(sim: Sim, k: number): Promise<string> {
  const r = sim.r;
  const d = pick(r, sim.devices);
  const roll = r();
  if (roll < 0.28) {
    const name = queue(sim, d, false);
    if (!name) return "skip";
    await flush(sim, d);
    return `${d.name} ${name}`;
  }
  if (roll < 0.38) {
    await flush(sim, d);
    return `${d.name} flush`;
  }
  if (roll < 0.48) {
    await d.client.sync();
    return `${d.name} sync`;
  }
  if (roll < 0.53) {
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
  if (roll < 0.58 && sim.late.length) {
    // a late copy arrives, out of order
    const [x] = sim.late.splice(Math.floor(r() * sim.late.length), 1);
    if (x) {
      const a = count(
        sim,
        sim.w.server,
        { u: x.u },
        { ...x.e, clientTime: sim.w.clock.now() + d.skew },
        true,
      );
      return `late ${x.u} ${x.e.name}: ${a.ok ? (a.replayed ? "replay" : "ok") : a.error.code}`;
    }
  }
  if (roll < 0.63) {
    d.down = !d.down;
    return `${d.name} ${d.down ? "offline" : "online"}`;
  }
  if (roll < 0.68) {
    d.skew = pick(r, [
      0,
      0,
      20_000,
      -20_000,
      2 * MINUTE,
      -2 * MINUTE,
      -HOUR,
      20 * MINUTE,
      3 * DAY,
      -3 * DAY,
      -5 * DAY,
    ]);
    if (Math.abs(d.skew) >= DAY) hit(sim, "a device clock days off");
    return `${d.name} clock ${d.skew}`;
  }
  if (roll < 0.73) {
    // a restart: a new client over the stored state, the clock maybe reset;
    // now and then the process ends while it sends a write
    const i = sim.devices.indexOf(d);
    if (!d.down && chance(r, 0.4)) {
      d.crash = chance(r, 0.5) ? "in flight" : "before send";
      if (!d.client.outbox().some((e) => e.state === "queued")) queue(sim, d, false);
      await flush(sim, d);
      d.crash = null;
    }
    if (d.client.updateRequired) hit(sim, "a restart while held");
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
    nd.session = d.session;
    nd.frozenLogs = d.frozenLogs;
    await startDevice(nd);
    sim.devices[i] = nd;
    // answers of the old client's writes are known from here only by state
    for (const rec of sim.writes.values()) if (rec.dev === d) rec.dev = nd;
    return `${d.name} restart`;
  }
  if (roll < 0.76) {
    sim.w.server.work();
    return "work";
  }
  if (roll < 0.81) {
    // now and then days pass (a device offline over a weekend)
    sim.w.clock.advance(
      chance(r, 0.08)
        ? pick(r, [DAY, 2 * DAY, 3.5 * DAY])
        : pick(r, [1000, 10_000, MINUTE, 10 * MINUTE, HOUR]),
    );
    return "time";
  }
  if (roll < 0.84) {
    const e = pick(r, d.client.problems().length ? d.client.problems() : [null]);
    if (!e) return "skip";
    if (chance(r, 0.6)) {
      const ids = JSON.stringify(e.minted);
      d.client.sendAgain(e.local);
      // a new 3-day window; a new age if its ids are new
      const rec = sim.writes.get(e.local);
      if (rec) {
        const now = sim.w.clock.now();
        rec.queuedAt = now;
        if (!e.minted.length || JSON.stringify(e.minted) !== ids) rec.madeAt = now;
        const off = d.client.now() - now;
        if (Math.abs(off) > Math.abs(rec.off)) rec.off = off;
        delete rec.endedAt;
      }
      hit(sim, "Send again");
      await flush(sim, d);
      return `${d.name} send again ${e.name}`;
    }
    d.client.discard(e.local);
    hit(sim, "discard");
    sim.writes.delete(e.local);
    return `${d.name} discard ${e.name}`;
  }
  if (roll < 0.87) {
    // mostly on the tiered replica, whose hydrated threads are summaries
    // again for its later reads
    const tiered = sim.devices.filter((x) => x.tier.window !== "full");
    const h = tiered.length && chance(r, 0.7) ? pick(r, tiered) : d;
    const log = pick(
      r,
      h.logs.filter((l) => l.startsWith("space:")),
    );
    const ths = h.client.view().list("thread", (p) => `space:${p.s}` === log);
    const th = ths.length ? pick(r, ths) : null;
    if (!th) return "skip";
    await h.client.hydrate(log, th.id);
    return `${h.name} hydrate`;
  }
  if (roll < 0.9) {
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
  if (roll < 0.92) {
    d.old = !d.old;
    if (!d.old) await d.client.updated();
    return `${d.name} ${d.old ? "below the minimum version" : "updated"}`;
  }
  if (roll < 0.935) {
    d.wrong = true;
    return `${d.name} client record expires`;
  }
  if (roll < 0.955) {
    const what = derived(sim, d);
    if (!what) return "skip";
    await flush(sim, d);
    return `${d.name} ${what}`;
  }
  if (roll < 0.965) {
    // the session ends (a cookie that expired): nothing may change a log
    // until the person signs in again
    if (d.session) {
      d.session = false;
      hit(sim, "a session that ends");
      return `${d.name} session ends`;
    }
    d.session = true;
    d.frozenLogs = null;
    await d.client.signedIn();
    return `${d.name} signed in again`;
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
    d.session = true;
    d.frozenLogs = null;
    d.listening?.abort();
    d.listening = null;
  }
  await new Promise((r) => setImmediate(r));
  note(sim);
  // the healed network delivers every late copy
  for (const x of sim.late.splice(0))
    count(sim, sim.w.server, { u: x.u }, { ...x.e, clientTime: sim.w.clock.now() }, true);
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
    // (a write held by UPDATE_REQUIRED before the restart is queued again by
    // the new process itself)
    note(sim);
  }
  sim.late = [];
  for (let k = 0; k < 12; k++) {
    sim.w.clock.advance(11 * MINUTE);
    for (const d of sim.devices) await flush(sim, d);
    sim.w.server.work();
    ended(sim);
    if (!sim.devices.some((d) => d.client.outbox().some((e) => e.state === "queued"))) break;
  }
  sim.w.server.work();
  for (let k = 0; k < 2; k++) for (const d of sim.devices) await d.client.sync();
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every string in a JSON value. */
function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v !== null && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}
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
      // what the replica still holds under a thread the tiered read does
      // not serve in full (it left the full tier, and nothing changed under
      // it since) is current
      for (const [k, x] of c.records(log)) {
        const now = full.get(k);
        if (!now) out.push(`${d.name} ${log}: extra ${k}`);
        else if (!want.has(k) && threadOfRec(x) === null)
          out.push(`${d.name} ${log}: unserved ${k}`);
        else if (!want.has(k) && !same(x, now))
          out.push(`${d.name} ${log}: stale ${k} under a summary thread`);
        else if (!want.has(k)) want.set(k, now);
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
  // count), or shown; never silently gone. Shown failed, EXPIRED or dropped
  // only for a reason the simulation made
  for (const [local, rec] of sim.writes) {
    const entry = sim.devices
      .flatMap((d) => d.client.problems())
      .find((e) => e.local === local && e.state !== "refused");
    if (entry) {
      const end = rec.endedAt ?? sim.w.clock.now();
      const waited = end - rec.madeAt;
      const off = Math.abs(rec.off);
      const why =
        entry.state === "failed"
          ? entry.error?.code === "TOO_LARGE" || (sim.excuses.get(local) ?? 0) >= MAX_TRIES
          : entry.state === "dropped"
            ? end - rec.queuedAt >= OUTBOX_TTL - off - MINUTE
            : sim.lateExpired.has(local) ||
              waited >= ID_MAX_AGE - off - MINUTE ||
              rec.off > RETRY_MAX - MINUTE ||
              rec.off < -ID_MAX_AGE + MINUTE;
      if (!why)
        out.push(
          `${rec.name} ${local} of ${rec.dev.name} ${entry.state}${entry.error ? ` (${entry.error.code})` : ""} with no reason: waited ${waited} ms, clock off ${rec.off} ms, excuses ${sim.excuses.get(local) ?? 0}, queuedAt ${rec.madeAt - entry.queuedAt} ms before it was made, error ${JSON.stringify(entry.error)}`,
        );
    }
    // NOT_FOUND for an id derived from a mutation id of another write after
    // that write applied under another mutation id
    const nf = sim.notFound.get(local);
    const mine = sim.devices
      .flatMap((d) => d.client.outbox())
      .find((e) => e.local === local && e.state === "refused");
    if (nf !== undefined && mine) {
      const u = rec.dev.u;
      for (const v of stringsIn(mine.input)) {
        if (!isUlid(v)) continue;
        for (const [key, maker] of sim.locals) {
          const [who, mid] = key.split(":") as [string, string];
          if (who !== u || maker === local || mid.slice(0, 10) !== v.slice(0, 10)) continue;
          if (!derivedFrom(v, u, [mid])) continue;
          const as = sim.appliedAs.get(maker);
          if (as && as.at < nf && as.mid !== mid)
            out.push(
              `${rec.name} ${local} of ${rec.dev.name} refused NOT_FOUND: it names ${v}, derived from ${mid}, but its write applied as ${as.mid}`,
            );
        }
      }
    }
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
    const forged = [...sim.locals].some(
      ([m, l]) => l === local && sim.forged.has(m.split(":")[1] ?? ""),
    );
    if (
      err?.code === "BAD_REQUEST" &&
      err.issues?.some((x) => x.includes("already used")) &&
      !forged
    )
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
    forged: new Set(),
    excuses: new Map(),
    appliedAs: new Map(),
    notFound: new Map(),
    lateExpired: new Set(),
    order: 0,
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
    ended(sim);
    for (const d of sim.devices) {
      if (d.session) continue;
      // a read served before the session ended may still land; from when
      // the client signed out with none in flight, no log changes
      if (d.frozenLogs === null) {
        if (d.client.signedOut && [...d.reading.values()].every((n) => n === 0))
          d.frozenLogs = logsOf(d);
      } else if (logsOf(d) !== d.frozenLogs)
        sim.bad.push(`${d.name}: a log changed while its session had ended (step ${k}: ${what})`);
    }
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
