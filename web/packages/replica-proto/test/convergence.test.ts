// Convergence, property-based: random sequences of writes from random actors,
// hostile ones included, with role changes, removals, bans and moderation
// mid-sequence and the clock moving forward. Every step is checked four ways:
//
// - The write oracle (test/write-oracle.ts) predicts each envelope's answer
//   (ok or the refusal's code) and whether it is recorded; the server must
//   give exactly that answer, and report the predicted last seq for the
//   client. For a write applied now, the effect model (test/effect-model.ts)
//   predicts the records it changes, and the server's change set must match;
//   any other answer must change nothing. Registrations are predicted too.
// - State invariants hold after every step: one owner per space, no member
//   record beside a ban, no tombstone older than 30 days, report
//   notifications to the space's staff when the effect worker ran and only
//   while they are staff when they are read, no effect lost (each report's
//   notifications and each run's job are written, queued, or dead letters),
//   and no marker at rest (`scanStorage`) that is not still in its record and
//   field, unremoved.
// - Writes: honest writes are queued on a device's `ReplicaClient` and sent
//   with `flush`, through its outbox. A device's clock may be slow, fast or
//   reset, and changes across restarts (the client's state is saved and
//   restored); its answers may be lost after the server applied the write.
//   After every step, no write was applied twice, and every write queued is
//   still queued, or ended applied, refused, expired, or failed or dropped
//   and shown to the person: never silently gone. At the end of a sequence
//   the outboxes are drained and every write has its end.
// - After every step, for every actor, the replica built from a snapshot and
//   pulls must equal the read oracle's projection of the server's records
//   (test/oracle.ts), and so must a fresh snapshot. Lazy clients sync only
//   every 5 to 20 steps, so their pulls span many changes and cross the 7-
//   and 30-day limits. A pull may name (put or del) only keys the reader could
//   read at some step.
// - Every text the generator writes carries a unique marker: questions,
//   titles, replies, follow-up questions, report reasons and notes, request
//   answers and decline reasons, a space's description, title, rules and
//   questions, and the summaries and follow-up answers that runs write when
//   they finish (`finishJob`). No response (snapshot, pull, apply answer or
//   error) may carry a marker unless the marker is still stored in its record
//   and the reader may see that text now: a space's settings are public; for
//   a report or a request, the reader is its person or the space's staff;
//   otherwise the record is not removed, its space is open or the reader a
//   member, and if hidden, the reader is its author or the space's staff.
//   This check uses neither oracle.
//
// The generator also makes: bans followed by the banned person's own writes,
// declines followed by the person asking again, removals of threads with
// follow-ups and replies, stale decisions, gapped and out-of-order seqs, old
// and future ids, client ids used by another person, clients idle for 90
// days, bursts of registrations, envelopes nested too deep or too large, a
// failing random source, failing effects, and forged and replayed cursors
// (another reader's token, another log's token, a changed byte, a token from
// before the log's history was replaced).
//
// Seeds are fixed: 200 sequences of 100 steps. REPLICA_PROTO_SEQUENCES runs
// more locally (1,000 before a change is merged).

import test, { type ExecutionContext } from "ava";

import {
  PROTOCOL_VERSION,
  ReplicaClient,
  UNRECORDED,
  ulid,
  type Actor,
  type ApplyResult,
  type Envelope,
  type LogId,
  type ServerHalf,
  type StoredRecord,
} from "../src/index.js";

import { checkEffects, predictEffects } from "./effect-model.js";
import { DAY, HOUR, MINUTE, World, actor, ok, rng } from "./harness.js";
import { diff, expected } from "./oracle.js";
import { WriteModel } from "./write-oracle.js";

const SEQUENCES = Number(process.env["REPLICA_PROTO_SEQUENCES"] ?? 200);
const STEPS = 100;
const CHUNK = 10;
const PEOPLE = ["olga", "ada", "mona", "mel", "otto", "eve"] as const;
type Person = (typeof PEOPLE)[number];
/** An actor as sent: a person, signed out, or a handle no person may have. */
type Who = Person | null | "null";
const STAFF_ROLES = new Set(["mod", "admin", "owner"]);

interface Sent {
  u: Who;
  e: Envelope;
}

/** A person's device: its clock (the server's plus `skew`), its client, and
 * what the suite saw of its writes. */
interface Device {
  u: Person;
  name: string;
  skew: number;
  cl: ReplicaClient;
  /** Recorded answers the client got, by the write's local id. */
  answered: Map<string, ApplyResult>;
  /** How many of `cl.answered` were read into `answered`. */
  seen: number;
  api: ServerHalf;
  /** The local id of the write in the last envelope this device sent. */
  lastLocal: string | undefined;
}

interface Ctx {
  seed: number;
  w: World;
  r: () => number;
  sent: Sent[];
  model: WriteModel;
  devices: Device[];
  /** Each person's client ids for hand-made (hostile) envelopes. */
  raw: Map<Person, string>;
  /** Writes planned by earlier steps (a banned person's own writes, a second
   * decision on the same request, asking again after a decline). */
  plan: { u: Person; name: string; input: (c: Ctx, d: Device) => unknown; what: string }[];
  /** marker → the record and field it was written to */
  origins: Map<string, { key: string; field: string }>;
  marks: number;
  /** Fault switches. */
  faults: { random: boolean; effects: boolean; loss: boolean };
  /** Every write queued on a device, by local id: its person and device. */
  writes: Map<string, { u: Person; dev: Device; name: string }>;
  /** Writes sent with `send` (online only): their answer. */
  direct: Map<string, ApplyResult>;
  /** (person, mutation id) → the local id of the device write it carries. */
  localOf: Map<string, string>;
  /** Fresh applications of each device write. */
  applied: Map<string, number>;
  /** Every admission id each person had in each space. */
  admissions: Map<string, Set<string>>;
  /** Each space's history: how many times it opened or closed. */
  history: Map<string, { closed: boolean; n: number }>;
  /** Tokens served to readers, with the space history they were served in. */
  tokens: { u: string | null; log: LogId; cursor: string; n: number }[];
  /** Reports and runs created, for the effect checks. */
  reports: Set<string>;
  runs: Set<string>;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: () => number, p: number) => r() < p;
const RESET = Date.parse("2020-01-01T00:00:00Z");

function records<K extends StoredRecord["kind"]>(c: Ctx, kind: K) {
  return [...c.w.server.dump().values()].filter(
    (x): x is Extract<StoredRecord, { kind: K }> => x.kind === kind,
  );
}

/** Something that names a record: usually a real one, sometimes made up. */
function some(c: Ctx, ids: string[]): string {
  return ids.length && !chance(c.r, 0.08) ? pick(c.r, ids) : c.w.id();
}
const spaceId = (c: Ctx) =>
  some(
    c,
    records(c, "space").map((s) => s.id),
  );
const threadId = (c: Ctx) =>
  some(
    c,
    records(c, "thread").map((s) => s.id),
  );
function itemKey(c: Ctx): string {
  const items = [
    ...records(c, "thread").map((p) => `${p.k === "ask" ? "a" : "p"}:${p.id}`),
    ...records(c, "followup").map((f) => `f:${f.th}:${f.id}`),
    ...records(c, "reply").map((x) => `r:${x.th}:${x.id}`),
  ];
  return items.length ? pick(c.r, items) : `a:${c.w.id()}`;
}

