// Equivalence with the mock backend. The same history of writes, as the
// mock's person `me`, runs through the mock's procedures (its own
// dispatcher, under Node) and through the mutators; after each step the
// stored state of both, reduced to what the mock stores for `me`
// (`projectMock`, `projectOurs`), must be equal, and so must each answer's
// outcome (applied, or the same error code).
//
// The history leaves out the inputs where a phase 0 decision (or a decision
// of this package, recorded in the table below) makes the two differ. Each
// row of DIFFERENCES is tested on its own: the mock does what the row says,
// and the mutators do what it says instead.
//
// Not compared: times (both stamp the server's time, but move `updatedAt`
// on different writes), run records (job state; see D5), the mock's display
// fields (`kw`, `online`, `tok`), a space's `mods` (D11), versions of the
// rules (`rulesAt` there, `rulesRev` here), and invite codes (D9).

import test from "ava";
import type { ExecutionContext } from "ava";

import { MUTATORS, isoAt, type Outcome } from "../src/index.js";

import {
  Labels,
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

/** One side of the history: how a step names records on it. */
interface Side {
  side: "ours" | "mock";
  /** The id a label (or a seeded id) stands for. */
  id(label: string): string;
  /** A new client-made id (ours; the mock makes its own and ignores it). */
  fresh(): string;
  /** The k-th follow-up of a thread: ours its id, the mock's its node id. */
  node(th: string, k: number): string;
  /** A reply by its path ("0", "0.1"): ours its id, the mock's the path. */
  reply(th: string, path: string): string;
  /** A record's rev now (ours; the mock has none and ignores `base`). */
  rev(key: string): number;
  /** A member's admission id now (ours; the mock has none). */
  adm(sp: string, u: string): string;
}

interface Step {
  /** The mutator; and the mock's procedure when it has another name. */
  name: string;
  mockName?: string;
  input: (x: Side) => unknown;
  /** Label the record the write creates (its result's `id`). */
  label?: string;
}

/** The seed: three spaces and a few threads, made by the mutators.
 * - #lounge (open): owner olga, admin me, moderator mona, member otto;
 * - #lab (listed, join by request): owner olga, moderator me, member mona;
 * - #den (listed, join by request): owner olga;
 * - #vault (unlisted, invite only): owner olga;
 * - in #lounge: T1, me's ask, with otto's follow-up; T2, otto's post with
 *   me's reply and otto's reply under it; in #lab: T3, olga's ask;
 * - eve asks to join #lab; mona made an invite link to #lounge; otto likes
 *   T1; an invite notification for me to #vault; a catalog source SRC1. */
function seedWorld(t: ExecutionContext) {
  const w = new World(11);
  const [lounge, lab, den, vault] = [w.id(), w.id(), w.id(), w.id()];
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
  return { w, ids: { lounge, lab, den, vault, T1, T2, T3, F1, R1, R2, L1, N1: n } };
}

/** Run a history on both sides, comparing after every step. */
async function both(t: ExecutionContext, steps: Step[], seed = seedWorld(t)) {
  const { w, ids } = seed;
  const L = new Labels();
  const named: Record<string, string> = ids;
  await reset(toMock(w.store), w.now);
  t.deepEqual(projectOurs(w.store, L), projectMock(stored(), L), "the seed");
  for (const [k, step] of steps.entries()) {
    const what = `step ${k + 1}: ${step.name} ${step.input.toString().slice(0, 120)}`;
    const resolve = (label: string, side: "ours" | "mock") =>
      named[label] ?? (side === "ours" ? L.idOurs(label) : L.idMock(label));
    const ours: Side = {
      side: "ours",
      id: (l) => resolve(l, "ours"),
      fresh: () => w.id(),
      node: (th, n) => oursNodes(w, resolve(th, "ours"))[n] ?? "missing",
      reply: (th, path) => oursReply(w, resolve(th, "ours"), path),
      rev: (key) => w.rev(key),
      adm: (sp, u) => w.admission(resolve(sp, "ours"), u).adm,
    };
    const mock: Side = {
      side: "mock",
      id: (l) => resolve(l, "mock"),
      fresh: () => "unused",
      node: (th, n) => mockNodeIds(stored(), resolve(th, "mock"))[n] ?? "missing",
      reply: (_th, path) => path,
      rev: () => 0,
      adm: () => "",
    };
    const a = w.run(ME, step.name, step.input(ours));
    const b = await call(step.mockName ?? step.name, step.input(mock));
    t.is(
      outcome(a),
      b.ok ? "ok" : b.code,
      `${what}: ours ${JSON.stringify(a)}, mock ${JSON.stringify(b)}`,
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

/** Our follow-ups of a thread in the order they were made. */
function oursNodes(w: World, th: string): string[] {
  return [...w.store.records.values()]
    .filter((r) => r.kind === "followup" && r.th === th)
    .sort((a, b) => ((a as Any).createdAt < (b as Any).createdAt ? -1 : 1))
    .map((r) => (r as Any).id as string);
}

function mockNodeIds(d: Any, th: string): string[] {
  const fus = d.fu[th] ?? [];
  const tree = d.qtd[th] ?? { nodes: fus.map((_: unknown, k: number) => ({ id: "f" + k })) };
  return tree.nodes.map((n: Any) => n.id as string);
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

// ---- the history ----

const HISTORY: Step[] = [
  // personal marks
  { name: "likes.set", mockName: "likes.toggle", input: (x) => ({ thread: x.id("T2"), on: true }) },
  { name: "likes.set", mockName: "likes.toggle", input: (x) => ({ thread: x.id("T1"), on: true }) },
  {
    name: "likes.set",
    mockName: "likes.toggle",
    input: (x) => ({ thread: x.id("T1"), on: false }),
  },
  { name: "likes.set", mockName: "likes.toggle", input: (x) => ({ thread: x.id("T3"), on: true }) },
  {
    name: "saved.set",
    mockName: "saved.toggle",
    input: (x) => ({ kind: "thread", id: x.id("T1"), on: true }),
  },
  {
    name: "saved.set",
    mockName: "saved.toggle",
    input: (x) => ({ kind: "thread", id: x.id("T1"), on: false }),
  },
  {
    name: "saved.set",
    mockName: "saved.toggle",
    input: (x) => ({ kind: "ask", id: `${x.id("T1")}:r`, on: true }),
  },
  {
    name: "saved.set",
    mockName: "saved.toggle",
    input: (x) => ({ kind: "ask", id: `${x.id("T1")}:${x.node("T1", 0)}`, on: true }),
  },
  {
    name: "saved.set",
    mockName: "saved.toggle",
    input: () => ({ kind: "source", id: "SRC1", on: true }),
  },
  {
    name: "likes.setReply",
    mockName: "likes.toggleReply",
    input: (x) =>
      x.side === "ours"
        ? { reply: x.reply("T2", "0.0"), on: true }
        : { reply: `${x.id("T2")}:0.0`, on: true },
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
  { name: "notifications.markRead", input: (x) => ({ id: x.id("N1") }) },
  { name: "invites.decline", input: (x) => ({ notification: x.id("N1") }) },
  { name: "notifications.markSeen", input: () => ({ kind: "requests" }) },

  // threads, follow-ups and replies
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
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "post", q: "   " }),
  },
  {
    name: "threads.create",
    input: (x) => ({ id: x.fresh(), space: x.id("den"), kind: "post", q: "x" }),
  },
  {
    name: "threads.update",
    input: (x) => ({
      id: x.id("T4"),
      q: "A new ask, edited",
      base: { rev: x.rev(`thread:${x.id("T4")}`) },
    }),
  },
  {
    name: "threads.update",
    input: (x) => ({
      id: x.id("T4"),
      q: "A new ask, edited",
      base: { rev: x.rev(`thread:${x.id("T4")}`) },
    }),
  },
  {
    name: "threads.update",
    input: (x) => ({ id: x.id("T2"), q: "not mine", base: { rev: x.rev(`thread:${x.id("T2")}`) } }),
  },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "First" }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "Second" }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T5"), q: "on a post" }) },
  {
    name: "followups.update",
    input: (x) => ({
      thread: x.id("T4"),
      node: x.node("T4", 1),
      q: "Second, edited",
      base: { rev: x.rev(`followup:${x.node("T4", 1)}`) },
    }),
  },
  {
    name: "followups.update",
    input: (x) => ({ thread: x.id("T1"), node: x.node("T1", 0), q: "not mine", base: { rev: 1 } }),
  },
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
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 0) }) },
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 1) }) },
  {
    name: "research.createPostFollowUp",
    input: (x) => ({ id: x.fresh(), thread: x.id("T5"), t: "Reply one" }),
  },
  {
    name: "research.createPostFollowUp",
    input: (x) =>
      x.side === "ours"
        ? { id: x.fresh(), thread: x.id("T5"), t: "Under one", parent: x.reply("T5", "0") }
        : { thread: x.id("T5"), t: "Under one", parent: 0 },
  },
  {
    name: "replies.update",
    input: (x) =>
      x.side === "ours"
        ? {
            thread: x.id("T5"),
            reply: x.reply("T5", "0"),
            t: "Reply one, edited",
            base: { rev: x.rev(`reply:${x.reply("T5", "0")}`) },
          }
        : { thread: x.id("T5"), path: "0", t: "Reply one, edited" },
  },
  {
    name: "replies.delete",
    input: (x) =>
      x.side === "ours"
        ? { thread: x.id("T5"), reply: x.reply("T5", "0") }
        : { thread: x.id("T5"), path: "0" },
  },
  {
    name: "replies.delete",
    input: (x) =>
      x.side === "ours"
        ? { thread: x.id("T5"), reply: x.reply("T5", "0.0") }
        : { thread: x.id("T5"), path: "0.0" },
  },
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

  // members and links
  {
    name: "members.setRole",
    input: (x) => ({
      space: x.id("lounge"),
      user: "otto",
      role: "mod",
      base: { rev: x.rev(`member:${x.id("lounge")}:otto`) },
    }),
  },
  {
    name: "members.setRole",
    input: (x) => ({ space: x.id("lounge"), user: "otto", role: "owner", base: { rev: 0 } }),
  },
  {
    name: "members.setRole",
    input: (x) => ({ space: x.id("lounge"), user: "olga", role: "member", base: { rev: 0 } }),
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
    input: (x) => ({
      space: x.id("lab"),
      users: ["eve"],
      decision: "reopen",
      base: { eve: x.rev(`request:${x.id("lab")}:eve`) },
    }),
  },
  {
    name: "joinRequests.decide",
    input: (x) => ({
      space: x.id("lab"),
      users: ["eve"],
      decision: "approve",
      base: { eve: x.rev(`request:${x.id("lab")}:eve`) },
    }),
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
  {
    name: "moderation.decide",
    input: (x) => ({
      item: `a:${x.id("T7")}`,
      decision: "shown",
      base: { rev: x.rev(`thread:${x.id("T7")}`) },
    }),
  },
  { name: "reports.resolve", input: (x) => ({ report: x.id("P1"), outcome: "hidden" }) },

  // skills and pages
  {
    name: "skills.create",
    input: (x) => ({ space: x.id("lounge"), name: "Cite", prompt: "Cite sources." }),
  },
  {
    name: "skills.create",
    input: (x) => ({ space: x.id("lounge"), name: "Cite", prompt: "again" }),
  },
  {
    name: "skills.create",
    input: (x) => ({ space: x.id("lounge"), name: "Short", prompt: "Be short." }),
  },
  {
    name: "skills.update",
    input: (x) => ({
      space: x.id("lounge"),
      index: 0,
      name: "Cite",
      prompt: "Cite.",
      base: { rev: 0 },
    }),
  },
  {
    name: "skills.update",
    input: (x) => ({ space: x.id("lounge"), index: 0, name: "Short", prompt: "x" }),
  },
  { name: "skills.reorder", input: (x) => ({ space: x.id("lounge"), from: 0, to: 1 }) },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), index: 0 }) },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), index: 4 }) },
  {
    name: "pages.update",
    input: (x) => ({ space: x.id("lounge"), page: null, title: "Guide", text: ["One"] }),
  },
  { name: "pages.update", input: (x) => ({ space: x.id("lounge"), title: "FAQ", text: [] }) },
  {
    name: "pages.update",
    input: (x) => ({
      space: x.id("lounge"),
      page: 0,
      title: "Guide 2",
      text: ["Two"],
      base: { rev: 1 },
    }),
  },
  {
    name: "pages.update",
    input: (x) => ({
      space: x.id("lounge"),
      page: 0,
      title: "Guide 3",
      text: ["x"],
      base: { rev: 1 },
    }),
  },
  {
    name: "pages.restore",
    input: (x) => ({ space: x.id("lounge"), page: 0, rev: 1, note: "Back", base: { rev: 2 } }),
  },
  { name: "pages.move", input: (x) => ({ space: x.id("lounge"), from: 0, to: 1 }) },
  { name: "pages.remove", input: (x) => ({ space: x.id("lounge"), page: 1 }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lab"), title: "Lab page", text: ["l"] }) },

  // sources
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
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "keep" }),
  },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "remove" }),
  },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "restore" }),
  },
  {
    name: "spaceSources.review",
    input: (x) => ({ space: x.id("lab"), source: "NOPE", decision: "approve" }),
  },
  { name: "sources.markRead", input: (x) => ({ id: x.id("S2") }) },

  // joining and leaving
  { name: "spaces.join", input: (x) => ({ space: x.id("lab") }) },
  {
    name: "spaces.create",
    label: "mine",
    input: (x) => ({
      id: x.fresh(),
      name: "Mine",
      vis: "listed",
      policy: "request",
      invite: "mods",
      qs: [{ q: "Why?" }, { q: " " }],
    }),
  },
  { name: "spaces.create", input: (x) => ({ id: x.fresh(), name: "#mine" }) },

  { name: "spaces.leave", input: (x) => ({ space: x.id("mine") }) },
  // last: reports.create sets the mock's repSeen to false (D2)
  { name: "notifications.markAllRead", input: () => ({}) },
];

