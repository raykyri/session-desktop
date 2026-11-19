// The decisions of phase 1a.2 (brief-1a2.md, part A), one test or more each,
// and the device runs of part B where they are mutators.

import test from "ava";

import {
  DEVICE_RUNS_PER_HOUR,
  MUTATORS,
  NOT_MUTATORS,
  UNKNOWN,
  apply,
  deriveId,
  logsOf,
  redact,
  ulid,
  view,
  withOwnIds,
  type Reader,
  type RecordSource,
  type StoredRecord,
} from "../src/index.js";

import { HOUR, admit, cast, ok, refused, rng, thread, World } from "./world.js";

const rec = <K extends StoredRecord["kind"]>(w: World, key: string, kind: K) => {
  const r = w.get(key);
  if (r?.kind !== kind) throw new Error(`${key}: no ${kind}`);
  return r as Extract<StoredRecord, { kind: K }>;
};
const runsOf = (w: World, th: string) =>
  [...w.store.records.values()].filter(
    (r): r is Extract<StoredRecord, { kind: "run" }> => r.kind === "run" && r.th === th,
  );
const effects = (o: ReturnType<World["run"]>) => (o.status === "ok" ? o.effects : null);
const reader = (w: World): Reader => ({
  get: (kind, id) => w.store.records.get(`${kind}:${id}`) as never,
});

// ---- 1. runs of follow-up asks ----

test("1. followups.ask, research.forkNode and followups.update with run write a run with a derived id and a job", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const [a, b] = [w.id(), w.id()];
  const m1 = w.id();
  const asked = w.run("otto", "followups.ask", { id: a, thread: th, q: "A" }, m1);
  const r1 = deriveId("otto", m1, 1);
  t.deepEqual(ok(t, asked), { id: a, run: r1 });
  t.deepEqual(effects(asked), [{ type: "job", kind: "run", id: r1 }]);
  t.like(rec(w, `run:${r1}`, "run"), {
    th,
    node: a,
    u: "otto",
    status: "queued",
    attempt: 1,
    executor: null,
    lease: null,
    end: null,
  });
  const m2 = w.id();
  const forked = w.run(
    "mel",
    "research.forkNode",
    { id: b, thread: th, parent: a, q: "B", model: "m" },
    m2,
  );
  const r2 = deriveId("mel", m2, 1);
  t.deepEqual(ok(t, forked), { id: b, run: r2 });
  t.deepEqual(effects(forked), [{ type: "job", kind: "run", id: r2 }]);
  t.like(rec(w, `run:${r2}`, "run"), { node: b, model: "m", u: "mel" });
  // an edit without run starts nothing; with run, a new attempt
  const edit = w.run("otto", "followups.update", {
    thread: th,
    node: a,
    q: "A2",
    base: { rev: w.rev(`followup:${a}`) },
  });
  t.is(ok(t, edit), null);
  t.deepEqual(effects(edit), []);
  const m3 = w.id();
  const again = w.run(
    "otto",
    "followups.update",
    { thread: th, node: a, q: "A2", run: true, base: { rev: w.rev(`followup:${a}`) } },
    m3,
  );
  const r3 = deriveId("otto", m3, 1);
  t.deepEqual(ok(t, again), { run: r3 });
  t.deepEqual(effects(again), [{ type: "job", kind: "run", id: r3 }]);
  t.like(rec(w, `run:${r3}`, "run"), { node: a, attempt: 2 });
  // deleting a follow-up deletes its runs; removing a thread, every run of it
  ok(t, w.run("mel", "followups.delete", { thread: th, node: b }));
  t.is(w.get(`run:${r2}`), undefined);
  t.truthy(w.get(`run:${r1}`));
  ok(t, w.run("mona", "moderation.decide", { item: `f:${th}:${a}`, decision: "removed" }));
  t.deepEqual(
    runsOf(w, th).map((r) => r.node),
    ["r"],
  );
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.deepEqual(runsOf(w, th), []);
});

// ---- 2. API keys in the user log; the payer check in `can` ----

