// Convergence, property-based: random sequences of writes from random actors,
// hostile ones included, with role changes, removals, bans and moderation
// mid-sequence and the clock moving forward. Every step is checked three
// ways:
//
// - The write oracle (test/write-oracle.ts) predicts each write's answer (ok
//   or the refusal's code) and whether it is recorded; the server must give
//   exactly that answer, and report the predicted last seq for the client.
// - After every step, for every actor, the replica built from a snapshot and
//   pulls must equal the read oracle's projection of the server's records
//   (test/oracle.ts), and so must a fresh snapshot. Lazy clients sync only
//   every 5 to 20 steps, so their pulls span many changes and cross the 7-
//   and 30-day limits. A pull may name (put or del) only keys the reader could
//   read at some step.
// - Every text the generator writes carries a unique marker. No response
//   (snapshot, pull, apply answer or error) may carry a marker unless the
//   marker is still stored in its record and the reader may see that text
//   now: the record is not removed, its space is open or the reader a member,
//   and if hidden, the reader is its author or the space's staff. This check
//   uses neither oracle.
//
// The generator also makes: bans followed by the banned person's own writes,
// removals of threads with follow-ups and replies, stale approvals, gapped and
// out-of-order seqs, fast clocks (refused with CLOCK_SKEW, then sent again
// from the corrected clock), client ids used by another person, and forged
// cursors.
//
// Seeds are fixed: 200 sequences of 100 steps. REPLICA_PROTO_SEQUENCES runs
// more locally (1,000 before a change is merged).

import test, { type ExecutionContext } from "ava";

import {
  ReplicaClient,
  ulid,
  type ApplyResult,
  type Envelope,
  type LogId,
  type ServerHalf,
  type StoredRecord,
} from "../src/index.js";

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
interface Attempt extends Sent {
  what: string;
}

