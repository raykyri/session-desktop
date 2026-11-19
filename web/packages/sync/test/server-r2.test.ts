// The server half's findings of review round 2 of phase 1, each as it stands
// after its fix, over both stores: reviewer A's (`r2a/e01-runs.ts`,
// `r2a/e02-rules.ts`, `r2a/e04-effects.ts`) and the test gaps G1 to G4, and
// the server side of reviewer B's findings 1, 2, 6, 7 and 8a.

import test from "ava";
import BetterSqlite from "better-sqlite3";

import {
  DEVICE_TURN_MAX,
  LEASE_MS,
  MAX_CALL_BYTES,
  OPENED_MAX,
  SqliteServerStore,
  SyncServer,
  newCursorKey,
  openStream,
  type Actor,
  type CallAnswer,
  type CursorMap,
  type ServerStore,
  type StoreTx,
} from "../src/server/index.js";

import { DAY, HOUR, MINUTE, STORES, cast, makeStore, ok, refused, type World } from "./helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call --
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

function fork(w: World, u: string, thread: string, dev: string | null, q = "and then?", x = {}) {
  const id = w.id();
  const a = w.as(u, "research.forkNode", {
    id,
    thread,
    parent: "r",
    q,
    ...(dev ? { executor: exec(dev) } : {}),
    ...x,
  });
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
const view = (w: World, key: string, u: string | null) => w.server.viewOf(key, u) as Any;
const decide = (w: World, item: string, decision: string, base?: number) =>
  w.as("mona", "moderation.decide", {
    item,
    decision,
    ...(base !== undefined ? { base: { rev: base } } : {}),
  });

/** Open a stream for `actor`, run `act`, and answer what it sent. */
async function listen(
  w: World,
  actor: Actor | null,
  cursors: CursorMap,
  act: () => void,
): Promise<{ during: string; closed: boolean }> {
  const ac = new AbortController();
  const s = openStream(w.server, actor, cursors, ac.signal, {
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const reader = s.getReader();
  const dec = new TextDecoder();
  let text = "";
  let closed = false;
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += dec.decode(r.value);
    }
    closed = !ac.signal.aborted;
  })();
  await new Promise((r) => setTimeout(r, 5));
  const atOpen = text.length;
  act();
  await new Promise((r) => setTimeout(r, 5));
  const wasClosed = closed;
  ac.abort();
  await pump;
  return { during: text.slice(atOpen), closed: wasClosed };
}
const runTexts = (s: string) =>
  [...s.matchAll(/event: run\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1] ?? "{}").text as string);

