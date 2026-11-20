// The server half's rules from review round 1 of phase 2, over both stores:
// server runs end on a ban, a removal or an archive, and a job's calls
// check access (reviewer A, F3); the queued runs limit (F5); an admin-only
// model on the included tokens (F1); a device sign-in approved with one
// click only from the address that asked for it (reviewer B, F1).

import test from "ava";

import type { CallAnswer } from "../src/server/index.js";

import { STORES, cast, ok, refused, turnOf, type World } from "./helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment --
   records and call results are read as `any` */
type Any = any;

const code = (a: CallAnswer) => (a.ok ? "ok" : a.error.code);
const get = (w: World, key: string) => w.get(key) as Any;

function ask(w: World, u: string, space: string, extra: object = {}) {
  const id = w.id();
  const a = w.as(u, "threads.create", { id, space, kind: "ask", q: "Q?", ...extra });
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  return { th: id, run: (a.result as { run: string }).run };
}

for (const kind of STORES) {
  test(`${kind}: F3: a ban, a removal and an archive end server runs and tell the runner after the commit`, (t) => {
    const cancelled: string[] = [];
    const { w, open, closed } = cast(t, kind, 1, {
      jobs: { start: () => {}, cancel: (r) => void cancelled.push(r) },
    });
    const banned = ask(w, "otto", open);
    const queued = ask(w, "mel", closed);
    const kept = ask(w, "mel", open);
    t.true(w.server.runJobs.start(banned.run).ok);
    ok(t, w.as("olga", "members.ban", { space: open, user: "otto" }));
    t.like(get(w, `run:${banned.run}`), { status: "failed", end: "access" });
    t.false(get(w, `thread:${banned.th}`).running);
    t.deepEqual(cancelled, [banned.run]);
    // a removal from the closed space: the queued run ends too
    const m = get(w, `member:${closed}:mel`);
    ok(t, w.as("olga", "members.remove", { space: closed, user: "mel", base: { adm: m.adm } }));
    t.like(get(w, `run:${queued.run}`), { status: "failed", end: "access" });
    t.deepEqual(cancelled, [banned.run, queued.run]);
    t.like(get(w, `run:${kept.run}`), { status: "queued" }, "another space's run goes on");
    // an archive ends every live run of the space
    t.true(w.server.runJobs.start(kept.run).ok);
    ok(t, w.as("olga", "spaces.archive", { id: open, archived: true }));
    t.like(get(w, `run:${kept.run}`), { status: "failed", end: "interrupted" });
    t.deepEqual(cancelled, [banned.run, queued.run, kept.run]);
    // nothing more lands
    t.is(w.server.runJobs.turn(kept.run, 1, turnOf("late")), null);
    t.false(w.server.runJobs.finish(kept.run, 1, "late"));
  });

  test(`${kind}: F3: a job's calls end a run whose person lost access or whose space was archived`, (t) => {
    const { w, open } = cast(t, kind);
    const commit = (key: string, rec: unknown) =>
      w.server.run((tx) => w.server.commit(tx, [[key, rec as never]], w.server.time(tx)));
    // a ban the job hears of first
    const a = ask(w, "mel", open);
    t.true(w.server.runJobs.start(a.run).ok);
    commit(`ban:${open}:mel`, { kind: "ban", id: `${open}:mel`, sp: open, u: "mel", createdAt: "2026-01-01T00:00:00Z" });
    t.like(get(w, `run:${a.run}`), { status: "running" });
    t.false(w.server.runJobs.delta(a.run, 1, 1, "x"));
    t.like(get(w, `run:${a.run}`), { status: "failed", end: "access" });
    t.false(get(w, `thread:${a.th}`).running);
    commit(`ban:${open}:mel`, null);
    // each call checks: turn, finish, fail and holds
    for (const call of ["turn", "finish", "fail", "holds"] as const) {
      const b = ask(w, "mel", open);
      t.true(w.server.runJobs.start(b.run).ok);
      const s = get(w, `space:${open}`);
      commit(`space:${open}`, { ...s, archived: true });
      const jobs = w.server.runJobs;
      const r =
        call === "turn"
          ? jobs.turn(b.run, 1, turnOf("x"))
          : call === "finish"
            ? jobs.finish(b.run, 1, "x")
            : call === "fail"
              ? jobs.fail(b.run, 1, "tokens")
              : jobs.holds(b.run, 1);
      t.true(r === null || r === false, call);
      t.like(get(w, `run:${b.run}`), { status: "failed", end: "interrupted" }, call);
      t.is(get(w, `thread:${b.th}`).sum, null, call);
      commit(`space:${open}`, { ...get(w, `space:${open}`), archived: false });
    }
  });

  test(`${kind}: a run that ends for its payer keeps the tokens it used on its thread`, (t) => {
    const { w, open } = cast(t, kind);
    const a = ask(w, "mel", open);
    t.true(w.server.runJobs.start(a.run).ok);
    t.true(w.server.runJobs.fail(a.run, 1, "tokens", 940));
    t.like(get(w, `thread:${a.th}`), { running: false, tok: 940, sum: null });
    const b = ask(w, "mel", open);
    t.true(w.server.runJobs.start(b.run).ok);
    t.true(w.server.runJobs.fail(b.run, 1, "rate"));
    t.like(get(w, `thread:${b.th}`), { running: false, tok: 0 });
  });

  test(`${kind}: F5: the queued runs limit counts a person's queued and running server runs`, (t) => {
    const { w, open } = cast(t, kind, 1, { queuedRunsPerUser: 2 });
    const a = ask(w, "mel", open);
    const second = ask(w, "mel", open);
    const third = w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "3" });
    refused(t, third, "TOO_MANY_REQUESTS");
    t.false(third.ok && "seq" in third, "unrecorded");
    // a post, and another person's ask, are not counted
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "post", q: "p" }));
    ask(w, "otto", open);
    // a running run counts; one that ended does not
    t.true(w.server.runJobs.start(a.run).ok);
    refused(t, w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "4" }), "TOO_MANY_REQUESTS");
    t.true(w.server.runJobs.fail(a.run, 1, "rate"));
    ask(w, "mel", open);
    // Run again of an ask whose run is live replaces it: the count stays;
    // of one whose run ended, it is one more
    const again = (th: string) =>
      w.as("mel", "threads.update", { id: th, q: "Q?", run: true, base: { rev: get(w, `thread:${th}`).rev } });
    ok(t, again(second.th));
    refused(t, again(a.th), "TOO_MANY_REQUESTS");
    // online: retryNode of a stopped ask
    const b = ask(w, "otto", open);
    ok(t, w.server.call({ u: "otto" }, "research.cancelNode", { thread: b.th, node: "r" }) as never);
    const o = cast(t, kind, 2, { queuedRunsPerUser: 1 });
    const x = ask(o.w, "mel", o.open);
    t.is(code(o.w.server.call({ u: "mel" }, "research.cancelNode", { thread: x.th, node: "r" })), "ok");
    ask(o.w, "mel", o.open);
    t.is(
      code(o.w.server.call({ u: "mel" }, "research.retryNode", { thread: x.th, node: "r" })),
      "TOO_MANY_REQUESTS",
    );
    // a device run is not counted (it has its own limit)
    t.like(get(o.w, `thread:${x.th}`), { running: false });
  });

  test(`${kind}: F1: an admin-only model on the included tokens needs the server's yes`, (t) => {
    const asked: string[] = [];
    const { w, open } = cast(t, kind, 1, {
      includedModel: (u, model) => {
        asked.push(`${u}:${model}`);
        return u === "olga";
      },
    });
    for (const pay of [undefined, "session"])
      refused(
        t,
        w.as("mel", "threads.create", {
          id: w.id(),
          space: open,
          kind: "ask",
          q: "Q?",
          model: "claude-fable",
          ...(pay ? { pay } : {}),
        }),
        "FORBIDDEN",
      );
    const a = ask(w, "olga", open, { model: "claude-fable" });
    t.deepEqual(asked, ["mel:claude-fable", "mel:claude-fable", "olga:claude-fable"]);
    // a model that is not admin-only is not asked about
    ask(w, "mel", open, { model: "gemini-flash" });
    t.is(asked.length, 3);
    // forkNode and a run again that names it
    refused(
      t,
      w.as("mel", "research.forkNode", { id: w.id(), thread: a.th, parent: "r", q: "and?", model: "claude-fable" }),
      "FORBIDDEN",
    );
    const m = ask(w, "mel", open);
    refused(
      t,
      w.as("mel", "threads.update", {
        id: m.th,
        q: "Q?",
        run: true,
        model: "claude-fable",
        base: { rev: get(w, `thread:${m.th}`).rev },
      }),
      "FORBIDDEN",
    );
    t.is(
      code(w.server.call({ u: "mel" }, "research.cancelNode", { thread: m.th, node: "r" })),
      "ok",
    );
    t.is(
      code(
        w.server.call({ u: "mel" }, "research.retryNode", {
          thread: m.th,
          node: "r",
          model: "claude-fable",
        }),
      ),
      "FORBIDDEN",
    );
    // a server with no answer refuses it for everyone
    const o = cast(t, kind, 2);
    refused(
      t,
      o.w.as("olga", "threads.create", { id: o.w.id(), space: o.open, kind: "ask", q: "Q?", model: "claude-fable" }),
      "FORBIDDEN",
    );
  });

  test(`${kind}: device sign-in: one click from the address that asked, else the code`, (t) => {
    const { w } = cast(t, kind);
    const authorize = (ip: string | null) =>
      w.server.call(null, "devices.authorize", { name: "Mac", device: "MacBook Air", app: "Session 1.0" }, { ip }) as Any;
    const approve = (input: object, ip: string | null) =>
      code(w.server.call({ u: "mel" }, "devices.approve", input, { ip }));
    const a = authorize("203.0.113.5");
    t.is(approve({ request: a.result.request }, "198.51.100.9"), "BAD_REQUEST");
    t.is(approve({ request: a.result.request }, null), "BAD_REQUEST");
    t.is(approve({ request: a.result.request, code: "" }, "198.51.100.9"), "BAD_REQUEST");
    t.is(approve({ request: a.result.request, code: "ZZZ-ZZZ" }, "203.0.113.5"), "BAD_REQUEST");
    t.is(approve({ request: a.result.request }, "203.0.113.5"), "ok");
    // no address known when it was asked: the code, from anywhere
    const b = authorize(null);
    t.is(approve({ request: b.result.request }, null), "BAD_REQUEST");
    t.is(approve({ request: b.result.request, code: b.result.code.toLowerCase() }, null), "ok");
    // a deny needs no code
    const c = authorize("203.0.113.5");
    t.is(approve({ request: c.result.request, deny: true }, "198.51.100.9"), "ok");
    // the browser's read
    const d = authorize("203.0.113.5");
    const v = w.server.online.signinView({ u: "mel" }, d.result.request, { ip: "203.0.113.5" });
    if (!v.ok) return t.fail(JSON.stringify(v));
    t.like(v.view, {
      request: d.result.request,
      name: "Mac",
      kind: "mac",
      device: "MacBook Air",
      app: "Session 1.0",
      state: "waiting",
      sameComputer: true,
    });
    t.false(JSON.stringify(v.view).includes(d.result.code.replace("-", "")));
    const far = w.server.online.signinView({ u: "mel" }, d.result.request, { ip: "198.51.100.9" });
    t.like(far, { ok: true, view: { sameComputer: false } });
    t.like(w.server.online.signinView({ u: "mel" }, d.result.request), {
      ok: true,
      view: { sameComputer: false },
    });
    t.like(w.server.online.signinView(null, d.result.request), {
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    t.like(w.server.online.signinView({ u: "mel", device: "D1" }, d.result.request), {
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    t.like(w.server.online.signinView({ u: "mel" }, "nope"), {
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    // approved by someone else: not theirs to read
    t.is(approve({ request: d.result.request }, "203.0.113.5"), "ok");
    t.like(w.server.online.signinView({ u: "otto" }, d.result.request), {
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    t.like(w.server.online.signinView({ u: "mel" }, d.result.request), {
      ok: true,
      view: { state: "approved" },
    });
    // expired
    w.clock.advance(11 * 60_000);
    t.like(w.server.online.signinView({ u: "mel" }, d.result.request), {
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    // a name, a device and an app are bounded
    t.is(
      code(w.server.call(null, "devices.authorize", { name: "Mac", app: "x".repeat(201) })),
      "BAD_REQUEST",
    );
    const long = w.server.call(null, "devices.authorize", {
      name: "n".repeat(200),
      device: ` ${"d".repeat(199)}`,
    }) as Any;
    t.true(long.ok);
    t.like(w.server.online.signinView({ u: "mel" }, long.result.request), {
      ok: true,
      view: { name: "n".repeat(200), device: "d".repeat(199) },
    });
    t.is(code(w.server.call(null, "devices.authorize", { name: "   " })), "BAD_REQUEST");
  });
  test(`${kind}: F6: the write budget: a bucket per person, refilled by time; a clock that goes back refills nothing`, (t) => {
    const { w, open } = cast(t, kind, 1, { writeBudget: { burst: 20, perMinute: 60 } });
    const post = (u: string) =>
      w.as(u, "threads.create", { id: w.id(), space: open, kind: "post", q: "p" });
    // the cast's own writes drew on the buckets: a minute refills them
    w.clock.advance(60_000);
    for (let k = 0; k < 20; k++) ok(t, post("mel"));
    const e = refused(t, post("mel"), "TOO_MANY_REQUESTS");
    t.truthy(e?.retryAt);
    ok(t, post("otto"));
    t.is(code(w.server.call({ u: "mel" }, "settings.update", {})), "TOO_MANY_REQUESTS");
    w.clock.advance(1000);
    ok(t, post("mel"));
    refused(t, post("mel"), "TOO_MANY_REQUESTS");
    w.clock.advance(-60_000);
    refused(t, post("mel"), "TOO_MANY_REQUESTS");
    w.clock.advance(60_000 + 2000);
    ok(t, post("mel"));
    ok(t, post("mel"));
    refused(t, post("mel"), "TOO_MANY_REQUESTS");
    // a full bucket holds no more than its size
    w.clock.advance(10 * 60_000);
    for (let k = 0; k < 20; k++) ok(t, post("mel"));
    refused(t, post("mel"), "TOO_MANY_REQUESTS");
    // no budget: no limit
    const o = cast(t, kind, 2);
    for (let k = 0; k < 50; k++)
      ok(t, o.w.as("mel", "threads.create", { id: o.w.id(), space: o.open, kind: "post", q: "p" }));
  });
}
