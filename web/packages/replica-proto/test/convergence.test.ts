// Convergence, property-based: random sequences of writes from random actors,
// hostile ones included, with role changes, removals, bans and moderation
// mid-sequence and the clock moving forward. After every step, for every
// actor, the replica built from a snapshot and pulls must equal the read
// rules' projection of the server's records (test/oracle.ts), and so must a
// fresh snapshot. Lazy clients sync at random steps, so pulls also span many
// changes and cross the 7- and 30-day limits.
//
// Seeds are fixed: 200 sequences of 100 steps. REPLICA_PROTO_SEQUENCES runs
// more locally.

import test, { type ExecutionContext } from "ava";

import {
  ReplicaClient,
  ulid,
  type Envelope,
  type LogId,
  type ServerHalf,
  type StoredRecord,
} from "../src/index.js";

import { DAY, HOUR, MINUTE, World, actor, ok, rng } from "./harness.js";
import { diff, expected } from "./oracle.js";

const SEQUENCES = Number(process.env["REPLICA_PROTO_SEQUENCES"] ?? 200);
const STEPS = 100;
const CHUNK = 10;
const PEOPLE = ["olga", "ada", "mona", "mel", "otto", "eve"] as const;
type Person = (typeof PEOPLE)[number] | null;

interface Ctx {
  w: World;
  r: () => number;
  sent: { u: Person; e: Envelope }[];
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
const text = (c: Ctx) => `${pick(c.r, words)} ${Math.floor(c.r() * 1000)}`;

const GENERATORS: Record<string, (c: Ctx) => unknown> = {
  "spaces.create": (c) => ({
    id: newId(c),
    name: pick(c.r, ["lounge", "lab", "new", "other", "#Lab"]),
    ...(chance(c.r, 0.5) ? { vis: pick(c.r, ["open", "listed", "unlisted"]) } : {}),
  }),
  "spaces.update": (c) => ({
    id: spaceId(c),
    set: pick(c.r, [
      { vis: pick(c.r, ["open", "listed", "unlisted"]) },
      { invite: pick(c.r, ["mods", "members"]) },
      { rules: [text(c)] },
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
  "threads.create": (c) => ({
    id: newId(c),
    space: spaceId(c),
    kind: pick(c.r, ["ask", "post"]),
    q: text(c),
  }),
  "threads.update": (c) => ({ id: threadId(c), q: text(c) }),
  "threads.delete": (c) => ({ id: threadId(c) }),
  "likes.set": (c) => ({ thread: threadId(c), on: chance(c.r, 0.7) }),
  "saved.toggle": (c) => ({
    kind: "thread",
    id: threadId(c),
    ...(chance(c.r, 0.5) ? { on: chance(c.r, 0.5) } : {}),
  }),
  "followups.ask": (c) => ({ id: newId(c), thread: threadId(c), q: text(c) }),
  "research.createPostFollowUp": (c) => {
    const replies = records(c, "reply").filter((x) => x.parent === null);
    const top = replies.length && chance(c.r, 0.3) ? pick(c.r, replies) : null;
    return {
      id: newId(c),
      thread: top ? top.th : threadId(c),
      t: text(c),
      ...(top ? { parent: top.id } : {}),
    };
  },
  "joinRequests.create": (c) => ({
    space: spaceId(c),
    rulesAccepted: chance(c.r, 0.8),
    answers: ["yes"],
  }),
  "joinRequests.decide": (c) => {
    const reqs = records(c, "request");
    const r = reqs.length ? pick(c.r, reqs) : null;
    return {
      space: r && chance(c.r, 0.8) ? r.sp : spaceId(c),
      users: [r ? r.u : pick(c.r, PEOPLE)],
      decision: pick(c.r, ["approve", "approve", "decline", "reopen"]),
    };
  },
  "members.setRole": (c) => ({
    space: spaceId(c),
    user: pick(c.r, PEOPLE),
    role: pick(c.r, ["member", "mod", "mod", "admin", "owner"]),
  }),
  "members.remove": (c) => ({ space: spaceId(c), user: pick(c.r, PEOPLE) }),
  "members.ban": (c) => ({ space: spaceId(c), user: pick(c.r, PEOPLE) }),
  "invites.create": (c) => ({
    id: newId(c),
    space: spaceId(c),
    ...(chance(c.r, 0.3) ? { days: 1 } : {}),
  }),
  "reports.create": (c) => ({ id: newId(c), item: itemKey(c), why: "spam" }),
  "moderation.decide": (c) => ({
    item: itemKey(c),
    decision: pick(c.r, ["hidden", "hidden", "removed", "shown"]),
  }),
};
const NAMES = Object.keys(GENERATORS);
// role and membership changes come often, so scopes change mid-sequence
const WEIGHTED = [
  ...NAMES,
  "threads.create",
  "threads.create",
  "spaces.join",
  "spaces.join",
  "joinRequests.create",
  "joinRequests.decide",
  "members.setRole",
  "members.setRole",
  "members.remove",
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

/** One step's write: a generated mutation, sometimes made hostile. */
function nextWrite(c: Ctx): { u: Person; e: Envelope; what: string } {
  const r = c.r;
  let u: Person = chance(r, 0.05) ? null : pick(r, PEOPLE);
  // a replay: the same envelope again, as its sender or as someone else
  if (c.sent.length && chance(r, 0.06)) {
    const old = pick(r, c.sent);
    const who = chance(r, 0.5) ? old.u : u;
    return { u: who, e: old.e, what: `replay of ${old.e.name} as ${who}` };
  }
  const name = pick(r, WEIGHTED);
  // the staff's writes mostly come from staff, so they succeed often enough
  if (STAFF_WRITES.has(name) && chance(r, 0.5))
    u = pick(r, ["olga", "olga", "ada", "mona"] as const);
  let input = (GENERATORS[name] as (c: Ctx) => unknown)(c) as Record<string, unknown>;
  let mutationId = c.w.id();
  let sentName = name;
  let what = name;
  if (u === "eve" || chance(r, 0.1)) {
    switch (Math.floor(r() * 6)) {
      case 0:
        input = { ...input, likes: 999, u: "olga" };
        what += " with forged fields";
        break;
      case 1:
        sentName = pick(r, ["spaces.nuke", "__proto__", "toString"]);
        what = `unknown ${sentName}`;
        break;
      case 2:
        mutationId = ulid(c.w.clock.now() - 4 * DAY, r);
        what += " with an old mutation id";
        break;
      case 3:
        if (c.sent.length) mutationId = pick(r, c.sent).e.mutationId;
        what += " with someone's mutation id";
        break;
      case 4:
        if ("id" in input) input = { ...input, id: ulid(c.w.clock.now() + 2 * MINUTE, r) };
        what += " with a future id";
        break;
      default:
        if ("id" in input) input = { ...input, id: "not-a-ulid" };
        what += " with a malformed id";
    }
  }
  return { u, e: { mutationId, name: sentName, input, protocolVersion: 1 }, what };
}

async function sequence(t: ExecutionContext, seed: number): Promise<boolean> {
  const w = new World(seed);
  const c: Ctx = { w, r: rng(seed * 7919 + 17), sent: [] };
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
      w.as("olga", "joinRequests.decide", { space: closed, users: [u], decision: "approve" }),
    );
  }
  await ok(t, w.as("olga", "members.setRole", { space: closed, user: "mona", role: "mod" }));

  const people: Person[] = [...PEOPLE, null];
  // every key each reader could read at some step: a pull may name (put or
  // del) only these, so it never exposes the key of a record outside the
  // reader's scope
  const knowable = new Map<string, Set<string>>();
  const known = (u: Person, log: LogId) => {
    const k = `${u} ${log}`;
    let set = knowable.get(k);
    if (!set) knowable.set(k, (set = new Set()));
    return set;
  };
  const leaks: string[] = [];
  const watched: ServerHalf = {
    apply: (a, e) => w.server.apply(a, e),
    snapshot: (a, log, tier) => w.server.snapshot(a, log, tier),
    pull: async (a, log, cursor) => {
      const p = await w.server.pull(a, log, cursor);
      if (!("resync" in p)) {
        const set = known((a?.u ?? null) as Person, log);
        for (const ch of p.changes)
          if (!set.has(ch.key)) leaks.push(`${a?.u ?? null} got ${ch.op} ${ch.key} in ${log}`);
      }
      return p;
    },
  };
  const client = (u: Person) =>
    new ReplicaClient(watched, actor(u), { clock: w.clock, random: w.random });
  const eager = new Map<Person, ReplicaClient>(people.map((u) => [u, client(u)]));
  const lazy = new Map<Person, ReplicaClient>(
    (["mel", "eve", null] as Person[]).map((u) => [u, client(u)]),
  );
  /** Record what each reader may read now, before any client syncs. */
  const learn = () => {
    for (const u of people)
      for (const log of logsFor(u))
        for (const k of expected(w.server.dump(), u, log).keys()) known(u, log).add(k);
  };
  // the logs each actor reads; eve also asks for other people's user logs
  const logsFor = (u: Person): LogId[] => [
    ...records(c, "space").map((s) => `space:${s.id}` as LogId),
    ...(u ? [`user:${u}` as LogId] : []),
    ...(u === "eve" || u === null ? (["user:mel", "user:olga"] as LogId[]) : []),
  ];

  const check = async (step: number, what: string, cl: ReplicaClient): Promise<boolean> => {
    const u = cl.actor?.u ?? null;
    for (const log of logsFor(u as Person)) {
      await cl.sync(log);
      const want = expected(w.server.dump(), u, log);
      if (leaks.length) {
        t.fail(
          `seed ${seed}, step ${step} (${what}): a pull named a key outside the reader's scope\n${leaks.slice(0, 3).join("\n")}`,
        );
        return false;
      }
      const d = diff(cl.records(log), want);
      if (d) {
        t.fail(`seed ${seed}, step ${step} (${what}): ${u}'s replica of ${log}\n${d}`);
        return false;
      }
      const snap = await w.server.snapshot(actor(u), log);
      const s = diff(new Map(snap.records.map((x) => [x.key, x.record])), want);
      if (s) {
        t.fail(`seed ${seed}, step ${step} (${what}): ${u}'s snapshot of ${log}\n${s}`);
        return false;
      }
    }
    return true;
  };

  learn();
  for (const cl of eager.values()) if (!(await check(-1, "setup", cl))) return false;
  for (let step = 0; step < STEPS; step++) {
    let what: string;
    const roll = c.r();
    if (roll < 0.06) {
      w.clock.advance(Math.floor(c.r() * 6 * HOUR));
      what = "clock +hours";
    } else if (roll < 0.075) {
      w.clock.advance(4 * DAY);
      what = "clock +4 days";
    } else if (roll < 0.08) {
      w.clock.advance(31 * DAY);
      what = "clock +31 days";
    } else {
      const next = nextWrite(c);
      what = `${next.u}: ${next.what}`;
      const res = await w.server.apply(actor(next.u), next.e);
      tally(res.ok ? `ok ${next.e.name}` : `${res.error.code} ${next.e.name}`);
      if (next.u !== null) c.sent.push({ u: next.u, e: next.e });
    }
    learn();
    for (const cl of eager.values()) if (!(await check(step, what, cl))) return false;
    for (const cl of lazy.values())
      if (chance(c.r, 0.15) && !(await check(step, what, cl))) return false;
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

for (let from = 1; from <= SEQUENCES; from += CHUNK) {
  const to = Math.min(SEQUENCES, from + CHUNK - 1);
  test(`replicas equal the scoped projection after every step: seeds ${from} to ${to}`, async (t) => {
    for (let seed = from; seed <= to; seed++) if (!(await sequence(t, seed))) return;
    t.pass();
  });
}
