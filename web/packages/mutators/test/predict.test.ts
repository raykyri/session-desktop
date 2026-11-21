// M1b review 1: a client's prediction against the server's apply, over every
// mutator. The replica holds only what `view` serves the actor; a read of a
// record that exists but the actor may not read is unknown (the replica
// cannot tell it from an absent one). For each write, the prediction (on a
// client transaction) and the server's answer must agree, and for an
// applied write the actor's view of every key either side changed must be
// the same, revs included: what the replica shows before the confirmation
// is what the server will serve.

import test, { type ExecutionContext } from "ava";

import {
  MUTATORS,
  StagedTx,
  UnknownRead,
  inIndex,
  msToIso,
  predict,
  predictedView,
  uniqueOf,
  view,
  type Source,
  type StoredRecord,
} from "../src/index.js";

import { everyMutator } from "./scenario.js";
import { MODEL, World, admit, ask, cast, fork, ok, post, type Answer } from "./world.js";

/** The actor's replica: what `view` serves them, and nothing else. */
function replicaOf(w: World, me: string): Source {
  const records = w.store.records;
  const held = new Map<string, StoredRecord>();
  for (const [k, r] of records) {
    const v = view(w.store, r, me);
    if (v) held.set(k, v);
  }
  const unread = (k: string) => records.has(k) && !held.has(k);
  return {
    byKey: (key) => {
      if (unread(key)) throw new UnknownRead(key);
      return held.get(key);
    },
    keysIn: (kind, index) => {
      const keys = [...records].filter(([, r]) => r.kind === kind && inIndex(r, index));
      if (keys.some(([k]) => unread(k))) throw new UnknownRead(`${kind} ${JSON.stringify(index)}`);
      return keys.map(([k]) => k);
    },
    uniqueKey: (index, value) => {
      for (const [k, r] of records)
        if (uniqueOf(r, index) === value) {
          if (unread(k)) throw new UnknownRead(`${index} ${value}`);
          return k;
        }
      return undefined;
    },
    idTaken: () => false,
  };
}

const json = (r: StoredRecord | null | undefined) => (r ? JSON.stringify(r) : "none");

/** Writes whose result `notify` adds to (the mentions it notified). */
const NOTIFY_RESULT = new Set(["threads.create", "comments.create", "research.createPostFollowUp"]);
/** Writes a client cannot predict: a value only `pre` makes. */
const UNPREDICTABLE = new Set(["invites.create"]);

/** Predict `name` as `me` on the actor's replica, apply it on the server, and
 * report every difference. */
function check(
  w: World,
  out: string[],
  me: string,
  name: string,
  input: unknown,
  serverOnly: (key: string) => boolean = () => false,
): Answer {
  const mutationId = w.id();
  const tx = new StagedTx(replicaOf(w, me), me, msToIso(w.ms), mutationId, "client");
  const def = MUTATORS[name];
  if (!def) throw new Error(name);
  const p = predict(tx, def, input);
  const before = new Map(w.store.records);
  const a = w.apply(me, name, input, { mutationId });
  const what = `${me} ${name} ${JSON.stringify(input).slice(0, 80)}`;
  const code = (x: Answer) => (x.ok ? "ok" : x.error.code);
  if ("unknown" in p) {
    if (!UNPREDICTABLE.has(name)) out.push(`${what}: predicted unknown, server ${code(a)}`);
    return a;
  }
  if (p.ok !== a.ok || (!p.ok && !a.ok && p.error.code !== a.error.code)) {
    out.push(`${what}: predicted ${p.ok ? "ok" : p.error.code}, server ${code(a)}`);
    return a;
  }
  if (!p.ok || !a.ok) return a;
  if (!NOTIFY_RESULT.has(name) && JSON.stringify(p.result) !== JSON.stringify(a.result))
    out.push(`${what}: result ${JSON.stringify(p.result)}, server ${JSON.stringify(a.result)}`);
  const predicted = predictedView(tx);
  const after = w.store.records;
  const keys = new Set(predicted.keys());
  for (const [k, r] of after) if (before.get(k) !== r) keys.add(k);
  for (const k of before.keys()) if (!after.has(k)) keys.add(k);
  const old = { byKey: (k: string) => before.get(k) };
  for (const k of keys) {
    if (serverOnly(k)) continue;
    const s = after.get(k);
    const served = s ? view(w.store, s, me) : null;
    const b = before.get(k);
    const mine = predicted.has(k) ? predicted.get(k) : b ? view(old, b, me) : null;
    if (json(served) !== json(mine))
      out.push(`${what}: ${k}\n    predicted ${json(mine)}\n    server    ${json(served)}`);
  }
  return a;
}