/** A new id from the sending device's clock: fresh, or one that was ever
 * taken (any record's, readable or not, deleted ones included). */
function newId(c: Ctx, d: Device | null): string {
  if (chance(c.r, 0.05)) {
    const taken = c.model.knownIds();
    if (taken.length) return pick(c.r, taken);
  }
  return d ? d.cl.newId() : c.w.id();
}

const words = ["why", "how", "notes", "draft", "plan"];
/** Text with a unique marker, written to `key`'s `field`. */
function marked(c: Ctx, key: string, field: string): string {
  const m = `mk${c.seed}x${c.marks++}z`;
  c.origins.set(m, { key, field });
  return `${pick(c.r, words)} ${m}`;
}
const MARKER = /mk\d+x\d+z/g;

const roleNow = (c: Ctx, sp: string, u: string) => {
  const m = c.w.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
};
/** A record's rev as the client saw it: usually now, sometimes one write ago. */
const seenRev = (c: Ctx, key: string) => {
  const rev = c.w.rev(key);
  return chance(c.r, 0.85) ? rev : Math.max(0, rev - 1);
};
/** A member's admission id as the client saw it: usually now, sometimes an
 * earlier one of the same person (a decision made before they were let in
 * again). */
const seenAdmission = (c: Ctx, sp: string, u: string) => {
  const had = [...(c.admissions.get(`${sp}:${u}`) ?? [])];
  const now = c.w.admission(sp, u).adm;
  return chance(c.r, 0.6) || !had.length ? now : pick(c.r, had);
};
/** The record a moderation key names. */
const itemRecordKey = (item: string) => {
  const [k, th, sub] = item.split(":");
  return k === "f" ? `followup:${sub}` : k === "r" ? `reply:${sub}` : `thread:${th}`;
};

/** Settings of a space, each with a marker in its text. */
function settings(c: Ctx, sp: string): Record<string, unknown> {
  const key = `space:${sp}`;
  return pick(c.r, [
    { vis: pick(c.r, ["open", "listed", "unlisted"]) },
    { vis: pick(c.r, ["open", "listed"]) },
    { invite: pick(c.r, ["mods", "members"]) },
    { rules: [marked(c, key, "rules"), ...(chance(c.r, 0.3) ? ["  "] : [])] },
    { name: pick(c.r, ["lounge", "lab", "renamed", "#Lab Two!"]) },
    { postsOff: chance(c.r, 0.5) },
    { policy: pick(c.r, ["request", "invite"]) },
    { desc: marked(c, key, "desc") },
    { title: marked(c, key, "title") },
    {
      qs: [
        { q: marked(c, key, "qs"), req: chance(c.r, 0.5) },
        ...(chance(c.r, 0.3) ? [{ q: "   " }] : []),
      ],
    },
  ]);
}

type Gen = (c: Ctx, u: Who, d: Device | null) => Record<string, unknown>;
const GENERATORS: Record<string, Gen> = {
  "spaces.create": (c, _u, d) => {
    const id = newId(c, d);
    const closed = chance(c.r, 0.5);
    return {
      id,
      name: pick(c.r, ["lounge", "lab", "new", "other", "#Lab"]),
      ...(chance(c.r, 0.5) ? { vis: closed ? pick(c.r, ["listed", "unlisted"]) : "open" } : {}),
      ...(chance(c.r, 0.5) ? { desc: marked(c, `space:${id}`, "desc") } : {}),
      ...(chance(c.r, 0.5) ? { rules: [marked(c, `space:${id}`, "rules"), " "] } : {}),
      ...(chance(c.r, 0.4) ? { policy: pick(c.r, ["request", "invite"]) } : {}),
      ...(chance(c.r, 0.4) ? { invite: pick(c.r, ["mods", "members"]) } : {}),
      ...(chance(c.r, 0.4)
        ? { qs: [{ q: marked(c, `space:${id}`, "qs"), req: chance(c.r, 0.5) }, { q: "" }] }
        : {}),
    };
  },
  "spaces.update": (c) => {
    const id = spaceId(c);
    return {
      id,
      set: settings(c, id),
      ...(chance(c.r, 0.3) ? { base: { rulesRev: Math.floor(c.r() * 3) } } : {}),
    };
  },
  "spaces.join": (c) => {
    const codes = records(c, "invite").map((l) => l.code);
    return {
      space: spaceId(c),
      ...(chance(c.r, 0.5)
        ? { invite: codes.length && chance(c.r, 0.8) ? pick(c.r, codes) : "0000000000" }
        : {}),
    };
  },
  "spaces.leave": (c) => ({ space: spaceId(c) }),
  "threads.create": (c, _u, d) => {
    const id = newId(c, d);
    return {
      id,
      space: spaceId(c),
      kind: pick(c.r, ["ask", "post"]),
      q: marked(c, `thread:${id}`, "q"),
      ...(chance(c.r, 0.5) ? { title: marked(c, `thread:${id}`, "t") } : {}),
    };
  },
  "threads.update": (c, u) => {
    // usually the person's own thread, as they last saw it
    const own = records(c, "thread").filter((p) => p.u === u);
    const id = own.length && chance(c.r, 0.7) ? pick(c.r, own).id : threadId(c);
    const rev = c.w.get(`thread:${id}`)?.rev ?? 1;
    return {
      id,
      q: marked(c, `thread:${id}`, "q"),
      base: { rev: chance(c.r, 0.8) ? rev : Math.max(0, rev - 1) },
    };
  },
  "threads.delete": (c, u) => {
    const own = records(c, "thread").filter((p) => p.u === u);
    return { id: own.length && chance(c.r, 0.6) ? pick(c.r, own).id : threadId(c) };
  },
  "likes.set": (c) => ({ thread: threadId(c), on: chance(c.r, 0.7) }),
  "saved.set": (c) => ({ kind: "thread", id: threadId(c), on: chance(c.r, 0.6) }),
  "followups.ask": (c, _u, d) => {
    const id = newId(c, d);
    return { id, thread: threadId(c), q: marked(c, `followup:${id}`, "q") };
  },
  "research.createPostFollowUp": (c, _u, d) => {
    const replies = records(c, "reply").filter((x) => x.parent === null);
    const top = replies.length && chance(c.r, 0.3) ? pick(c.r, replies) : null;
    const id = newId(c, d);
    return {
      id,
      thread: top ? top.th : threadId(c),
      t: marked(c, `reply:${id}`, "t"),
      ...(top ? { parent: top.id } : {}),
    };
  },
  "joinRequests.create": (c) => {
    const closed = records(c, "space").filter((x) => x.vis !== "open");
    const space = closed.length && chance(c.r, 0.7) ? pick(c.r, closed).id : spaceId(c);
    return {
      space,
      rulesAccepted: chance(c.r, 0.8),
      // the request is the sender's, and a replay may send it as someone else
      answers: [marked(c, `request:${space}:*`, "a")],
    };
  },
  "joinRequests.decide": (c) => {
    // usually an open request, so approvals change scopes; a planned second
    // decision on the same request makes the stale ones
    const all = records(c, "request");
    const open = all.filter((x) => x.st === "open");
    const reqs = open.length && chance(c.r, 0.7) ? open : all;
    const r = reqs.length ? pick(c.r, reqs) : null;
    const space = r && chance(c.r, 0.8) ? r.sp : spaceId(c);
    const user = r ? r.u : pick(c.r, PEOPLE);
    const decision = pick(c.r, ["approve", "approve", "decline", "decline", "reopen"]);
    return {
      space,
      users: [user],
      decision,
      base: { [user]: seenRev(c, `request:${space}:${user}`) },
      ...(decision === "decline" && chance(c.r, 0.7)
        ? { why: marked(c, `request:${space}:${user}`, "why") }
        : {}),
    };
  },
  "members.setRole": (c) => {
    const space = spaceId(c);
    const user = pick(c.r, [...PEOPLE, "null"]);
    return {
      space,
      user,
      role: pick(c.r, ["member", "mod", "mod", "admin", "owner"]),
      base: { rev: seenRev(c, `member:${space}:${user}`) },
    };
  },
  "members.remove": (c) => {
    const space = spaceId(c);
    const user = pick(c.r, PEOPLE);
    return { space, user, base: { adm: seenAdmission(c, space, user) } };
  },
  "members.ban": (c) => ({ space: spaceId(c), user: pick(c.r, PEOPLE) }),
  "invites.create": (c, _u, d) => ({
    id: newId(c, d),
    space: spaceId(c),
    ...(chance(c.r, 0.3) ? { days: 1 } : {}),
  }),
  "reports.create": (c, _u, d) => {
    const id = newId(c, d);
    return {
      id,
      item: itemKey(c),
      why: marked(c, `report:${id}`, "why"),
      ...(chance(c.r, 0.5) ? { note: marked(c, `report:${id}`, "note") } : {}),
    };
  },
  "moderation.decide": (c) => {
    // a removal of a thread that has follow-ups or replies, often
    const busy = records(c, "thread").filter((p) => {
      const n = c.w.get(`counts:${p.id}`);
      return n?.kind === "counts" && n.r > 0 && p.mod !== "removed";
    });
    if (busy.length && chance(c.r, 0.4)) {
      const p = pick(c.r, busy);
      const item = `${p.k === "ask" ? "a" : "p"}:${p.id}`;
      return { item, decision: "removed", base: { rev: seenRev(c, `thread:${p.id}`) } };
    }
    const item = itemKey(c);
    return {
      item,
      decision: pick(c.r, ["hidden", "hidden", "removed", "shown", "shown"]),
      base: { rev: seenRev(c, itemRecordKey(item)) },
    };
  },
};
const NAMES = Object.keys(GENERATORS);
// role and membership changes come often, so scopes change mid-sequence
const WEIGHTED = [
  ...NAMES,
  "spaces.update",
  "spaces.update",
  "threads.create",
  "threads.create",
  "spaces.join",
  "spaces.join",
  "joinRequests.create",
  "joinRequests.decide",
  "members.setRole",
  "members.setRole",
  "members.remove",
  "members.ban",
  "moderation.decide",
  "likes.set",
  "followups.ask",
  "research.createPostFollowUp",
  "reports.create",
];

