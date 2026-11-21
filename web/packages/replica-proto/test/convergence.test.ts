// Convergence, property-based: random sequences of writes from random actors,
// hostile ones included, with removals, bans, moderation and restores of a
// log mid-sequence and the clock moving forward. Every step is checked four
// ways:
//
// - The write oracle (test/write-oracle.ts) predicts each envelope's answer
//   (ok or the refusal's code) and whether it is recorded; the server must
//   give exactly that answer, and report the predicted last seq for the
//   client. For a write applied now, the effect model (test/effect-model.ts)
//   predicts the records it changes, its notifications included, and the
//   server's change set must match; any other answer must change nothing.
//   Registrations are predicted too.
// - State invariants hold after every step: one owner per space, the one the
//   space record names; no member record beside a ban; no tombstone older
//   than 30 days; nobody notified of their own action, and at most one
//   unread reply, branch or comment notification per person and thread;
//   notifications served only while their person may read their space; and
//   no marker at rest (`scanStorage`) that is not still in its record and
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
//   titles, replies, node questions, quotes and look-up phrases, comments,
//   decline reasons, a space's About, and the summaries and node answers that
//   runs write when they finish (`finishJob`). No response (snapshot, pull,
//   apply answer or error) may carry a marker unless the marker is still
//   stored in its record and the reader may see that text now: a space's
//   About is public; for a request, the reader is its person or the space's
//   owner; otherwise the record is not removed, its space is open or the
//   reader a member, and if hidden, the reader is its author or the space's
//   owner. This check uses neither oracle. Removal reasons carry no marker:
//   they are the owner's text, shown with the placeholder.
//
// The generator also makes: bans followed by the banned person's own writes,
// declines followed by the person asking again, removals of threads with
// nodes, comments and replies, stale decisions, gapped and out-of-order seqs,
// old and future ids, old queue times, reminted envelopes naming other ids,
// client ids used by another person, clients idle for 90 days, bursts of
// registrations, envelopes nested too deep or too large, a failing random
// source, restores of a space log, and forged and replayed cursors (another
// reader's token, another log's token, a changed byte, a token from before
// the log's history was replaced).
//
// Seeds are fixed: 200 sequences of 100 steps. REPLICA_PROTO_SEQUENCES runs
// more locally (1,000 before a change is merged).

import { spaces } from "@session/shared";
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
  /** marker → the record and field it was written to, and where a write may
   * copy it (a node opened as its own thread: `also`) */
  origins: Map<string, { key: string; field: string; also?: { key: string; field: string }[] }>;
  marks: number;
  /** Fault switches. */
  faults: { random: boolean; loss: boolean };
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
  /** Each space log's history: how many times it was replaced (a restore). */
  history: Map<string, number>;
  /** Tokens served to readers, with the space history they were served in. */
  tokens: { u: string | null; log: LogId; cursor: string; n: number }[];
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
    ...records(c, "node").map((f) => `f:${f.th}:${f.id}`),
    ...records(c, "reply").map((x) => `r:${x.th}:${x.id}`),
    ...records(c, "comment").map((x) => `c:${x.th}:${x.id}`),
  ];
  return items.length ? pick(c.r, items) : `a:${c.w.id()}`;
}
/** A node reference in a thread: usually `r` or one of its nodes, sometimes
 * a node of another thread or a made-up one. */
function nodeRef(c: Ctx, th: string): string {
  const own = records(c, "node").filter((n) => n.th === th);
  if (chance(c.r, 0.4)) return "r";
  if (own.length && chance(c.r, 0.85)) return pick(c.r, own).id;
  // a thread without nodes: mostly its root
  if (!own.length && chance(c.r, 0.8)) return "r";
  return some(
    c,
    records(c, "node").map((n) => n.id),
  );
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** A model and an effort: mostly a registry model and an effort it accepts;
 * now and then a missing or an unknown effort, a model outside the registry
 * or an effort the model does not accept. */
const model = (c: Ctx) =>
  chance(c.r, 0.7)
    ? { model: "claude-fable", effort: pick(c.r, ["low", "medium", "high"]) }
    : chance(c.r, 0.1)
      ? { model: "m" }
      : {
          model: pick(c.r, ["claude-fable", "claude-fable", "gemini-flash", "m"]),
          effort: pick(c.r, [...EFFORTS, ...(chance(c.r, 0.05) ? ["huge"] : [])]),
        };

/** An ask thread `u` may write under, mostly (M1b review 18: the node tree
 * is reached); else any thread, or a made-up id. */
function askThreadId(c: Ctx, u: string): string {
  const spaces = new Map(records(c, "space").map((x) => [x.id, x]));
  const mine = records(c, "thread").filter((p) => {
    const sp = spaces.get(p.s);
    return (
      p.k === "ask" &&
      p.mod !== "removed" &&
      !p.gone &&
      sp !== undefined &&
      (sp.vis === "open" || c.w.get(`member:${p.s}:${u}`) !== undefined)
    );
  });
  return mine.length && chance(c.r, 0.8) ? pick(c.r, mine).id : threadId(c);
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
  const m = `mk${c.seed}§${c.marks++}§`;
  c.origins.set(m, { key, field });
  return `${pick(c.r, words)} ${m}`;
}
// "§" is in no token, code or id alphabet, so only a marker matches
const MARKER = /mk\d+§\d+§/g;

const roleNow = (c: Ctx, sp: string, u: string) => {
  const m = c.w.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.role : null;
}; /** A record's rev as the client saw it: usually now, sometimes one write ago. */
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
  return k === "f"
    ? `node:${sub}`
    : k === "r"
      ? `reply:${sub}`
      : k === "c"
        ? `comment:${sub}`
        : `thread:${th}`;
};

