// The server half's findings of review round 1 of phase 1 (reviewer A), each
// as it stands after its fix, over both stores: the device run calls
// (`r1a/e02-runs.ts`), the SSE stream (`r1a/e01-sse.ts`), the protocol
// around them (`r1a/e05-protocol.ts`), the fractional clock
// (`r1a/e04-stores.ts`), and the test gaps G2, G4, G9, G11 and G18.

import test from "ava";

import {
  CLIENT_IDLE_TTL,
  newCursorKey,
  openStream,
  type Actor,
  type CallAnswer,
  type CursorMap,
  type LogId,
} from "../src/server/index.js";

import { DAY, HOUR, MINUTE, STORES, World, cast, ok, refused } from "./helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access --
   records and call results are read as `any` */
type Any = any;

/** Sign a device in for `u` (approved in the browser, the token taken). */
function device(w: World, u: string): { id: string; token: string; as: Actor } {
  const a = w.server.call(null, "devices.authorize", { name: "mac" }) as Any;
  const b = w.server.call({ u }, "devices.approve", { request: a.result.request }) as Any;
  const c = w.server.call(null, "devices.token", { request: a.result.request }) as Any;
  if (!a.ok || !b.ok || !c.ok) throw new Error(JSON.stringify([a, b, c]));
  return { id: c.result.device, token: c.result.token, as: { u, device: c.result.device } };
}

const exec = (id: string) => ({ kind: "device", cli: "claude", device: id });

/** A follow-up asked by `u` with a device run; its id and the run's. */
function fork(w: World, u: string, thread: string, dev: string, q = "and then?") {
  const id = w.id();
  const a = w.as(u, "research.forkNode", { id, thread, parent: "r", q, executor: exec(dev) });
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  return { fu: id, run: (a.result as { run: string }).run };
}

function ask(w: World, u: string, space: string, q: string, extra: object = {}) {
  const id = w.id();
  const a = w.as(u, "threads.create", { id, space, kind: "ask", q, ...extra });
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  return { th: id, run: (a.result as { run: string }).run };
}

const code = (a: CallAnswer) => (a.ok ? "ok" : a.error.code);
const get = (w: World, key: string) => w.get(key) as Any;

/** Open a stream for `actor`, run `act`, and answer what it sent. */
async function listen(
  w: World,
  actor: Actor | null,
  cursors: CursorMap,
  act: () => void,
): Promise<{ atOpen: string; during: string }> {
  const ac = new AbortController();
  const s = openStream(w.server, actor, cursors, ac.signal, {
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const reader = s.getReader();
  const dec = new TextDecoder();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
    }
  })();
  await new Promise((r) => setTimeout(r, 5));
  const atOpen = text;
  act();
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await pump;
  return { atOpen, during: text.slice(atOpen.length) };
}
const pokes = (s: string) => (s.match(/event: poke/g) ?? []).length;
const runEvents = (s: string) =>
  [...s.matchAll(/event: run\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1] ?? "{}") as Any);