const STAFF_WRITES = new Set([
  "spaces.update",
  "joinRequests.decide",
  "members.setRole",
  "members.remove",
  "members.ban",
  "moderation.decide",
  "invites.create",
]);

/** The writes a banned person might still try in the space they are banned from. */
function afterBan(c: Ctx, sp: string, u: Person) {
  const threads = records(c, "thread").filter((p) => p.s === sp);
  const own = threads.filter((p) => p.u === u);
  const any = threads.length ? pick(c.r, threads).id : c.w.id();
  const mine = own.length ? pick(c.r, own) : null;
  const options: { name: string; input: (c: Ctx, d: Device) => unknown }[] = [
    ...(mine
      ? [
          {
            name: "threads.update",
            input: (c: Ctx) => ({
              id: mine.id,
              q: marked(c, `thread:${mine.id}`, "q"),
              base: { rev: mine.rev },
            }),
          },
          { name: "threads.delete", input: () => ({ id: mine.id }) },
        ]
      : []),
    { name: "likes.set", input: (c: Ctx) => ({ thread: any, on: chance(c.r, 0.5) }) },
    {
      name: "saved.set",
      input: (c: Ctx) => ({ kind: "thread", id: any, on: chance(c.r, 0.5) }),
    },
    {
      name: "research.createPostFollowUp",
      input: (c: Ctx, d: Device) => {
        const id = d.cl.newId();
        return { id, thread: any, t: marked(c, `reply:${id}`, "t") };
      },
    },
    {
      name: "threads.create",
      input: (c: Ctx, d: Device) => ({
        ...(GENERATORS["threads.create"] as Gen)(c, u, d),
        space: sp,
      }),
    },
  ];
  for (let k = 0; k < 3; k++) {
    const o = pick(c.r, options);
    c.plan.push({ u, name: o.name, input: o.input, what: `${o.name} after a ban` });
  }
}

/** The removal rule, checked on the stored records (no oracle): a removed
 * item keeps no text, and nothing is stored under a removed thread or a
 * removed top-level reply. */
function erasureFaults(dump: ReadonlyMap<string, StoredRecord>): string[] {
  const out: string[] = [];
  const threads = new Set<string>();
  const replies = new Set<string>();
  for (const [k, r] of dump) {
    if (r.kind === "thread" && r.mod === "removed") {
      threads.add(r.id);
      if (r.q || r.t || r.sum) out.push(`removed ${k} keeps its text`);
    }
    if (r.kind === "followup" && r.mod === "removed" && (r.q || r.a))
      out.push(`removed ${k} keeps its text`);
    if (r.kind === "reply" && r.mod === "removed") {
      if (r.parent === null) replies.add(r.id);
      if (r.t) out.push(`removed ${k} keeps its text`);
    }
  }
  for (const [k, r] of dump) {
    if ((r.kind === "followup" || r.kind === "reply" || r.kind === "run") && threads.has(r.th))
      out.push(`${k} is stored under a removed thread`);
    if (r.kind === "reply" && r.parent !== null && replies.has(r.parent))
      out.push(`${k} is stored under a removed reply`);
  }
  return out;
}

/** Nest `v` `depth` levels deep in arrays. */
const nest = (v: unknown, depth: number): unknown => (depth ? [nest(v, depth - 1)] : v);

