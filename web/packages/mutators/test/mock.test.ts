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

import { MUTATORS, type Outcome } from "../src/index.js";

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

/* eslint-disable @typescript-eslint/no-explicit-any -- the mock is untyped JS */
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
  run("olga", "spaces.create", { id: lab, name: "lab", vis: "listed", policy: "request", invite: "members" });
  run("olga", "spaces.create", { id: den, name: "den", vis: "listed", policy: "request" });
  run("olga", "spaces.create", { id: vault, name: "vault", vis: "unlisted", policy: "invite" });
  for (const u of [ME, "mona", "otto"]) run(u, "spaces.join", { space: lounge });
  const role = (sp: string, u: string, r: string) =>
    run("olga", "members.setRole", { space: sp, user: u, role: r, base: { rev: w.rev(`member:${sp}:${u}`) } });
  role(lounge, ME, "admin");
  role(lounge, "mona", "mod");
  // into #lab with links, so the only join request is eve's (the mock keeps
  // one request per person)
  for (const u of [ME, "mona"]) {
    const link = w.id();
    run("olga", "invites.create", { id: link, space: lab });
    run(u, "spaces.join", { space: lab, invite: (w.get(`invite:${link}`) as { code: string }).code });
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
    meta: { pl: "web", form: "article", au: "example.org", h: "example.org", len: "6 min read", tok: 2000, url: "example.org/a", t: "A", desc: "", sum: "", body: [] },
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
    t.is(outcome(a), b.ok ? "ok" : b.code, `${what}: ours ${JSON.stringify(a)}, mock ${JSON.stringify(b)}`);
    if (step.label && a.status === "ok" && b.ok)
      L.set(step.label, (a.result as { id: string }).id, (b.result as { id: string }).id);
    t.deepEqual(projectOurs(w.store, L), projectMock(stored(), L), what);
    w.advance(1000);
    await setNow(w.now);
  }
}