for (const kind of STORES) {
  // ---- H1: runs.claim serves only what the read rules let its caller read

  test(`${kind}: H1: runs.claim leaves out a hidden thread's text for a caller who may not read it`, (t) => {
    const { w, open } = cast(t, kind);
    const { th } = ask(w, "otto", open, "HIDDEN QUESTION");
    w.server.finishJob(`thread:${th}`, "HIDDEN ANSWER");
    ok(t, w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden" }));
    const d = device(w, "mel");
    const { run } = fork(w, "mel", th, d.id);
    const c = w.server.call(d.as, "runs.claim", { run, device: d.id });
    t.true(c.ok);
    t.false(JSON.stringify(c).includes("HIDDEN"));
  });

  test(`${kind}: H1: a removed member's queued device run ends with the removal, and claiming it is NOT_FOUND`, (t) => {
    const { w, closed } = cast(t, kind);
    const { th } = ask(w, "olga", closed, "plans");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", th, d.id, "mel's tap");
    ok(
      t,
      w.as("olga", "members.remove", {
        space: closed,
        user: "mel",
        base: { adm: get(w, `member:${closed}:mel`).adm },
      }),
    );
    t.like(get(w, `run:${run}`), { status: "failed", end: "access" });
    w.server.finishJob(`thread:${th}`, "ANSWER WRITTEN AFTER MEL WAS REMOVED");
    w.clock.advance(3 * DAY);
    const c = w.server.call(d.as, "runs.claim", { run, device: d.id });
    t.is(code(c), "NOT_FOUND");
    t.false(JSON.stringify(c).includes("AFTER MEL"));
  });

  // ---- H2: claim, turn and finish are gated like a write, at call time

  test(`${kind}: H2: a device run of a person removed or banned after the claim is ended, its answer refused`, (t) => {
    const { w, open, closed } = cast(t, kind);
    // removed from the closed space while the run runs
    const { th } = ask(w, "olga", closed, "plans");
    const d = device(w, "mel");
    const a = fork(w, "mel", th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run: a.run, device: d.id }));
    // the membership ends in a write the run's ending is part of; to see the
    // call-time gate alone, the member record goes without that write
    w.server.store.transaction((tx) => tx.del(`member:${closed}:mel`));
    const f = w.server.call(d.as, "runs.finish", {
      run: a.run,
      device: d.id,
      attempt: 1,
      answer: "TEXT WRITTEN BY REMOVED MEL",
    });
    t.is(code(f), "NOT_FOUND");
    t.like(get(w, `run:${a.run}`), { status: "failed", end: "access" });
    t.is(get(w, `followup:${a.fu}`).a, null);
    // banned from the open space after the claim
    const o = ask(w, "otto", open, "otto's thread");
    const b = fork(w, "mel", o.th, d.id, "q");
    ok(t, w.server.call(d.as, "runs.claim", { run: b.run, device: d.id }));
    w.server.store.transaction((tx) =>
      tx.put(
        `ban:${open}:mel`,
        { kind: "ban", id: `${open}:mel`, sp: open, u: "mel", createdAt: "x", rev: 1 } as never,
        1,
      ),
    );
    const at = { run: b.run, device: d.id, attempt: 1 };
    t.is(code(w.server.call(d.as, "runs.turn", { ...at, turn: "SPAM" })), "FORBIDDEN");
    t.is(
      code(w.server.call(d.as, "runs.finish", { ...at, answer: "SPAM WRITTEN AFTER THE BAN" })),
      "FORBIDDEN",
    );
    t.is((w.server.viewOf(`followup:${b.fu}`, null) as Any).a, null);
    t.like(get(w, `run:${b.run}`), { status: "failed", end: "access" });
  });

  test(`${kind}: H2: a ban ends the banned person's device runs in its space, queued or running`, (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "otto's thread");
    const d = device(w, "mel");
    const queued = fork(w, "mel", o.th, d.id, "q1");
    const running = fork(w, "mel", o.th, d.id, "q2");
    ok(t, w.server.call(d.as, "runs.claim", { run: running.run, device: d.id }));
    ok(t, w.as("mona", "members.ban", { space: open, user: "mel" }));
    for (const r of [queued.run, running.run])
      t.like(get(w, `run:${r}`), { status: "failed", end: "access" });
    t.is(code(w.server.call(d.as, "runs.claim", { run: queued.run, device: d.id })), "FORBIDDEN");
  });

  // ---- W1: an ended lease ends the run, on a quiet server too

  test(`${kind}: W1: a call after the lease ended is refused, ends the run, and the next one is refused too`, (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "t");
    const d = device(w, "mel");
    const { fu, run } = fork(w, "mel", o.th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    w.clock.advance(10 * MINUTE);
    const finish = () =>
      w.server.call(d.as, "runs.finish", { run, device: d.id, attempt: 1, answer: "late" });
    t.is(code(finish()), "PRECONDITION_FAILED");
    t.like(get(w, `run:${run}`), { status: "failed", end: "interrupted" });
    w.clock.advance(500);
    t.is(code(finish()), "PRECONDITION_FAILED");
    t.is(get(w, `followup:${fu}`).a, null);
    // the heartbeat the same
    const b = fork(w, "mel", o.th, d.id, "again");
    ok(t, w.server.call(d.as, "runs.claim", { run: b.run, device: d.id }));
    w.clock.advance(10 * MINUTE);
    const beat = () =>
      w.server.call(d.as, "runs.heartbeat", { run: b.run, device: d.id, attempt: 1 });
    t.is(code(beat()), "PRECONDITION_FAILED");
    w.clock.advance(500);
    t.is(code(beat()), "PRECONDITION_FAILED");
    t.like(get(w, `run:${b.run}`), { status: "failed", end: "interrupted" });
  });

  test(`${kind}: W1: a refused write does not roll back the housekeeping that ended a lease`, (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "t");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", o.th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    w.clock.advance(10 * MINUTE);
    // a write that is refused, unrecorded, is the request that runs housekeeping
    refused(t, w.as("mel", "followups.ask", { id: "bad", thread: o.th, q: "x" }), "BAD_REQUEST");
    t.like(get(w, `run:${run}`), { status: "failed", end: "interrupted" });
  });

  test(`${kind}: W1: housekeeping on a timer ends a lease with no request at all`, (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "t");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", o.th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    let tick = () => {};
    const stop = w.server.startHousekeeping({
      setInterval: (f) => (tick = f),
      clearInterval: () => {},
    });
    w.clock.advance(91_000);
    tick();
    t.like(get(w, `run:${run}`), { status: "failed", end: "interrupted" });
    stop();
  });

  // ---- W2: an answer lands only on the attempt the ask is at

  test(`${kind}: W2: an earlier run's answer never lands on a later ask`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { th, run } = ask(w, "mel", open, "What is 2+2?", { executor: exec(d.id) });
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    ok(
      t,
      w.as("mel", "threads.update", {
        id: th,
        q: "What is the capital of France?",
        run: true,
        base: { rev: w.rev(`thread:${th}`) },
      }),
    );
    t.like(get(w, `run:${run}`), { status: "cancelled" });
    w.server.finishJob(`thread:${th}`, "Paris");
    const f = w.server.call(d.as, "runs.finish", { run, device: d.id, attempt: 1, answer: "4" });
    t.is(code(f), "PRECONDITION_FAILED");
    t.is(get(w, `thread:${th}`).sum, "Paris");
  });

  test(`${kind}: W2: a run whose attempt is not its ask's writes no answer`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { th, run } = ask(w, "mel", open, "Q", { executor: exec(d.id) });
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    // the ask moved on without cancelling this run (a store edit)
    w.server.store.transaction((tx) => {
      const p = tx.get(`thread:${th}`) as Any;
      tx.put(`thread:${th}`, { ...p, att: 2, sum: "newer" }, 1);
    });
    ok(t, w.server.call(d.as, "runs.finish", { run, device: d.id, attempt: 1, answer: "old" }));
    t.is(get(w, `thread:${th}`).sum, "newer");
  });

  // ---- W3: run events after the commit, numbered per attempt

  test(`${kind}: W3: runs.turn with a stream open answers ok, and the reader gets events numbered 1, 2`, async (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "t");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", o.th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    const cur = w.server.snapshot({ u: "otto" }, `space:${open}`).cursor;
    const answers: CallAnswer[] = [];
    const s = await listen(w, { u: "otto" }, { [`space:${open}`]: cur }, () => {
      for (const text of ["text 1", "text 2"])
        answers.push(
          w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: text }),
        );
    });
    t.deepEqual(answers.map(code), ["ok", "ok"]);
    t.deepEqual(
      runEvents(s.during).map((e) => [e.run, e.attempt, e.seq, e.text]),
      [
        [run, 1, 1, "text 1"],
        [run, 1, 2, "text 2"],
      ],
    );
  });

  // G11: in-flight text goes to the run's readers only
  test(`${kind}: G11: a stream of a reader who may not read the run gets no run events`, async (t) => {
    const { w, closed } = cast(t, kind);
    const { th } = ask(w, "olga", closed, "plans");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    const log: LogId = `space:${closed}`;
    const otto = w.server.snapshot({ u: "otto" }, log).cursor;
    const s = await listen(w, { u: "otto" }, { [log]: otto }, () => {
      ok(t, w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: "SECRET" }));
    });
    t.false(s.during.includes("SECRET"));
    const olga = w.server.snapshot({ u: "olga" }, log).cursor;
    const s2 = await listen(w, { u: "olga" }, { [log]: olga }, () => {
      ok(t, w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: "MEMBERS" }));
    });
    t.is(runEvents(s2.during).length, 1);
  });

  // ---- W8: the lease is the server's only

  test(`${kind}: W8: a heartbeat changes no log, and a reader gets neither the lease nor the device`, async (t) => {
    const { w, open } = cast(t, kind);
    const o = ask(w, "otto", open, "t");
    const d = device(w, "mel");
    const { run } = fork(w, "mel", o.th, d.id);
    ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    const cur = w.server.snapshot(null, `space:${open}`).cursor;
    const s = await listen(w, null, { [`space:${open}`]: cur }, () => {
      for (let k = 0; k < 3; k++) {
        w.clock.advance(30_000);
        ok(t, w.server.call(d.as, "runs.heartbeat", { run, device: d.id, attempt: 1 }));
      }
    });
    t.is(pokes(s.during), 0);
    const anon = w.server.viewOf(`run:${run}`, null) as Any;
    t.false("lease" in anon);
    t.is(anon.executor.device, "");
    t.is((w.server.viewOf(`run:${run}`, "mel") as Any).executor.device, d.id);
    t.like(w.server.store.dump().leases[0] ?? {}, { run, seq: 0 });
  });

  // ---- W4: the hourly limit counts device runs started

  test(`${kind}: W4: 100 device runs an hour, deleted threads included`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    let ran = 0;
    let stop = "";
    for (let k = 0; k < 150 && !stop; k++) {
      const id = w.id();
      const a = w.as("mel", "threads.create", {
        id,
        space: open,
        kind: "ask",
        q: `q${k}`,
        executor: exec(d.id),
      });
      if (!a.ok) {
        stop = a.error.code;
        break;
      }
      const run = (a.result as { run: string }).run;
      ok(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
      ok(t, w.server.call(d.as, "runs.finish", { run, device: d.id, attempt: 1, answer: "a" }));
      ran++;
      ok(t, w.as("mel", "threads.delete", { id }));
      w.clock.advance(1000);
    }
    t.is(ran, 100);
    t.is(stop, "TOO_MANY_REQUESTS");
    w.clock.advance(HOUR);
    ask(w, "mel", open, "later", { executor: exec(d.id) });
    w.server.housekeepAll();
    t.true(w.server.store.dump().deviceRuns.length <= 1, "starts older than an hour are pruned");
  });

  // ---- H3: the stream never keeps a token it cannot open

  test(`${kind}: H3: a token that does not open is poked once and dropped from the stream`, async (t) => {
    const { w, open, closed } = cast(t, kind);
    const secret = () => {
      for (let k = 0; k < 3; k++)
        ok(
          t,
          w.as("mel", "threads.create", { id: w.id(), space: closed, kind: "post", q: `s${k}` }),
        );
    };
    for (const actor of [null, { u: "otto" }]) {
      const s = await listen(w, actor, { [`space:${closed}`]: "garbage" }, secret);
      t.is(pokes(s.atOpen), 1, "one poke at connect");
      t.is(pokes(s.during), 0, "nothing for commits it may not read");
    }
    const post = w.id();
    ok(t, w.as("olga", "threads.create", { id: post, space: open, kind: "post", q: "x" }));
    // another person's user log, with a made-up token and with one of otto's
    const ottos = w.server.snapshot({ u: "otto" }, "user:otto").cursor;
    for (const token of ["garbage", ottos]) {
      const s = await listen(w, { u: "otto" }, { "user:mel": token }, () => {
        ok(t, w.as("mel", "likes.set", { thread: post, on: true }));
        ok(t, w.as("mel", "mutes.set", { handle: "otto", on: true }));
        ok(t, w.as("mel", "likes.set", { thread: post, on: false }));
        ok(t, w.as("mel", "mutes.set", { handle: "otto", on: false }));
      });
      t.is(pokes(s.during), 0);
    }
    // an honest token keeps working, and a later resync drops the log too
    const log: LogId = `space:${open}`;
    const cur = w.server.snapshot({ u: "otto" }, log).cursor;
    const s = await listen(w, { u: "otto" }, { [log]: cur }, () => {
      ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "a" }));
      ok(t, w.as("olga", "spaces.update", { id: open, set: { vis: "listed", policy: "request" } }));
      ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "b" }));
      ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "c" }));
    });
    t.is(pokes(s.during), 2, "the post, then the resync of the closed log; then nothing");
  });

  // ---- E16: a listener that throws

  test(`${kind}: E16: a listener that throws changes no answer and silences no other listener`, (t) => {
    const { w, open } = cast(t, kind);
    const heard: string[] = [];
    const off = w.server.subscribe(() => {
      throw new Error("a stream's controller is closed");
    });
    const off2 = w.server.subscribe((logs) => void heard.push([...logs].join(",")));
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
    const a = w.server.call(null, "devices.authorize", { name: "mac" }) as Any;
    ok(t, w.server.call({ u: "mel" }, "devices.approve", { request: a.result.request }));
    t.true(w.server.call(null, "devices.token", { request: a.result.request }).ok);
    t.true(heard.length >= 2);
    off();
    off2();
  });

  // ---- E17, G4: approving a sign-in

  test(`${kind}: E17: a device token approves no sign-in; G4: a sign-in older than 10 minutes is NOT_FOUND`, (t) => {
    const { w } = cast(t, kind);
    const d1 = device(w, "mel");
    const s = w.server.call(null, "devices.authorize", { name: "attacker" }) as Any;
    t.is(code(w.server.call(d1.as, "devices.approve", { request: s.result.request })), "FORBIDDEN");
    const late = w.server.call(null, "devices.authorize", { name: "late" }) as Any;
    w.clock.advance(10 * MINUTE + 1);
    t.is(
      code(w.server.call({ u: "mel" }, "devices.approve", { request: late.result.request })),
      "NOT_FOUND",
    );
  });

  // ---- E18: revoking a device ends its runs

  test(`${kind}: E18: devices.revoke ends the device's queued and running runs`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const q = ask(w, "mel", open, "q", { executor: exec(d.id) });
    const r = ask(w, "mel", open, "r", { executor: exec(d.id) });
    ok(t, w.server.call(d.as, "runs.claim", { run: r.run, device: d.id }));
    ok(t, w.server.call({ u: "mel" }, "devices.revoke", { id: d.id }));
    for (const x of [q, r]) {
      t.like(get(w, `run:${x.run}`), { status: "failed", end: "access" });
      t.false(get(w, `thread:${x.th}`).running);
    }
    t.is(
      code(w.server.call({ u: "mel" }, "runs.claim", { run: q.run, device: d.id })),
      "FORBIDDEN",
    );
  });

  // ---- E20: an untaken sign-in leaves nothing

  test(`${kind}: E20: a sign-in approved but never taken leaves no device and no token`, (t) => {
    const { w } = cast(t, kind);
    const s = w.server.call(null, "devices.authorize", { name: "mac" }) as Any;
    ok(t, w.server.call({ u: "mel" }, "devices.approve", { request: s.result.request }));
    t.deepEqual(w.server.store.dump().tokens, []);
    w.clock.advance(11 * MINUTE);
    t.is(code(w.server.call(null, "devices.token", { request: s.result.request })), "NOT_FOUND");
    w.server.housekeepAll();
    const d = w.server.store.dump();
    t.false(d.records.some((r) => r.record.kind === "device"));
    t.deepEqual(d.tokens, []);
    t.deepEqual(d.signins, []);
  });

  // ---- G2: a device acts only on its own runs

  test(`${kind}: G2: a device token cannot act on another device's run`, (t) => {
    const { w, open } = cast(t, kind);
    const a = device(w, "mel");
    const b = device(w, "mel");
    const { run } = ask(w, "mel", open, "q", { executor: exec(b.id) });
    t.is(code(w.server.call(a.as, "runs.claim", { run, device: b.id })), "FORBIDDEN");
    t.is(code(w.server.call(a.as, "runs.claim", { run, device: a.id })), "FORBIDDEN");
    ok(t, w.server.call(b.as, "runs.claim", { run, device: b.id }));
  });

  // ---- G9: a revoked device registers no client

  test(`${kind}: G9: register refuses a revoked device`, (t) => {
    const { w } = cast(t, kind);
    const d = device(w, "mel");
    t.true(w.server.register(d.as).ok);
    ok(t, w.server.call({ u: "mel" }, "devices.revoke", { id: d.id }));
    const r = w.server.register(d.as);
    t.is(r.ok ? "ok" : r.error.code, "WRONG_CLIENT");
  });

  // ---- G18: an idle client is refused even before housekeeping prunes it

  test(`${kind}: G18: a client idle for 90 days is WRONG_CLIENT between housekeeping passes`, (t) => {
    const { w, open } = cast(t, kind);
    const e = w.envelope("mel", "likes.set", { thread: ask(w, "otto", open, "q").th, on: true });
    // housekeeping runs just before the client becomes idle, then not again
    // within the second
    w.clock.advance(CLIENT_IDLE_TTL - 500);
    w.server.snapshot(null, `space:${open}`);
    w.clock.advance(600);
    const a = w.server.apply(
      { u: "mel" },
      { ...e, mutationId: w.id(), clientTime: w.clock.now(), queuedAt: w.clock.now() },
    );
    refused(t, a, "WRONG_CLIENT");
  });

  // ---- the fractional clock, and the online calls' clock

  test(`${kind}: a clock at a fraction of a millisecond: the server keeps whole milliseconds`, (t) => {
    const w = new World(kind);
    w.clock.ms += 0.5;
    const r = w.server.register({ u: "mel" });
    t.true(r.ok);
    t.true(Number.isInteger(r.serverTime));
    const c = w.server.call(null, "no.such", {});
    t.is(c.serverTime, Math.floor(w.clock.now()), "an early answer reads the server's clock");
  });

  // ---- leaving and removal, as the user log serves it

  test(`${kind}: the user log serves how a membership ended`, (t) => {
    const { w, closed } = cast(t, kind);
    const s = w.server.snapshot({ u: "mel" }, "user:mel");
    ok(t, w.as("mel", "spaces.leave", { space: closed }));
    // a membership change replaces the user log's history: the pull answers
    // resync, and the snapshot holds the exit record
    t.true("resync" in w.server.pull({ u: "mel" }, "user:mel", s.cursor));
    const snap = w.server.snapshot({ u: "mel" }, "user:mel").records;
    const put = snap.find((c) => c.key === `exit:${closed}:mel`);
    t.like(put?.record ?? {}, { kind: "exit", sp: closed, u: "mel", ended: "left" });
    t.false(snap.some((c) => c.key === `member:${closed}:mel`));
    t.false(
      w.server
        .snapshot({ u: "olga" }, `space:${closed}`)
        .records.some((r) => r.key.startsWith("exit:")),
    );
  });

  // ---- the effect worker starts jobs after its transaction

  test(`${kind}: the effect worker starts a job outside its transaction, and keeps it queued until started`, (t) => {
    let fail = true;
    const started: string[] = [];
    const holder: { w?: World } = {};
    const { w, open } = cast(t, kind, 1, {
      jobs: {
        start: (j) => {
          if (fail) throw new Error("the runner is down");
          started.push(j.id);
          // a runner that answers at once writes in a transaction of its own
          holder.w?.server.finishJob(`thread:${th}`, "at once");
        },
      },
    });
    holder.w = w;
    const { th } = ask(w, "mel", open, "q");
    w.server.work();
    t.is(started.length, 0);
    t.true(w.server.store.dump().effects.some((e) => e.effect.type === "job"));
    fail = false;
    w.clock.advance(MINUTE);
    w.server.work();
    t.is(started.length, 1);
    t.is(get(w, `thread:${th}`).sum, "at once");
    t.false(w.server.store.dump().effects.some((e) => e.effect.type === "job"));
  });
}