type Gen = (c: Ctx, u: Who, d: Device | null) => Record<string, unknown>;
const GENERATORS: Record<string, Gen> = {
  "spaces.create": (c, _u, d) => {
    const id = newId(c, d);
    return {
      id,
      name: pick(c.r, ["lounge", "lab", "new", "other", "#Lab", " -Lab ünd #2", "-lab", "x"]),
      ...(chance(c.r, 0.5) ? { vis: pick(c.r, ["open", "private"]) } : {}),
      ...(chance(c.r, 0.5) ? { desc: marked(c, `space:${id}`, "desc") } : {}),
    };
  },
  // About only (`01` C11); now and then over 300 characters
  "spaces.update": (c) => {
    const id = spaceId(c);
    return { id, desc: chance(c.r, 0.1) ? "x".repeat(301) : marked(c, `space:${id}`, "desc") };
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
    // now and then a node opened as its own thread (`03` G5), usually one
    // with an answer: its question and answer are copied to the new thread,
    // so their markers may be stored there too
    const nodes = records(c, "node");
    const open = nodes.filter(
      (n) => n.promoted === null && n.mod === null && !n.del && c.w.get(`answer:${n.id}`),
    );
    if (nodes.length && chance(c.r, open.length ? 0.35 : 0.12)) {
      const answered = open.length ? open : nodes.filter((n) => c.w.get(`answer:${n.id}`));
      const n = pick(c.r, answered.length && chance(c.r, 0.8) ? answered : nodes);
      const copied = JSON.stringify([n.q, c.w.get(`answer:${n.id}`)]).match(MARKER) ?? [];
      for (const m of copied) {
        const o = c.origins.get(m);
        if (o)
          o.also = [
            ...(o.also ?? []),
            { key: "thread:*", field: "q" },
            { key: "answer:*", field: "md" },
          ];
      }
      return { id, from: { th: n.th, node: n.id } };
    }
    const kind = pick(c.r, ["ask", "post"]);
    // a post mentions people now and then, and a handle that is no account
    const at = chance(c.r, 0.3) ? ` @${pick(c.r, [...PEOPLE, "nobody"])}` : "";
    return {
      id,
      space: spaceId(c),
      kind,
      q: marked(c, `thread:${id}`, "q") + at,
      ...(chance(c.r, 0.5) ? { title: marked(c, `thread:${id}`, "t") } : {}),
      ...(kind === "ask" ? model(c) : {}),
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
  "saved.set": (c) => ({ kind: "thread", id: threadId(c), on: chance(c.r, 0.6) }),
  // Continue, Branch, Branch here and Look up (`03` §2.1)
  "research.forkNode": (c, u, d) => {
    const id = newId(c, d);
    const thread = askThreadId(c, u ?? "");
    const look = chance(c.r, 0.3);
    // the phrase ends on a letter, so the marker survives the trim
    const phrase = chance(c.r, 0.1)
      ? "one two three four five"
      : `${marked(c, `node:${id}`, "look")}x`;
    // a look-up's quote holds its phrase, on word boundaries, usually; now
    // and then the phrase starts inside a word of it
    const quote = marked(c, `node:${id}`, "quote");
    const around = pick(c.r, [` ${phrase}.`, ` (${phrase})`, ` ${phrase}`, `x${phrase}`, ""]);
    return {
      id,
      thread,
      parent: nodeRef(c, thread),
      ...(look
        ? { kind: "lookup", look: phrase }
        : { kind: "ask", q: marked(c, `node:${id}`, "q") }),
      // a look-up carries its quote (now and then none: BAD_REQUEST)
      ...(look
        ? chance(c.r, 0.95)
          ? { quote: `${quote}${around}`, b: 1 }
          : {}
        : chance(c.r, 0.3)
          ? { quote, b: 1 }
          : {}),
      ...model(c),
    };
  },
  "comments.create": (c, u, d) => {
    const thread = askThreadId(c, u ?? "");
    const node = nodeRef(c, thread);
    // a comment to any comment of the thread, at any depth
    const tops = records(c, "comment").filter((x) => x.th === thread);
    const top = tops.length && chance(c.r, 0.3) ? pick(c.r, tops) : null;
    const id = newId(c, d);
    const at = chance(c.r, 0.3) ? ` @${pick(c.r, PEOPLE)}` : "";
    return {
      id,
      thread,
      node: top ? top.node : node,
      t: marked(c, `comment:${id}`, "t") + at,
      ...(top ? { parent: top.id } : {}),
    };
  },
  // the author's edit of a node's question, as they saw it
  "followups.update": (c, u) => {
    // mostly one of the person's own asks that is not removed or deleted
    const own = records(c, "node").filter(
      (n) => n.u === u && n.k === "ask" && n.mod !== "removed" && !n.del,
    );
    const n = own.length && chance(c.r, 0.9) ? pick(c.r, own) : null;
    const thread = n ? n.th : threadId(c);
    const node = n ? n.id : nodeRef(c, thread);
    return {
      thread,
      node,
      q: marked(c, `node:${node}`, "q"),
      base: { rev: seenRev(c, `node:${node}`) },
    };
  },
  "followups.delete": (c, u) => {
    const own = records(c, "node").filter((n) => n.u === u);
    const n = own.length && chance(c.r, 0.6) ? pick(c.r, own) : null;
    const thread = n ? n.th : threadId(c);
    return { thread, node: n ? n.id : nodeRef(c, thread) };
  },
  // stop a run, usually one that has not ended
  "research.cancelNode": (c, u) => {
    const runs = records(c, "run");
    const live = runs.filter((r) => r.u === u && (r.status === "queued" || r.status === "running"));
    const r =
      live.length && chance(c.r, 0.7) ? pick(c.r, live) : runs.length ? pick(c.r, runs) : null;
    return r ? { thread: r.th, node: r.node } : { thread: threadId(c), node: "r" };
  },
  // run a stopped run again, on a model now and then outside the registry
  "research.retryNode": (c, u) => {
    const runs = records(c, "run");
    const stopped = runs.filter((r) => r.u === u && r.status === "cancelled");
    const r =
      stopped.length && chance(c.r, 0.7)
        ? pick(c.r, stopped)
        : runs.length
          ? pick(c.r, runs)
          : null;
    // the attempt the person saw stop; now and then an earlier one (STALE)
    const attempt = r ? (chance(c.r, 0.85) ? r.attempt : Math.max(1, r.attempt - 1)) : 1;
    return {
      ...(r ? { thread: r.th, node: r.node } : { thread: threadId(c), node: "r" }),
      ...model(c),
      base: { attempt },
    };
  },
  "research.createPostFollowUp": (c, _u, d) => {
    // a reply to any reply, at any depth
    const replies = records(c, "reply");
    const top = replies.length && chance(c.r, 0.3) ? pick(c.r, replies) : null;
    const id = newId(c, d);
    const at = chance(c.r, 0.3) ? ` @${pick(c.r, PEOPLE)}` : "";
    return {
      id,
      thread: top ? top.th : threadId(c),
      t: marked(c, `reply:${id}`, "t") + at,
      ...(top ? { parent: top.id } : {}),
    };
  },
  "replies.update": (c, u) => edit(c, u, "reply"),
  "comments.update": (c, u) => edit(c, u, "comment"),
  "replies.delete": (c, u) => {
    const own = records(c, "reply").filter((x) => x.u === u);
    return {
      id: some(
        c,
        (own.length && chance(c.r, 0.7) ? own : records(c, "reply")).map((x) => x.id),
      ),
    };
  },
  "comments.delete": (c, u) => {
    const own = records(c, "comment").filter((x) => x.u === u);
    return {
      id: some(
        c,
        (own.length && chance(c.r, 0.7) ? own : records(c, "comment")).map((x) => x.id),
      ),
    };
  },
  "joinRequests.create": (c) => {
    const closed = records(c, "space").filter((x) => x.vis !== "open");
    const space = closed.length && chance(c.r, 0.7) ? pick(c.r, closed).id : spaceId(c);
    return { space };
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
  "members.remove": (c) => {
    const space = spaceId(c);
    const user = pick(c.r, PEOPLE);
    return { space, user, base: { adm: seenAdmission(c, space, user) } };
  },
  "members.ban": (c) => ({ space: spaceId(c), user: pick(c.r, PEOPLE) }),
  "members.unban": (c) => {
    const bans = records(c, "ban");
    const b = bans.length && chance(c.r, 0.7) ? pick(c.r, bans) : null;
    return b ? { space: b.sp, user: b.u } : { space: spaceId(c), user: pick(c.r, PEOPLE) };
  },
  "invites.create": (c, _u, d) => ({
    id: newId(c, d),
    space: spaceId(c),
    days: pick(c.r, [1, 7, 7, 30, ...(chance(c.r, 0.1) ? [0, 31] : [])]),
  }),
  "invites.revoke": (c) => ({
    id: some(
      c,
      records(c, "invite").map((l) => l.id),
    ),
  }),
  "invites.restore": (c) => ({
    id: some(
      c,
      records(c, "invite").map((l) => l.id),
    ),
  }),
  "moderation.decide": (c) => {
    // a removal of a thread that has nodes or replies, often; a removal's
    // reason is the owner's text, with no marker
    const note = chance(c.r, 0.5) ? { note: pick(c.r, ["Off topic.", " ", "Spam"]) } : {};
    const busy = records(c, "thread").filter((p) => {
      const n = c.w.get(`counts:${p.id}`);
      return n?.kind === "counts" && n.r > 0 && p.mod !== "removed";
    });
    if (busy.length && chance(c.r, 0.4)) {
      const p = pick(c.r, busy);
      const item = `${p.k === "ask" ? "a" : "p"}:${p.id}`;
      return { item, decision: "removed", ...note };
    }
    const item = itemKey(c);
    const decision = pick(c.r, ["hidden", "hidden", "removed", "shown", "shown"]);
    // "shown" needs a base; the restricting decisions take one or not
    const withBase = decision === "shown" ? chance(c.r, 0.95) : chance(c.r, 0.5);
    const base = withBase ? { base: { rev: seenRev(c, itemRecordKey(item)) } } : {};
    return { item, decision, ...(decision === "removed" ? note : {}), ...base };
  },
  "notifications.markRead": (c, u) => {
    const mine = records(c, "notif").filter((n) => n.to === u);
    return {
      id: some(
        c,
        (mine.length && chance(c.r, 0.8) ? mine : records(c, "notif")).map((n) => n.id),
      ),
    };
  },
  "notifications.markAllRead": () => ({}),
  "prefs.set": (c) => ({ layout: pick(c.r, ["centred", "wide"]) }),
};

/** An author's edit of a reply or a comment: usually their own, as they saw it. */
function edit(c: Ctx, u: Who, kind: "reply" | "comment") {
  const all = records(c, kind);
  // mostly one of the person's own that is not removed or a shell
  const own = all.filter((x) => x.u === u && x.mod !== "removed" && !x.del);
  const id = some(
    c,
    (own.length && chance(c.r, 0.9) ? own : all).map((x) => x.id),
  );
  return {
    id,
    t: marked(c, `${kind}:${id}`, "t"),
    base: { rev: seenRev(c, `${kind}:${id}`) },
  };
}
const NAMES = Object.keys(GENERATORS);
// membership changes come often, so scopes change mid-sequence
const WEIGHTED = [
  ...NAMES,
  "threads.create",
  "threads.create",
  "spaces.join",
  "spaces.join",
  "joinRequests.create",
  "joinRequests.decide",
  "joinRequests.decide",
  "members.remove",
  "members.ban",
  "moderation.decide",
  "moderation.decide",
  "research.forkNode",
  "research.forkNode",
  "comments.create",
  "research.createPostFollowUp",
  "saved.set",
  // edits, retries and deletes of one's own items (M2 review 26)
  "followups.update",
  "followups.update",
  "comments.update",
  "comments.update",
  "research.retryNode",
  "research.retryNode",
  "research.cancelNode",
  "followups.delete",
];
/** Generators whose names no device write reaches successfully by design
 * (none at the moment). */
const RAW_ONLY: ReadonlySet<string> = new Set<string>();

const OWNER_WRITES = new Set([
  "spaces.update",
  "joinRequests.decide",
  "members.remove",
  "members.ban",
  "members.unban",
  "moderation.decide",
  "invites.create",
  "invites.revoke",
  "invites.restore",
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
    {
      name: "research.forkNode",
      input: (c: Ctx, d: Device) => ({
        ...(GENERATORS["research.forkNode"] as Gen)(c, u, d),
        thread: any,
        parent: "r",
      }),
    },
    {
      name: "comments.create",
      input: (c: Ctx, d: Device) => {
        const id = d.cl.newId();
        return { id, thread: any, node: "r", t: marked(c, `comment:${id}`, "t") };
      },
    },
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
 * item keeps no text, and nothing is stored under a removed thread, a
 * removed node, or a removed top-level reply or comment. */
function erasureFaults(dump: ReadonlyMap<string, StoredRecord>): string[] {
  const out: string[] = [];
  const threads = new Set<string>();
  const nodes = new Set<string>();
  const tops = new Set<string>();
  for (const [k, r] of dump) {
    if (r.kind === "thread" && r.mod === "removed") {
      threads.add(r.id);
      if (r.q || r.t || r.sum) out.push(`removed ${k} keeps its text`);
    }
    if (r.kind === "node" && r.mod === "removed") {
      nodes.add(r.id);
      if (r.q || r.look || r.quote) out.push(`removed ${k} keeps its text`);
    }
    if ((r.kind === "reply" || r.kind === "comment") && r.mod === "removed") {
      tops.add(`${r.kind}:${r.id}`);
      if (r.t) out.push(`removed ${k} keeps its text`);
    }
  }
  for (const [k, r] of dump) {
    if (
      (r.kind === "node" ||
        r.kind === "answer" ||
        r.kind === "reply" ||
        r.kind === "comment" ||
        r.kind === "run" ||
        r.kind === "save" ||
        (r.kind === "notif" && r.type === "mention")) &&
      threads.has(r.th ?? "")
    )
      out.push(`${k} is stored under a removed thread`);
    if ((r.kind === "answer" && nodes.has(r.node)) || (r.kind === "comment" && nodes.has(r.node)))
      out.push(`${k} is stored under a removed node`);
    // nothing is stored under a removed reply or comment, at any depth
    if (r.kind === "reply" || r.kind === "comment")
      for (let up = r.parent; up !== null;) {
        if (tops.has(`${r.kind}:${up}`)) {
          out.push(`${k} is stored under a removed ${r.kind}`);
          break;
        }
        const x = dump.get(`${r.kind}:${up}`);
        up = x && (x.kind === "reply" || x.kind === "comment") ? x.parent : null;
      }
  }
  return out;
}

/** The stored records that do not parse with the shared contract's stored
 * schema (`spaces.storedRecordSchema`), with the first issue of each. Join
 * requests are the prototype's own kind (`01` C10). */
function unparsed(dump: ReadonlyMap<string, StoredRecord>): string[] {
  const out: string[] = [];
  for (const [k, r] of dump) {
    if (r.kind === "request") continue;
    const p = spaces.storedRecordSchema.safeParse(r);
    if (!p.success) out.push(`${k} does not parse: ${JSON.stringify(p.error.issues[0])}`);
  }
  return out;
}

/** Nest `v` `depth` levels deep in arrays. */
const nest = (v: unknown, depth: number): unknown => (depth ? [nest(v, depth - 1)] : v);

async function sequence(t: ExecutionContext, seed: number): Promise<boolean> {
  const faults = { random: false, loss: false };
  const serverRandom = rng(seed ^ 0x5eed);
  const w = new World(seed, {
    random: () => {
      if (faults.random) throw new Error("the random source is unavailable");
      return serverRandom();
    },
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
  };
  // a starting point: one open and one private space with a few members
  const open = w.id();
  const closed = w.id();
  await ok(t, w.as("olga", "spaces.create", { id: open, name: "lounge" }));
  await ok(t, w.as("olga", "spaces.create", { id: closed, name: "lab", vis: "private" }));
  for (const u of ["mona", "mel", "eve"]) await ok(t, w.as(u, "spaces.join", { space: open }));
  for (const u of ["ada", "mona", "mel"]) {
    await ok(t, w.as(u, "joinRequests.create", { space: closed }));
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
  /** The records that store the marker now, in the field it was written
   * (or copied) to, and are not removed. */
  const storedNow = (m: string) => {
    const o = c.origins.get(m);
    const out: Record<string, unknown>[] = [];
    if (!o) return out;
    for (const at of [o, ...(o.also ?? [])]) {
      // a key ending in "*": any record whose key starts with the rest
      const recs = at.key.endsWith("*")
        ? [...w.server.dump()].filter(([k]) => k.startsWith(at.key.slice(0, -1))).map(([, r]) => r)
        : [w.get(at.key)];
      for (const r of recs) {
        const rec = r as Record<string, unknown> | undefined;
        if (rec && JSON.stringify(rec[at.field] ?? null).includes(m) && rec["mod"] !== "removed")
          out.push(rec);
      }
    }
    return out;
  };
  const isOwner = (sp: string, reader: string | null) =>
    reader !== null && roleNow(c, sp, reader) === "owner";
  /** May `u` read a space's content now: it is open, or `u` is a member. */
  const readsSpace = (sp: string, u: string | null) => {
    const space = w.get(`space:${sp}`);
    return (
      space?.kind === "space" &&
      (space.vis === "open" || (u !== null && roleNow(c, sp, u) !== null))
    );
  };
  /** The secret check: may `reader` see the text that carries `m`, now? */
  const mayShow = (reader: string | null, m: string): boolean =>
    // a text copied to another record (a hidden ask's question, in the
    // thread opened from it) shows wherever one of its records may be read
    storedNow(m).some((rec) => mayRead(reader, rec));
  const mayRead = (reader: string | null, rec: Record<string, unknown>): boolean => {
    // a space's About is public, with the space record
    if (rec["kind"] === "space") return true;
    // a request's decline reason: its person and the space's owner
    if (rec["kind"] === "request") return reader === rec["u"] || isOwner(String(rec["sp"]), reader);
    const sp = String(rec["s"]);
    if (!readsSpace(sp, reader)) return false;
    // hidden text, an answer of a hidden ask included: its author and the owner
    if (rec["mod"] === "hidden" && reader !== rec["u"] && !isOwner(sp, reader)) return false;
    return true;
  };
  const scan = (reader: string | null, what: string, response: unknown) => {
    for (const m of JSON.stringify(response).match(MARKER) ?? [])
      if (!mayShow(reader, m))
        failures.push(`${what} to ${reader} carries ${m} (${JSON.stringify(c.origins.get(m))})`);
  };
  /** How many times a space log's history was replaced (by a restore). */
  const spaceHistory = (log: LogId) =>
    log.startsWith("space:") ? (c.history.get(log.slice(6)) ?? 0) : 0;
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
    if (e.name === "threads.create" && (e.input as { from?: unknown } | null)?.from)
      tally(`${got} threads.create from a node`);
    if (got !== p.code) {
      failures.push(
        `${what}: the write oracle predicted ${p.code}, the server answered ${JSON.stringify(res)}\n${JSON.stringify(e).slice(0, 600)}`,
      );
      return res;
    }
    // and the reason the client acts on (`queue_full`)
    const reason = res.ok ? undefined : res.error.reason;
    if (reason !== p.reason)
      failures.push(`${what}: the write oracle predicted reason ${p.reason}, got ${reason}`);
    // a write applied now (not a replay) changes exactly what the effect
    // model predicts; anything else changes nothing
    const fresh = p.code === "ok" && p.stored && u !== null && u !== "null";
    const effects = fresh
      ? predictEffects(
          before,
          u,
          e.name,
          e.input as Record<string, unknown>,
          now,
          c.admissions,
          (h) => (PEOPLE as readonly string[]).includes(h),
        )
      : { keys: new Map(), fresh: [] };
    const fault = checkEffects(before, w.server.dump(), effects, res.ok ? res.result : null);
    if (fault) failures.push(`${what}: the effect model: ${fault}\n${JSON.stringify(e)}`);
    c.model.commit(u, e, p, now);
    c.model.learn(w.server.dump());
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
      if (e.name === "members.ban") {
        const i = e.input as { space: string; user: Person };
        afterBan(c, i.space, i.user);
      }
      // the author's later edit or delete of a new reply, comment or ask,
      // and a stopped run run again: few of these exist at a random step,
      // so these follow-ups reach the writes (M2 review 26)
      const author = PEOPLE.find((x) => x === u);
      const later = (name: string, input: (c: Ctx) => unknown) =>
        author && c.plan.push({ u: author, name, input, what: `${name} of its own` });
      const item = { "research.createPostFollowUp": "reply", "comments.create": "comment" } as const;
      if (e.name in item) {
        const kind = item[e.name as keyof typeof item];
        const id = (e.input as { id: string }).id;
        const roll = c.r();
        if (roll < 0.2) later(`${kind === "reply" ? "replies" : "comments"}.delete`, () => ({ id }));
        else if (roll < 0.4)
          later(`${kind === "reply" ? "replies" : "comments"}.update`, (c) => ({
            id,
            t: marked(c, `${kind}:${id}`, "t"),
            base: { rev: c.w.rev(`${kind}:${id}`) },
          }));
      }
      if (e.name === "research.forkNode") {
        const i = e.input as { id: string; thread: string; kind: string };
        const roll = c.r();
        if (roll < 0.15) later("followups.delete", () => ({ thread: i.thread, node: i.id }));
        else if (roll < 0.3 && i.kind === "ask")
          later("followups.update", (c) => ({
            thread: i.thread,
            node: i.id,
            q: marked(c, `node:${i.id}`, "q"),
            base: { rev: c.w.rev(`node:${i.id}`) },
          }));
      }
      if (e.name === "research.cancelNode" && chance(c.r, 0.9)) {
        const i = e.input as { thread: string; node: string };
        later("research.retryNode", (c) => ({
          ...i,
          ...model(c),
          base: {
            attempt:
              records(c, "run").find((r) => r.th === i.thread && r.node === i.node)?.attempt ?? 1,
          },
        }));
      }
      if (e.name === "joinRequests.decide" && chance(c.r, 0.7)) {
        const i = e.input as { space: string; users: Person[]; decision: string };
        const who = i.users[0];
        if (i.decision === "decline" && who && PEOPLE.includes(who))
          c.plan.push({
            u: who,
            name: "joinRequests.create",
            input: () => ({ space: i.space }),
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
            ["thread", "node", "reply", "comment", "space"].includes(kind ?? "")
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
      if (e.replaces?.length) tally("client remint");
      if (faults.loss && chance(c.r, 0.3)) {
        tally("client lost answer");
        if (chance(c.r, 0.5)) throw new Error("the connection dropped");
        return {
          ok: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "lost", serverTime: 0 },
        };
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
  for (const s of records(c, "space")) c.history.set(s.id, 0);

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
      // a replay is the answer of the same write sent before under its
      // mutation id (a device given someone's mutation id, the same user's
      // and payload): applied then, not now
      if (answer?.ok && n !== 1 && !c.direct.has(local) && !(answer.replay && n === 0))
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
      if ((await cl.sync(log)) === "resync") tally("client resync");
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
      // user logs follow current access, with no oracle: a person's user log
      // holds notifications and saves only of spaces they may read now
      if (u !== null && log === `user:${u}`)
        for (const x of [...cl.records(log).values(), ...snap.records.map((y) => y.record)]) {
          const sp =
            x.kind === "notif"
              ? x.sp
              : x.kind === "save"
                ? (w.get(`thread:${x.th}`) as { s?: string } | undefined)?.s
                : undefined;
          if (sp && !readsSpace(sp, u))
            return failed(step, what, `${u} holds a ${x.kind} of ${sp}, not reading it`);
        }
    }
    return true;
  };

  /** The state invariants, checked on the stored records and on every value
   * at rest after each step (no oracle):
   * - each space has exactly one owner, the one its record names;
   * - nobody has a member record in a space they are banned from;
   * - no tombstone is older than 30 days;
   * - nobody is notified of their own action, and a person has at most one
   *   unread reply, branch or comment notification per thread;
   * - no marker is at rest anywhere unless it is still in the record and
   *   field it was written to, and that record is not removed. */
  const invariants = async (step: number): Promise<string[]> => {
    const out: string[] = [];
    const dump = w.server.dump();
    for (const s of records(c, "space")) {
      const owners = records(c, "member").filter((m) => m.sp === s.id && m.role === "owner");
      if (owners.length !== 1 || owners[0]?.u !== s.owner)
        out.push(`#${s.name} has the owners ${owners.map((m) => m.u).join()}, names ${s.owner}`);
    }
    for (const b of records(c, "ban"))
      if (dump.has(`member:${b.sp}:${b.u}`)) out.push(`${b.u} is a member of ${b.sp} and banned`);
    const scan = await w.server.scanStorage();
    for (const tomb of scan.tombstones)
      if (tomb.at < w.clock.now() - 30 * DAY)
        out.push(`a tombstone of ${tomb.key} outlived 30 days`);
    const unread = new Set<string>();
    for (const n of records(c, "notif")) {
      if (n.actor === n.to) out.push(`${n.to} was notified of their own ${n.type}`);
      if (n.read || !["reply", "branch", "comment"].includes(n.type)) continue;
      const k = `${n.to} ${n.type} ${n.th}`;
      if (unread.has(k)) out.push(`${n.to} has two unread ${n.type} notifications of ${n.th}`);
      unread.add(k);
    }
    for (const [table, values] of Object.entries(scan))
      for (const m of JSON.stringify(values).match(MARKER) ?? [])
        if (!storedNow(m).length)
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
    // the owner's writes mostly come from olga, who owns the first spaces,
    // so they succeed often enough
    if (OWNER_WRITES.has(name) && chance(c.r, 0.5)) u = "olga";
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
    // the owner's other device decides the same request (a stale decision)
    if (name === "joinRequests.decide" && chance(c.r, 0.4)) {
      const same = { ...input };
      c.plan.push({ u: "olga", name, input: () => same, what: "the same decision again" });
    }
    if (u === "eve" || chance(c.r, 0.12)) {
      const now = d.cl.now();
      switch (Math.floor(c.r() * 7)) {
        case 0:
          input = { ...input, saves: 999, u: "olga" };
          what += " with forged fields";
          break;
        case 1:
          sentName = pick(c.r, [
            "spaces.nuke",
            "__proto__",
            "toString",
            "saved.toggle",
            "likes.set",
            "reports.create",
            "members.setRole",
            "followups.ask",
          ]);
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
    let queuedAt: number | null = null;
    let replaces: string[] | undefined;
    let what = `${u} raw: ${name}`;
    switch (Math.floor(r() * 11)) {
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
        protocolVersion = pick(r, [2, 3]);
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
      case 7:
        queuedAt = clientTime + pick(r, [-5 * DAY, -4 * DAY, 2 * MINUTE, -HOUR]);
        what += " queued at another time";
        break;
      case 8: {
        // a reminted envelope: the ids it replaces, its own or someone's
        const mine = c.sent.filter((x) => x.u === u).map((x) => x.e.mutationId);
        replaces = [w.id(), ...(mine.length && chance(r, 0.5) ? [pick(r, mine)] : [])];
        if (chance(r, 0.1)) replaces.push("not-a-ulid");
        what += " naming ids it replaces";
        break;
      }
      default:
    }
    const e: Envelope = {
      clientId,
      seq,
      mutationId: w.id(),
      ...(replaces ? { replaces } : {}),
      name,
      input,
      protocolVersion,
      clientTime,
      queuedAt: queuedAt ?? clientTime,
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
    if (roll < 0.043) {
      w.clock.advance(Math.floor(c.r() * 6 * HOUR));
      what = "clock +hours";
    } else if (roll < 0.05) {
      // (its share comes from the clock steps, so forged cursors keep theirs)
      // a restore replaces a space log's history: its cursors resync
      const sp = pick(
        c.r,
        records(c, "space").map((s) => s.id),
      );
      await w.server.replaceHistory(`space:${sp}`);
      c.history.set(sp, (c.history.get(sp) ?? 0) + 1);
      what = `space:${sp} is restored`;
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
    } else if (roll < 0.17) {
      // a run finishes: a thread's summary or a node's answer, with a marker;
      // mostly one whose run has not ended, so nodes can be forked under it
      // (M1b review 18)
      const items = [
        ...records(c, "thread").map((p) => ({
          key: `thread:${p.id}`,
          at: `thread:${p.id}`,
          field: "sum",
          live: records(c, "run").some((r) => r.th === p.id && r.node === "r" && liveRun(r)),
        })),
        ...records(c, "node").map((f) => ({
          key: `node:${f.id}`,
          at: `answer:${f.id}`,
          field: "md",
          live: records(c, "run").some((r) => r.id === f.run && liveRun(r)),
        })),
      ];
      const live = items.filter((x) => x.live);
      const item =
        live.length && chance(c.r, 0.85) ? pick(c.r, live) : items.length ? pick(c.r, items) : null;
      what = `a run finishes for ${item?.key ?? "nothing"}`;
      if (item) await w.server.finishJob(item.key, marked(c, item.at, item.field));
    } else if (roll < 0.21) {
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
    } else if (roll < 0.23) {
      const k = pick(c.r, ["random", "loss"] as const);
      faults[k] = !faults[k];
      what = `${k} faults ${faults[k] ? "on" : "off"}`;
    } else if (roll < 0.24) {
      const u = pick(c.r, PEOPLE);
      const n = 1 + Math.floor(c.r() * 24);
      for (let k = 0; k < n; k++) await watched.register(actor(u));
      what = `${u} registers ${n} clients`;
    } else if (roll < 0.32) {
      what = await rawWrite();
    } else {
      what = await deviceWrite();
    }
    if (failures.length) return failed(step, what, failures.slice(0, 3).join("\n"));
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
  // the end: faults off, every outbox sent
  faults.random = faults.loss = false;
  c.plan.length = 0;
  for (let round = 0; round < 8; round++) {
    // a day passes once, for a person who used up a day's registrations
    w.clock.advance(round === 4 ? DAY : 11 * MINUTE);
    for (const d of c.devices) await flush(d);
  }
  if (failures.length) return failed(STEPS, "drain", failures.slice(0, 3).join("\n"));
  learn();
  const end = [...(await invariants(STEPS)), ...outcomes(true), ...unparsed(w.server.dump())];
  if (end.length) return failed(STEPS, "drain", end.slice(0, 3).join("\n"));
  for (const cl of eager.values()) if (!(await check(STEPS, "drain", cl))) return false;
  // once the outboxes are drained and the logs read, a device's view (its
  // predictions and applied writes over its replica) is the oracle's
  // projection: nothing it predicted lingers or is counted twice (M2 review 22)
  for (const d of c.devices) {
    if (d.cl.pending().length) continue;
    const want = new Map<string, StoredRecord>();
    for (const log of logsFor(d.u)) {
      await d.cl.sync(log);
      for (const [k, v] of expected(w.server.dump(), d.u, log)) want.set(k, v);
    }
    const delta = diff(d.cl.view(), want);
    if (delta) return failed(STEPS, "drain", `${d.name}'s view\n${delta}`);
    for (const x of d.cl.problems()) tally(`client ${x.reason}`);
  }
  return true;
}

/** A run that has not ended. */
const liveRun = (r: Extract<StoredRecord, { kind: "run" }>) =>
  r.status === "queued" || r.status === "running";

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

/** The fewest applied writes of each mutator over the 200 fixed sequences:
 * the generators must reach the node tree, not only refuse it (M1b review
 * 18). Checked only on the fixed run. */
const MIN_APPLIED: Record<string, number> = {
  // every generator applies at least once
  ...Object.fromEntries(NAMES.filter((n) => !RAW_ONLY.has(n)).map((n) => [n, 1])),
  "followups.update": 3,
  "research.retryNode": 3,
  "comments.update": 3,
  "threads.create": 100,
  "threads.create from a node": 1,
  "research.forkNode": 20,
  "comments.create": 20,
  "research.createPostFollowUp": 20,
  "research.cancelNode": 5,
  "followups.delete": 1,
  "threads.delete": 5,
  "moderation.decide": 20,
  "saved.set": 50,
  "spaces.create": 10,
};
/** The client's outcomes the fixed sequences must reach. */
const MIN_CLIENT: Record<string, number> = {
  "client remint": 5,
  "client lost answer": 20,
  "client DROPPED": 1,
  "client EXPIRED": 1,
  "client resync": 20,
};

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

if (!ONE && SEQUENCES === 200)
  test.serial(
    "the fixed sequences apply every write of the node tree some number of times",
    (t) => {
      const short = Object.entries(MIN_APPLIED).filter(([k, n]) => (TALLY.get(`ok ${k}`) ?? 0) < n);
      const outcomes = Object.entries(MIN_CLIENT).filter(([k, n]) => (TALLY.get(k) ?? 0) < n);
      t.deepEqual(
        [
          ...short.map(
            ([k, n]) => `${k}: ${TALLY.get(`ok ${k}`) ?? 0} applied, at least ${n} expected`,
          ),
          ...outcomes.map(([k, n]) => `${k}: ${TALLY.get(k) ?? 0}, at least ${n} expected`),
        ],
        [],
      );
    },
  );