test("2. an API key's record is its person's, without the raw key, and `can` checks the key that pays", (t) => {
  const { w, open } = cast(t);
  w.key("mel", "K1");
  w.key("otto", "K2");
  const k = rec(w, "apikey:K1", "apikey");
  t.deepEqual(Object.keys(k).sort(), ["id", "kind", "name", "provider", "rev", "status", "u"]);
  t.deepEqual(logsOf(k), ["user:mel"]);
  t.is(view(reader(w), k, "mel"), k);
  t.is(view(reader(w), k, "otto"), null);
  // the payer check needs no server pre-check: a client predicts it
  const th = w.id();
  const input = { id: th, space: open, kind: "ask", q: "Q", pay: "K1" };
  t.false(MUTATORS.get("threads.create")?.needsPre(input));
  const predicted = apply(
    MUTATORS,
    w.store,
    { u: "mel" },
    { mutationId: w.id(), name: "threads.create", input, clientTime: w.now },
    { now: w.now },
  );
  t.is(predicted.status, "ok");
  refused(
    t,
    w.run("mel", "threads.create", { ...input, id: w.id(), pay: "K2" }),
    "FORBIDDEN",
    "another person's key",
  );
  refused(
    t,
    w.run("mel", "threads.create", { ...input, id: w.id(), pay: "GONE" }),
    "FORBIDDEN",
    "a revoked key (its record deleted)",
  );
  ok(t, w.run("mel", "threads.create", input));
  const f = w.id();
  ok(t, w.run("mel", "followups.ask", { id: f, thread: th, q: "F" }));
  refused(
    t,
    w.run("mel", "research.forkNode", { id: w.id(), thread: th, parent: "r", q: "x", pay: "K2" }),
    "FORBIDDEN",
  );
  refused(
    t,
    w.run("mel", "followups.update", {
      thread: th,
      node: f,
      q: "F",
      run: true,
      pay: "K2",
      base: { rev: w.rev(`followup:${f}`) },
    }),
    "FORBIDDEN",
  );
  refused(
    t,
    w.run("mel", "threads.update", {
      id: th,
      q: "Q",
      run: true,
      pay: "K2",
      base: { rev: w.rev(`thread:${th}`) },
    }),
    "FORBIDDEN",
  );
  t.true(NOT_MUTATORS["apiKeys.create"]?.includes("`apikey` record"));
});

// ---- 3. skills and pages by id ----

test("3. skills and pages: a queued edit names its item, not its place; a reorder sends the order and the list's rev", (t) => {
  const { w, open } = cast(t);
  const [a, b, c] = [w.id(), w.id(), w.id()];
  for (const [id, name] of [
    [a, "A"],
    [b, "B"],
    [c, "C"],
  ] as const)
    ok(t, w.run("mona", "skills.create", { id, space: open, name, prompt: name }));
  // mona's reorder, decided on the list as she saw it; ada removes A first
  const seen = w.rev(`skills:${open}`);
  ok(t, w.run("olga", "skills.remove", { space: open, id: a }));
  refused(
    t,
    w.run("mona", "skills.reorder", { space: open, order: [c, b, a], base: { rev: seen } }),
    "STALE",
  );
  // an edit of C made before a reorder still edits C
  ok(
    t,
    w.run("mona", "skills.reorder", {
      space: open,
      order: [c, b],
      base: { rev: w.rev(`skills:${open}`) },
    }),
  );
  ok(t, w.run("mona", "skills.update", { space: open, id: c, name: "C", prompt: "C2" }));
  t.deepEqual(
    rec(w, `skills:${open}`, "skills").order.map((x) => {
      const k = rec(w, `skill:${x}`, "skill");
      return [k.name, k.prompt];
    }),
    [
      ["C", "C2"],
      ["B", "B"],
    ],
  );
  // pages: a new page whose slug is taken is CONFLICT; a move names both pages
  const [p, q] = [w.id(), w.id()];
  ok(t, w.run("mona", "pages.update", { space: open, id: p, title: "Rules", text: ["r"] }));
  refused(
    t,
    w.run("mona", "pages.update", { space: open, id: w.id(), title: " RULES ", text: [] }),
    "CONFLICT",
  );
  t.is(rec(w, `page:${p}`, "page").text[0], "r");
  ok(t, w.run("mona", "pages.update", { space: open, id: q, title: "Help", text: ["h"] }));
  ok(t, w.run("mona", "pages.move", { space: open, page: q, other: p }));
  // an edit queued before the move edits the same page after it
  ok(t, w.run("mona", "pages.update", { space: open, page: p, title: "Rules", text: ["r2"] }));
  t.deepEqual(
    rec(w, `pages:${open}`, "pages").list.map((x) => x.t),
    ["Help", "Rules"],
  );
  t.deepEqual(rec(w, `page:${p}`, "page").text, ["r2"]);
  // the same id twice: CONFLICT
  refused(
    t,
    w.run("mona", "pages.update", { space: open, id: q, title: "Other", text: [] }),
    "CONFLICT",
  );
});

// ---- 4. the catalog log ----