const outcome = (o: Outcome) => (o.status === "ok" ? "ok" : o.status === "refused" ? o.error.code : "unknown");

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
  { name: "likes.set", mockName: "likes.toggle", input: (x) => ({ thread: x.id("T1"), on: false }) },
  { name: "likes.set", mockName: "likes.toggle", input: (x) => ({ thread: x.id("T3"), on: true }) },
  { name: "saved.set", mockName: "saved.toggle", input: (x) => ({ kind: "thread", id: x.id("T1"), on: true }) },
  { name: "saved.set", mockName: "saved.toggle", input: (x) => ({ kind: "thread", id: x.id("T1"), on: false }) },
  { name: "saved.set", mockName: "saved.toggle", input: (x) => ({ kind: "ask", id: `${x.id("T1")}:r`, on: true }) },
  { name: "saved.set", mockName: "saved.toggle", input: (x) => ({ kind: "ask", id: `${x.id("T1")}:${x.node("T1", 0)}`, on: true }) },
  { name: "saved.set", mockName: "saved.toggle", input: () => ({ kind: "source", id: "SRC1", on: true }) },
  { name: "likes.setReply", mockName: "likes.toggleReply", input: (x) => (x.side === "ours" ? { reply: x.reply("T2", "0.0"), on: true } : { reply: `${x.id("T2")}:0.0`, on: true }) },
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
  { name: "threads.create", label: "T4", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "ask", q: "A new ask", title: "New" }) },
  { name: "threads.create", label: "T5", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "post", q: " A new post " }) },
  { name: "threads.create", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "post", q: "   " }) },
  { name: "threads.create", input: (x) => ({ id: x.fresh(), space: x.id("den"), kind: "post", q: "x" }) },
  { name: "threads.update", input: (x) => ({ id: x.id("T4"), q: "A new ask, edited", base: { rev: x.rev(`thread:${x.id("T4")}`) } }) },
  { name: "threads.update", input: (x) => ({ id: x.id("T4"), q: "A new ask, edited", base: { rev: x.rev(`thread:${x.id("T4")}`) } }) },
  { name: "threads.update", input: (x) => ({ id: x.id("T2"), q: "not mine", base: { rev: x.rev(`thread:${x.id("T2")}`) } }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "First" }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), q: "Second" }) },
  { name: "followups.ask", input: (x) => ({ id: x.fresh(), thread: x.id("T5"), q: "on a post" }) },
  { name: "followups.update", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 1), q: "Second, edited", base: { rev: x.rev(`followup:${x.node("T4", 1)}`) } }) },
  { name: "followups.update", input: (x) => ({ thread: x.id("T1"), node: x.node("T1", 0), q: "not mine", base: { rev: 1 } }) },
  { name: "research.forkNode", label: "N2", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), parent: x.node("T4", 0), q: "Under the first" }) },
  { name: "research.forkNode", input: (x) => ({ id: x.fresh(), thread: x.id("T4"), parent: "r", q: "Third" }) },
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 0) }) },
  { name: "followups.delete", input: (x) => ({ thread: x.id("T4"), node: x.node("T4", 1) }) },
  { name: "research.createPostFollowUp", input: (x) => ({ id: x.fresh(), thread: x.id("T5"), t: "Reply one" }) },
  { name: "research.createPostFollowUp", input: (x) => (x.side === "ours" ? { id: x.fresh(), thread: x.id("T5"), t: "Under one", parent: x.reply("T5", "0") } : { thread: x.id("T5"), t: "Under one", parent: 0 }) },
  { name: "replies.update", input: (x) => (x.side === "ours" ? { thread: x.id("T5"), reply: x.reply("T5", "0"), t: "Reply one, edited", base: { rev: x.rev(`reply:${x.reply("T5", "0")}`) } } : { thread: x.id("T5"), path: "0", t: "Reply one, edited" }) },
  { name: "replies.delete", input: (x) => (x.side === "ours" ? { thread: x.id("T5"), reply: x.reply("T5", "0") } : { thread: x.id("T5"), path: "0" }) },
  { name: "replies.delete", input: (x) => (x.side === "ours" ? { thread: x.id("T5"), reply: x.reply("T5", "0.0") } : { thread: x.id("T5"), path: "0.0" }) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T4") }) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T5") }) },
  { name: "threads.delete", input: (x) => ({ id: x.id("T2") }) },

  // spaces, as the lounge's admin
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), set: { desc: "Talk here", faq: true, topics: [["t1", "One"], ["t2", "Two"]], av: 5, plain: true, pageEdit: "members" } }) },
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), set: { rules: [" Be kind ", ""] } }) },
  { name: "spaces.update", input: (x) => ({ id: x.id("lab"), set: { desc: "no" } }) },
  { name: "threads.create", label: "T6", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "ask", q: "With a topic", topic: "t2" }) },
  { name: "threads.create", label: "T7", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), kind: "ask", q: "With no such topic", topic: "t9" }) },
  { name: "threads.move", input: (x) => ({ id: x.id("T7"), topic: "t1" }) },
  { name: "threads.move", input: (x) => ({ id: x.id("T7"), topic: "t3" }) },
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), set: { topics: [["t1", "One"]] } }) },
  { name: "spaces.update", input: (x) => ({ id: x.id("lounge"), unset: ["faq", "plain"] }) },
  { name: "spaces.verifyDomain", input: (x) => ({ id: x.id("lounge"), domain: " Example.ORG " }) },
  { name: "spaces.verifyDomain", input: (x) => ({ id: x.id("lounge"), domain: "nope" }) },

  // members and links
  { name: "members.setRole", input: (x) => ({ space: x.id("lounge"), user: "otto", role: "mod", base: { rev: x.rev(`member:${x.id("lounge")}:otto`) } }) },
  { name: "members.setRole", input: (x) => ({ space: x.id("lounge"), user: "otto", role: "owner", base: { rev: 0 } }) },
  { name: "members.setRole", input: (x) => ({ space: x.id("lounge"), user: "olga", role: "member", base: { rev: 0 } }) },
  { name: "members.ban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "members.unban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "members.unban", input: (x) => ({ space: x.id("lounge"), user: "otto" }) },
  { name: "spaces.join", input: (x) => ({ space: x.id("den") }) },
  { name: "joinRequests.create", input: (x) => ({ space: x.id("den"), rulesAccepted: true }) },
  { name: "joinRequests.withdraw", input: (x) => ({ space: x.id("den") }) },
  { name: "joinRequests.create", input: (x) => ({ space: x.id("vault"), rulesAccepted: true }) },
  { name: "joinRequests.decide", input: (x) => ({ space: x.id("lab"), users: ["eve"], decision: "decline", why: " Not now " }) },
  { name: "joinRequests.decide", input: (x) => ({ space: x.id("lab"), users: ["eve"], decision: "reopen", base: { eve: x.rev(`request:${x.id("lab")}:eve`) } }) },
  { name: "joinRequests.decide", input: (x) => ({ space: x.id("lab"), users: ["eve"], decision: "approve", base: { eve: x.rev(`request:${x.id("lab")}:eve`) } }) },
  { name: "members.remove", input: (x) => ({ space: x.id("lab"), user: "eve", base: { adm: x.adm("lab", "eve") } }) },
  { name: "invites.create", label: "L2", input: (x) => ({ id: x.fresh(), space: x.id("lounge"), days: 7 }) },
  { name: "invites.create", input: (x) => ({ id: x.fresh(), space: x.id("den") }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.restore", input: (x) => ({ id: x.id("L2") }) },
  { name: "invites.revoke", input: (x) => ({ id: x.id("L1") }) },

  // reports and moderation
  { name: "reports.create", label: "P1", input: (x) => ({ id: x.fresh(), item: `a:${x.id("T6")}`, why: "Spam" }) },
  { name: "reports.create", label: "P2", input: (x) => ({ id: x.fresh(), item: `a:${x.id("T3")}`, why: "Off" }) },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T7")}`, decision: "hidden" }) },
  { name: "moderation.decide", input: (x) => ({ item: `a:${x.id("T7")}`, decision: "shown", base: { rev: x.rev(`thread:${x.id("T7")}`) } }) },
  { name: "reports.resolve", input: (x) => ({ report: x.id("P1"), outcome: "hidden" }) },

  // skills and pages
  { name: "skills.create", input: (x) => ({ space: x.id("lounge"), name: "Cite", prompt: "Cite sources." }) },
  { name: "skills.create", input: (x) => ({ space: x.id("lounge"), name: "Cite", prompt: "again" }) },
  { name: "skills.create", input: (x) => ({ space: x.id("lounge"), name: "Short", prompt: "Be short." }) },
  { name: "skills.update", input: (x) => ({ space: x.id("lounge"), index: 0, name: "Cite", prompt: "Cite.", base: { rev: 0 } }) },
  { name: "skills.update", input: (x) => ({ space: x.id("lounge"), index: 0, name: "Short", prompt: "x" }) },
  { name: "skills.reorder", input: (x) => ({ space: x.id("lounge"), from: 0, to: 1 }) },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), index: 0 }) },
  { name: "skills.remove", input: (x) => ({ space: x.id("lounge"), index: 4 }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lounge"), page: null, title: "Guide", text: ["One"] }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lounge"), title: "FAQ", text: [] }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lounge"), page: 0, title: "Guide 2", text: ["Two"], base: { rev: 1 } }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lounge"), page: 0, title: "Guide 3", text: ["x"], base: { rev: 1 } }) },
  { name: "pages.restore", input: (x) => ({ space: x.id("lounge"), page: 0, rev: 1, note: "Back", base: { rev: 2 } }) },
  { name: "pages.move", input: (x) => ({ space: x.id("lounge"), from: 0, to: 1 }) },
  { name: "pages.remove", input: (x) => ({ space: x.id("lounge"), page: 1 }) },
  { name: "pages.update", input: (x) => ({ space: x.id("lab"), title: "Lab page", text: ["l"] }) },

  // sources
  { name: "spaceSources.add", label: "S1", input: (x) => ({ space: x.id("lounge"), url: "https://arxiv.org/abs/2401.0001", note: " a paper " }) },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lounge"), url: "arxiv.org/abs/2401.0001/" }) },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lounge"), source: "SRC1" }) },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lounge"), url: "https://www.example.org/a?x=1" }) },
  { name: "spaceSources.add", label: "S2", input: (x) => ({ space: x.id("lab"), url: "https://x.com/someone/status/1" }) },
  { name: "spaceSources.setPolicy", input: (x) => ({ space: x.id("lab"), policy: "review" }) },
  { name: "spaceSources.add", input: (x) => ({ space: x.id("lab"), source: x.id("S1") }) },
  { name: "sourceReports.create", input: (x) => ({ space: x.id("lab"), source: x.id("S2"), why: "Broken" }) },
  { name: "spaceSources.review", input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "keep" }) },
  { name: "spaceSources.review", input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "remove" }) },
  { name: "spaceSources.review", input: (x) => ({ space: x.id("lab"), source: x.id("S2"), decision: "restore" }) },
  { name: "spaceSources.review", input: (x) => ({ space: x.id("lab"), source: "NOPE", decision: "approve" }) },
  { name: "sources.markRead", input: (x) => ({ id: x.id("S2") }) },

  // joining and leaving
  { name: "spaces.join", input: (x) => ({ space: x.id("lab") }) },
  { name: "spaces.create", label: "mine", input: (x) => ({ id: x.fresh(), name: "Mine", vis: "listed", policy: "request", invite: "mods", qs: [{ q: "Why?" }, { q: " " }] }) },
  { name: "spaces.create", input: (x) => ({ id: x.fresh(), name: "#mine" }) },

  { name: "spaces.leave", input: (x) => ({ space: x.id("mine") }) },
  // last: reports.create sets the mock's repSeen to false (D2)
  { name: "notifications.markAllRead", input: () => ({}) },
];

test("the history: after every step, the mutators store what the mock stores", async (t) => {
  await both(t, HISTORY);
  const names = new Set(HISTORY.map((s) => s.name));
  t.log(`${HISTORY.length} steps, ${names.size} mutators`);
});

void MUTATORS;
