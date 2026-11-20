// Equivalence with the mock backend. The same history of writes, as the
// mock's person `me`, runs through the mock's procedures (its own
// dispatcher, under Node) and through the mutators; after each step the
// stored state of both, reduced to what the mock stores for `me`
// (`projectMock`, `projectOurs`), must be equal, and so must each answer's
// outcome (applied, or the same error code).
//
// Since phase 1a.2 the mock follows the mutators' rules: it takes the
// client's ids, `base` and the renamed procedures, answers STALE, and
// erases removed items. The history sends both sides the same input where
// the two address records the same way, and the same client-made ids. The
// rows of DIFFERENCES are what remains, each a gap that a mock without a
// real server keeps on purpose; each is tested on its own: the mock does
// what the row says, and the mutators do what it says instead.
//
// Not compared: times (both stamp the server's time, but move `updatedAt`
// on different writes), versions (each side counts its own; a step reads
// the version from the side it runs on), run records (job state, keyed by
// node in the mock and by id here), the mock's display fields (`online`,
// `tok`), a space's staff list (`mods`: the mock updates the entry of the
// person whose role changed), versions of the rules (`rulesAt` there,
// `rulesRev` here), invite codes (D12), admission ids (each side makes its
// own) and reply like counts (the mock counts the viewer's like on read).

import test from "ava";
import type { ExecutionContext } from "ava";

import { MUTATORS, NOT_MUTATORS, type Outcome, type StoredRecord } from "../src/index.js";

import {
  Labels,
  M,
  ME,
  call,
  projectMock,
  projectOurs,
  reset,
  restore,
  setNow,
  stored,
  toMock,
} from "./mock.js";
import { World, ok } from "./world.js";

test.after.always(() => restore());

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
   the mock is untyped JavaScript: its collections are read as `any` */
type Any = any;

/** The seed: three spaces and a few threads, made by the mutators.
 * - #lounge (open): owner olga, admin me, moderator mona, member otto;
 * - #lab (listed, join by request): owner olga, moderator me, member mona;
 * - #den (listed, join by request): owner olga;
 * - #vault (unlisted, invite only): owner olga;
 * - #yard (open): owner olga;
 * - in #lounge: T1, me's ask, with otto's follow-up; T2, otto's post with
 *   me's reply and otto's reply under it; in #lab: T3, olga's ask;
 * - eve asks to join #lab; mona made an invite link to #lounge; otto likes
 *   T1; an invite notification for me to #vault; a catalog source SRC1. */
function seedWorld(t: ExecutionContext) {
  const w = new World(11);
  const [lounge, lab, den, vault, yard] = [w.id(), w.id(), w.id(), w.id(), w.id()];
  const run = (u: string, name: string, input: unknown) => {
    ok(t, w.run(u, name, input));
    w.advance(1000);
  };
  run("olga", "spaces.create", { id: lounge, name: "lounge" });
  run("olga", "spaces.create", {
    id: lab,
    name: "lab",
    vis: "listed",
    policy: "request",
    invite: "members",
  });
  run("olga", "spaces.create", { id: den, name: "den", vis: "listed", policy: "request" });
  run("olga", "spaces.create", { id: vault, name: "vault", vis: "unlisted", policy: "invite" });
  run("olga", "spaces.create", { id: yard, name: "yard" });
  for (const u of [ME, "mona", "otto"]) run(u, "spaces.join", { space: lounge });
  const role = (sp: string, u: string, r: string) =>
    run("olga", "members.setRole", {
      space: sp,
      user: u,
      role: r,
      base: { rev: w.rev(`member:${sp}:${u}`) },
    });
  role(lounge, ME, "admin");
  role(lounge, "mona", "mod");
  // into #lab with links, so the only join request is eve's (the mock keeps
  // one request per person)
  for (const u of [ME, "mona"]) {
    const link = w.id();
    run("olga", "invites.create", { id: link, space: lab });
    run(u, "spaces.join", {
      space: lab,
      invite: (w.get(`invite:${link}`) as { code: string }).code,
    });
  }
  role(lab, ME, "mod");
  const [T1, T2, T3, F1, R1, R2, L1] = [w.id(), w.id(), w.id(), w.id(), w.id(), w.id(), w.id()];
  run(ME, "threads.create", { id: T1, space: lounge, kind: "ask", q: "Why?" });
  run("otto", "followups.ask", { id: F1, thread: T1, q: "And then?" });
  run("otto", "threads.create", { id: T2, space: lounge, kind: "post", q: "A post" });
  run(ME, "research.createPostFollowUp", { id: R1, thread: T2, t: "A reply" });
  run("otto", "research.createPostFollowUp", { id: R2, thread: T2, t: "Under it", parent: R1 });
  run("olga", "threads.create", { id: T3, space: lab, kind: "ask", q: "In the lab" });
  run("eve", "joinRequests.create", { space: lab, rulesAccepted: true });
  run("mona", "invites.create", { id: L1, space: lounge });
  run("otto", "likes.set", { thread: T1, on: true });
  const n = w.id();
  w.store.records.set(`notif:${n}`, {
    kind: "notif",
    id: n,
    to: ME,
    type: "invite",
    sp: vault,
    report: null,
    item: null,
    outcome: null,
    response: null,
    actor: "olga",
    thread: null,
    node: null,
    invite: null,
    read: false,
    createdAt: "2026-11-16T09:00:00Z",
    rev: 1,
  });
  w.store.registry.set(n, 1);
  w.store.records.set("source:SRC1", {
    kind: "source",
    id: "SRC1",
    meta: {
      pl: "web",
      form: "article",
      au: "example.org",
      h: "example.org",
      len: "6 min read",
      tok: 2000,
      url: "example.org/a",
      t: "A",
      desc: "",
      sum: "",
      body: [],
    },
    nurl: "example.org/a",
    createdAt: "2026-11-01T00:00:00Z",
    rev: 1,
  });
  w.store.records.set(`profile:${ME}`, { kind: "profile", u: ME, name: "Me", bio: "", rev: 1 });
  return { w, ids: { lounge, lab, den, vault, yard, T1, T2, T3, F1, R1, R2, L1, N1: n } };
}