const report = (t: ExecutionContext, out: string[]) =>
  t.deepEqual(out, [], out.slice(0, 5).join("\n"));

test("every mutator: the prediction on the actor's replica is the server's answer and view", (t) => {
  const w = new World();
  const out: string[] = [];
  everyMutator(t, w, undefined, (u, name, input) => check(w, out, u, name, input));
  report(t, out);
});

test("saves, removals and deletes over other people's records predict the server's view", (t) => {
  const { w, open, closed } = cast(t);
  const out: string[] = [];
  const as = (u: string, name: string, input: unknown) => ok(t, check(w, out, u, name, input));
  admit(t, w, closed, "mona");
  // saves in an open space: the served count ± 1; in a private one the
  // count stays the server's (0 below 3)
  const p = post(t, w, "mel", open);
  for (const u of ["mona", "otto", "mel"]) as(u, "saved.set", { kind: "thread", id: p, on: true });
  as("otto", "saved.set", { kind: "thread", id: p, on: false });
  // a private channel's true count is server-only: the served count is the
  // server's when the write is confirmed
  const q = post(t, w, "ada", closed);
  const privateCount = (k: string) => k === `counts:${q}`;
  for (const u of ["ada", "mona", "olga"])
    ok(t, check(w, out, u, "saved.set", { kind: "thread", id: q, on: true }, privateCount));
  ok(t, check(w, out, "ada", "saved.set", { kind: "thread", id: q, on: false }, privateCount));
  // the owner removes a thread others saved and were mentioned in
  const r = post(t, w, "mel", open, "Hi @otto");
  as("mona", "saved.set", { kind: "thread", id: r, on: true });
  as("olga", "saved.set", { kind: "thread", id: r, on: true });
  as("olga", "moderation.decide", { item: `p:${r}`, decision: "removed", note: "spam" });
  // the author deletes a thread others saved
  const s = post(t, w, "mel", open);
  as("otto", "saved.set", { kind: "thread", id: s, on: true });
  as("mel", "threads.delete", { id: s });
  // a node removed with nodes and comments under it
  const a = ask(t, w, "mel", open);
  const n = fork(t, w, "mona", a);
  fork(t, w, "otto", a, n);
  as("otto", "comments.create", { id: w.id(), thread: a, node: n, t: "hm" });
  as("olga", "moderation.decide", { item: `f:${a}:${n}`, decision: "removed" });
  // members: a join with an invite link, a removal and a ban, from the
  // owner's and the person's replicas
  const link = ok(t, w.apply("olga", "invites.create", { id: w.id(), space: closed, days: 7 })) as {
    code: string;
  };
  as("eve", "spaces.join", { space: closed, invite: link.code });
  as("olga", "members.ban", { space: closed, user: "eve" });
  as("olga", "members.ban", { space: open, user: "otto" });
  as("mel", "spaces.leave", { space: open });
  as("mona", "notifications.markAllRead", {});
  as("mona", "research.forkNode", {
    id: w.id(),
    thread: a,
    parent: "r",
    kind: "ask",
    q: "More?",
    ...MODEL,
  });
  report(t, out);
});

test("a model outside the registry is refused in the prediction too", (t) => {
  const { w, open } = cast(t);
  const out: string[] = [];
  const input = { id: w.id(), space: open, kind: "ask", q: "?", model: "nope", effort: "medium" };
  const a = check(w, out, "mel", "threads.create", input);
  t.like(a, { ok: false, error: { code: "BAD_REQUEST" } });
  report(t, out);
});