test.serial("the history: after every step, the mutators store what the mock stores", async (t) => {
  await both(t, HISTORY);
  const names = new Set(HISTORY.map((s) => s.name));
  t.log(`${HISTORY.length} steps, ${names.size} mutators`);
  // the mutators the history leaves out are in the table below
  t.deepEqual(
    MUTATORS.names.filter((n) => !names.has(n)),
    ["spaces.archive", "spaces.delete", "onboarding.finish"],
  );
});

// ---- the intended differences ----

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
 * and why (a phase 0 decision, or this package's). `check` runs the case on
 * both sides and asserts exactly that difference. */
interface Difference {
  id: string;
  procedures: string;
  mock: string;
  ours: string;
  why: string;
  check(t: ExecutionContext, p: Pair): Promise<void>;
}

const OLD_PAGE = "01KA0000000000000000000000";
const code = (o: Outcome) => (o.status === "refused" ? o.error.code : o.status);
const mockCode = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? "ok" : r.code);

export const DIFFERENCES: Difference[] = [
  {
    id: "D1",
    procedures: "likes.toggle, likes.toggleReply, saved.toggle",
    mock: "toggle when `on` is left out",
    ours: "likes.set, likes.setReply and saved.set, with a required `on`",
    why: "phase 0: the result depends on what the client saw, so two devices do not cancel out",
    async check(t, p) {
      t.is(mockCode(await p.mock("likes.toggle", { thread: p.ids.T2 })), "ok");
      t.true(p.md().liked.has(p.ids.T2));
      t.is(code(p.ours("likes.set", { thread: p.ids.T2 })), "BAD_REQUEST");
      t.is(code(p.ours("likes.toggle", { thread: p.ids.T2 })), "NOT_FOUND");
    },
  },
  {
    id: "D2",
    procedures: "reports.create",
    mock: "sets the caller's own `repSeen` to false",
    ours: "writes no seen flag; the space's staff are notified by a post-commit effect (`notifyStaff`)",
    why: "the mock has one person; the notice is for the staff, written by the server",
    async check(t, p) {
      p.ours("notifications.markSeen", { kind: "reports" });
      await p.mock("notifications.markSeen", { kind: "reports" });
      const out = p.ours("reports.create", { id: p.w.id(), item: `a:${p.ids.T3}`, why: "x" });
      await p.mock("reports.create", { item: `a:${p.ids.T3}`, why: "x" });
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
    why: "AGENTS.md: effects run after the commit, from a worker",
    async check(t, p) {
      const id = p.w.id();
      p.ours("reports.create", { id, item: `a:${p.ids.T3}`, why: "x" });
      const r = await p.mock("reports.create", { item: `a:${p.ids.T3}`, why: "x" });
      const out = p.ours("reports.resolve", { report: id, outcome: "dismissed" });
      await p.mock("reports.resolve", { report: r.ok ? r.result.id : "", outcome: "dismissed" });
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
    id: "D4",
    procedures: "reports.resolve",
    mock: '"dismissed" on the last open report of an item shows the item (deletes its moderation state)',
    ours: "dismissing leaves the item's moderation state as it is",
    why: "showing an item needs its base.rev (phase 0, stale intent); a dismissal decides about the report",
    async check(t, p) {
      p.ours("moderation.decide", { item: `a:${p.ids.T3}`, decision: "hidden" });
      await p.mock("moderation.decide", { item: `a:${p.ids.T3}`, decision: "hidden" });
      const id = p.w.id();
      p.ours("reports.create", { id, item: `a:${p.ids.T3}`, why: "x" });
      const r = await p.mock("reports.create", { item: `a:${p.ids.T3}`, why: "x" });
      p.ours("reports.resolve", { report: id, outcome: "dismissed" });
      await p.mock("reports.resolve", { report: r.ok ? r.result.id : "", outcome: "dismissed" });
      t.is(p.md().modSt[`a:${p.ids.T3}`], undefined);
      t.is(p.get(`thread:${p.ids.T3}`).mod, "hidden");
    },
  },
  {
    id: "D5",
    procedures: "followups.ask, research.forkNode",
    mock: "starts a run of the new ask (a run record)",
    ours: "writes the follow-up only; no run record and no job",
    why: "the prototype's followups.ask (phase 0); see the design findings",
    async check(t, p) {
      p.ours("followups.ask", { id: p.w.id(), thread: p.ids.T1, q: "Q" });
      await p.mock("followups.ask", { thread: p.ids.T1, q: "Q" });
      t.truthy(p.md().runs[`${p.ids.T1}:f1`]);
      // the one run of T1 is its own ask's, from threads.create
      t.is(
        [...p.w.store.records.values()].filter((r) => r.kind === "run" && r.th === p.ids.T1).length,
        1,
      );
    },
  },
  {
    id: "D6",
    procedures: 'moderation.decide, reports.resolve ("removed")',
    mock: "marks the item removed and keeps its text and everything under it",
    ours: "erases the item's text, and a thread's follow-ups, replies and runs, from storage",
    why: "phase 0: removing a thread erases it and everything under it",
    async check(t, p) {
      p.ours("moderation.decide", { item: `a:${p.ids.T1}`, decision: "removed" });
      await p.mock("moderation.decide", { item: `a:${p.ids.T1}`, decision: "removed" });
      const m = p.md();
      t.is(m.modSt[`a:${p.ids.T1}`], "removed");
      t.is(m.posts.find((x: Any) => x.id === p.ids.T1).q, "Why?");
      t.is(m.fu[p.ids.T1].length, 1);
      t.like(p.get(`thread:${p.ids.T1}`), { mod: "removed", q: "" });
      t.is(p.get(`followup:${p.ids.F1}`), undefined);
    },
  },
  {
    id: "D7",
    procedures: "spaces.update",
    mock: "stores a new name as sent",
    ours: "applies the name rule (lower case, [a-z0-9-], 32 characters), as spaces.create does",
    why: "the prototype's spaces.update (phase 0)",
    async check(t, p) {
      p.ours("spaces.update", { id: p.ids.lounge, set: { name: "Big Lounge!" } });
      await p.mock("spaces.update", { id: p.ids.lounge, set: { name: "Big Lounge!" } });
      t.is(p.md().spaces.find((s: Any) => s.id === p.ids.lounge).name, "Big Lounge!");
      t.is(p.get(`space:${p.ids.lounge}`).name, "big-lounge-");
    },
  },
  {
    id: "D8",
    procedures: "spaces.create",
    mock: "stores a closed space's policy, invite setting and questions as sent (absent when left out; questions untrimmed)",
    ours: 'defaults policy "request" and invite "mods", and trims the questions',
    why: "the prototype's spaces.create (phase 0)",
    async check(t, p) {
      p.ours("spaces.create", { id: p.w.id(), name: "club", vis: "listed", qs: [{ q: " Why? " }] });
      await p.mock("spaces.create", { name: "club", vis: "listed", qs: [{ q: " Why? " }] });
      const m = p.md().spaces.find((s: Any) => s.name === "club");
      t.like(m, { policy: undefined, invite: undefined });
      t.is(m.qs[0].q, " Why? ");
      const ours = [...p.w.store.records.values()].find(
        (r) => r.kind === "space" && r.name === "club",
      ) as Any;
      t.like(ours, { policy: "request", invite: "mods" });
      t.is(ours.qs[0].q, "Why?");
    },
  },
  {
    id: "D9",
    procedures: "spaces.update",
    mock: "keeps a space's policy, invite setting and questions when it becomes open",
    ours: "clears them (they apply to closed spaces only)",
    why: "the prototype's spaces.update (phase 0)",
    async check(t, p) {
      const club = { name: "club", vis: "listed", policy: "request", invite: "mods" };
      const id = p.w.id();
      p.ours("spaces.create", { id, ...club });
      const r = await p.mock("spaces.create", club);
      p.ours("spaces.update", { id, set: { vis: "open" } });
      await p.mock("spaces.update", { id: r.ok ? r.result.id : "", set: { vis: "open" } });
      t.like(
        p.md().spaces.find((s: Any) => s.name === "club"),
        { vis: "open", policy: "request", invite: "mods" },
      );
      t.like(p.get(`space:${id}`), { vis: "open", policy: null, invite: null });
    },
  },
  {
    id: "D10",
    procedures: "spaces.join, spaces.leave",
    mock: "changes only the person's own lists (`joined`, `rel`); the space's member list and count stay",
    ours: "the member record is the membership: joining writes it, leaving deletes it, and the count follows",
    why: "the mock has one person; here a membership is one record (phase 0)",
    async check(t, p) {
      const yard = p.w.id();
      p.w.run("olga", "spaces.create", { id: yard, name: "yard" });
      await reset(toMock(p.w.store), p.w.now);
      p.ours("spaces.join", { space: yard });
      await p.mock("spaces.join", { space: yard });
      t.true(p.md().joined.includes(yard));
      t.false(p.md().memOther[yard].some((m: Any) => m.u === ME));
      t.truthy(p.get(`member:${yard}:${ME}`));
      t.is(p.get(`space:${yard}`).members, 2);
    },
  },
  {
    id: "D11",
    procedures: "members.setRole (and every change of a member's role)",
    mock: "updates a space's staff list (`mods`) only for the caller's own role and an ownership transfer",
    ours: "rewrites the staff list from the member records after every change",
    why: "the staff list is what a non-member reads of a closed space (phase 0)",
    async check(t, p) {
      p.ours("members.setRole", {
        space: p.ids.lounge,
        user: "otto",
        role: "mod",
        base: { rev: p.w.rev(`member:${p.ids.lounge}:otto`) },
      });
      await p.mock("members.setRole", { space: p.ids.lounge, user: "otto", role: "mod" });
      t.false(
        p
          .md()
          .spaces.find((s: Any) => s.id === p.ids.lounge)
          .mods.some((m: Any) => m[0] === "otto"),
      );
      t.true(p.get(`space:${p.ids.lounge}`).mods.some((m: Any) => m[0] === "otto"));
    },
  },
  {
    id: "D12",
    procedures: "invites.create",
    mock: "makes the link's id and takes its code from the id (`id.slice(-5)`)",
    ours: "the client makes the id; the server makes a 10-character code from its random source in the pre-check",
    why: "phase 0: server-made values never come from the client",
    async check(t, p) {
      const id = p.w.id();
      const out = p.ours("invites.create", { id, space: p.ids.lounge });
      const r = await p.mock("invites.create", { space: p.ids.lounge });
      t.true(r.ok && r.result.code === r.result.id.slice(-5).toLowerCase());
      const c = out.status === "ok" ? (out.result as Any).code : "";
      t.is(c.length, 10);
      t.false(id.toLowerCase().includes(c));
    },
  },
  {
    id: "D13",
    procedures: "spaces.join (notification)",
    mock: "an invite notification admits the person to the closed space",
    ours: "it is marked accepted, and admits nobody: joining a closed space needs a live invite link",
    why: "phase 0: an invite is a link; a standing pass would let a removed member join again",
    async check(t, p) {
      t.is(
        mockCode(await p.mock("spaces.join", { space: p.ids.vault, notification: p.ids.N1 })),
        "ok",
      );
      t.true(p.md().joined.includes(p.ids.vault));
      t.is(
        code(p.ours("spaces.join", { space: p.ids.vault, notification: p.ids.N1 })),
        "FORBIDDEN",
      );
    },
  },
  {
    id: "D14",
    procedures: "spaces.join (an approved request)",
    mock: "a request a moderator approved lets the person join again after a removal",
    ours: "approval writes the membership; an approved request admits nobody later",
    why: "phase 0: an approved request kept as a standing pass would let a removed member join again",
    async check(t, p) {
      const md = p.md();
      md.reqs.push({ u: ME, sp: p.ids.den, st: "approved", a: [] });
      await reset(md, p.w.now);
      t.is(mockCode(await p.mock("spaces.join", { space: p.ids.den })), "ok");
      p.w.run(ME, "joinRequests.create", { space: p.ids.den, rulesAccepted: true });
      p.w.run("olga", "joinRequests.decide", {
        space: p.ids.den,
        users: [ME],
        decision: "approve",
        base: p.w.requests(p.ids.den, [ME]),
      });
      p.w.run("olga", "members.remove", {
        space: p.ids.den,
        user: ME,
        base: p.w.admission(p.ids.den, ME),
      });
      t.is(code(p.ours("spaces.join", { space: p.ids.den })), "FORBIDDEN");
    },
  },
  {
    id: "D15",
    procedures: "every write in a space",
    mock: "a banned person can still write in an open space (bans stop joining a closed one)",
    ours: "a ban stops every write in its space, the person's own included",
    why: "phase 0: a ban stops every write in its space",
    async check(t, p) {
      p.w.run("olga", "members.ban", { space: p.ids.lounge, user: "otto" });
      const md = p.md();
      md.banned.push({ id: `${p.ids.lounge}:${ME}`, sp: p.ids.lounge, u: ME });
      await reset(md, p.w.now);
      t.is(
        mockCode(await p.mock("threads.create", { space: p.ids.lounge, kind: "post", q: "x" })),
        "ok",
      );
      t.is(
        code(
          p.w.run("otto", "threads.create", {
            id: p.w.id(),
            space: p.ids.lounge,
            kind: "post",
            q: "x",
          }),
        ),
        "FORBIDDEN",
      );
    },
  },
  {
    id: "D16",
    procedures: "research.createPostFollowUp",
    mock: "adds a reply to an ask thread",
    ours: "BAD_REQUEST: replies are for posts",
    why: "the prototype's research.createPostFollowUp (phase 0)",
    async check(t, p) {
      t.is(
        mockCode(await p.mock("research.createPostFollowUp", { thread: p.ids.T1, t: "x" })),
        "ok",
      );
      t.is(
        code(p.ours("research.createPostFollowUp", { id: p.w.id(), thread: p.ids.T1, t: "x" })),
        "BAD_REQUEST",
      );
    },
  },
  {
    id: "D17",
    procedures: "research.forkNode",
    mock: "adds an ask to a post's ask tree",
    ours: "BAD_REQUEST: ask trees are for asks, as followups.ask",
    why: "this package: a post's first-level count is its replies",
    async check(t, p) {
      t.is(
        mockCode(await p.mock("research.forkNode", { thread: p.ids.T2, parent: "r", q: "x" })),
        "ok",
      );
      t.is(
        code(p.ours("research.forkNode", { id: p.w.id(), thread: p.ids.T2, parent: "r", q: "x" })),
        "BAD_REQUEST",
      );
    },
  },
  {
    id: "D18",
    procedures: "replies.update, followups.update",
    mock: "edits a deleted reply or follow-up, writing text back into the shell",
    ours: "PRECONDITION_FAILED, as threads.update does for a deleted thread",
    why: "the prototype's threads.update (phase 0), applied to replies and follow-ups",
    async check(t, p) {
      p.ours("replies.delete", { thread: p.ids.T2, reply: p.ids.R1 });
      await p.mock("replies.delete", { thread: p.ids.T2, path: "0" });
      t.is(
        mockCode(await p.mock("replies.update", { thread: p.ids.T2, path: "0", t: "back" })),
        "ok",
      );
      t.is(p.md().rp[p.ids.T2][0].t, "back");
      t.is(
        code(
          p.ours("replies.update", {
            thread: p.ids.T2,
            reply: p.ids.R1,
            t: "back",
            base: { rev: p.w.rev(`reply:${p.ids.R1}`) },
          }),
        ),
        "PRECONDITION_FAILED",
      );
    },
  },
  {
    id: "D19",
    procedures: "replies.delete",
    mock: "keeps reply likes, keyed by the reply's path (which then names another reply)",
    ours: "deletes the likes of a reply it deletes",
    why: "this package: a reply like names the reply's id",
    async check(t, p) {
      p.w.run("otto", "likes.setReply", { reply: p.ids.R2, on: true });
      const md = p.md();
      md.rpLiked.add(`${p.ids.T2}:0.0`);
      await reset(md, p.w.now);
      p.w.run("otto", "replies.delete", { thread: p.ids.T2, reply: p.ids.R2 });
      await p.mock("replies.delete", { thread: p.ids.T2, path: "0.0" });
      t.true(p.md().rpLiked.has(`${p.ids.T2}:0.0`));
      t.is(p.get(`rlike:otto:${p.ids.R2}`), undefined);
    },
  },
  {
    id: "D20",
    procedures: "threads.update, followups.update, replies.update",
    mock: "takes no base",
    ours: "an author's edit carries `base.rev` of what it edits, and is STALE when it differs",
    why: "phase 0: threads.update carries base.rev; here also follow-ups and replies",
    async check(t, p) {
      t.is(mockCode(await p.mock("threads.update", { id: p.ids.T1, q: "Why not?" })), "ok");
      t.is(
        code(p.ours("threads.update", { id: p.ids.T1, q: "Why not?", base: { rev: 0 } })),
        "STALE",
      );
      t.is(
        code(
          p.ours("replies.update", { thread: p.ids.T2, reply: p.ids.R1, t: "x", base: { rev: 0 } }),
        ),
        "STALE",
      );
    },
  },
  {
    id: "D21",
    procedures: "threads.create (from)",
    mock: "anyone who may read the thread starts a thread from any follow-up; the new thread is the follow-up's author's",
    ours: "only the follow-up's author starts a thread from it, as its author; hidden and removed follow-ups are not copied",
    why: "this package: a write never makes a record in another person's name",
    async check(t, p) {
      const r = await p.mock("threads.create", {
        space: p.ids.lounge,
        kind: "ask",
        q: "",
        from: { th: p.ids.T1, node: "f0" },
      });
      t.true(r.ok);
      t.is(p.md().posts.find((x: Any) => r.ok && x.id === r.result.id).u, "otto");
      t.is(
        code(
          p.ours("threads.create", {
            id: p.w.id(),
            space: p.ids.lounge,
            kind: "ask",
            q: "",
            from: { th: p.ids.T1, node: p.ids.F1 },
          }),
        ),
        "FORBIDDEN",
      );
    },
  },
  {
    id: "D22",
    procedures: "spaces.archive",
    mock: 'stores the day as the page shows it (`Intl`: "Nov 16")',
    ours: "stores the time (ISO)",
    why: "AGENTS.md: run uses no Intl formatting",
    async check(t, p) {
      const mine = p.w.id();
      p.ours("spaces.create", { id: mine, name: "mine" });
      const r = await p.mock("spaces.create", { name: "mine" });
      p.ours("spaces.archive", { id: mine, archived: true });
      await p.mock("spaces.archive", { id: r.ok ? r.result.id : "", archived: true });
      t.deepEqual(p.md().spaces.find((s: Any) => s.name === "mine").archived, {
        by: ME,
        on: "Nov 16",
      });
      t.deepEqual(p.get(`space:${mine}`).archived, { by: ME, at: isoAt(p.w.now) });
    },
  },
  {
    id: "D23",
    procedures: "spaces.delete",
    mock: "marks the space deleted and keeps its content",
    ours: "erases its content (threads and what is under them, members, requests, bans, links, reports, pages, skills, sources, and the likes, saves and notifications about it) and marks the space deleted",
    why: "this package, after phase 0's erasure rule; online only",
    async check(t, p) {
      const mine = p.w.id();
      p.ours("spaces.create", { id: mine, name: "mine" });
      const r = await p.mock("spaces.create", { name: "mine" });
      const sid = r.ok ? r.result.id : "";
      const th = p.w.id();
      p.ours("threads.create", { id: th, space: mine, kind: "post", q: "x" });
      await p.mock("threads.create", { space: sid, kind: "post", q: "x" });
      p.ours("spaces.delete", { id: mine });
      await p.mock("spaces.delete", { id: sid });
      t.true(p.md().spaces.find((s: Any) => s.id === sid).deleted);
      t.is(p.md().posts.filter((x: Any) => x.s === sid).length, 1);
      t.true(p.get(`space:${mine}`).deleted);
      t.is(p.get(`thread:${th}`), undefined);
    },
  },
  {
    id: "D24",
    procedures: "onboarding.finish",
    mock: "replaces the person's list of joined spaces with the listed ones",
    ours: "joins the listed open spaces and leaves no space",
    why: "this package: a membership is a member record, and leaving is spaces.leave",
    async check(t, p) {
      const yard = p.w.id();
      p.w.run("olga", "spaces.create", { id: yard, name: "yard" });
      await reset(toMock(p.w.store), p.w.now);
      p.ours("onboarding.finish", { spaces: [yard] });
      await p.mock("onboarding.finish", { spaces: [yard] });
      t.deepEqual(p.md().joined, [yard]);
      t.truthy(p.get(`member:${p.ids.lounge}:${ME}`));
      t.truthy(p.get(`member:${yard}:${ME}`));
    },
  },
  {
    id: "D25",
    procedures: "sourceReports.create",
    mock: "adds a report each time",
    ours: "one report per person, source and space: a second replaces the first's reason",
    why: "this package: a report of a source is keyed by space, source and person",
    async check(t, p) {
      for (const why of ["a", "b"]) {
        p.ours("sourceReports.create", { space: p.ids.lab, source: "SRC1", why });
        await p.mock("sourceReports.create", { space: p.ids.lab, source: "SRC1", why });
      }
      t.is(p.md().dsReps.length, 2);
      t.is(p.get(`srcrep:${p.ids.lab}:SRC1:${ME}`).why, "b");
    },
  },
  {
    id: "D26",
    procedures: "spaceSources.add",
    mock: "adding a source removed from the space adds a second entry for it",
    ours: "the space's one entry for the source is put back (`rm` false)",
    why: "this package: a source in a space is keyed by space and source",
    async check(t, p) {
      p.ours("spaceSources.add", { space: p.ids.lounge, source: "SRC1" });
      await p.mock("spaceSources.add", { space: p.ids.lounge, source: "SRC1" });
      p.ours("spaceSources.review", { space: p.ids.lounge, source: "SRC1", decision: "remove" });
      await p.mock("spaceSources.review", {
        space: p.ids.lounge,
        source: "SRC1",
        decision: "remove",
      });
      p.ours("spaceSources.add", { space: p.ids.lounge, source: "SRC1" });
      await p.mock("spaceSources.add", { space: p.ids.lounge, source: "SRC1" });
      t.is(p.md().dsDrops[p.ids.lounge].length, 2);
      t.false(p.get(`spacesrc:${p.ids.lounge}:SRC1`).rm);
    },
  },
  {
    id: "D27",
    procedures: "pages.update, pages.restore",
    mock: "a listed page without a stored document takes its author and history from the client's `base`",
    ours: "it stands for an empty document by the editor; `base` gives only the version",
    why: "phase 0: the server never stores client-made state",
    async check(t, p) {
      p.w.store.records.set(`pages:${p.ids.lounge}`, {
        kind: "pages",
        sp: p.ids.lounge,
        list: [{ id: OLD_PAGE, t: "Old", at: "2026-11-01T00:00:00Z" }],
        rev: 1,
      });
      const md = p.md();
      md.spaces.find((s: Any) => s.id === p.ids.lounge).pages = [["Old", "2026-11-01T00:00:00Z"]];
      await reset(md, p.w.now);
      const base = { by: "olga", revs: [{ by: "olga", note: "Wrote it" }] };
      p.ours("pages.update", { space: p.ids.lounge, page: 0, title: "Old", text: ["x"], base });
      await p.mock("pages.update", {
        space: p.ids.lounge,
        page: 0,
        title: "Old",
        text: ["x"],
        base,
      });
      t.like(p.md().pagedocs[`${p.ids.lounge}/old`], { by: "olga" });
      t.is(p.md().pagedocs[`${p.ids.lounge}/old`].revs.length, 2);
      t.like(p.get(`page:${p.ids.lounge}:old`), { by: ME });
      t.is(p.get(`page:${p.ids.lounge}:old`).revs.length, 1);
    },
  },
  {
    id: "D28",
    procedures: "spaces.update",
    mock: "accepts `dom` (a verified domain) and `pages` as settings",
    ours: "BAD_REQUEST: the domain's state is the domain check's, and pages are the page procedures'",
    why: "phase 0: server-made values never come from the client",
    async check(t, p) {
      const dom = { domain: "x.org", state: "ok" };
      t.is(mockCode(await p.mock("spaces.update", { id: p.ids.lounge, set: { dom } })), "ok");
      t.is(code(p.ours("spaces.update", { id: p.ids.lounge, set: { dom } })), "BAD_REQUEST");
    },
  },
  {
    id: "D29",
    procedures:
      "moderation.decide, reports.resolve, joinRequests.decide, members.setRole, members.remove",
    mock: "take no base",
    ours: '"shown", reopening a report that shows an item, approving and reopening a request and a role change carry base.rev (STALE when it differs); a removal names the admission id; hiding, removing, declining and banning apply to the record as it is',
    why: "phase 0: stale intent",
    async check(t, p) {
      p.ours("moderation.decide", { item: `a:${p.ids.T3}`, decision: "hidden" });
      await p.mock("moderation.decide", { item: `a:${p.ids.T3}`, decision: "hidden" });
      t.is(
        mockCode(await p.mock("moderation.decide", { item: `a:${p.ids.T3}`, decision: "shown" })),
        "ok",
      );
      t.is(
        code(p.ours("moderation.decide", { item: `a:${p.ids.T3}`, decision: "shown" })),
        "BAD_REQUEST",
      );
      t.is(
        code(
          p.ours("moderation.decide", {
            item: `a:${p.ids.T3}`,
            decision: "shown",
            base: { rev: 1 },
          }),
        ),
        "STALE",
      );
      t.is(
        mockCode(
          await p.mock("joinRequests.decide", {
            space: p.ids.lab,
            users: ["eve"],
            decision: "approve",
          }),
        ),
        "ok",
      );
      t.is(
        code(
          p.ours("joinRequests.decide", {
            space: p.ids.lab,
            users: ["eve"],
            decision: "approve",
            base: { eve: 0 },
          }),
        ),
        "STALE",
      );
      t.is(
        code(p.ours("members.remove", { space: p.ids.lounge, user: "otto", base: { adm: "old" } })),
        "STALE",
      );
    },
  },
  {
    id: "D30",
    procedures: "followups.ask",
    mock: 'stores the answer as "Researching…" until the run writes it',
    ours: "stores `a` null until the job writes it",
    why: "the prototype's follow-up (phase 0): no display text is stored",
    async check(t, p) {
      p.ours("followups.ask", { id: p.w.id(), thread: p.ids.T1, q: "Q" });
      await p.mock("followups.ask", { thread: p.ids.T1, q: "Q" });
      t.is(p.md().fu[p.ids.T1][1].a, "Researching…");
      t.is(
        [...p.w.store.records.values()]
          .filter((r) => r.kind === "followup" && r.q === "Q")
          .map((r) => (r as Any).a)[0],
        null,
      );
    },
  },
  {
    id: "D31",
    procedures: "threads.create",
    mock: "stores `kw` (the question again, for search)",
    ours: "stores no search copy",
    why: "this package: the search index is the server's, not a stored field",
    async check(t, p) {
      const id = p.w.id();
      p.ours("threads.create", { id, space: p.ids.lounge, kind: "post", q: "Words" });
      const r = await p.mock("threads.create", { space: p.ids.lounge, kind: "post", q: "Words" });
      t.is(p.md().posts.find((x: Any) => r.ok && x.id === r.result.id).kw, "Words");
      t.false("kw" in p.get(`thread:${id}`));
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

test.serial("the table of differences names each row once", (t) => {
  t.is(new Set(DIFFERENCES.map((d) => d.id)).size, DIFFERENCES.length);
  for (const d of DIFFERENCES) t.truthy(d.why, d.id);
});