/** Run a history on both sides, comparing after every step. */
async function both(t: ExecutionContext, steps: Step[], seed = seedWorld(t)) {
  const { w, ids } = seed;
  const L = new Labels();
  const named: Record<string, string> = ids;
  await reset(toMock(w.store), w.now);
  t.deepEqual(projectOurs(w.store, L), projectMock(stored(), L), "the seed");
  for (const [k, step] of steps.entries()) {
    const what = `step ${k + 1}: ${step.name} ${step.input.toString().slice(0, 140)}`;
    const resolve = (label: string, side: "ours" | "mock") =>
      named[label] ?? (side === "ours" ? L.idOurs(label) : L.idMock(label));
    // the step's new ids, made by the client: the same on both sides
    const fresh = [w.id(), w.id()];
    const ours = oursSide(w, (l) => resolve(l, "ours"), fresh);
    const mock = mockSide((l) => resolve(l, "mock"), fresh);
    const a = w.run(ME, step.name, step.input(ours));
    const b = await call(step.name, step.input(mock));
    t.is(
      outcome(a),
      b.ok ? "ok" : b.code,
      `${what}: ours ${JSON.stringify(a).slice(0, 300)}, mock ${JSON.stringify(b).slice(0, 300)}`,
    );
    if (step.label && a.status === "ok" && b.ok)
      L.set(step.label, (a.result as { id: string }).id, (b.result as { id: string }).id);
    t.deepEqual(projectOurs(w.store, L), projectMock(stored(), L), what);
    w.advance(1000);
    await setNow(w.now);
  }
}

const outcome = (o: Outcome) =>
  o.status === "ok" ? "ok" : o.status === "refused" ? o.error.code : "unknown";

/** One side of the history: how a step names records on it, and the
 * versions it reads from it (each side counts its own). */
interface Side {
  side: "ours" | "mock";
  /** The id a label (or a seeded id) stands for. */
  id(label: string): string;
  /** The step's k-th new client-made id (the same on both sides). */
  fresh(k?: number): string;
  /** The k-th follow-up of a thread: ours its id, the mock's its node id. */
  node(th: string, k: number): string;
  /** A reply by its path ("0", "0.1"): ours its id, the mock's the path. */
  reply(th: string, path: string): string;
  /** A moderation key of a follow-up or a reply: ours by id, the mock's by
   * index or path. */
  fkey(th: string, k: number): string;
  rkey(th: string, path: string): string;
  /** Versions as this side holds them (a record without one is at 1). */
  threadRev(th: string): number;
  nodeRev(th: string, k: number): number;
  replyRev(th: string, path: string): number;
  memberRev(sp: string, u: string): number;
  reqRev(sp: string, u: string): number;
  reportRev(rep: string): number;
  itemRev(key: string): number;
  skillsRev(sp: string): number;
  /** A member's admission id on this side. */
  adm(sp: string, u: string): string;
  /** The k-th skill's and page's id of a space. */
  skill(sp: string, k: number): string;
  page(sp: string, k: number): string;
}

interface Step {
  name: string;
  input: (x: Side) => unknown;
  /** Label the record the write creates (its result's `id`). */
  label?: string;
}

const recOf = <K extends StoredRecord["kind"]>(w: World, key: string) =>
  w.get(key) as Extract<StoredRecord, { kind: K }> | undefined;

function oursSide(w: World, id: (l: string) => string, fresh: string[]): Side {
  const node = (th: string, k: number) => oursNodes(w, id(th))[k] ?? "missing";
  const reply = (th: string, path: string) => oursReply(w, id(th), path);
  const x: Side = {
    side: "ours",
    id,
    fresh: (k = 0) => fresh[k] ?? "missing",
    node,
    reply,
    fkey: (th, k) => `f:${id(th)}:${node(th, k)}`,
    rkey: (th, path) => `r:${id(th)}:${reply(th, path)}`,
    threadRev: (th) => w.rev(`thread:${id(th)}`),
    nodeRev: (th, k) => w.rev(`followup:${node(th, k)}`),
    replyRev: (th, path) => w.rev(`reply:${reply(th, path)}`),
    memberRev: (sp, u) => w.rev(`member:${id(sp)}:${u}`),
    reqRev: (sp, u) => w.rev(`request:${id(sp)}:${u}`),
    reportRev: (rep) => w.rev(`report:${id(rep)}`),
    itemRev: (key) => {
      const [k, th, sub] = key.split(":");
      if (k === "f") return w.rev(`hide:followup:${sub}`);
      if (k === "r") return w.rev(`hide:reply:${sub}`);
      return w.rev(`hide:thread:${th}`);
    },
    skillsRev: (sp) => w.rev(`skills:${id(sp)}`),
    adm: (sp, u) => w.admission(id(sp), u).adm,
    skill: (sp, k) => recOf<"skills">(w, `skills:${id(sp)}`)?.order[k] ?? "missing",
    page: (sp, k) => recOf<"pages">(w, `pages:${id(sp)}`)?.list[k]?.id ?? "missing",
  };
  return x;
}