// ---- E22: a database restored from a backup

test("E22: a cursor served before a restore, or by another database, answers resync", (t) => {
  const keys = { current: newCursorKey() };
  // the live database and the restored one: the same history up to the
  // backup, then each its own
  const live = new World("memory", 7, { cursorKeys: keys });
  const restored = new World("memory", 7, { cursorKeys: keys });
  const sp = live.id();
  restored.id();
  for (const w of [live, restored]) ok(t, w.as("olga", "spaces.create", { id: sp, name: "s" }));
  for (let k = 0; k < 5; k++)
    ok(
      t,
      live.as("olga", "threads.create", { id: live.id(), space: sp, kind: "post", q: `l${k}` }),
    );
  const cursor = live.server.snapshot({ u: "olga" }, `space:${sp}`).cursor;
  for (let k = 0; k < 8; k++)
    ok(
      t,
      restored.as("olga", "threads.create", {
        id: restored.id(),
        space: sp,
        kind: "post",
        q: `n${k}`,
      }),
    );
  t.true("resync" in restored.server.pull({ u: "olga" }, `space:${sp}`, cursor));
  // a restore in place: the operator gives the database a new instance id
  const c2 = restored.server.snapshot({ u: "olga" }, `space:${sp}`).cursor;
  t.false("resync" in restored.server.pull({ u: "olga" }, `space:${sp}`, c2));
  restored.server.resetInstance();
  t.true("resync" in restored.server.pull({ u: "olga" }, `space:${sp}`, c2));
});
