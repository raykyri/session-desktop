// The write and read rules review round 1 of phase 1 (reviewer A) found
// broken, each as it stands after its fix. The experiment each test comes
// from is named in the test (`r1a/e03-mutators.ts`, `r1a/e05-protocol.ts`,
// `r1a/e02-runs.ts`).

import test from "ava";

import {
  DEVICE_RUNS_PER_HOUR,
  MUTATORS,
  apply,
  canRead,
  view,
  type MemoryStore,
  type StoredRecord,
} from "../src/index.js";

import type { World } from "./world.js";
import { DAY, HOUR, admit, cast, ok, refused, thread } from "./world.js";

const asReader = (s: MemoryStore) => ({
  get: (kind: string, id: string) => s.records.get(`${kind}:${id}`),
});
const seen = (w: World, key: string, u: string | null) => {
  const r = w.get(key);
  return r ? view(asReader(w.store) as never, r, u) : null;
};
const rec = <T = Record<string, unknown>>(w: World, key: string) => w.get(key) as unknown as T;

// ---- H4: a thread's `about` is text of the thread

test("H4: a hidden thread's about is redacted, and a removed or deleted thread's is erased", (t) => {
  const { w, open } = cast(t);
  const about = { quote: "ABUSE-QUOTE", it: "ABUSE-IT", its: ["ABUSE-ITS"] };
  const th = w.id();
  ok(t, w.run("otto", "threads.create", { id: th, space: open, kind: "ask", q: "Q", about }));
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
  t.like(seen(w, `thread:${th}`, null) ?? {}, { q: "", about: null });
  t.like(seen(w, `thread:${th}`, "mel") ?? {}, { about: null });
  t.like(seen(w, `thread:${th}`, "otto") ?? {}, { about }, "its author reads it");
  t.like(seen(w, `thread:${th}`, "mona") ?? {}, { about }, "a moderator reads it");
  ok(t, w.run("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
  t.false(JSON.stringify([...w.store.records.values()]).includes("ABUSE"), "erased at rest");
  const gone = w.id();
  ok(t, w.run("otto", "threads.create", { id: gone, space: open, kind: "ask", q: "Q", about }));
  ok(t, w.run("otto", "threads.delete", { id: gone }));
  t.like(rec(w, `thread:${gone}`), { gone: true, about: null });
});

// ---- W5: threads.create from a branch writes in the source's space too

test("W5: a ban in the source thread's space stops threads.create from a branch of it", (t) => {
  const { w, open } = cast(t);
  const mine = w.id();
  ok(t, w.run("mel", "spaces.create", { id: mine, name: "mels" }));
  const th = thread(t, w, "otto", open);
  const fu = w.id();
  ok(t, w.run("mel", "followups.ask", { id: fu, thread: th, q: "mel's follow-up" }));
  ok(t, w.run("mona", "members.ban", { space: open, user: "mel" }));
  const before = rec<{ rev: number }>(w, `followup:${fu}`).rev;
  refused(
    t,
    w.run("mel", "threads.create", {
      id: w.id(),
      space: mine,
      kind: "ask",
      q: "-",
      from: { th, node: fu },
    }),
    "FORBIDDEN",
  );
  t.like(rec(w, `followup:${fu}`), { rev: before, promoted: null });
});

// ---- W6: reports in a user log follow access

test("W6: a removed member's reports and source reports leave their user log", (t) => {
  const { w, closed } = cast(t);
  const post = thread(t, w, "olga", closed, "post");
  const rep = w.id();
  ok(t, w.run("mel", "reports.create", { id: rep, item: `p:${post}`, why: "spam" }));
  const src = ok(t, w.run("olga", "spaceSources.add", { space: closed, url: "example.com/s" })) as {
    id: string;
  };
  ok(t, w.run("mel", "sourceReports.create", { space: closed, source: src.id, why: "bad" }));
  const keys = [`report:${rep}`, `srcrep:${closed}:${src.id}:mel`];
  for (const k of keys) t.not(seen(w, k, "mel"), null, `${k} while mel is a member`);
  ok(
    t,
    w.run("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  for (const k of keys) {
    t.is(seen(w, k, "mel"), null, `${k} after mel's removal`);
    t.not(seen(w, k, "mona"), null, `${k}: the space's moderators still read it`);
  }
});

// ---- W7: inputs that pass the schema never make `run` throw

test("W7a: a source another person added and a moderator removed is added anew by a moderator, as theirs", (t) => {
  const { w, open, closed } = cast(t);
  // the source is known to otto through another space where it stays
  const a = ok(t, w.run("mel", "spaceSources.add", { space: closed, url: "example.com/a" })) as {
    id: string;
  };
  ok(t, w.run("mel", "spaceSources.add", { space: open, source: a.id }));
  ok(t, w.run("mona", "spaceSources.review", { space: open, source: a.id, decision: "remove" }));
  admit(t, w, closed, "otto");
  // a member below moderator puts back no source a moderator removed
  // (review round 2 of phase 1)
  refused(t, w.run("otto", "spaceSources.add", { space: open, source: a.id }), "FORBIDDEN");
  const out = w.run("mona", "spaceSources.add", { space: open, source: a.id });
  t.like(ok(t, out) ?? {}, { id: a.id });
  t.like(rec(w, `spacesrc:${open}:${a.id}`), { by: "mona", rm: false });
});

test("W7b: a file name or URL with a lone surrogate is BAD_REQUEST, not a fault", (t) => {
  const { w, open } = cast(t);
  refused(t, w.run("otto", "spaceSources.add", { space: open, file: "\ud800.pdf" }), "BAD_REQUEST");
  refused(
    t,
    w.run("otto", "spaceSources.add", { space: open, url: "a.com/\udc00" }),
    "BAD_REQUEST",
  );
  ok(t, w.run("otto", "spaceSources.add", { space: open, file: "😀.pdf" }));
});

// ---- E19: a removed source is redacted like a pending one

test("E19: a source a moderator removed is served in full only to its maker and the moderators", (t) => {
  const { w, open } = cast(t);
  const s = ok(
    t,
    w.run("mel", "spaceSources.add", { space: open, url: "abuse.example/page", note: "ABUSIVE" }),
  ) as { id: string };
  ok(t, w.run("mona", "spaceSources.review", { space: open, source: s.id, decision: "remove" }));
  const key = `spacesrc:${open}:${s.id}`;
  for (const u of [null, "otto"])
    t.like(seen(w, key, u) ?? {}, { rm: true, note: "", meta: { url: "" } }, `reader ${u}`);
  for (const u of ["mel", "mona"])
    t.like(seen(w, key, u) ?? {}, { note: "ABUSIVE" }, `reader ${u}`);
});

// ---- E21: invites.decline declines invites only

test("E21: invites.decline on a notification that is not an invite is NOT_FOUND", (t) => {
  const { w, open } = cast(t);
  const n = w.id();
  w.store.commit([
    [
      `notif:${n}`,
      {
        kind: "notif",
        id: n,
        to: "mona",
        type: "report",
        sp: open,
        report: null,
        item: null,
        outcome: null,
        response: null,
        actor: null,
        thread: null,
        node: null,
        invite: null,
        read: false,
        createdAt: "2026-11-16T09:00:00Z",
      },
    ],
  ]);
  refused(t, w.run("mona", "invites.decline", { notification: n }), "NOT_FOUND");
  t.like(rec(w, `notif:${n}`), { response: null, read: false });
});

// ---- E12: smaller rule gaps

test("E12b, E12c: threads.update with run is BAD_REQUEST on a post and refused in an archived space", (t) => {
  const { w, open } = cast(t);
  const post = thread(t, w, "mel", open, "post");
  const base = { rev: w.rev(`thread:${post}`) };
  refused(t, w.run("mel", "threads.update", { id: post, q: "P", run: true, base }), "BAD_REQUEST");
  t.like(rec(w, `thread:${post}`), { running: false, att: 0 });
  const ask = thread(t, w, "mel", open);
  const fu = w.id();
  ok(t, w.run("mel", "followups.ask", { id: fu, thread: ask, q: "F" }));
  ok(t, w.run("olga", "spaces.archive", { id: open, archived: true }));
  refused(
    t,
    w.run("mel", "threads.update", {
      id: ask,
      q: "Q",
      run: true,
      base: { rev: w.rev(`thread:${ask}`) },
    }),
    "PRECONDITION_FAILED",
  );
  refused(
    t,
    w.run("mel", "followups.update", {
      thread: ask,
      node: fu,
      q: "F2",
      run: true,
      base: { rev: w.rev(`followup:${fu}`) },
    }),
    "PRECONDITION_FAILED",
  );
  // an edit without run is no ask, as before
  ok(
    t,
    w.run("mel", "threads.update", { id: ask, q: "Q2", base: { rev: w.rev(`thread:${ask}`) } }),
  );
});

test("E12d: research.forkNode's uses names the thread's ask or readable follow-ups of the same thread", (t) => {
  const { w, open, closed } = cast(t);
  const ask = thread(t, w, "otto", open);
  const mine = w.id();
  ok(t, w.run("otto", "followups.ask", { id: mine, thread: ask, q: "F" }));
  const secret = thread(t, w, "olga", closed);
  const sfu = w.id();
  ok(t, w.run("olga", "followups.ask", { id: sfu, thread: secret, q: "secret" }));
  const other = thread(t, w, "otto", open);
  const ofu = w.id();
  ok(t, w.run("otto", "followups.ask", { id: ofu, thread: other, q: "elsewhere" }));
  const fork = (uses: string[]) =>
    w.run("otto", "research.forkNode", { id: w.id(), thread: ask, parent: "r", q: "c", uses });
  refused(t, fork([sfu]), "NOT_FOUND");
  refused(t, fork(["r", ofu]), "NOT_FOUND");
  ok(t, fork(["r", mine]));
});

test("E12f: sourceReports.create for a source the space does not have is NOT_FOUND", (t) => {
  const { w, open } = cast(t);
  const other = w.id();
  ok(t, w.run("otto", "spaces.create", { id: other, name: "ottos" }));
  const s = ok(t, w.run("otto", "spaceSources.add", { space: other, url: "example.com/z" })) as {
    id: string;
  };
  refused(
    t,
    w.run("otto", "sourceReports.create", { space: open, source: s.id, why: "x" }),
    "NOT_FOUND",
  );
  ok(t, w.run("mel", "sourceReports.create", { space: other, source: s.id, why: "x" }));
});

// ---- leaving and removal

test("a membership's end is in the person's user log: left or removed; joining again deletes it", (t) => {
  const { w, open, closed } = cast(t);
  const exit = (sp: string, u: string) => w.get(`exit:${sp}:${u}`);
  ok(t, w.run("mel", "spaces.leave", { space: closed }));
  t.like(exit(closed, "mel") ?? {}, { kind: "exit", sp: closed, u: "mel", ended: "left" });
  const e = exit(closed, "mel") as StoredRecord;
  const g = asReader(w.store) as never;
  t.true(canRead(g, e, "mel"));
  t.false(canRead(g, e, "olga"), "nobody else reads it, the space's staff included");
  admit(t, w, closed, "mel");
  t.is(exit(closed, "mel"), undefined);
  ok(
    t,
    w.run("olga", "members.remove", {
      space: closed,
      user: "mel",
      base: w.admission(closed, "mel"),
    }),
  );
  t.like(exit(closed, "mel") ?? {}, { ended: "removed" });
  ok(t, w.run("mona", "members.ban", { space: open, user: "otto" }));
  t.like(exit(open, "otto") ?? {}, { ended: "removed" });
  ok(t, w.run("mona", "members.ban", { space: open, user: "eve" }));
  t.is(exit(open, "eve"), undefined, "eve was no member");
});

// ---- W2: a later run of an ask cancels the earlier ones

test("W2: threads.update and followups.update with run cancel the ask's earlier runs", (t) => {
  const { w, open } = cast(t);
  const th = w.id();
  const r1 = (
    ok(t, w.run("mel", "threads.create", { id: th, space: open, kind: "ask", q: "Q" })) as {
      run: string;
    }
  ).run;
  const fu = w.id();
  const f1 = (
    ok(t, w.run("mel", "followups.ask", { id: fu, thread: th, q: "F" })) as { run: string }
  ).run;
  const r2 = (
    ok(
      t,
      w.run("mel", "threads.update", {
        id: th,
        q: "Q2",
        run: true,
        base: { rev: w.rev(`thread:${th}`) },
      }),
    ) as { run: string }
  ).run;
  t.like(rec(w, `run:${r1}`), { status: "cancelled", end: "stopped" });
  t.like(rec(w, `run:${r2}`), { status: "queued", attempt: 2 });
  t.like(rec(w, `run:${f1}`), { status: "queued" }, "another ask's run is left alone");
  ok(
    t,
    w.run("mel", "followups.update", {
      thread: th,
      node: fu,
      q: "F2",
      run: true,
      base: { rev: w.rev(`followup:${fu}`) },
    }),
  );
  t.like(rec(w, `run:${f1}`), { status: "cancelled" });
});

// ---- W4: the hourly limit of device runs counts starts, not run records

test("W4: deleting a thread does not take its device run out of the hourly count", (t) => {
  const { w, open } = cast(t);
  w.device("mel", "MAC1");
  const mac = { kind: "device", cli: "claude", device: "MAC1" };
  for (let k = 0; k < DEVICE_RUNS_PER_HOUR; k++) {
    const id = w.id();
    ok(
      t,
      w.run("mel", "threads.create", { id, space: open, kind: "ask", q: `q${k}`, executor: mac }),
    );
    ok(t, w.run("mel", "threads.delete", { id }));
    w.advance(1000);
  }
  t.false([...w.store.records.values()].some((r) => r.kind === "run" && r.u === "mel"));
  const out = w.run("mel", "threads.create", {
    id: w.id(),
    space: open,
    kind: "ask",
    q: "one more",
    executor: mac,
  });
  refused(t, out, "TOO_MANY_REQUESTS");
  w.advance(HOUR);
  ok(
    t,
    w.run("mel", "threads.create", {
      id: w.id(),
      space: open,
      kind: "ask",
      q: "later",
      executor: mac,
    }),
  );
  // a client cannot count them: a device run's prediction is unknown
  const guess = apply(
    MUTATORS,
    w.store,
    { u: "mel" },
    {
      mutationId: w.id(),
      name: "threads.create",
      input: { id: w.id(), space: open, kind: "ask", q: "p", executor: mac },
      clientTime: w.now,
    },
    { now: w.now },
  );
  t.is(guess.status, "unknown");
  void DAY;
});