test("4. a catalog source is in the public `catalog` log", (t) => {
  const w = new World();
  w.store.commit([
    [
      "source:SRC9",
      {
        kind: "source",
        id: "SRC9",
        meta: {
          pl: "web",
          form: "article",
          au: "a",
          h: "a",
          len: "",
          tok: 0,
          url: "a/b",
          t: null,
          desc: "",
          sum: "",
          body: [],
        },
        nurl: "a/b",
        createdAt: "2026-11-01T00:00:00Z",
      },
    ],
  ]);
  const s = rec(w, "source:SRC9", "source");
  t.deepEqual(logsOf(s), ["catalog"]);
  for (const u of ["mel", null]) t.is(view(reader(w), s, u), s);
});

// ---- 5. a pending source: one audience, redacted fields ----

test("5. a source waiting for review keeps one audience; its fields are redacted for members who are not staff", (t) => {
  const { w, closed } = cast(t);
  admit(t, w, closed, "otto");
  ok(t, w.run("mona", "spaceSources.setPolicy", { space: closed, policy: "review" }));
  const mid = w.id();
  ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "example.org/p", note: "N" }, mid));
  const id = deriveId("mel", mid, 1);
  const e = rec(w, `spacesrc:${closed}:${id}`, "spacesrc");
  const g = reader(w);
  t.is(view(g, e, "mel"), e);
  t.is(view(g, e, "mona"), e);
  const other = view(g, e, "otto");
  t.like(other, { kind: "spacesrc", src: id, by: "mel", rv: true, note: "", nurl: null });
  t.is((other as typeof e).meta.url, "");
  t.is(view(g, e, "eve"), null);
  // otto can neither read its metadata through a known URL nor save it
  refused(t, w.run("otto", "sources.markRead", { id }), "NOT_FOUND");
  // approval: everyone reads it in full, and no record changed audience
  ok(t, w.run("mona", "spaceSources.review", { space: closed, source: id, decision: "approve" }));
  const after = rec(w, `spacesrc:${closed}:${id}`, "spacesrc");
  t.is(redact(g, after, "otto"), after);
  ok(t, w.run("otto", "sources.markRead", { id }));
});

// ---- 6. a promoted branch copies the actor's own follow-ups only ----

test("6. promoting a branch copies only the actor's own follow-ups, and none below another person's", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const [a, b, c, d, e] = [w.id(), w.id(), w.id(), w.id(), w.id()];
  ok(t, w.run("mel", "followups.ask", { id: a, thread: th, q: "A" }));
  ok(t, w.run("mel", "research.forkNode", { id: b, thread: th, parent: a, q: "B (mel)" }));
  ok(t, w.run("otto", "research.forkNode", { id: c, thread: th, parent: a, q: "C (otto)" }));
  ok(
    t,
    w.run("mel", "research.forkNode", { id: d, thread: th, parent: c, q: "D (mel, below otto)" }),
  );
  ok(t, w.run("mel", "research.forkNode", { id: e, thread: th, parent: b, q: "E (mel)" }));
  const id = w.id();
  ok(
    t,
    w.run("mel", "threads.create", {
      id,
      space: open,
      kind: "ask",
      q: "",
      from: { th, node: a },
      branch: "all",
    }),
  );
  const copied = [...w.store.records.values()]
    .filter((r): r is Extract<StoredRecord, { kind: "followup" }> => r.kind === "followup")
    .filter((r) => r.th === id);
  t.deepEqual(copied.map((r) => r.q).sort(), ["B (mel)", "E (mel)"]);
  t.true(copied.every((r) => r.u === "mel"));
  t.is(rec(w, `counts:${id}`, "counts").r, 1);
});

// ---- 7. reopening a report always carries base ----

test("7. every reopening of a report requires base: the report's rev, and the item's when it shows the item", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  const rep = w.id();
  ok(t, w.run("otto", "reports.create", { id: rep, item: `a:${th}`, why: "W" }));
  ok(t, w.run("mona", "reports.resolve", { report: rep, outcome: "dismissed" }));
  // a dismissed report: base is required even though no item is shown
  refused(t, w.run("mona", "reports.resolve", { report: rep, outcome: "open" }), "BAD_REQUEST");
  const seen = { rev: w.rev(`report:${rep}`), item: w.rev(`thread:${th}`) };
  // another moderator decides again first: the reopening is STALE
  ok(t, w.run("olga", "reports.resolve", { report: rep, outcome: "hidden" }));
  refused(
    t,
    w.run("mona", "reports.resolve", { report: rep, outcome: "open", base: seen }),
    "STALE",
  );
  ok(
    t,
    w.run("mona", "reports.resolve", {
      report: rep,
      outcome: "open",
      base: { rev: w.rev(`report:${rep}`), item: w.rev(`thread:${th}`) },
    }),
  );
  t.is(rec(w, `thread:${th}`, "thread").mod, null);
  // the other outcomes take no base
  ok(t, w.run("mona", "reports.resolve", { report: rep, outcome: "dismissed", base: seen }));
});