function mockSide(id: (l: string) => string, fresh: string[]): Side {
  const d = () => stored();
  const rev = (r: Any) => (r?.rev as number | undefined) ?? 1;
  const replyRec = (th: string, path: string) => {
    let r: Any = null;
    let l: Any[] = d().rp[id(th)] ?? [];
    for (const k of path.split(".").map(Number)) {
      r = l[k];
      l = r?.kids ?? [];
    }
    return r;
  };
  const nodeRec = (th: string, k: number) => {
    const n = mockNodes(d(), id(th))[k];
    return n?.fu != null
      ? d().fu[id(th)][n.fu]
      : (d().qtd[id(th)]?.nodes ?? []).find((x: Any) => x.id === n?.id);
  };
  const roster = (sp: string): Any[] => d().memOther[id(sp)] ?? [];
  return {
    side: "mock",
    id,
    fresh: (k = 0) => fresh[k] ?? "missing",
    node: (th, k) => mockNodeIds(d(), id(th))[k] ?? "missing",
    // replies and flat follow-ups by id (phase 1b): the mock's ids are the
    // client's, the same as ours
    reply: (th, path) => (replyRec(th, path)?.id as string | undefined) ?? "missing",
    fkey: (th, k) => {
      const n = mockNodes(d(), id(th))[k];
      return n?.fu != null ? `f:${id(th)}:${d().fu[id(th)][n.fu].id}` : `n:${id(th)}:${n?.id}`;
    },
    rkey: (th, path) =>
      `r:${id(th)}:${(replyRec(th, path)?.id as string | undefined) ?? "missing"}`,
    threadRev: (th) => rev(d().posts.find((p: Any) => p.id === id(th))),
    nodeRev: (th, k) => rev(nodeRec(th, k)),
    replyRev: (th, path) => rev(replyRec(th, path)),
    memberRev: (sp, u) => rev(roster(sp).find((m) => m.u === u)),
    reqRev: (sp, u) => rev(d().reqs.find((r: Any) => r.u === u && r.sp === id(sp))),
    reportRev: (rep) => rev(d().reports.find((r: Any) => r.id === id(rep))),
    // the base of "shown": the item's moderation record's version (phase 1b)
    itemRev: (key) =>
      d().modSt[key] === "hidden" ? ((d().modRev?.[key] as number | undefined) ?? 0) : 0,
    skillsRev: (sp) => (d().skillsRev[id(sp)] as number | undefined) ?? 0,
    adm: (sp, u) => (roster(sp).find((m) => m.u === u)?.adm as string | undefined) ?? "",
    skill: (sp, k) => (d().skills[id(sp)]?.[k]?.id as string | undefined) ?? "missing",
    page: (sp, k) =>
      (d().spaces.find((s: Any) => s.id === id(sp))?.pages?.[k]?.[2] as string | undefined) ??
      "missing",
  };
}

/** Our follow-ups of a thread in the order they were made. */
function oursNodes(w: World, th: string): string[] {
  return [...w.store.records.values()]
    .filter((r) => r.kind === "followup" && r.th === th)
    .sort((a, b) => ((a as Any).createdAt < (b as Any).createdAt ? -1 : 1))
    .map((r) => (r as Any).id as string);
}

function mockNodeIds(d: Any, th: string): string[] {
  return mockNodes(d, th).map((n: Any) => n.id as string);
}

/** The mock's ask nodes of a thread: its stored tree, or its flat
 * follow-ups as first-level asks. */
function mockNodes(d: Any, th: string): Any[] {
  const fus = d.fu[th] ?? [];
  return (
    d.qtd[th] ?? {
      nodes: fus.map((f: Any, k: number) => ({ id: f.id ?? "f" + k, par: "r", fu: k })),
    }
  ).nodes;
}

function oursReply(w: World, th: string, path: string): string {
  const rs = [...w.store.records.values()]
    .filter((r) => r.kind === "reply" && r.th === th)
    .sort((a, b) => ((a as Any).createdAt < (b as Any).createdAt ? -1 : 1)) as Any[];
  const [i, j] = path.split(".").map(Number);
  const top = rs.filter((r) => r.parent === null)[i ?? 0];
  if (j === undefined) return top?.id ?? "missing";
  return rs.filter((r) => r.parent === top?.id)[j]?.id ?? "missing";
}

/** The input of a reply's write: both name the reply by id (phase 1b). */
const replyIn = (x: Side, th: string, path: string, more: object) => ({
  thread: x.id(th),
  reply: x.reply(th, path),
  ...more,
});

// ---- the history ----
// The rows of the phase 1a table that the mock adopted are marked (Dn): the
// step shows both sides answer and store the same.