interface Ctx {
  seed: number;
  w: World;
  r: () => number;
  sent: Sent[];
  model: WriteModel;
  /** Each person's client ids (mel and olga write from two devices). */
  clients: Map<Person, string[]>;
  /** Writes planned by earlier steps (a banned person's own writes, a second
   * decision on the same request). */
  plan: { u: Person; name: string; input: unknown; what: string }[];
  /** marker → the record and field it was written to */
  origins: Map<string, { key: string; field: string }>;
  marks: number;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const chance = (r: () => number, p: number) => r() < p;

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

/** A new id: fresh, or one that is already taken (any record's, readable or not). */
function newId(c: Ctx): string {
  if (chance(c.r, 0.05)) {
    const taken = [...c.w.server.dump().values()].flatMap((x) =>
      "id" in x && x.kind !== "ban" ? [x.id] : [],
    );
    if (taken.length) return pick(c.r, taken);
  }
  return c.w.id();
}

const words = ["why", "how", "notes", "draft", "plan"];
/** Plain text, for fields the secret check does not follow (rules, reasons). */
const plain = (c: Ctx) => `${pick(c.r, words)} ${Math.floor(c.r() * 1000)}`;
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
/** The record a moderation key names. */
const itemRecordKey = (item: string) => {
  const [k, th, sub] = item.split(":");
  return k === "f" ? `followup:${sub}` : k === "r" ? `reply:${sub}` : `thread:${th}`;
};

const GENERATORS: Record<string, (c: Ctx, u: Who) => Record<string, unknown>> = {
  "spaces.create": (c) => ({
    id: newId(c),
    name: pick(c.r, ["lounge", "lab", "new", "other", "#Lab"]),
    ...(chance(c.r, 0.5) ? { vis: pick(c.r, ["open", "listed", "unlisted"]) } : {}),
  }),
  "spaces.update": (c) => ({
    id: spaceId(c),
    set: pick(c.r, [
      { vis: pick(c.r, ["open", "listed", "unlisted"]) },
      { vis: pick(c.r, ["open", "listed"]) },
      { invite: pick(c.r, ["mods", "members"]) },
      { rules: [plain(c)] },
      { name: pick(c.r, ["lounge", "lab", "renamed"]) },
      { postsOff: chance(c.r, 0.5) },
      { policy: pick(c.r, ["request", "invite"]) },
    ]),
    ...(chance(c.r, 0.3) ? { base: { rulesRev: Math.floor(c.r() * 3) } } : {}),
  }),
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
  "threads.create": (c) => {
    const id = newId(c);
    return {
      id,
      space: spaceId(c),
      kind: pick(c.r, ["ask", "post"]),
      q: marked(c, `thread:${id}`, "q"),
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
  "followups.ask": (c) => {
    const id = newId(c);
    return { id, thread: threadId(c), q: marked(c, `followup:${id}`, "q") };
  },
  "research.createPostFollowUp": (c) => {
    const replies = records(c, "reply").filter((x) => x.parent === null);
    const top = replies.length && chance(c.r, 0.3) ? pick(c.r, replies) : null;
    const id = newId(c);
    return {
      id,
      thread: top ? top.th : threadId(c),
      t: marked(c, `reply:${id}`, "t"),
      ...(top ? { parent: top.id } : {}),
    };
  },
  "joinRequests.create": (c) => ({
    space: (() => {
      const closed = records(c, "space").filter((x) => x.vis !== "open");
      return closed.length && chance(c.r, 0.7) ? pick(c.r, closed).id : spaceId(c);
    })(),
    rulesAccepted: chance(c.r, 0.8),
    answers: ["yes"],
  }),
  "joinRequests.decide": (c) => {
    // usually an open request, so approvals change scopes; a planned second
    // decision on the same request makes the stale ones
    const all = records(c, "request");
    const open = all.filter((x) => x.st === "open");
    const reqs = open.length && chance(c.r, 0.7) ? open : all;
    const r = reqs.length ? pick(c.r, reqs) : null;
    const space = r && chance(c.r, 0.8) ? r.sp : spaceId(c);
    const user = r ? r.u : pick(c.r, PEOPLE);
    return {
      space,
      users: [user],
      decision: pick(c.r, ["approve", "approve", "decline", "reopen"]),
      base: { [user]: seenRev(c, `request:${space}:${user}`) },
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
    return { space, user, base: { rev: seenRev(c, `member:${space}:${user}`) } };
  },
  "members.ban": (c) => {
    const space = spaceId(c);
    const user = pick(c.r, PEOPLE);
    return { space, user, base: { rev: seenRev(c, `member:${space}:${user}`) } };
  },
  "invites.create": (c) => ({
    id: newId(c),
    space: spaceId(c),
    ...(chance(c.r, 0.3) ? { days: 1 } : {}),
  }),
  "reports.create": (c) => ({ id: newId(c), item: itemKey(c), why: "spam" }),
  "moderation.decide": (c) => {
    // a removal of a thread that has follow-ups or replies, often
    const busy = records(c, "thread").filter((p) => p.r > 0 && p.mod !== "removed");
    if (busy.length && chance(c.r, 0.4)) {
      const p = pick(c.r, busy);
      const item = `${p.k === "ask" ? "a" : "p"}:${p.id}`;
      return { item, decision: "removed", base: { rev: p.rev } };
    }
    const item = itemKey(c);
    return {
      item,
      decision: pick(c.r, ["hidden", "hidden", "removed", "shown"]),
      base: { rev: seenRev(c, itemRecordKey(item)) },
    };
  },
};
const NAMES = Object.keys(GENERATORS);
// role and membership changes come often, so scopes change mid-sequence
const WEIGHTED = [
  ...NAMES,
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
  const options = [
    ...(mine
      ? [
          {
            name: "threads.update",
            input: { id: mine.id, q: marked(c, `thread:${mine.id}`, "q"), base: { rev: mine.rev } },
          },
          { name: "threads.delete", input: { id: mine.id } },
        ]
      : []),
    { name: "likes.set", input: { thread: any, on: chance(c.r, 0.5) } },
    { name: "saved.set", input: { kind: "thread", id: any, on: chance(c.r, 0.5) } },
    ...(() => {
      const id = c.w.id();
      return [
        {
          name: "research.createPostFollowUp",
          input: { id, thread: any, t: marked(c, `reply:${id}`, "t") },
        },
      ];
    })(),
    {
      name: "threads.create",
      input: (GENERATORS["threads.create"] as (c: Ctx, u: Who) => object)(c, u),
    },
  ];
  for (let k = 0; k < 3; k++) {
    const o = pick(c.r, options);
    c.plan.push({ u, name: o.name, input: o.input, what: `${o.name} after a ban` });
  }
}

/** A person's client and its next seq, as the model has it. */
function clientOf(c: Ctx, u: Person) {
  const clientId = pick(c.r, c.clients.get(u) ?? []);
  return { clientId, seq: (c.model.lastSeq(clientId) ?? 0) + 1 };
}

/** One step's writes: a planned or a generated mutation, sometimes made hostile. */
function nextWrites(c: Ctx): Attempt[] {
  const r = c.r;
  const planned = c.plan.shift();
  if (planned) {
    const { clientId, seq } = clientOf(c, planned.u);
    const e = {
      clientId,
      seq,
      mutationId: c.w.id(),
      name: planned.name,
      input: planned.input,
      protocolVersion: 2,
    };
    return [{ u: planned.u, e, what: planned.what }];
  }
  // a replay: the same envelope again, as its sender or as someone else
  if (c.sent.length && chance(r, 0.06)) {
    const old = pick(r, c.sent);
    const who: Who = chance(r, 0.5) ? old.u : pick(r, PEOPLE);
    return [{ u: who, e: old.e, what: `replay of ${old.e.name} as ${who}` }];
  }
  const roll = r();
  let u: Who = roll < 0.03 ? null : roll < 0.04 ? "null" : pick(r, PEOPLE);
  const name = pick(r, WEIGHTED);
  // the staff's writes mostly come from staff, so they succeed often enough
  if (STAFF_WRITES.has(name) && chance(r, 0.5))
    u = pick(r, ["olga", "olga", "ada", "mona"] as const);
  // and requests to join mostly from people outside the closed spaces
  if (name === "joinRequests.create" && chance(r, 0.6))
    u = pick(r, ["otto", "eve", "mel"] as const);
  const person: Person = u === null || u === "null" ? "eve" : u;
  let input = (GENERATORS[name] as (c: Ctx, u: Who) => Record<string, unknown>)(c, u);
  let { clientId, seq } = clientOf(c, person);
  let mutationId = c.w.id();
  let sentName = name;
  let what = name;
  // a second moderator decides the same request (a stale approval or decline)
  if (name === "joinRequests.decide" && chance(r, 0.4)) {
    const other = pick(r, ["olga", "ada", "mona"] as const);
    c.plan.push({ u: other, name, input: { ...input }, what: "the same decision again" });
  }
  if (u === "eve" || chance(r, 0.15)) {
    switch (Math.floor(r() * 10)) {
      case 0:
        input = { ...input, likes: 999, u: "olga" };
        what += " with forged fields";
        break;
      case 1:
        sentName = pick(r, ["spaces.nuke", "__proto__", "toString", "saved.toggle"]);
        what = `unknown ${sentName}`;
        break;
      case 2:
        mutationId = ulid(c.w.clock.now() - pick(r, [5 * DAY, 2 * MINUTE, DAY]), r);
        what += " with an old mutation id";
        break;
      case 3:
        if (c.sent.length) mutationId = pick(r, c.sent).e.mutationId;
        what += " with someone's mutation id";
        break;
      case 4: {
        // a fast clock: refused, then sent again from the corrected clock
        const ahead = pick(r, [2 * MINUTE, 10 * MINUTE, HOUR]);
        const skewed = {
          ...input,
          ...("id" in input ? { id: ulid(c.w.clock.now() + ahead, r) } : {}),
        };
        const first: Attempt = {
          u,
          e: {
            clientId,
            seq,
            mutationId: ulid(c.w.clock.now() + ahead, r),
            name,
            input: skewed,
            protocolVersion: 2,
          },
          what: `${name} from a fast clock`,
        };
        const retry: Attempt = {
          u,
          e: { clientId, seq, mutationId: c.w.id(), name, input, protocolVersion: 2 },
          what: `${name} sent again from the corrected clock`,
        };
        return [first, retry];
      }
      case 5:
        if ("id" in input) input = { ...input, id: "not-a-ulid" };
        else mutationId = "G".repeat(1 + Math.floor(r() * 40));
        what += " with a malformed id";
        break;
      case 6:
        seq += 1 + Math.floor(r() * 3);
        what += " with a gap in its seq";
        break;
      case 7:
        seq = Math.max(1, seq - 1 - Math.floor(r() * 3));
        what += " with an earlier seq";
        break;
      case 8: {
        const others = PEOPLE.filter((p) => p !== person);
        clientId = chance(r, 0.8) ? pick(r, c.clients.get(pick(r, others)) ?? []) : "made-up";
        what += " from another person's client";
        break;
      }
      default:
        if (chance(r, 0.5)) {
          input = {
            ...input,
            ...("id" in input ? { id: ulid(c.w.clock.now() + 2 * MINUTE, r) } : {}),
          };
          what += " with a future id";
        } else {
          what += " from an old protocol version";
          return [{ u, e: { clientId, seq, mutationId, name, input, protocolVersion: 1 }, what }];
        }
    }
  }
  return [{ u, e: { clientId, seq, mutationId, name: sentName, input, protocolVersion: 2 }, what }];
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

async function sequence(t: ExecutionContext, seed: number): Promise<boolean> {
  const w = new World(seed);
  const c: Ctx = {
    seed,
    w,
    r: rng(seed * 7919 + 17),
    sent: [],
    model: new WriteModel(),
    clients: new Map(),
    plan: [],
    origins: new Map(),
    marks: 0,
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
  /** The secret check: may `reader` see the text that carries `m`, now? */
  const mayShow = (reader: string | null, m: string): boolean => {
    const o = c.origins.get(m);
    const rec = o && (w.get(o.key) as Record<string, unknown> | undefined);
    if (!o || !rec || typeof rec[o.field] !== "string" || !(rec[o.field] as string).includes(m))
      return false;
    if (rec["mod"] === "removed") return false;
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
  const watched: ServerHalf = {
    register: (a) => w.server.register(a),
    apply: async (a, e) => {
      const res = await w.server.apply(a, e);
      scan(a?.u ?? null, `apply ${e.name}`, res);
      return res;
    },
    snapshot: async (a, log, o) => {
      const s = await w.server.snapshot(a, log, o);
      scan(a?.u ?? null, `snapshot of ${log}`, s);
      return s;
    },
    pull: async (a, log, cursor, o) => {
      const p = await w.server.pull(a, log, cursor, o);
      scan(a?.u ?? null, `pull of ${log}`, p);
      if (!("resync" in p)) {
        const set = known(a?.u ?? null, log);
        for (const ch of p.changes)
          if (!set.has(ch.key)) failures.push(`${a?.u ?? null} got ${ch.op} ${ch.key} in ${log}`);
      }
      return p;
    },
  };
  // writers: one client per person, two for mel and olga
  for (const u of PEOPLE) {
    const ids: string[] = [];
    for (let k = 0; k < (u === "mel" || u === "olga" ? 2 : 1); k++) {
      const res = await watched.register(actor(u));
      if (!res.ok) return (t.fail(`register ${u}`), false);
      c.model.registered(res.clientId, u);
      ids.push(res.clientId);
    }
    c.clients.set(u, ids);
  }
  c.model.learn(w.server.dump());

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
    }
    return true;
  };

  /** A pull from a cursor the reader made up: a real epoch with any version
   * up to the real one, or a cursor the server gave another reader of the
   * same log (who may read more). Also checks that what a read hands out is
   * a copy. */
  const forged = async (step: number): Promise<boolean> => {
    const u = pick(c.r, people);
    const snaps: {
      log: ReturnType<typeof logsFor>[number];
      s: Awaited<ReturnType<typeof watched.snapshot>>;
    }[] = [];
    for (const log of logsFor(u)) snaps.push({ log, s: await watched.snapshot(actor(u), log) });
    const { log, s } = pick(c.r, snaps);
    let cursor = { epoch: s.epoch, version: Math.floor(c.r() * (s.version + 1)) };
    if (chance(c.r, 0.4)) {
      const other = await watched.snapshot(actor(pick(c.r, people)), log);
      cursor = { epoch: other.epoch, version: other.version };
    }
    const version = cursor.version;
    const p = await watched.pull(actor(u), log, cursor);
    if (failures.length)
      return failed(step, `forged cursor ${version}`, failures.slice(0, 3).join("\n"));
    const want = expected(w.server.dump(), u, log);
    for (const ch of "resync" in p ? [] : p.changes) {
      const bad =
        ch.op === "put"
          ? JSON.stringify(ch.record) !== JSON.stringify(want.get(ch.key))
          : want.has(ch.key);
      if (bad)
        return failed(step, `forged cursor ${version}`, `${u} got ${ch.op} ${ch.key} in ${log}`);
    }
    const stored = JSON.stringify([...w.server.dump()]);
    for (const x of s.records) Object.assign(x.record, { rev: -1 });
    if (!("resync" in p))
      for (const ch of p.changes) if (ch.op === "put") Object.assign(ch.record, { rev: -1 });
    if (JSON.stringify([...w.server.dump()]) !== stored)
      return failed(step, "forged cursor", "a read handed out the server's own records");
    return true;
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
    } else if (roll < 0.11) {
      if (!(await forged(step))) return false;
      what = "forged cursor";
    } else {
      const attempts = nextWrites(c);
      what = attempts.map((a) => `${a.u}: ${a.what}`).join("; ");
      for (const a of attempts) {
        const now = w.clock.now();
        const p = c.model.predict(w.server.dump(), a.u, a.e, now);
        const res: ApplyResult = await watched.apply(actor(a.u), a.e);
        const got = res.ok ? "ok" : res.error.code;
        tally(`${got} ${a.e.name}`);
        if (got !== p.code)
          return failed(
            step,
            what,
            `the write oracle predicted ${p.code}, the server answered ${JSON.stringify(res)}\n${JSON.stringify(a.e)}`,
          );
        c.model.commit(a.u, a.e, p, now);
        c.model.learn(w.server.dump());
        const owner = [...c.clients].find(([, ids]) => ids.includes(a.e.clientId))?.[0];
        if (owner !== undefined) {
          const s = await w.server.snapshot(actor(owner), `user:${owner}`, {
            clientId: a.e.clientId,
          });
          if (s.lastSeq !== c.model.lastSeq(a.e.clientId))
            return failed(
              step,
              what,
              `last seq ${s.lastSeq}, the model has ${c.model.lastSeq(a.e.clientId)}`,
            );
        }
        if (a.u !== null) c.sent.push({ u: a.u, e: a.e });
        if (got === "ok" && a.e.name === "members.ban") {
          const i = a.e.input as { space: string; user: Person };
          afterBan(c, i.space, i.user);
        }
        if (failures.length) return failed(step, what, failures.slice(0, 3).join("\n"));
      }
    }
    learn();
    const erased = erasureFaults(w.server.dump());
    if (erased.length) return failed(step, what, erased.slice(0, 3).join("\n"));
    for (const cl of eager.values()) if (!(await check(step, what, cl))) return false;
    for (const l of lazy)
      if (step >= l.next) {
        if (!(await check(step, what, l.cl))) return false;
        l.next = step + 5 + Math.floor(c.r() * 16);
      }
  }
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