async function sequence(t: ExecutionContext, seed: number): Promise<boolean> {
  const faults = { random: false, effects: false, loss: false };
  const serverRandom = rng(seed ^ 0x5eed);
  const effectDice = rng(seed * 31 + 3);
  const w = new World(seed, {
    random: () => {
      if (faults.random) throw new Error("the random source is unavailable");
      return serverRandom();
    },
    failEffect: () => faults.effects && effectDice() < 0.7,
  });
  const c: Ctx = {
    seed,
    w,
    r: rng(seed * 7919 + 17),
    sent: [],
    model: new WriteModel(),
    devices: [],
    raw: new Map(),
    plan: [],
    origins: new Map(),
    marks: 0,
    faults,
    writes: new Map(),
    direct: new Map(),
    localOf: new Map(),
    applied: new Map(),
    admissions: new Map(),
    history: new Map(),
    tokens: [],
    reports: new Set(),
    runs: new Set(),
  };
  // a starting point: one open and one closed space with a few members
  const open = w.id();
  const closed = w.id();
  await ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  await ok(
    t,
    w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "listed", invite: "members" }),
  );
  for (const u of ["mona", "mel", "eve"]) await ok(t, w.as(u, "spaces.join", { space: open }));
  for (const u of ["ada", "mona", "mel"]) {
    await ok(t, w.as(u, "joinRequests.create", { space: closed, rulesAccepted: true }));
    await ok(
      t,
      w.as("olga", "joinRequests.decide", {
        space: closed,
        users: [u],
        decision: "approve",
        base: w.requests(closed, [u]),
      }),
    );
  }
  await ok(
    t,
    w.as("olga", "members.setRole", {
      space: closed,
      user: "mona",
      role: "mod",
      base: w.member(closed, "mona"),
    }),
  );

  const failures: string[] = [];
  const people: (Person | null)[] = [...PEOPLE, null];
  // every key each reader could read at some step: a pull may name (put or
  // del) only these, so it never exposes the key of a record outside the
  // reader's scope
  const knowable = new Map<string, Set<string>>();
  const known = (u: string | null, log: LogId) => {
    const k = `${u} ${log}`;
    let set = knowable.get(k);
    if (!set) knowable.set(k, (set = new Set()));
    return set;
  };
  /** Whether the marker is stored now, in the record and field it was
   * written to, and that record is not removed. */
  const storedNow = (m: string) => {
    const o = c.origins.get(m);
    if (!o) return null;
    // a key ending in "*": any record whose key starts with the rest
    const recs = o.key.endsWith("*")
      ? [...w.server.dump()].filter(([k]) => k.startsWith(o.key.slice(0, -1))).map(([, r]) => r)
      : [w.get(o.key)];
    for (const r of recs) {
      const rec = r as Record<string, unknown> | undefined;
      if (rec && JSON.stringify(rec[o.field] ?? null).includes(m) && rec["mod"] !== "removed")
        return rec;
    }
    return null;
  };
  const isStaff = (sp: string, reader: string | null) => {
    const role = reader === null ? null : roleNow(c, sp, reader);
    return role !== null && STAFF_ROLES.has(role);
  };
  /** The secret check: may `reader` see the text that carries `m`, now? */
  const mayShow = (reader: string | null, m: string): boolean => {
    const rec = storedNow(m);
    if (!rec) return false;
    // a space's settings are public, with the space record
    if (rec["kind"] === "space") return true;
    // a report's reason and note, a request's answers and decline reason:
    // their person and the space's staff
    if (rec["kind"] === "report") return reader === rec["by"] || isStaff(String(rec["sp"]), reader);
    if (rec["kind"] === "request") return reader === rec["u"] || isStaff(String(rec["sp"]), reader);
    const sp = String(rec["s"]);
    const space = w.get(`space:${sp}`);
    const role = reader === null ? null : roleNow(c, sp, reader);
    if (space?.kind !== "space" || (space.vis !== "open" && role === null)) return false;
    if (rec["mod"] === "hidden" && reader !== rec["u"] && !(role !== null && STAFF_ROLES.has(role)))
      return false;
    return true;
  };
  const scan = (reader: string | null, what: string, response: unknown) => {
    for (const m of JSON.stringify(response).match(MARKER) ?? [])
      if (!mayShow(reader, m))
        failures.push(`${what} to ${reader} carries ${m} (${JSON.stringify(c.origins.get(m))})`);
  };
  /** Count the spaces' openings and closings, as the stored records show them. */
  const refreshHistory = () => {
    for (const s of records(c, "space")) {
      const h = c.history.get(s.id) ?? { closed: s.vis !== "open", n: 0 };
      if (h.closed !== (s.vis !== "open")) {
        h.closed = !h.closed;
        h.n++;
      }
      c.history.set(s.id, h);
    }
  };
  const spaceHistory = (log: LogId) => {
    refreshHistory();
    return log.startsWith("space:") ? (c.history.get(log.slice(6))?.n ?? 0) : 0;
  };
  const stash = (u: string | null, log: LogId, cursor: string) => {
    if (c.tokens.length > 300) c.tokens.splice(0, 100);
    if (chance(c.r, 0.2)) c.tokens.push({ u, log, cursor, n: spaceHistory(log) });
  };
  const reader = (a: Actor | null) => (a?.u === "null" ? null : (a?.u ?? null));

  /** Apply one envelope as `u`, checked against the write oracle and the
   * effect model. A fault goes to `failures`. */
  const applyChecked = async (u: Who, e: Envelope, what: string): Promise<ApplyResult> => {
    const now = w.clock.now();
    const before = new Map(w.server.dump());
    c.model.randomDown = faults.random;
    const p = c.model.predict(before, u, e, now);
    const res = await w.server.apply(actor(u), e);
    scan(u, `apply ${e.name}`, res);
    const got = res.ok ? "ok" : res.error.code;
    tally(`${got} ${e.name}`);
    if (got !== p.code) {
      failures.push(
        `${what}: the write oracle predicted ${p.code}, the server answered ${JSON.stringify(res)}\n${JSON.stringify(e).slice(0, 600)}`,
      );
      return res;
    }
    // a write applied now (not a replay) changes exactly what the effect
    // model predicts; anything else changes nothing
    const fresh = p.code === "ok" && p.stored && u !== null && u !== "null";
    const effects = fresh
      ? predictEffects(before, u, e.name, e.input as Record<string, unknown>, now, c.admissions)
      : { keys: new Map(), fresh: [] };
    const fault = checkEffects(before, w.server.dump(), effects, res.ok ? res.result : null);
    if (fault) failures.push(`${what}: the effect model: ${fault}\n${JSON.stringify(e)}`);
    c.model.commit(u, e, p, now);
    c.model.learn(w.server.dump());
    refreshHistory();
    // a flush sends many writes in one step: what each reader may read is
    // learned after each of them
    learn();
    for (const r of w.server.dump().values())
      if (r.kind === "member") {
        const k = `${r.sp}:${r.u}`;
        c.admissions.set(k, (c.admissions.get(k) ?? new Set()).add(r.adm));
      }
    if (fresh) {
      const local = c.localOf.get(`${u} ${e.mutationId}`);
      if (local !== undefined) {
        const n = (c.applied.get(local) ?? 0) + 1;
        c.applied.set(local, n);
        if (n > 1) failures.push(`${what}: write ${local} (${e.name}) was applied ${n} times`);
      }
      if (e.name === "reports.create") c.reports.add(String((e.input as { id: string }).id));
      if (e.name === "threads.create" && res.ok) {
        const run = (res.result as { run: string | null }).run;
        if (run) c.runs.add(run);
      }
      if (e.name === "members.ban") {
        const i = e.input as { space: string; user: Person };
        afterBan(c, i.space, i.user);
      }
      if (e.name === "joinRequests.decide" && chance(c.r, 0.7)) {
        const i = e.input as { space: string; users: Person[]; decision: string };
        const who = i.users[0];
        if (i.decision === "decline" && who && PEOPLE.includes(who))
          c.plan.push({
            u: who,
            name: "joinRequests.create",
            input: (c) => ({
              space: i.space,
              rulesAccepted: true,
              answers: [marked(c, `request:${i.space}:*`, "a")],
            }),
            what: "asking again after a decline",
          });
      }
    }
    const owner =
      c.devices.find((d) => d.cl.clientId === e.clientId)?.u ??
      [...c.raw].find(([, id]) => id === e.clientId)?.[0];
    if (owner !== undefined) {
      c.model.read(owner, e.clientId, w.clock.now());
      const s = await w.server.snapshot(actor(owner), `user:${owner}`, { clientId: e.clientId });
      if (s.lastSeq !== (c.model.lastSeq(e.clientId) ?? null))
        failures.push(
          `${what}: last seq ${s.lastSeq}, the model has ${c.model.lastSeq(e.clientId)}`,
        );
    }
    return res;
  };

  /** The server as the readers and writers reach it: every response is
   * scanned for markers, registrations are checked against the model, and a
   * pull names only keys the reader could read. */
  const watched: ServerHalf = {
    register: async (a) => {
      const now = w.clock.now();
      c.model.randomDown = faults.random;
      const want = c.model.predictRegister(a?.u ?? null, now);
      const res = await w.server.register(a);
      const got = res.ok ? "ok" : res.error.code;
      if (got !== want) failures.push(`register ${a?.u}: the model predicted ${want}, got ${got}`);
      if (res.ok && a) c.model.registered(res.clientId, a.u, now);
      return res;
    },
    apply: (a, e) => applyChecked((a?.u ?? null) as Who, e, `apply ${e.name}`),
    snapshot: async (a, log, o) => {
      const s = await w.server.snapshot(a, log, o);
      c.model.read(a?.u ?? null, o?.clientId, w.clock.now());
      scan(reader(a), `snapshot of ${log}`, s);
      stash(reader(a), log, s.cursor);
      return s;
    },
    pull: async (a, log, cursor, o) => {
      const p = await w.server.pull(a, log, cursor, o);
      scan(reader(a), `pull of ${log}`, p);
      if (!("resync" in p)) {
        c.model.read(a?.u ?? null, o?.clientId, w.clock.now());
        stash(reader(a), log, p.cursor);
        const set = known(reader(a), log);
        for (const ch of p.changes)
          if (!set.has(ch.key)) failures.push(`${reader(a)} got ${ch.op} ${ch.key} in ${log}`);
      }
      return p;
    },
  };

  /** A device's view of the server: the same, but an answer may be lost on
   * the way back after the server applied the write. */
  const deviceApi = (dev: () => Device): ServerHalf => ({
    register: (a) => watched.register(a),
    snapshot: (a, l, o) => watched.snapshot(a, l, o),
    pull: (a, l, cur, o) => watched.pull(a, l, cur, o),
    apply: async (_a, e) => {
      const d = dev();
      // a write the client gave new ids (after CLOCK_SKEW): its markers now
      // belong to the record under the new id
      const id = (e.input as { id?: unknown } | null)?.id;
      if (typeof id === "string")
        for (const m of JSON.stringify(e.input).match(MARKER) ?? []) {
          const o = c.origins.get(m);
          const [kind, old] = o?.key.split(":") ?? [];
          if (
            o &&
            old !== id &&
            ["thread", "followup", "reply", "report", "space"].includes(kind ?? "")
          )
            o.key = `${kind}:${id}`;
        }
      const p = d.cl.pending().find((x) => x.mutationId === e.mutationId);
      if (p) c.localOf.set(`${d.u} ${e.mutationId}`, p.local);
      d.lastLocal = p?.local;
      const res = await applyChecked(d.u, e, `${d.name}: ${e.name}`);
      // a device's envelope that got a recorded answer may be replayed later
      // (one answered CLOCK_SKEW is not: see the report on reminted ids)
      if (res.ok || !UNRECORDED.has(res.error.code)) c.sent.push({ u: d.u, e });
      if (faults.loss && chance(c.r, 0.3)) {
        if (chance(c.r, 0.5)) throw new Error("the connection dropped");
        return { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "lost" } };
      }
      return res;
    },
  });

  // devices: one per person, two for mel and olga; and one client id per
  // person for hand-made envelopes
  for (const u of PEOPLE) {
    for (let k = 0; k < (u === "mel" || u === "olga" ? 2 : 1); k++) {
      const name = `${u}#${k + 1}`;
      const dev: Device = {
        u,
        name,
        skew: 0,
        cl: null as unknown as ReplicaClient,
        answered: new Map(),
        seen: 0,
        api: null as unknown as ServerHalf,
        lastLocal: undefined,
      };
      dev.api = deviceApi(() => dev);
      dev.cl = new ReplicaClient(dev.api, actor(u), {
        clock: { now: () => w.clock.now() + dev.skew },
        random: c.r,
      });
      c.devices.push(dev);
    }
    const res = await watched.register(actor(u));
    if (!res.ok) return (t.fail(`register ${u}`), false);
    c.raw.set(u, res.clientId);
  }
  // the setup's writes came from each person's default client
  for (const u of PEOPLE) c.model.registered(await w.clientId(u), u, w.clock.now());
  c.model.learn(w.server.dump());
  for (const r of w.server.dump().values())
    if (r.kind === "member") c.admissions.set(`${r.sp}:${r.u}`, new Set([r.adm]));
  for (const s of records(c, "space")) c.history.set(s.id, { closed: s.vis !== "open", n: 0 });

  /** Read a device client's new recorded answers into the suite's record. */
  const harvest = (d: Device) => {
    for (; d.seen < d.cl.answered.length; d.seen++) {
      const a = d.cl.answered[d.seen];
      if (a) d.answered.set(a.local, a.result);
    }
  };
  const flush = async (d: Device) => {
    await d.cl.flush();
    harvest(d);
  };
  const queue = (d: Device, name: string, input: unknown, mutationId?: string) => {
    const p = d.cl.queue(name, input, mutationId);
    c.writes.set(p.local, { u: d.u, dev: d, name });
  };
  /** The device restarts: its state is saved and restored, maybe with its
   * clock changed. */
  const restart = (d: Device) => {
    harvest(d);
    const state = d.cl.state();
    d.cl = new ReplicaClient(
      d.api,
      actor(d.u),
      { clock: { now: () => w.clock.now() + d.skew }, random: c.r },
      state,
    );
    d.seen = 0;
  };
  const SKEWS = [0, 0, -10 * MINUTE, -10 * DAY, -2 * DAY, 2 * MINUTE, HOUR, "reset"] as const;
  const newSkew = (d: Device) => {
    const s = pick(c.r, SKEWS);
    d.skew = s === "reset" ? RESET - w.clock.now() : s;
  };

  /** Every write's state: still queued, or ended (answered, or shown to the
   * person), and applied at most once (`applyChecked` checks that). */
  const outcomes = (final: boolean): string[] => {
    const out: string[] = [];
    for (const [local, x] of c.writes) {
      const queued = x.dev.cl.pending().find((p) => p.local === local);
      const answer = x.dev.answered.get(local) ?? c.direct.get(local);
      const shown = x.dev.cl.problems().find((p) => p.local === local);
      const n = c.applied.get(local) ?? 0;
      if (queued) {
        if (final)
          out.push(
            `${x.dev.name}: ${x.name} ${local} is still queued (${JSON.stringify({ ...queued, input: undefined, skew: x.dev.skew, last: x.dev.cl.sent.at(-1)?.name })})`,
          );
        continue;
      }
      if (!answer && !shown)
        out.push(
          `${x.dev.name}: ${x.name} ${local} left the outbox with no answer and was not shown`,
        );
      if (answer?.ok && n !== 1 && !c.direct.has(local))
        out.push(`${x.dev.name}: ${x.name} ${local} answered ok, applied ${n} times`);
      if (
        answer &&
        !answer.ok &&
        answer.error.code !== "EXPIRED" &&
        !c.direct.has(local) &&
        n !== 0
      )
        out.push(
          `${x.dev.name}: ${x.name} ${local} answered ${answer.error.code}, applied ${n} times`,
        );
    }
    return out;
  };

  const client = (u: Person | null) =>
    new ReplicaClient(watched, actor(u), { clock: w.clock, random: w.random });
  const eager = new Map<Person | null, ReplicaClient>(people.map((u) => [u, client(u)]));
  const lazy = (["mel", "eve", null, "otto", "ada", "mona"] as (Person | null)[]).map((u) => ({
    cl: client(u),
    next: 5 + Math.floor(c.r() * 16),
  }));
  // the logs each actor reads; eve and the signed-out caller also ask for
  // other people's user logs
  const logsFor = (u: Person | null): LogId[] => [
    ...records(c, "space").map((s) => `space:${s.id}` as LogId),
    ...(u ? [`user:${u}` as LogId] : []),
    ...(u === "eve" || u === null ? (["user:mel", "user:olga", "user:null"] as LogId[]) : []),
  ];
  /** Record what each reader may read now, before any client syncs. */
  const learn = () => {
    for (const u of people)
      for (const log of logsFor(u))
        for (const k of expected(w.server.dump(), u, log).keys()) known(u, log).add(k);
  };

  const failed = (step: number, what: string, detail: string) => {
    t.fail(`seed ${seed}, step ${step} (${what}): ${detail}`);
    return false;
  };
  const check = async (step: number, what: string, cl: ReplicaClient): Promise<boolean> => {
    const u = (cl.actor?.u ?? null) as Person | null;
    for (const log of logsFor(u)) {
      await cl.sync(log);
      const want = expected(w.server.dump(), u, log);
      if (failures.length) return failed(step, what, failures.slice(0, 3).join("\n"));
      const d = diff(cl.records(log), want);
      if (d) return failed(step, what, `${u}'s replica of ${log}\n${d}`);
      const snap = await watched.snapshot(actor(u), log);
      const s = diff(new Map(snap.records.map((x) => [x.key, x.record])), want);
      if (s) return failed(step, what, `${u}'s snapshot of ${log}\n${s}`);
      // a frozen copy holds only what the reader wrote
      for (const [k, x] of cl.frozen(log))
        if (!("u" in x) || x.u !== u || cl.records(log).has(k))
          return failed(step, what, `${u} holds a frozen ${k}`);
      // the staff invariant at read time, with no oracle: a person's user log
      // holds report notifications only for spaces where they are staff now
      if (u !== null && log === `user:${u}`)
        for (const x of [...cl.records(log).values(), ...snap.records.map((y) => y.record)])
          if (x.kind === "notif" && !isStaff(x.sp, u))
            return failed(step, what, `${u} holds a notification of ${x.sp}, not being staff`);
    }
    return true;
  };

  /** The state invariants, checked on the stored records and on every value
   * at rest after each step (no oracle):
   * - each space has exactly one owner;
   * - nobody has a member record in a space they are banned from;
   * - no tombstone is older than 30 days;
   * - the notifications of a report go to the space's staff (owner, admins,
   *   moderators) when the worker wrote them, and to nobody else;
   * - no effect is lost: every report has its notifications, or its effect
   *   is queued or a dead letter; every run has its job, likewise;
   * - no marker is at rest anywhere unless it is still in the record and
   *   field it was written to, and that record is not removed. */
  const notified = new Set<string>();
  const invariants = async (step: number, final = false): Promise<string[]> => {
    const out: string[] = [];
    const dump = w.server.dump();
    for (const s of records(c, "space")) {
      const owners = records(c, "member").filter((m) => m.sp === s.id && m.role === "owner");
      if (owners.length !== 1) out.push(`#${s.name} has ${owners.length} owners`);
    }
    for (const b of records(c, "ban"))
      if (dump.has(`member:${b.sp}:${b.u}`)) out.push(`${b.u} is a member of ${b.sp} and banned`);
    const scan = await w.server.scanStorage();
    for (const tomb of scan.tombstones)
      if (tomb.at < w.clock.now() - 30 * DAY)
        out.push(`a tombstone of ${tomb.key} outlived 30 days`);
    const fresh = new Map<string, { sp: string; to: string[] }>();
    for (const [k, n] of dump) {
      if (n.kind !== "notif" || notified.has(k)) continue;
      notified.add(k);
      const g = fresh.get(n.report) ?? { sp: n.sp, to: [] };
      g.to.push(n.to);
      fresh.set(n.report, g);
    }
    for (const [report, g] of fresh) {
      const staff = records(c, "member")
        .filter((m) => m.sp === g.sp && STAFF_ROLES.has(m.role))
        .map((m) => m.u)
        .sort();
      if (JSON.stringify(g.to.sort()) !== JSON.stringify(staff))
        out.push(`report ${report} notified ${g.to.join()}, its staff are ${staff.join()}`);
    }
    const pending = (e: unknown) => JSON.stringify(e);
    const queuedOrDead = new Set(
      [...scan.effects.map((x) => x.effect), ...scan.deadLetters.map((x) => x.effect)].map(pending),
    );
    const notifiedReports = new Set(records(c, "notif").map((n) => n.report));
    for (const report of c.reports)
      if (
        !notifiedReports.has(report) &&
        ![...queuedOrDead].some((e) => e.includes(`"report":"${report}"`))
      )
        out.push(`the notifications of report ${report} were lost`);
    const jobs = new Set(scan.jobs.map((j) => j.id));
    for (const run of c.runs)
      if (!jobs.has(run) && ![...queuedOrDead].some((e) => e.includes(`"id":"${run}"`)))
        out.push(`the job of run ${run} was lost`);
    if (final && scan.effects.length) out.push(`${scan.effects.length} effects never ran`);
    for (const [table, values] of Object.entries(scan))
      for (const m of JSON.stringify(values).match(MARKER) ?? [])
        if (!storedNow(m))
          out.push(
            `step ${step}: ${m} is at rest in ${table} (${JSON.stringify(c.origins.get(m))})`,
          );
    return out;
  };

  /** A pull from a cursor the reader did not get for this log: another
   * reader's token, the reader's token of another log, a token with a byte
   * changed (each must resync), or a token the reader was served earlier
   * (resync if the log's history was replaced since; otherwise resync, or
   * changes all in the reader's scope). Also checks that what a read hands
   * out is a copy. */
  const forged = async (step: number): Promise<boolean> => {
    const u = pick(c.r, people);
    const logs = logsFor(u);
    const log = pick(c.r, logs);
    const s = await watched.snapshot(actor(u), log);
    const roll = c.r();
    let cursor: string;
    let mustResync: boolean;
    let what: string;
    if (roll < 0.25) {
      const other = pick(
        c.r,
        people.filter((x) => x !== u),
      );
      cursor = (await watched.snapshot(actor(other), log)).cursor;
      mustResync = true;
      what = `${other}'s token`;
    } else if (roll < 0.45) {
      const elsewhere = pick(c.r, [...logs.filter((l) => l !== log), `space:${w.id()}` as LogId]);
      cursor = (await watched.snapshot(actor(u), elsewhere)).cursor;
      mustResync = true;
      what = `the token of ${elsewhere}`;
    } else if (roll < 0.55) {
      const raw = Buffer.from(s.cursor, "base64url");
      const k = Math.floor(c.r() * raw.length);
      raw[k] = (raw[k] ?? 0) ^ (1 << Math.floor(c.r() * 8));
      cursor = raw.toString("base64url");
      mustResync = true;
      what = "a token with a changed byte";
    } else {
      const mine = c.tokens.filter((x) => x.u === u && x.log === log);
      const old = mine.length ? pick(c.r, mine) : { cursor: s.cursor, n: spaceHistory(log) };
      cursor = old.cursor;
      mustResync = old.n !== spaceHistory(log);
      what = `an earlier token of history ${old.n}, now ${spaceHistory(log)}`;
    }
    const p = await watched.pull(actor(u), log, cursor);
    if (failures.length)
      return failed(step, `forged cursor: ${what}`, failures.slice(0, 3).join("\n"));
    if (mustResync && !("resync" in p))
      return failed(step, `forged cursor: ${what}`, `${u}'s pull of ${log} did not resync`);
    const want = expected(w.server.dump(), u, log);
    for (const ch of "resync" in p ? [] : p.changes) {
      const bad =
        ch.op === "put"
          ? JSON.stringify(ch.record) !== JSON.stringify(want.get(ch.key))
          : want.has(ch.key);
      if (bad)
        return failed(step, `forged cursor: ${what}`, `${u} got ${ch.op} ${ch.key} in ${log}`);
    }
    const stored = JSON.stringify([...w.server.dump()]);
    for (const x of s.records) Object.assign(x.record, { rev: -1 });
    if (!("resync" in p))
      for (const ch of p.changes) if (ch.op === "put") Object.assign(ch.record, { rev: -1 });
    if (JSON.stringify([...w.server.dump()]) !== stored)
      return failed(step, "forged cursor", "a read handed out the server's own records");
    return true;
  };

  /** One write from a device: a planned or a generated mutation, sometimes
   * made hostile in ways an honest client could also send. */
  const deviceWrite = async (): Promise<string> => {
    const planned = c.plan.shift();
    if (planned) {
      const d = pick(
        c.r,
        c.devices.filter((x) => x.u === planned.u),
      );
      queue(d, planned.name, planned.input(c, d));
      await flush(d);
      return `${d.name}: ${planned.what}`;
    }
    let u: Person = pick(c.r, PEOPLE);
    const name = pick(c.r, WEIGHTED);
    // the staff's writes mostly come from staff, so they succeed often enough
    if (STAFF_WRITES.has(name) && chance(c.r, 0.5))
      u = pick(c.r, ["olga", "olga", "ada", "mona"] as const);
    // and requests to join mostly from people outside the closed spaces
    if (name === "joinRequests.create" && chance(c.r, 0.6))
      u = pick(c.r, ["otto", "eve", "mel"] as const);
    const d = pick(
      c.r,
      c.devices.filter((x) => x.u === u),
    );
    let input: Record<string, unknown> = (GENERATORS[name] as Gen)(c, u, d);
    let what = `${d.name}: ${name}`;
    let mutationId: string | undefined;
    let sentName = name;
    // a second moderator decides the same request (a stale decision)
    if (name === "joinRequests.decide" && chance(c.r, 0.4)) {
      const other = pick(c.r, ["olga", "ada", "mona"] as const);
      const same = { ...input };
      c.plan.push({ u: other, name, input: () => same, what: "the same decision again" });
    }
    if (u === "eve" || chance(c.r, 0.12)) {
      const now = d.cl.now();
      switch (Math.floor(c.r() * 7)) {
        case 0:
          input = { ...input, likes: 999, u: "olga" };
          what += " with forged fields";
          break;
        case 1:
          sentName = pick(c.r, ["spaces.nuke", "__proto__", "toString", "saved.toggle"]);
          what = `${d.name}: unknown ${sentName}`;
          break;
        case 2:
          mutationId = ulid(now - pick(c.r, [5 * DAY, 2 * MINUTE, DAY]), c.r);
          what += " with an old mutation id";
          break;
        case 3:
          mutationId = c.sent.length ? pick(c.r, c.sent).e.mutationId : undefined;
          what += " with someone's mutation id";
          break;
        case 4:
          if ("id" in input) input = { ...input, id: "not-a-ulid" };
          else mutationId = "G".repeat(1 + Math.floor(c.r() * 40));
          what += " with a malformed id";
          break;
        case 5:
          if ("id" in input) input = { ...input, id: ulid(now + 2 * MINUTE, c.r) };
          what += " with a future id";
          break;
        default:
          input = { ...input, extra: nest(1, 30 + Math.floor(c.r() * 6)) };
          what += " nested deep";
      }
    }
    if (sentName === "spaces.create") {
      d.lastLocal = undefined;
      const res = await d.cl.send(sentName, input, mutationId);
      harvest(d);
      // the online write's local id: the one the device sent last, unless
      // that was a queued write (then the flush stopped before it)
      const id = d.lastLocal;
      if (id !== undefined && !c.writes.has(id)) {
        c.writes.set(id, { u: d.u, dev: d, name: sentName });
        c.direct.set(id, res);
      }
      return `${what} (online)`;
    }
    queue(d, sentName, input, mutationId);
    if (chance(c.r, 0.75)) await flush(d);
    else what += " (queued)";
    return what;
  };

  /** One hand-made envelope, as a hostile client sends it. */
  const rawWrite = async (): Promise<string> => {
    const r = c.r;
    // a replay: an envelope sent before, as its sender or as someone else
    if (c.sent.length && chance(r, 0.25)) {
      const old = pick(r, c.sent);
      const who: Who = chance(r, 0.5) ? old.u : pick(r, PEOPLE);
      const what = `replay of ${old.e.name} as ${who}`;
      await applyChecked(who, old.e, what);
      return what;
    }
    const roll = r();
    const u: Who = roll < 0.1 ? null : roll < 0.15 ? "null" : pick(r, PEOPLE);
    const person: Person = u === null || u === "null" ? "eve" : u;
    const name = pick(r, WEIGHTED);
    let input: unknown = (GENERATORS[name] as Gen)(c, u, null);
    let clientId = c.raw.get(person) ?? "";
    let seq = (c.model.lastSeq(clientId) ?? 0) + 1;
    let protocolVersion = PROTOCOL_VERSION;
    let clientTime = w.clock.now();
    let what = `${u} raw: ${name}`;
    switch (Math.floor(r() * 9)) {
      case 0:
        seq += 1 + Math.floor(r() * 3);
        what += " with a gap in its seq";
        break;
      case 1:
        seq = Math.max(1, seq - 1 - Math.floor(r() * 3));
        what += " with an earlier seq";
        break;
      case 2: {
        const others = c.devices.filter((d) => d.u !== person && d.cl.clientId !== null);
        clientId =
          others.length && chance(r, 0.8) ? (pick(r, others).cl.clientId ?? "") : "made-up";
        what += " from another person's client";
        break;
      }
      case 3:
        protocolVersion = 2;
        what += " from an old protocol version";
        break;
      case 4:
        clientTime += pick(r, [2 * MINUTE, -2 * MINUTE, -3 * DAY, HOUR]);
        what += " from a clock that is off";
        break;
      case 5:
        input = nest(input, 33 + Math.floor(r() * 10));
        what += " nested more than 32 deep";
        break;
      case 6:
        input = { ...(input as object), q: "x".repeat(300_000) };
        what += " larger than 256 KB";
        break;
      default:
    }
    const e: Envelope = {
      clientId,
      seq,
      mutationId: w.id(),
      name,
      input,
      protocolVersion,
      clientTime,
    };
    const res = await applyChecked(u, e, what);
    if (u !== null && chance(r, 0.5)) c.sent.push({ u, e });
    // the hand-made client expired (idle 90 days): it registers again
    if (!res.ok && res.error.code === "WRONG_CLIENT" && clientId === c.raw.get(person)) {
      const again = await watched.register(actor(person));
      if (again.ok) c.raw.set(person, again.clientId);
    }
    return what;
  };

  learn();
  for (const cl of eager.values()) if (!(await check(-1, "setup", cl))) return false;
  for (let step = 0; step < STEPS; step++) {
    let what: string;
    const roll = c.r();
    if (roll < 0.05) {
      w.clock.advance(Math.floor(c.r() * 6 * HOUR));
      what = "clock +hours";
    } else if (roll < 0.065) {
      w.clock.advance(4 * DAY);
      what = "clock +4 days";
    } else if (roll < 0.07) {
      w.clock.advance(31 * DAY);
      what = "clock +31 days";
    } else if (roll < 0.077) {
      // exactly the tombstones' lifetime: cursors from this millisecond sit on the boundary
      w.clock.advance(30 * DAY);
      what = "clock +30 days exactly";
    } else if (roll < 0.081) {
      // every client record expires (idle for 90 days)
      w.clock.advance(91 * DAY);
      what = "clock +91 days";
    } else if (roll < 0.11) {
      if (!(await forged(step))) return false;
      what = "forged cursor";
    } else if (roll < 0.14) {
      // a run finishes: a thread's summary or a follow-up's answer, with a marker
      const items = [
        ...records(c, "thread").map((p) => ({ key: `thread:${p.id}`, field: "sum" })),
        ...records(c, "followup").map((f) => ({ key: `followup:${f.id}`, field: "a" })),
      ];
      const item = items.length ? pick(c.r, items) : null;
      what = `a run finishes for ${item?.key ?? "nothing"}`;
      if (item) await w.server.finishJob(item.key, marked(c, item.key, item.field));
    } else if (roll < 0.18) {
      const d = pick(c.r, c.devices);
      const x = c.r();
      if (x < 0.4) {
        if (chance(c.r, 0.5)) newSkew(d);
        restart(d);
        what = `${d.name} restarts, its clock ${d.skew} ms off`;
      } else if (x < 0.6) {
        newSkew(d);
        what = `${d.name}'s clock is now ${d.skew} ms off`;
      } else {
        what = `${d.name} flushes`;
      }
      await flush(d);
    } else if (roll < 0.2) {
      const k = pick(c.r, ["random", "effects", "loss"] as const);
      faults[k] = !faults[k];
      what = `${k} faults ${faults[k] ? "on" : "off"}`;
    } else if (roll < 0.21) {
      const u = pick(c.r, PEOPLE);
      const n = 1 + Math.floor(c.r() * 24);
      for (let k = 0; k < n; k++) await watched.register(actor(u));
      what = `${u} registers ${n} clients`;
    } else if (roll < 0.3) {
      what = await rawWrite();
    } else {
      what = await deviceWrite();
    }
    if (failures.length) return failed(step, what, failures.slice(0, 3).join("\n"));
    if (chance(c.r, 0.9)) await w.server.work();
    refreshHistory();
    learn();
    const erased = erasureFaults(w.server.dump());
    if (erased.length) return failed(step, what, erased.slice(0, 3).join("\n"));
    const broken = [...(await invariants(step)), ...outcomes(false)];
    if (broken.length) return failed(step, what, broken.slice(0, 3).join("\n"));
    for (const cl of eager.values()) if (!(await check(step, what, cl))) return false;
    for (const l of lazy)
      if (step >= l.next) {
        if (!(await check(step, what, l.cl))) return false;
        l.next = step + 5 + Math.floor(c.r() * 16);
      }
  }
  // the end: faults off, every outbox sent, every effect run
  faults.random = faults.effects = faults.loss = false;
  c.plan.length = 0;
  for (let round = 0; round < 8; round++) {
    // a day passes once, for a person who used up a day's registrations
    w.clock.advance(round === 4 ? DAY : 11 * MINUTE);
    for (const d of c.devices) await flush(d);
    await w.server.work();
  }
  if (failures.length) return failed(STEPS, "drain", failures.slice(0, 3).join("\n"));
  learn();
  const end = [...(await invariants(STEPS, true)), ...outcomes(true)];
  if (end.length) return failed(STEPS, "drain", end.slice(0, 3).join("\n"));
  for (const cl of eager.values()) if (!(await check(STEPS, "drain", cl))) return false;
  return true;
}

const TALLY = new Map<string, number>();
const tally = (k: string) => TALLY.set(k, (TALLY.get(k) ?? 0) + 1);
test.after(() => {
  if (process.env["REPLICA_PROTO_STATS"])
    console.log(
      [...TALLY]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n}\t${k}`)
        .join("\n"),
    );
});

// REPLICA_PROTO_SEED runs that one seed only (to debug a failure)
const ONE = process.env["REPLICA_PROTO_SEED"];
for (let from = ONE ? Number(ONE) : 1; from <= (ONE ? Number(ONE) : SEQUENCES); from += CHUNK) {
  const to = ONE ? from : Math.min(SEQUENCES, from + CHUNK - 1);
  test.serial(
    `writes match the write oracle and replicas the read oracle after every step: seeds ${from} to ${to}`,
    async (t) => {
      for (let seed = from; seed <= to; seed++) if (!(await sequence(t, seed))) return;
      t.pass();
    },
  );
}