for (const kind of STORES) {
  // ---- H1: in-flight text goes only to readers of the run's node as stored

  test(`${kind}: H1: a hidden thread's or follow-up's run text goes to its author and the moderators only`, async (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { th, run } = ask(w, "mel", open, "Q", { executor: exec(d.id) });
    ok(t, decide(w, `a:${th}`, "hidden"));
    t.is(code(w.server.call(d.as, "runs.claim", { run, device: d.id })), "ok");
    let k = 0;
    const heard = async (u: string | null, r: string) => {
      const text = `T${k++}`;
      const cur = (w.server.snapshot(u === null ? null : { u }, `space:${open}`) as Any).cursor;
      const l = await listen(w, u === null ? null : { u }, { [`space:${open}`]: cur }, () => {
        const a = w.server.call(d.as, "runs.turn", {
          run: r,
          device: d.id,
          attempt: 1,
          turn: text,
        });
        if (!a.ok) throw new Error(JSON.stringify(a));
      });
      return runTexts(l.during).includes(text);
    };
    t.false(await heard(null, run), "signed out");
    t.false(await heard("otto", run), "a member");
    t.true(await heard("mel", run), "its author");
    t.true(await heard("mona", run), "a moderator");
    // a hidden follow-up of another person's thread
    const o = ask(w, "otto", open, "otto's");
    const f = fork(w, "mel", o.th, d.id, "mel's follow-up");
    ok(t, decide(w, `f:${o.th}:${f.fu}`, "hidden"));
    t.is(code(w.server.call(d.as, "runs.claim", { run: f.run, device: d.id })), "ok");
    t.false(await heard(null, f.run), "signed out");
    t.false(await heard("otto", f.run), "the thread's author");
    t.true(await heard("mel", f.run), "the follow-up's author");
    t.true(await heard("mona", f.run), "a moderator");
    // shown again: everyone
    ok(t, decide(w, `f:${o.th}:${f.fu}`, "shown", get(w, `hide:followup:${f.fu}`).rev));
    t.true(await heard(null, f.run), "signed out, once shown");
  });

  // ---- G1: runs.claim leaves out a hidden follow-up of another person

  test(`${kind}: G1: runs.claim leaves out a hidden follow-up its caller may not read`, (t) => {
    const { w, open } = cast(t, kind);
    const { th } = ask(w, "olga", open, "olga's ask");
    w.server.finishJob(`thread:${th}`, "olga's answer");
    const mel = fork(w, "mel", th, null, "HIDDEN FOLLOW-UP");
    ok(t, decide(w, `f:${th}:${mel.fu}`, "hidden"));
    const o = device(w, "otto");
    const r = fork(w, "otto", th, o.id, "otto's follow-up");
    const c = w.server.call(o.as, "runs.claim", { run: r.run, device: o.id }) as Any;
    t.true(c.ok);
    t.deepEqual(
      c.result.turns.map((x: Any) => x.q),
      ["olga's ask", "otto's follow-up"],
    );
    // its author reads it: a turn of theirs
    const d = device(w, "mel");
    const m = fork(w, "mel", th, d.id, "mel's second");
    const c2 = w.server.call(d.as, "runs.claim", { run: m.run, device: d.id }) as Any;
    t.true(c2.result.turns.some((x: Any) => x.q === "HIDDEN FOLLOW-UP"));
  });

  // ---- H2: model and skill are ids, redacted and erased with their item

  test(`${kind}: H2: model is a model id and skill a skill of the space, at the input`, (t) => {
    const { w, open, closed } = cast(t, kind);
    for (const model of ["ABUSE-MODEL", "two words", "x".repeat(65), ""])
      refused(
        t,
        w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "q", model }),
        "BAD_REQUEST",
      );
    refused(
      t,
      w.as("mel", "research.forkNode", {
        id: w.id(),
        thread: ask(w, "mel", open, "q").th,
        parent: "r",
        q: "f",
        model: "Free Text",
      }),
      "BAD_REQUEST",
    );
    const sk = w.id();
    ok(t, w.as("olga", "skills.create", { id: sk, space: closed, name: "S", prompt: "p" }));
    // no skill, and a skill of another space
    for (const skill of [w.id(), sk, "ABUSE SKILL"])
      refused(
        t,
        w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "q", skill }),
        "NOT_FOUND",
      );
    const mine = w.id();
    ok(t, w.as("mona", "skills.create", { id: mine, space: open, name: "S", prompt: "p" }));
    const th = ask(w, "mel", open, "q", { skill: mine, model: "claude-opus-5.5" }).th;
    t.like(get(w, `thread:${th}`), { skill: mine, model: "claude-opus-5.5" });
  });

  test(`${kind}: H2: a hidden ask's model and skill and its runs' model are redacted, and erased on removal and delete`, (t) => {
    const { w, open } = cast(t, kind);
    const sk = w.id();
    ok(t, w.as("mona", "skills.create", { id: sk, space: open, name: "S", prompt: "p" }));
    const { th, run } = ask(w, "mel", open, "q", { model: "abuse-model", skill: sk });
    const f = fork(w, "otto", th, null, "f", { model: "abuse-fmodel" });
    const cur = w.server.snapshot(null, `space:${open}`).cursor;
    ok(t, decide(w, `a:${th}`, "hidden"));
    ok(t, decide(w, `f:${th}:${f.fu}`, "hidden"));
    t.like(view(w, `thread:${th}`, null), { model: null, skill: null });
    t.like(view(w, `followup:${f.fu}`, null), { model: null });
    t.like(view(w, `run:${run}`, null), { model: null });
    t.like(view(w, `run:${f.run}`, null), { model: null });
    t.like(view(w, `run:${run}`, "mel"), { model: "abuse-model" }, "its author");
    t.like(view(w, `run:${f.run}`, "mona"), { model: "abuse-fmodel" }, "a moderator");
    t.like(view(w, `thread:${th}`, "mona"), { model: "abuse-model", skill: sk });
    // a hide serves the runs again: a pull from before it gets them redacted
    const p = w.server.pull(null, `space:${open}`, cur) as Any;
    const runs = p.changes.filter((c: Any) => c.key.startsWith("run:"));
    t.deepEqual(runs.map((c: Any) => c.key).sort(), [`run:${f.run}`, `run:${run}`].sort());
    t.true(runs.every((c: Any) => c.record.model === null));
    const atRest = () => JSON.stringify(w.server.store.dump());
    ok(t, decide(w, `f:${th}:${f.fu}`, "removed"));
    t.false(atRest().includes("abuse-fmodel"));
    ok(t, decide(w, `a:${th}`, "removed"));
    t.false(atRest().includes("abuse-model"));
    t.like(get(w, `thread:${th}`), { model: null, skill: null });
    // deleted by its author, as a shell and gone
    const g = ask(w, "mel", open, "q", { model: "gone-model", skill: sk }).th;
    const kept = ask(w, "mel", open, "q", { model: "kept-model", skill: sk }).th;
    fork(w, "otto", kept, null, "a follow-up keeps the shell", { model: "fu-model" });
    ok(t, w.as("mel", "threads.delete", { id: g }));
    ok(t, w.as("mel", "threads.delete", { id: kept }));
    t.like(get(w, `thread:${g}`), { gone: true, model: null, skill: null });
    t.like(get(w, `thread:${kept}`), { del: true, gone: false, model: null, skill: null });
    t.false(atRest().includes("gone-model"));
    t.false(atRest().includes("kept-model"));
    // a follow-up its author deleted while it has asks below it
    const top = fork(w, "otto", kept, null, "top", { model: "top-model" });
    ok(
      t,
      w.as("mel", "research.forkNode", { id: w.id(), thread: kept, parent: top.fu, q: "below" }),
    );
    ok(t, w.as("otto", "followups.delete", { thread: kept, node: top.fu }));
    t.like(get(w, `followup:${top.fu}`), { del: true, model: null });
  });

  // ---- W1: an answer written while hidden counts as an edit

  test(`${kind}: W1: a device answer, a job's answer and a rerun to a hidden item make "shown" STALE`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const a = ask(w, "mel", open, "fine question", { executor: exec(d.id) });
    ok(t, decide(w, `a:${a.th}`, "hidden"));
    const seen = get(w, `hide:thread:${a.th}`).rev;
    w.server.call(d.as, "runs.claim", { run: a.run, device: d.id });
    const f = w.server.call(d.as, "runs.finish", {
      run: a.run,
      device: d.id,
      attempt: 1,
      answer: "TEXT MONA NEVER READ",
    });
    t.true(f.ok);
    refused(t, decide(w, `a:${a.th}`, "shown", seen), "STALE");
    t.is(view(w, `thread:${a.th}`, null).sum, null);
    ok(t, decide(w, `a:${a.th}`, "shown", get(w, `hide:thread:${a.th}`).rev));
    // a job's answer, to a thread and to a follow-up
    const b = ask(w, "mel", open, "q");
    ok(t, decide(w, `a:${b.th}`, "hidden"));
    const seen2 = get(w, `hide:thread:${b.th}`).rev;
    t.true(w.server.finishJob(`thread:${b.th}`, "JOB ANSWER"));
    refused(t, decide(w, `a:${b.th}`, "shown", seen2), "STALE");
    const fu = fork(w, "otto", b.th, null);
    ok(t, decide(w, `f:${b.th}:${fu.fu}`, "hidden"));
    const seen3 = get(w, `hide:followup:${fu.fu}`).rev;
    t.true(w.server.finishJob(`followup:${fu.fu}`, "JOB FOLLOW-UP ANSWER"));
    refused(t, decide(w, `f:${b.th}:${fu.fu}`, "shown", seen3), "STALE");
    // a rerun with the same question clears the answer
    const c = ask(w, "mel", open, "same");
    w.server.finishJob(`thread:${c.th}`, "read by mona");
    ok(t, decide(w, `a:${c.th}`, "hidden"));
    const seen4 = get(w, `hide:thread:${c.th}`).rev;
    ok(
      t,
      w.as("mel", "threads.update", {
        id: c.th,
        q: "same",
        run: true,
        base: { rev: w.rev(`thread:${c.th}`) },
      }),
    );
    refused(t, decide(w, `a:${c.th}`, "shown", seen4), "STALE");
    const seen5 = get(w, `hide:followup:${fu.fu}`).rev;
    ok(
      t,
      w.as("otto", "followups.update", {
        thread: b.th,
        node: fu.fu,
        q: "and then?",
        run: true,
        base: { rev: w.rev(`followup:${fu.fu}`) },
      }),
    );
    refused(t, decide(w, `f:${b.th}:${fu.fu}`, "shown", seen5), "STALE");
  });

  // ---- W2: an access end is its person's only

  test(`${kind}: W2: a run that ended for access reads as interrupted to everyone but its person`, (t) => {
    const { w, open } = cast(t, kind);
    ok(t, w.as("mel", "spaces.leave", { space: open }));
    const d = device(w, "mel");
    const { run } = ask(w, "mel", open, "q", { executor: exec(d.id) });
    const cur = w.server.snapshot(null, `space:${open}`).cursor;
    ok(t, w.as("mona", "members.ban", { space: open, user: "mel" }));
    t.like(get(w, `run:${run}`), { status: "failed", end: "access" });
    for (const u of [null, "otto", "mona"])
      t.like(view(w, `run:${run}`, u), { end: "interrupted" });
    t.like(view(w, `run:${run}`, "mel"), { end: "access" }, "its person");
    const p = w.server.pull(null, `space:${open}`, cur) as Any;
    const r = p.changes.find((c: Any) => c.key === `run:${run}`);
    t.like(r.record, { status: "failed", end: "interrupted" });
  });

  // ---- G2: the lease check itself, within a second of housekeeping

  test(`${kind}: G2: a call at the lease's end is refused though housekeeping ran within the second`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { th, run } = ask(w, "mel", open, "q", { executor: exec(d.id) });
    t.is(code(w.server.call(d.as, "runs.claim", { run, device: d.id })), "ok");
    w.clock.advance(LEASE_MS - 1);
    // housekeeping runs now, while the lease holds
    w.server.snapshot(null, `space:${open}`);
    t.like(get(w, `run:${run}`), { status: "running" });
    w.clock.advance(1);
    const a = w.server.call(d.as, "runs.heartbeat", { run, device: d.id, attempt: 1 });
    t.is(code(a), "PRECONDITION_FAILED");
    t.like(get(w, `run:${run}`), { status: "failed", end: "interrupted" });
    t.false(get(w, `thread:${th}`).running);
  });

  // ---- G3: a ban of a non-member ends their device runs at once

  test(`${kind}: G3: a ban of a person who is no member ends their queued and running device runs`, (t) => {
    const { w, open } = cast(t, kind);
    ok(t, w.as("mel", "spaces.leave", { space: open }));
    const d = device(w, "mel");
    const q = ask(w, "mel", open, "queued", { executor: exec(d.id) });
    const r = ask(w, "mel", open, "running", { executor: exec(d.id) });
    t.is(code(w.server.call(d.as, "runs.claim", { run: r.run, device: d.id })), "ok");
    ok(t, w.as("mona", "members.ban", { space: open, user: "mel" }));
    for (const x of [q, r]) {
      t.like(get(w, `run:${x.run}`), { status: "failed", end: "access" });
      t.false(get(w, `thread:${x.th}`).running);
    }
    t.is(w.server.store.dump().leases.length, 0);
  });

  // ---- smaller: device runs

  test(`${kind}: a turn over ${DEVICE_TURN_MAX} bytes and an input over ${MAX_CALL_BYTES} bytes are TOO_LARGE`, async (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { run } = ask(w, "mel", open, "q", { executor: exec(d.id) });
    w.server.call(d.as, "runs.claim", { run, device: d.id });
    const cur = w.server.snapshot(null, `space:${open}`).cursor;
    let big!: CallAnswer;
    const l = await listen(w, null, { [`space:${open}`]: cur }, () => {
      big = w.server.call(d.as, "runs.turn", {
        run,
        device: d.id,
        attempt: 1,
        turn: "x".repeat(DEVICE_TURN_MAX + 1),
      });
    });
    t.is(code(big), "TOO_LARGE");
    t.is(runTexts(l.during).length, 0);
    t.is(
      code(
        w.server.call(d.as, "runs.turn", {
          run,
          device: d.id,
          attempt: 1,
          turn: "x".repeat(DEVICE_TURN_MAX),
        }),
      ),
      "ok",
    );
    t.is(
      code(
        w.server.call(d.as, "runs.finish", {
          run,
          device: d.id,
          attempt: 1,
          answer: "x".repeat(MAX_CALL_BYTES),
        }),
      ),
      "TOO_LARGE",
    );
    t.like(get(w, `run:${run}`), { status: "running" });
    let deep: unknown = 1;
    for (let k = 0; k < 40; k++) deep = [deep];
    t.is(
      code(w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: deep })),
      "BAD_REQUEST",
    );
    // an answer over 200 KB that fits the call still ends the run too_large
    const f = w.server.call(d.as, "runs.finish", {
      run,
      device: d.id,
      attempt: 1,
      answer: "x".repeat(200 * 1024 + 1),
    }) as Any;
    t.deepEqual(f.result, { status: "too_large" });
  });

  test(`${kind}: a browser session of the run's person drives no device run`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const { th, run } = ask(w, "mel", open, "q", { executor: exec(d.id) });
    const inputs: [string, object][] = [
      ["runs.claim", {}],
      ["runs.heartbeat", { attempt: 1 }],
      ["runs.turn", { attempt: 1, turn: "t" }],
      ["runs.finish", { attempt: 1, answer: "a" }],
    ];
    for (const [name, extra] of inputs)
      t.is(
        code(w.server.call({ u: "mel" }, name, { run, device: d.id, ...extra })),
        "FORBIDDEN",
        name,
      );
    t.like(get(w, `run:${run}`), { status: "queued" });
    t.is(get(w, `thread:${th}`).sum, null);
  });

  test(`${kind}: archiving a space ends its device runs, and run calls there are PRECONDITION_FAILED`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const q = ask(w, "mel", open, "queued", { executor: exec(d.id) });
    const r = ask(w, "mel", open, "running", { executor: exec(d.id) });
    const job = ask(w, "mel", open, "a server job");
    t.is(code(w.server.call(d.as, "runs.claim", { run: r.run, device: d.id })), "ok");
    ok(t, w.as("olga", "spaces.archive", { id: open, archived: true }));
    for (const x of [q, r]) {
      t.like(get(w, `run:${x.run}`), { status: "failed", end: "interrupted" });
      t.false(get(w, `thread:${x.th}`).running);
    }
    t.like(get(w, `run:${job.run}`), { status: "queued" }, "a server job is not a device run");
    t.is(
      code(w.server.call(d.as, "runs.claim", { run: q.run, device: d.id })),
      "PRECONDITION_FAILED",
    );
    t.is(
      code(
        w.server.call(d.as, "runs.finish", {
          run: r.run,
          device: d.id,
          attempt: 1,
          answer: "late",
        }),
      ),
      "PRECONDITION_FAILED",
    );
    t.is(get(w, `thread:${r.th}`).sum, null);
    refused(
      t,
      w.as("mel", "followups.ask", { id: w.id(), thread: q.th, q: "x" }),
      "PRECONDITION_FAILED",
    );
  });

  test(`${kind}: a run whose job became a dead letter ends, and its thread stops running`, (t) => {
    let starts = 0;
    const { w, open } = cast(t, kind, 1, {
      jobs: {
        start: () => {
          starts++;
          throw new Error("runner down");
        },
      },
    });
    const { th, run } = ask(w, "mel", open, "q");
    for (let k = 0; k < 40 && w.server.store.dump().effects.length; k++) {
      w.server.work();
      w.clock.advance(HOUR);
    }
    t.is(starts, 10);
    t.is(w.server.store.dump().deadLetters.length, 1);
    t.like(get(w, `run:${run}`), { status: "failed", end: "interrupted" });
    t.false(get(w, `thread:${th}`).running);
  });

  // ---- smaller: devices

  test(`${kind}: the approver denies an approved sign-in whose token nobody took`, (t) => {
    const { w } = cast(t, kind);
    const a = w.server.call(null, "devices.authorize", { name: "attacker's mac" }) as Any;
    const req = a.result.request;
    t.true(w.server.call({ u: "mel" }, "devices.approve", { request: req }).ok);
    t.is(
      code(w.server.call({ u: "otto" }, "devices.approve", { request: req, deny: true })),
      "NOT_FOUND",
    );
    t.true(w.server.call({ u: "mel" }, "devices.approve", { request: req, deny: true }).ok);
    w.clock.advance(MINUTE);
    t.is(code(w.server.call(null, "devices.token", { request: req })), "FORBIDDEN");
    t.is(
      w.server.snapshot({ u: "mel" }, "user:mel").records.filter((r) => r.key.startsWith("device:"))
        .length,
      0,
    );
  });

  test(`${kind}: devices.revoke closes the device's streams`, async (t) => {
    const { w, open } = cast(t, kind);
    const d = device(w, "mel");
    const other = device(w, "mel");
    const cursors = {
      "user:mel": w.server.snapshot(d.as, "user:mel").cursor,
      [`space:${open}`]: w.server.snapshot(d.as, `space:${open}`).cursor,
    };
    const l = await listen(w, d.as, cursors, () => {
      w.server.call({ u: "mel" }, "devices.revoke", { id: d.id });
    });
    t.true(l.closed);
    t.is(w.server.online.authenticate(d.token), null);
    // another device's stream stays open
    const l2 = await listen(w, other.as, cursors, () => {
      w.server.call({ u: "mel" }, "devices.revoke", { id: device(w, "mel").id });
    });
    t.false(l2.closed);
  });

  // ---- smaller: the stores

  test(`${kind}: rows of one version keep their order after a rolled-back write`, (t) => {
    const s = makeStore(kind);
    s.transaction((tx) => {
      for (const k of ["a", "b", "c"]) tx.logPut("catalog", { key: k, op: "put", version: 1 });
    });
    t.throws(() =>
      s.transaction((tx) => {
        tx.logPut("catalog", { key: "a", op: "put", version: 2 });
        throw new Error("fault");
      }),
    );
    t.deepEqual(
      s.transaction((tx) => tx.logAfter("catalog", 0).map((r) => r.key)),
      ["a", "b", "c"],
    );
    s.transaction((tx) => tx.logPut("catalog", { key: "a", op: "put", version: 1 }));
    t.deepEqual(
      s.transaction((tx) => tx.logAfter("catalog", 0).map((r) => r.key)),
      ["b", "c", "a"],
    );
  });

  test(`${kind}: a housekeeping fault is counted and passed to onError; the request still answers`, (t) => {
    const errors: unknown[] = [];
    let failing = false;
    const inner = makeStore(kind);
    const store: ServerStore = new Proxy(inner, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return <T>(fn: (tx: StoreTx) => T) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(x, p, r) {
                  if (p === "tombsBefore" && failing)
                    return () => {
                      throw new Error("disk");
                    };
                  const v = Reflect.get(x, p, r);
                  return typeof v === "function" ? v.bind(x) : v;
                },
              }),
            ),
          );
      },
    });
    const { w, open } = cast(t, kind, 1, { store, onError: (e) => void errors.push(e) });
    failing = true;
    w.clock.advance(2000);
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
    t.true(w.server.housekeepingFaults >= 1);
    t.is(errors.length, w.server.housekeepingFaults);
    t.is((errors[0] as Error).message, "disk");
  });

  test(`${kind}: resetTime lets server time follow a clock that jumped ahead and came back`, (t) => {
    const { w, open } = cast(t, kind);
    w.clock.advance(DAY);
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
    w.clock.advance(-DAY);
    // server time stays a day ahead: a write on the right clock is CLOCK_SKEW
    refused(
      t,
      w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }),
      "CLOCK_SKEW",
    );
    t.is(w.server.resetTime(), w.clock.now());
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
  });

  // ---- reviewer B, findings 2 and 8a: CONFLICT in place of EXPIRED

  test(`${kind}: B2, B8a: a write sent again after its answer expired is CONFLICT when its id exists, EXPIRED when not`, (t) => {
    const { w, open } = cast(t, kind);
    const id = w.id();
    const e = w.envelope("mel", "threads.create", { id, space: open, kind: "post", q: "once" });
    ok(t, w.server.apply({ u: "mel" }, e));
    w.clock.advance(8 * DAY);
    // the same input under a new mutation id (Send again), its id 8 days old
    const again = w.server.apply(
      { u: "mel" },
      w.envelope("mel", "threads.create", { id, space: open, kind: "post", q: "once" }),
    );
    refused(t, again, "CONFLICT");
    // the same envelope (its mutation id 8 days old, its answer gone)
    const same = w.server.apply(
      { u: "mel" },
      { ...e, seq: w.nextSeq("mel"), clientTime: w.clock.now() },
    );
    refused(t, same, "CONFLICT");
    // an id never used: EXPIRED
    const fresh = w.server.apply(
      { u: "mel" },
      w.envelope("mel", "threads.create", {
        id: w.id(-5 * DAY),
        space: open,
        kind: "post",
        q: "never",
      }),
    );
    refused(t, fresh, "EXPIRED");
    t.is(
      [...w.server.records().values()].filter((r) => r.kind === "thread" && (r as Any).q === "once")
        .length,
      1,
    );
  });

  // ---- reviewer B, finding 1: a replay names the mutation id it was recorded under

  test(`${kind}: B1: a replayed answer carries recordedAs, the mutation id the write was processed under`, (t) => {
    const { w, open } = cast(t, kind);
    const e = w.envelope("mel", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "p",
    });
    const first = w.server.apply({ u: "mel" }, e);
    t.true(first.ok);
    t.is(first.recordedAs, undefined, "a fresh answer");
    const again = w.server.apply({ u: "mel" }, { ...e, seq: w.nextSeq("mel") });
    t.true(again.replayed);
    t.is(again.recordedAs, e.mutationId);
    // a remint that replaces it: the original's id
    const remint = w.server.apply(
      { u: "mel" },
      { ...e, seq: w.nextSeq("mel"), mutationId: w.id(), replaces: [e.mutationId] },
    );
    t.true(remint.replayed);
    t.is(remint.recordedAs, e.mutationId);
    // a remint processed first, then a late copy of the original: the
    // remint's id, from which the server derived the run's id
    const o = w.envelope("mel", "followups.ask", {
      id: w.id(),
      thread: ask(w, "otto", open, "q").th,
      q: "f",
    });
    const remintId = w.id();
    const r2 = w.server.apply(
      { u: "mel" },
      { ...o, mutationId: remintId, replaces: [o.mutationId] },
    );
    t.true(r2.ok);
    const late = w.server.apply({ u: "mel" }, { ...o, seq: w.nextSeq("mel") });
    t.true(late.replayed);
    t.is(late.recordedAs, remintId);
    t.deepEqual(late.ok && late.result, r2.ok && r2.result);
  });

  // ---- reviewer B, finding 6: summaries name withheld rows' threads

  test(`${kind}: B6: a tiered pull lists a summary thread whose rows it withheld`, (t) => {
    const { w, open } = cast(t, kind);
    const { th } = ask(w, "otto", open, "old thread");
    const f = fork(w, "otto", th, null, "a follow-up");
    w.server.finishJob(`followup:${f.fu}`, "its answer");
    w.clock.advance(40 * DAY);
    for (let k = 0; k < 210; k++)
      ok(t, w.as("olga", "threads.create", { id: w.id(), space: open, kind: "post", q: `p${k}` }));
    const o = { tier: { window: "phone" as const } };
    const s = w.server.snapshot({ u: "mel" }, `space:${open}`, o);
    t.true(s.summaries?.includes(th));
    // only the follow-up changes: its row is withheld, its thread listed
    ok(t, decide(w, `f:${th}:${f.fu}`, "hidden"));
    const p = w.server.pull({ u: "mel" }, `space:${open}`, s.cursor, o) as Any;
    t.false(p.changes.some((c: Any) => c.key === `followup:${f.fu}`));
    t.deepEqual(p.summaries, [th]);
  });

  test(`${kind}: tier.opened pins at most ${OPENED_MAX} threads`, (t) => {
    const { w, open } = cast(t, kind);
    const old: string[] = [];
    for (let k = 0; k < 3; k++) old.push(ask(w, "otto", open, `old ${k}`).th);
    w.clock.advance(40 * DAY);
    for (let k = 0; k < 205; k++)
      ok(t, w.as("olga", "threads.create", { id: w.id(), space: open, kind: "post", q: `p${k}` }));
    const filler = Array.from({ length: OPENED_MAX }, () => w.id());
    const s = (opened: string[]) =>
      w.server.snapshot({ u: "mel" }, `space:${open}`, { tier: { window: "phone", opened } });
    t.false(s([old[0] as string]).summaries?.includes(old[0] as string));
    const capped = s([...filler, old[0] as string]);
    t.true(capped.summaries?.includes(old[0] as string), "past the cap: a summary");
  });

  // ---- reviewer B, finding 7: lastSeq names the client's person only

  test(`${kind}: B7: a read with a client id answers lastSeq null unless the reader is that client's person`, (t) => {
    const { w, open } = cast(t, kind);
    const id = w.clientId("mel");
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
    t.is(
      typeof w.server.snapshot({ u: "mel" }, `space:${open}`, { clientId: id }).lastSeq,
      "number",
    );
    t.is(w.server.snapshot({ u: "otto" }, `space:${open}`, { clientId: id }).lastSeq, null);
    const s = w.server.snapshot(null, `space:${open}`, { clientId: id });
    t.is(s.lastSeq, null, "a session that ended reads as no actor");
    const p = w.server.pull(null, `space:${open}`, s.cursor, { clientId: id }) as Any;
    t.is(p.lastSeq, null);
  });
}

