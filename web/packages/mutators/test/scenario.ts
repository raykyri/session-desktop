// One applied write of every mutator, in an order that makes each succeed:
// the determinism test runs it with the clock, the random source and Intl
// trapped, and checks the shape of every record it wrote.

import type { ExecutionContext } from "ava";

import type { Answer, World } from "./world.js";
import { MODEL, admit, finish, ok, refused } from "./world.js";

/** Apply every mutator once; returns the names applied, in order. `between`
 * runs where the run loop would (outside any mutator). */
export function everyMutator(
  t: ExecutionContext,
  w: World,
  between: (f: () => void) => void = (f) => f(),
  apply: (u: string, name: string, input: unknown) => Answer = (u, name, input) =>
    w.apply(u, name, input),
): string[] {
  const done: string[] = [];
  const as = (u: string, name: string, input: unknown) => {
    ok(t, apply(u, name, input));
    done.push(name);
    return w;
  };
  const open = w.id();
  const lab = w.id();
  as("olga", "spaces.create", { id: open, name: "lounge" });
  as("olga", "spaces.create", { id: lab, name: "lab", vis: "private" });
  as("olga", "spaces.update", { id: lab, desc: "Be kind." });
  for (const u of ["mona", "mel", "otto"]) as(u, "spaces.join", { space: open });
  admit(t, w, lab, "ada");
  const th = w.id();
  as("mel", "threads.create", { id: th, space: open, kind: "ask", q: "Q", ...MODEL });
  between(() => finish(w, th, "r"));
  const fu = w.id();
  as("mona", "research.forkNode", {
    id: fu,
    thread: th,
    parent: "r",
    kind: "ask",
    q: "F",
    ...MODEL,
  });
  between(() => finish(w, th, fu));
  const look = w.id();
  as("otto", "research.forkNode", {
    id: look,
    thread: th,
    parent: fu,
    kind: "lookup",
    look: "“tide gauge”,",
    quote: "Each tide gauge records the sea level.",
    b: 2,
    ...MODEL,
  });
  as("otto", "research.cancelNode", { thread: th, node: look });
  as("otto", "research.retryNode", { thread: th, node: look, ...MODEL, base: { attempt: 1 } });
  as("mona", "followups.update", {
    thread: th,
    node: fu,
    q: "F2",
    base: { rev: w.rev(`node:${fu}`) },
  });
  as("otto", "threads.create", { id: w.id(), from: { th, node: fu } });
  const c = w.id();
  as("mel", "comments.create", { id: c, thread: th, node: fu, t: "@mona why?" });
  as("mel", "comments.update", { id: c, t: "Why, @mona?", base: { rev: w.rev(`comment:${c}`) } });
  const p = w.id();
  as("mel", "threads.create", { id: p, space: open, kind: "post", q: "P @otto" });
  const rep = w.id();
  as("otto", "research.createPostFollowUp", { id: rep, thread: p, t: "R" });
  as("otto", "replies.update", { id: rep, t: "R2", base: { rev: w.rev(`reply:${rep}`) } });
  as("otto", "saved.set", { kind: "thread", id: p, on: true });
  as("mel", "threads.update", { id: th, q: "Q2", base: { rev: w.rev(`thread:${th}`) } });
  const link = w.id();
  as("olga", "invites.create", { id: link, space: lab, days: 3 });
  as("olga", "invites.revoke", { id: link });
  as("olga", "invites.restore", { id: link });
  as("olga", "moderation.decide", {
    item: `p:${p}`,
    decision: "hidden",
    base: { rev: w.rev(`thread:${p}`) },
  });
  as("olga", "moderation.decide", { item: `r:${p}:${rep}`, decision: "removed", note: "x" });
  as("olga", "members.ban", { space: open, user: "otto" });
  as("olga", "members.unban", { space: open, user: "otto" });
  as("olga", "members.remove", {
    space: lab,
    user: "ada",
    base: { adm: admission(w, lab, "ada") },
  });
  as("mona", "notifications.markRead", { id: w.notifs("mona")[0]?.id ?? "" });
  as("mel", "notifications.markAllRead", {});
  as("mel", "comments.delete", { id: c });
  as("otto", "replies.delete", { id: rep });
  as("otto", "followups.delete", { thread: th, node: look });
  as("mel", "threads.delete", { id: p });
  as("mel", "prefs.set", { layout: "wide" });
  as("mona", "spaces.leave", { space: open });
  // the owner may not leave: a refusal is the other half of the rule
  refused(t, apply("olga", "spaces.leave", { space: open }), "PRECONDITION_FAILED");
  return done;
}

export function admission(w: World, sp: string, u: string): string {
  const m = w.get(`member:${sp}:${u}`);
  return m?.kind === "member" ? m.adm : "";
}