// ---- 8. staff read invite asks ----

test("8. a space's staff read the invite asks to it; they are in the space's log", (t) => {
  const { w, vault } = cast(t);
  ok(t, w.run("eve", "invites.request", { space: vault }));
  const ask = rec(w, `invask:eve:${vault}`, "invask");
  t.deepEqual(logsOf(ask), [`space:${vault}`, "user:eve"]);
  const g = reader(w);
  t.truthy(view(g, ask, "olga"));
  t.truthy(view(g, ask, "eve"));
  t.is(view(g, ask, "mel"), null);
});

// ---- 9. the client's own fresh ids ----

test("9. a replica answers its own minted ids and the ids derived from its fresh mutation ids as unused", (t) => {
  const { w, open } = cast(t);
  const th = thread(t, w, "mel", open);
  // a replica that knows nothing of the id registry
  const blind: RecordSource = {
    get: (kind, id) => w.store.get(kind, id),
    scan: (index, value) => w.store.scan(index, value),
    idUsed: () => UNKNOWN,
  };
  const f = ulid(w.now, rng(5));
  const mid = ulid(w.now, rng(6));
  const envelope = {
    mutationId: mid,
    name: "followups.ask",
    input: { id: f, thread: th, q: "F" },
    clientTime: w.now,
  };
  t.is(apply(MUTATORS, blind, { u: "otto" }, envelope, { now: w.now }).status, "unknown");
  const own = withOwnIds(blind, { user: "otto", minted: new Set([f]), mutations: new Set([mid]) });
  const guess = apply(MUTATORS, own, { u: "otto" }, envelope, { now: w.now });
  const truth = apply(MUTATORS, w.store, { u: "otto" }, envelope, { now: w.now });
  t.deepEqual(guess, truth);
  t.is(guess.status, "ok");
  // another user's mutation id, or an id the source knows to be used, is not own
  t.is(own.idUsed(deriveId("mel", mid, 1)), UNKNOWN);
  t.is(own.idUsed(deriveId("otto", mid, 2)), false);
  const used = withOwnIds(w.store, {
    user: "mel",
    minted: new Set([th]),
    mutations: new Set(),
  });
  t.is(used.idUsed(th), true);
});

// ---- 10. reply like counts ----

test("10. a reply's likes are counted in its thread's counts record; the reply's rev does not move", (t) => {
  const { w, open } = cast(t);
  const post = thread(t, w, "mel", open, "post");
  const [a, b] = [w.id(), w.id()];
  ok(t, w.run("mel", "research.createPostFollowUp", { id: a, thread: post, t: "A" }));
  ok(t, w.run("otto", "research.createPostFollowUp", { id: b, thread: post, t: "B", parent: a }));
  const rev = w.rev(`reply:${a}`);
  for (const u of ["otto", "mona", "otto"])
    ok(t, w.run(u, "likes.setReply", { reply: a, on: true }));
  ok(t, w.run("otto", "likes.setReply", { reply: b, on: true }));
  t.deepEqual(rec(w, `counts:${post}`, "counts").rlikes, { [a]: 2, [b]: 1 });
  t.is(w.rev(`reply:${a}`), rev);
  ok(t, w.run("mona", "likes.setReply", { reply: a, on: false }));
  t.deepEqual(rec(w, `counts:${post}`, "counts").rlikes, { [a]: 1, [b]: 1 });
  // a deleted reply leaves the counts; a removed thread clears them
  ok(t, w.run("otto", "replies.delete", { thread: post, reply: b }));
  t.deepEqual(rec(w, `counts:${post}`, "counts").rlikes, { [a]: 1 });
  t.is(w.get(`rlike:otto:${b}`), undefined);
  ok(t, w.run("mona", "moderation.decide", { item: `p:${post}`, decision: "removed" }));
  t.deepEqual(rec(w, `counts:${post}`, "counts").rlikes, {});
  t.is(w.get(`rlike:otto:${a}`), undefined);
});

// ---- the mockup pass, round 2: remove and ban in open spaces ----