const HISTORY: Step[] = [
  // personal marks: `on` is required (D1)
  { name: "likes.set", input: (x) => ({ thread: x.id("T2"), on: true }) },
  { name: "likes.set", input: (x) => ({ thread: x.id("T1"), on: true }) },
  { name: "likes.set", input: (x) => ({ thread: x.id("T1"), on: false }) },
  { name: "likes.set", input: (x) => ({ thread: x.id("T3"), on: true }) },
  { name: "likes.set", input: (x) => ({ thread: x.id("T3") }) },
  { name: "saved.set", input: (x) => ({ kind: "thread", id: x.id("T1"), on: true }) },
  { name: "saved.set", input: (x) => ({ kind: "thread", id: x.id("T1"), on: false }) },
  { name: "saved.set", input: (x) => ({ kind: "ask", id: `${x.id("T1")}:r`, on: true }) },
  {
    name: "saved.set",
    input: (x) => ({ kind: "ask", id: `${x.id("T1")}:${x.node("T1", 0)}`, on: true }),
  },
  { name: "saved.set", input: () => ({ kind: "source", id: "SRC1", on: true }) },
  {
    name: "likes.setReply",
    input: (x) => ({
      reply: x.reply("T2", "0.0"),
      on: true,
    }),
  },
  { name: "mutes.set", input: () => ({ handle: "eve", on: true }) },
  { name: "mutes.set", input: () => ({ handle: "eve", on: false }) },
  { name: "blocks.set", input: () => ({ handle: "eve", on: true }) },
  { name: "sources.markRead", input: () => ({ id: "SRC1" }) },
  { name: "sources.markRead", input: () => ({ id: "NOPE" }) },
  { name: "profile.update", input: () => ({ name: " Me Too ", bio: " hi " }) },
  { name: "profile.update", input: () => ({ name: "  ", bio: "" }) },
  { name: "invites.request", input: (x) => ({ space: x.id("vault") }) },
  { name: "invites.request", input: (x) => ({ space: x.id("vault") }) },
  // an open space takes no invite asks (review round 1 of phase 1, E12e)
  { name: "invites.request", input: (x) => ({ space: x.id("yard") }) },
  { name: "notifications.markRead", input: (x) => ({ id: x.id("N1") }) },
  // an invite notification alone admits nobody (D13)
  { name: "spaces.join", input: (x) => ({ space: x.id("vault"), notification: x.id("N1") }) },
  { name: "invites.decline", input: (x) => ({ notification: x.id("N1") }) },
  { name: "notifications.markSeen", input: () => ({ kind: "requests" }) },

  // threads, follow-ups and replies, with client-made ids
  {
    name: "threads.create",
    label: "T4",
    input: (x) => ({
      id: x.fresh(),
      space: x.id("lounge"),
      kind: "ask",
      q: "A new ask",
      title: "New",
    }),
  },
  {
    name: "threads.create",
    label: "T5",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "post", q: " A new post " }),
  },
  // an id in use: CONFLICT
  {
    name: "threads.create",
    input: (x) => ({ id: x.id("T4"), space: x.id("lounge"), kind: "post", q: "again" }),
  },
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "post", q: "   " }),
  },
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("den"), kind: "post", q: "x" }),
  },
  // an author's edit carries base.rev (D20)
  {
    name: "threads.update",
    input: (x) => ({ id: x.id("T4"), q: "A new ask, edited", base: { rev: x.threadRev("T4") } }),
  },
  {
    name: "threads.update",
    input: (x) => ({ id: x.id("T4"), q: "Stale", base: { rev: x.threadRev("T4") - 1 } }),
  },
  { name: "threads.update", input: (x) => ({ id: x.id("T4"), q: "No base" }) },
  // a post has no ask to run (review round 1 of phase 1, E12b)
  {
    name: "threads.update",
    input: (x) => ({
      id: x.id("T5"),
      q: "A new post",
      run: true,
      base: { rev: x.threadRev("T5") },
    }),
  },
  {
    name: "threads.update",
    input: (x) => ({ id: x.id("T2"), q: "not mine", base: { rev: x.threadRev("T2") } }),
  },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "First" }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "Second" }) },
  // a follow-up on a post (BAD_REQUEST); its answer is null until the run writes it (D30)
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T5"), q: "on a post" }) },
  {
    name: "followups.update",
    input: (x) => ({
      thread: x.id("T4"),
      node: x.node("T4", 1),
      q: "Second, edited",
      base: { rev: x.nodeRev("T4", 1) },
    }),
  },
  {
    name: "followups.update",
    input: (x) => ({
      thread: x.id("T4"),
      node: x.node("T4", 1),
      q: "Stale",
      base: { rev: x.nodeRev("T4", 1) - 1 },
    }),
  },
  {
    name: "followups.update",
    input: (x) => ({ thread: x.id("T1"), node: x.node("T1", 0), q: "not mine", base: { rev: 1 } }),
  },
  // a fork with the client's node id
  {
    name: "research.forkNode",
    label: "N2",
    input: (x) => ({
      id: x.fresh(),
      thread: x.id("T4"),
      parent: x.node("T4", 0),
      q: "Under the first",
    }),
  },
  {
    name: "research.forkNode",
    input: (x) => ({ id: x.fresh(), thread: x.id("T4"), parent: "r", q: "Third" }),
  },
  // uses names answers of the same thread (review round 1 of phase 1, E12d)
  {
    name: "research.forkNode",
    input: (x) => ({
      id: x.fresh(),
      thread: x.id("T4"),
      parent: "r",
      q: "Compare",
      uses: ["r", x.node("T1", 0)],
    }),
  },
  // an ask tree is for asks (D17)
  {
    name: "research.forkNode",
    input: (x) => ({ id: x.fresh(), thread: x.id("T5"), parent: "r", q: "on a post" }),
  },
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 0) }) },
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 1) }) },
  // a deleted follow-up is not edited (D18)
  {
    name: "followups.update",
    input: (x) => ({
      thread: x.id("T4"),
      node: x.node("T4", 0),
      q: "back",
      base: { rev: x.nodeRev("T4", 0) },
    }),
  },
  {
    name: "research.createPostFollowUp",
    input: (x) => ({ id: x.fresh(), thread: x.id("T5"), t: "Reply one" }),
  },
  // replies are for posts (D16)
  {
    name: "research.createPostFollowUp",
    input: (x) => ({ id: x.fresh(), thread: x.id("T4"), t: "on an ask" }),
  },
  {
    name: "research.createPostFollowUp",
    input: (x) => ({
      id: x.fresh(),
      thread: x.id("T5"),
      t: "Under one",
      parent: x.reply("T5", "0"),
    }),
  },
  {
    name: "replies.update",
    input: (x) =>
      replyIn(x, "T5", "0", { t: "Reply one, edited", base: { rev: x.replyRev("T5", "0") } }),
  },
  {
    name: "replies.update",
    input: (x) => replyIn(x, "T5", "0", { t: "Stale", base: { rev: x.replyRev("T5", "0") - 1 } }),
  },
  {
    name: "likes.setReply",
    input: (x) => ({
      reply: x.reply("T5", "0.0"),
      on: true,
    }),
  },
  { name: "replies.delete", input: (x) => replyIn(x, "T5", "0", {}) },
  // a deleted reply is not edited (D18)
  {
    name: "replies.update",
    input: (x) => replyIn(x, "T5", "0", { t: "back", base: { rev: x.replyRev("T5", "0") } }),
  },
  // deleting a reply deletes its likes (D19)
  { name: "replies.delete", input: (x) => replyIn(x, "T5", "0.0", {}) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T4") }) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T5") }) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T2") }) },

  // spaces, as the lounge's admin
  {
    name: "spaces.update",
    input: (x) => ({
      id: x.id("lounge"),
      set: {
        desc: "Talk here",
        faq: true,
        topics: [
          ["t1", "One"],
          ["t2", "Two"],
        ],
        av: 5,
        plain: true,
        pageEdit: "members",
      },
    }),
  },
  {
    name: "spaces.update",
    input: (x) => ({ id: x.id("lounge"), set: { rules: [" Be kind ", ""] } }),
  },
  // the name rule (D7); dom and pages are not settings (D28)
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), set: { name: "Big Lounge!" } }) },
  {
    name: "spaces.update",
    input: (x) => ({ id: x.id("lounge"), set: { dom: { domain: "x.org", state: "ok" } } }),
  },
  { name: "spaces.update", input: (x) => ({ id: x.id("lab"), set: { desc: "no" } }) },
  {
    name: "threads.create",
    label: "T6",
    input: (x) => ({
      id: x.fresh(),
      space: x.id("lounge"),
      kind: "ask",
      q: "With a topic",
      topic: "t2",
    }),
  },
  {
    name: "threads.create",
    label: "T7",
    input: (x) => ({
      id: x.fresh(),
      space: x.id("lounge"),
      kind: "ask",
      q: "With no such topic",
      topic: "t9",
    }),
  },
  { name: "threads.move", input: (x) => ({ id: x.id("T7"), topic: "t1" }) },
  { name: "threads.move", input: (x) => ({ id: x.id("T7"), topic: "t3" }) },
  {
    name: "spaces.update",
    input: (x) => ({ id: x.id("lounge"), set: { topics: [["t1", "One"]] } }),
  },
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), unset: ["faq", "plain"] }) },
  { name: "spaces.verifyDomain", input: (x) => ({ id: x.id("lounge"), domain: " Example.ORG " }) },
  { name: "spaces.verifyDomain", input: (x) => ({ id: x.id("lounge"), domain: "nope" }) },
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), unset: ["dom"] }) },

  // members and links: base and admission ids (D29); the staff list follows (D11)
  {
    name: "members.setRole",
    input: (x) => ({
      space: x.id("lounge"),
      user: "otto",
      role: "mod",
      base: { rev: x.memberRev("lounge", "otto") },
    }),
  },
  {
    name: "members.setRole",
    input: (x) => ({
      space: x.id("lounge"),
      user: "otto",
      role: "member",
      base: { rev: x.memberRev("lounge", "otto") - 1 },
    }),
  },
  {
    name: "members.setRole",
    input: (x) => ({ space: x.id("lounge"), user: "otto", role: "owner", base: { rev: 1 } }),
  },
  {
    name: "members.setRole",
    input: (x) => ({ space: x.id("lounge"), user: "olga", role: "member", base: { rev: 1 } }),
  },
  // an open space: remove (STALE with an admission the person no longer has), then ban
  {
    name: "members.remove",
    input: (x) => ({ space: x.id("lounge"), user: "otto", base: { adm: "an old admission" } }),
  },
  {
    name: "members.remove",
    input: (x) => ({ space: x.id("lounge"), user: "otto", base: { adm: x.adm("lounge", "otto") } }),
  },
  { name: "members.ban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "members.unban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "members.unban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "spaces.join", input: (x) => ({ space: x.id("den") }) },
  { name: "joinRequests.create", input: (x) => ({ space: x.id("den"), rulesAccepted: true }) },
  { name: "joinRequests.withdraw", input: (x) => ({ space: x.id("den") }) },
  { name: "joinRequests.create", input: (x) => ({ space: x.id("vault"), rulesAccepted: true }) },
  {
    name: "joinRequests.decide",
    input: (x) => ({ space: x.id("lab"), users: ["eve"], decision: "decline", why: " Not now " }),
  },
  {
    name: "joinRequests.decide",
    input: (x) => ({ space: x.id("lab"), users: ["eve"], decision: "reopen" }),
  },
  {
    name: "joinRequests.decide",
    input: (x) => ({
      space: x.id("lab"),
      users: ["eve"],
      decision: "reopen",
      base: { eve: x.reqRev("lab", "eve") - 1 },
    }),
  },
  {
    name: "joinRequests.decide",
    input: (x) => ({
      space: x.id("lab"),
      users: ["eve"],
      decision: "reopen",
      base: { eve: x.reqRev("lab", "eve") },
    }),
  },
  {
    name: "joinRequests.decide",
    input: (x) => ({
      space: x.id("lab"),
      users: ["eve"],
      decision: "approve",
      base: { eve: x.reqRev("lab", "eve") },
    }),
  },
  {
    name: "members.remove",
    input: (x) => ({ space: x.id("lab"), user: "eve", base: { adm: "an old admission" } }),
  },
  {
    name: "members.remove",
    input: (x) => ({ space: x.id("lab"), user: "eve", base: { adm: x.adm("lab", "eve") } }),
  },
  {
    name: "invites.create",
    label: "L2",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), days: 7 }),
  },
  { name: "invites.create", input: (x) => ({ id: x.fresh(), space: x.id("den") }) },
  { name: "invites.create", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), days: 31 }) },
  // 0 days is no number of days; null never expires (review round 1 of phase 1)
  { name: "invites.create", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), days: 0 }) },
  { name: "invites.create", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), days: null }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.restore", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L1") }) },

  // reports and moderation
  {
    name: "reports.create",
    label: "P1",
    input: (x) => ({ id: x.fresh(), item: `a:${x.id("T6")}`, why: "Spam" }),
  },
  {
    name: "reports.create",
    label: "P2",
    input: (x) => ({ id: x.fresh(), item: `a:${x.id("T3")}`, why: "Off" }),
  },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T7")}`, decision: "hidden" }) },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T7")}`, decision: "hidden" }) },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T7")}`, decision: "shown" }) },
  {
    name: "moderation.decide",
    input: (x) => ({
      item: `a:${x.id("T7")}`,
      decision: "shown",
      base: { rev: x.itemRev(`a:${x.id("T7")}`) - 1 },
    }),
  },
  {
    name: "moderation.decide",
    input: (x) => ({
      item: `a:${x.id("T7")}`,
      decision: "shown",
      base: { rev: x.itemRev(`a:${x.id("T7")}`) },
    }),
  },
  { name: "reports.resolve", input: (x) => ({ report: x.id("P1"), outcome: "hidden" }) },
  // every reopening requires base (decision 7)
  { name: "reports.resolve", input: (x) => ({ report: x.id("P1"), outcome: "open" }) },
  {
    name: "reports.resolve",
    input: (x) => ({
      report: x.id("P1"),
      outcome: "open",
      base: { rev: x.reportRev("P1") - 1, item: x.itemRev(`a:${x.id("T6")}`) },
    }),
  },
  {
    name: "reports.resolve",
    input: (x) => ({
      report: x.id("P1"),
      outcome: "open",
      base: { rev: x.reportRev("P1"), item: x.itemRev(`a:${x.id("T6")}`) },
    }),
  },
  // dismissing leaves a hidden item hidden (D4)
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T3")}`, decision: "hidden" }) },
  { name: "reports.resolve", input: (x) => ({ report: x.id("P2"), outcome: "dismissed" }) },
  // removal erases the item and everything under it (D6); a removed item stays removed
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T1")}`, decision: "removed" }) },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T1")}`, decision: "hidden" }) },
  { name: "likes.set", input: (x) => ({ thread: x.id("T1"), on: true }) },

  // skills and pages, by id (decision 3)
  {
    name: "skills.create",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), name: "Cite", prompt: "Cite sources." }),
  },
  {
    name: "skills.create",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), name: "Cite", prompt: "again" }),
  },
  {
    name: "skills.create",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), name: "Short", prompt: "Be short." }),
  },
  {
    name: "skills.update",
    input: (x) => ({
      space: x.id("lounge"),
      id: x.skill("lounge", 0),
      name: "Cite",
      prompt: "Cite.",
      base: { rev: 0 },
    }),
  },
  {
    name: "skills.update",
    input: (x) => ({ space: x.id("lounge"), id: x.skill("lounge", 0), name: "Short", prompt: "x" }),
  },
  {
    name: "skills.reorder",
    input: (x) => ({
      space: x.id("lounge"),
      order: [x.skill("lounge", 1), x.skill("lounge", 0)],
      base: { rev: x.skillsRev("lounge") - 1 },
    }),
  },
  {
    name: "skills.reorder",
    input: (x) => ({
      space: x.id("lounge"),
      order: [x.skill("lounge", 1), x.skill("lounge", 0)],
      base: { rev: x.skillsRev("lounge") },
    }),
  },
  {
    name: "skills.reorder",
    input: (x) => ({
      space: x.id("lounge"),
      order: [x.skill("lounge", 0)],
      base: { rev: x.skillsRev("lounge") },
    }),
  },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), id: x.skill("lounge", 0) }) },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), id: x.fresh() }) },
  {
    name: "pages.update",
    input: (x) => ({
      space: x.id("lounge"),
      page: null,
      id: x.fresh(),
      title: "Guide",
      text: ["One"],
    }),
  },
  {
    name: "pages.update",
    input: (x) => ({ space: x.id("lounge"), id: x.fresh(), title: "FAQ", text: [] }),
  },
  // a slug that is taken
  {
    name: "pages.update",
    input: (x) => ({ space: x.id("lounge"), id: x.fresh(), title: " guide! ", text: [] }),
  },
  {
    name: "pages.update",
    input: (x) => ({
      space: x.id("lounge"),
      page: x.page("lounge", 0),
      title: "Guide 2",
      text: ["Two"],
      base: { rev: 1 },
    }),
  },
  {
    name: "pages.update",
    input: (x) => ({
      space: x.id("lounge"),
      page: x.page("lounge", 0),
      title: "Guide 3",
      text: ["x"],
      base: { rev: 1 },
    }),
  },
  {
    name: "pages.restore",
    input: (x) => ({
      space: x.id("lounge"),
      page: x.page("lounge", 0),
      rev: 1,
      note: "Back",
      base: { rev: 2 },
    }),
  },
  {
    name: "pages.move",
    input: (x) => ({ space: x.id("lounge"), page: x.page("lounge", 0), to: 1 }),
  },
  {
    name: "pages.move",
    input: (x) => ({ space: x.id("lounge"), page: x.page("lounge", 1), to: 1 }),
  },
  {
    name: "pages.move",
    input: (x) => ({ space: x.id("lounge"), page: x.page("lounge", 0), to: 5 }),
  },
  { name: "pages.remove", input: (x) => ({ space: x.id("lounge"), page: x.page("lounge", 1) }) },
  {
    name: "pages.update",
    input: (x) => ({ space: x.id("lab"), id: x.fresh(), title: "Lab page", text: ["l"] }),
  },

  // sources; a removed source is put back (D26); one report per person (D25)
  {
    name: "spaceSources.add",
    label: "S1",
    input: (x) => ({
      space: x.id("lounge"),
      url: "https://arxiv.org/abs/2401.0001",
      note: " a paper ",
    }),
  },
  {
    name: "spaceSources.add",
    input: (x) => ({ space: x.id("lounge"), url: "arxiv.org/abs/2401.0001/" }),
  },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lounge"), source: "SRC1" }) },
  {
    name: "spaceSources.add",
    input: (x) => ({ space: x.id("lounge"), url: "https://www.example.org/a?x=1" }),
  },
  {
    name: "spaceSources.add",
    label: "S2",
    input: (x) => ({ space: x.id("lab"), url: "https://x.com/someone/status/1" }),
  },
  { name: "spaceSources.setPolicy", input: (x) => ({ space: x.id("lab"), policy: "review" }) },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lab"), source: x.id("S1") }) },
  {
    name: "sourceReports.create",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), why: "Broken" }),
  },
  {
    name: "sourceReports.create",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), why: "Still broken" }),
  },
  // a source the space does not have (review round 1 of phase 1, E12f)
  {
    name: "sourceReports.create",
    input: (x) => ({ space: x.id("lab"), source: "SRC1", why: "Not here" }),
  },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "keep" }),
  },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "remove" }),
  },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lab"), source: x.id("S2") }) },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: "NOPE", decision: "approve" }),
  },
  { name: "sources.markRead", input: (x) => ({ id: x.id("S2") }) },

  // joining, leaving, and the end of a space
  { name: "spaces.join", input: (x) => ({ space: x.id("lab") }) },
  // the welcome page joins and leaves nothing (D24)
  { name: "onboarding.finish", input: (x) => ({ spaces: [x.id("yard")] }) },
  { name: "onboarding.finish", input: (x) => ({ spaces: [x.id("lab")] }) },
  {
    name: "spaces.create",
    label: "mine",
    input: (x) => ({
      id: x.fresh(),
      name: "Mine",
      vis: "listed",
      qs: [{ q: " Why? " }, { q: " " }],
    }),
  },
  { name: "spaces.create", input: (x) => ({ id: x.fresh(), name: "#mine" }) },
  { name: "spaces.leave", input: (x) => ({ space: x.id("mine") }) },
  // a closed space that becomes open has no policy (D9); archive stores the time (D22)
  { name: "spaces.update", input: (x) => ({ id: x.id("mine"), set: { vis: "open" } }) },
  { name: "spaces.archive", input: (x) => ({ id: x.id("mine"), archived: true }) },
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("mine"), kind: "post", q: "archived" }),
  },
  { name: "spaces.archive", input: (x) => ({ id: x.id("mine"), archived: false }) },
  {
    name: "threads.create",
    label: "T8",
    input: (x) => ({ id: x.fresh(), space: x.id("mine"), kind: "post", q: "Before the end" }),
  },
  { name: "likes.set", input: (x) => ({ thread: x.id("T8"), on: true }) },
  // deleting a space erases its content (D23)
  { name: "spaces.delete", input: (x) => ({ id: x.id("mine") }) },
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("mine"), kind: "post", q: "gone" }),
  },
  // last: the reports notice (D2)
  { name: "notifications.markAllRead", input: () => ({}) },
];

test.serial("the history: after every step, the mutators store what the mock stores", async (t) => {
  await both(t, HISTORY);
  const names = new Set(HISTORY.map((s) => s.name));
  t.log(`${HISTORY.length} steps, ${names.size} mutators`);
  // every mutator is in the history
  t.deepEqual(
    MUTATORS.names.filter((n) => !names.has(n)),
    [],
  );
});

test.serial("every mock procedure is a mutator or an online-only call, and nothing else", (t) => {
  const mock = Object.keys(M.PROCEDURES).sort();
  t.deepEqual(mock, [...MUTATORS.names, ...Object.keys(NOT_MUTATORS)].sort());
});

// ---- the differences that remain ----

/** One side's view of a row's scenario. */
interface Pair {
  w: World;
  ids: Seed["ids"];
  /** Our write as `me`. */
  ours(name: string, input: unknown): Outcome;
  /** The mock's procedure as `me`. */
  mock(name: string, input: unknown): Promise<Awaited<ReturnType<typeof call>>>;
  /** The mock's stored collections now. */
  md(): Any;
  get(key: string): Any;
}

type Seed = ReturnType<typeof seedWorld>;

async function pair(t: ExecutionContext): Promise<Pair> {
  const { w, ids } = seedWorld(t);
  await reset(toMock(w.store), w.now);
  return {
    w,
    ids,
    ours: (name, input) => w.run(ME, name, input),
    mock: (name, input) => call(name, input),
    md: () => stored(),
    get: (key) => w.get(key),
  };
}

/** A row: the procedures, what the mock does, what the mutators do instead,
 * and why the mock keeps it: each is a gap a mock without a real server
 * keeps on purpose. `check` runs the case on both sides and asserts exactly
 * that difference. The rows of phase 1a's table that are gone, the mock
 * adopted (the history marks them, Dn). */
interface Difference {
  id: string;
  procedures: string;
  mock: string;
  ours: string;
  why: string;
  check(t: ExecutionContext, p: Pair): Promise<void>;
}

export const DIFFERENCES: Difference[] = [
  {
    id: "D2",
    procedures: "reports.create",
    mock: "sets the reports notice of its one person (repSeen false) in the procedure's transaction, when that person is staff of the space",
    ours: "writes no notice; the `notifyStaff` effect notifies the space's staff (as they are when it runs) after the commit",
    why: "the mock has no effect worker and one person: it applies that person's part of the effect at once",
    async check(t, p) {
      p.ours("notifications.markSeen", { kind: "reports" });
      await p.mock("notifications.markSeen", { kind: "reports" });
      const out = p.ours("reports.create", { id: p.w.id(), item: `a:${p.ids.T1}`, why: "x" });
      await p.mock("reports.create", { item: `a:${p.ids.T1}`, why: "x" });
      t.false(p.md().repSeen);
      t.true(p.get(`seen:${ME}`).reps);
      t.is(out.status === "ok" ? out.effects[0]?.type : null, "notifyStaff");
    },
  },
  {
    id: "D3",
    procedures: "reports.resolve",
    mock: "writes the reporter's report_resolved notification in the same transaction",
    ours: "queues a `reportResolved` effect; the server writes the notification after the commit",
    why: "the mock has no effect worker (AGENTS.md: effects run after the commit, from a worker)",
    async check(t, p) {
      const id = p.w.id();
      p.ours("reports.create", { id, item: `a:${p.ids.T3}`, why: "x" });
      await p.mock("reports.create", { id, item: `a:${p.ids.T3}`, why: "x" });
      const out = p.ours("reports.resolve", { report: id, outcome: "dismissed" });
      await p.mock("reports.resolve", { report: id, outcome: "dismissed" });
      t.is(p.md().notifs.filter((n: Any) => n.type === "report_resolved").length, 1);
      t.false(
        [...p.w.store.records.values()].some(
          (n) => n.kind === "notif" && n.type === "report_resolved",
        ),
      );
      t.deepEqual(out.status === "ok" ? out.effects : null, [
        { type: "reportResolved", report: id, outcome: "dismissed" },
      ]);
    },
  },
  {
    id: "D12",
    procedures: "invites.create",
    mock: "makes the 10-character code from a hash of the link's id and its count of links",
    ours: "makes it in the pre-check from the server's random source",
    why: "the mock's runs are deterministic (its ids come from the clock and a counter): it has no random source",
    async check(t, p) {
      const id = p.w.id();
      const out = p.ours("invites.create", { id, space: p.ids.lounge });
      const r = await p.mock("invites.create", { id, space: p.ids.lounge });
      const CODE = /^[0-9a-hjkmnp-tv-z]{10}$/;
      t.true(r.ok && CODE.test(r.result.code));
      t.regex(out.status === "ok" ? (out.result as Any).code : "", CODE);
      // the same id and count make the same code in the mock
      await reset(toMock(seedWorld(t).w.store), p.w.now);
      const again = await p.mock("invites.create", { id, space: p.ids.lounge });
      t.is(again.ok && again.result.code, r.ok && r.result.code);
    },
  },
];

for (const d of DIFFERENCES)
  test.serial(
    `${d.id} (${d.procedures}): the mock ${d.mock}; the mutators: ${d.ours}`,
    async (t) => {
      const p = await pair(t);
      await d.check(t, p);
    },
  );

test.serial("the table of differences names each row once, each with a reason", (t) => {
  t.is(new Set(DIFFERENCES.map((d) => d.id)).size, DIFFERENCES.length);
  for (const d of DIFFERENCES) t.truthy(d.why, d.id);
});