// ---- G4: a cursor served at a head the database has not reached

test("G4: a cursor served after the backup a database was restored from answers resync", (t) => {
  const keys = { current: newCursorKey() };
  const db = new BetterSqlite(":memory:");
  const { w, open } = cast(t, "sqlite", 1, { store: new SqliteServerStore(db), cursorKeys: keys });
  const backup = db.serialize();
  for (let k = 0; k < 5; k++)
    ok(t, w.as("olga", "threads.create", { id: w.id(), space: open, kind: "post", q: `l${k}` }));
  const cursor = w.server.snapshot({ u: "olga" }, `space:${open}`).cursor;
  // the restored database: the same instance id, an earlier head
  const restored = new SyncServer({
    store: new SqliteServerStore(new BetterSqlite(backup)),
    clock: w.clock,
    cursorKeys: keys,
  });
  const r = restored.register({ u: "olga" });
  if (!r.ok) return t.fail(JSON.stringify(r));
  const a = restored.apply(
    { u: "olga" },
    {
      ...w.envelope("olga", "threads.create", {
        id: w.id(),
        space: open,
        kind: "post",
        q: "after",
      }),
      clientId: r.clientId,
      seq: 1,
    },
  );
  t.true(a.ok, JSON.stringify(a));
  t.true("resync" in restored.pull({ u: "olga" }, `space:${open}`, cursor));
});