test("members.remove works in open spaces and is STALE once the person has rejoined; a ban lasts until unban", (t) => {
  const { w, open, closed } = cast(t);
  const seen = w.admission(open, "otto");
  ok(t, w.run("mona", "members.remove", { space: open, user: "otto", base: seen }));
  t.is(w.get(`member:${open}:otto`), undefined);
  // an open space: joining again undoes the removal, with a new admission id
  ok(t, w.run("otto", "spaces.join", { space: open }));
  t.truthy(w.get(`member:${open}:otto`));
  t.notDeepEqual(w.admission(open, "otto"), seen);
  refused(t, w.run("mona", "members.remove", { space: open, user: "otto", base: seen }), "STALE");
  t.truthy(w.get(`member:${open}:otto`));
  ok(
    t,
    w.run("mona", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  ok(t, w.run("mona", "members.ban", { space: open, user: "otto" }));
  t.deepEqual(Object.keys(rec(w, `ban:${open}:otto`, "ban")).sort(), [
    "createdAt",
    "id",
    "kind",
    "rev",
    "sp",
    "u",
  ]);
  w.advance(365 * 24 * HOUR);
  refused(t, w.run("otto", "spaces.join", { space: open }), "FORBIDDEN");
  ok(t, w.run("mona", "members.unban", { space: open, user: "otto" }));
  ok(t, w.run("otto", "spaces.join", { space: open }));
});

// ---- a verified domain is removed with unset ----

test("spaces.update: `dom` is no setting, but an admin unsets it", (t) => {
  const { w, open } = cast(t);
  ok(t, w.run("olga", "spaces.verifyDomain", { id: open, domain: "example.org" }));
  refused(t, w.run("olga", "spaces.update", { id: open, set: { dom: null } }), "BAD_REQUEST");
  ok(t, w.run("olga", "spaces.update", { id: open, unset: ["dom", "plain"] }));
  t.is(rec(w, `space:${open}`, "space").dom, null);
});

// ---- device runs ----

test("device runs: an executor on the run record, the device checked, no payer, and 100 runs an hour", (t) => {
  const { w, open } = cast(t);
  w.device("mel", "MAC1");
  w.key("mel", "K1");
  const mac = { kind: "device", cli: "claude", device: "MAC1" } as const;
  const th = w.id();
  const mid = w.id();
  const input = { id: th, space: open, kind: "ask", q: "Q", executor: mac, pay: "K1" };
  // the device is account state: a client gets unknown
  const guess = apply(
    MUTATORS,
    w.store,
    { u: "mel" },
    { mutationId: mid, name: "threads.create", input, clientTime: w.now },
    { now: w.now },
  );
  t.is(guess.status, "unknown");
  const out = w.run("mel", "threads.create", input, mid);
  const run = deriveId("mel", mid, 1);
  t.deepEqual(ok(t, out), { id: th, run });
  t.like(rec(w, `run:${run}`, "run"), {
    executor: { kind: "device", cli: "claude", device: "MAC1", u: "mel" },
    pay: null,
    status: "queued",
  });
  refused(
    t,
    w.run("otto", "threads.create", { ...input, id: w.id() }),
    "FORBIDDEN",
    "otto's device list has no MAC1",
  );
  refused(
    t,
    w.run("mel", "threads.create", { ...input, id: w.id(), executor: { ...mac, cli: "grok" } }),
    "BAD_REQUEST",
  );
  // forkNode takes an executor too
  const f = w.id();
  const fm = w.id();
  ok(
    t,
    w.run(
      "mel",
      "research.forkNode",
      { id: f, thread: th, parent: "r", q: "F", executor: mac },
      fm,
    ),
  );
  t.like(rec(w, `run:${deriveId("mel", fm, 1)}`, "run"), { node: f, executor: { device: "MAC1" } });
  // the limit: 100 device runs in an hour, then TOO_MANY_REQUESTS with retryAt
  for (let k = 2; k < DEVICE_RUNS_PER_HOUR; k++) {
    w.advance(1000);
    ok(t, w.run("mel", "threads.create", { ...input, id: w.id() }));
  }
  w.advance(1000);
  const limited = w.run("mel", "threads.create", { ...input, id: w.id() });
  const e = refused(t, limited, "TOO_MANY_REQUESTS");
  // the first run started at the cast's time; it leaves the window an hour later
  t.is(e?.retryAt, rec(w, `run:${run}`, "run").createdAt.replace("10:00:", "11:00:"));
  // runs with the included tokens are not limited
  ok(t, w.run("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "Q" }));
  w.advance(HOUR);
  ok(t, w.run("mel", "threads.create", { ...input, id: w.id() }));
  // the device calls with leases are online calls, not mutators
  for (const n of ["runs.claim", "runs.heartbeat", "runs.turn", "runs.finish", "devices.revoke"]) {
    t.truthy(NOT_MUTATORS[n], n);
    t.is(MUTATORS.get(n), undefined, n);
  }
});
