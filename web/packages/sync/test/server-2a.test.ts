// Phase 2a additions to the server half, over both stores:
// - a device's `runs.turn` is stored as a `turn` record (report-1b finding
//   6), redacted with the run's node and erased with its run;
// - the job API a server job runner uses (`runJobs`: start, turn, delta,
//   finish, fail, interrupt);
// - the run controls `research.cancelNode` and `research.retryNode`, and
//   `apiKeys.*` with a key vault and the `key` check job (finding 7);
// - `afterCommit` and the runner's `cancel` hook.

import test from "ava";

import {
  MemoryKeyVault,
  openStream,
  type CallAnswer,
  type JobRunner,
} from "../src/server/index.js";

import { STORES, cast, ok, type World } from "./helpers.js";

const okCall = (t: { fail(m: string): void }, a: CallAnswer): unknown => {
  if (!a.ok) t.fail(`expected ok, got ${JSON.stringify(a.error)}`);
  return a.ok ? a.result : undefined;
};
const code = (a: CallAnswer) => (a.ok ? "ok" : a.error.code);

/** A signed-in device of `u`'s. */
function device(t: { fail(m: string): void }, w: World, u: string) {
  const a = okCall(t, w.server.call(null, "devices.authorize", { name: `${u}'s Mac` })) as {
    request: string;
  };
  okCall(t, w.server.call({ u }, "devices.approve", { request: a.request }));
  const c = okCall(t, w.server.call(null, "devices.token", { request: a.request })) as {
    device: string;
  };
  return { id: c.device, as: { u, device: c.device } };
}

const ask = (t: { fail(m: string): void }, w: World, u: string, space: string, extra = {}) => {
  const id = w.id();
  const r = ok(
    t as never,
    w.as(u, "threads.create", { id, space, kind: "ask", q: "What changed?", ...extra }),
  ) as { run: string };
  return { th: id, run: r.run };
};

/** The events a stream sent so far. */
function events(w: World, u: string | null, log: string) {
  const s = w.server.snapshot(u === null ? null : { u }, log as never);
  const ac = new AbortController();
  const stream = openStream(
    w.server,
    u === null ? null : { u },
    { [log]: "cursor" in s ? s.cursor : "" },
    ac.signal,
    {
      setInterval: () => 0,
      clearInterval: () => {},
    },
  );
  const reader = stream.getReader();
  let text = "";
  const pump = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      text += new TextDecoder().decode(r.value);
    }
  })();
  return {
    runs: async () => {
      await new Promise((r) => setTimeout(r, 0));
      return [...text.matchAll(/event: run\ndata: (.*)\n\n/g)].map(
        (m) => JSON.parse(m[1] ?? "{}") as { text: string; seq: number },
      );
    },
    close: async () => {
      ac.abort();
      await pump;
    },
  };
}

for (const kind of STORES) {
  test(`${kind}: runs.turn stores a turn record, read as the run's node is, erased with the run`, (t) => {
    const { w, open } = cast(t, kind);
    const d = device(t, w, "mel");
    const { th, run } = ask(t, w, "mel", open, {
      executor: { kind: "device", cli: "claude", device: d.id },
    });
    okCall(t, w.server.call(d.as, "runs.claim", { run, device: d.id }));
    okCall(t, w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: "MK-T1" }));
    okCall(
      t,
      w.server.call(d.as, "runs.turn", { run, device: d.id, attempt: 1, turn: { t: "MK-T2" } }),
    );
    t.like(w.get(`turn:${run}:1`), { kind: "turn", run, th, n: 1, body: "MK-T1", u: "mel" });
    t.like(w.get(`turn:${run}:2`), { n: 2, body: { t: "MK-T2" } });
    // in the space's log: a signed-out reader pulls them
    const snap = w.server.snapshot(null, `space:${open}`);
    t.deepEqual(
      snap.records.filter((r) => r.record.kind === "turn").map((r) => r.key),
      [`turn:${run}:1`, `turn:${run}:2`],
    );
    // a hidden ask: its turns read as null for everyone but mel and mona
    ok(
      t,
      w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "hidden", base: { rev: 0 } }),
    );
    const body = (u: string | null) =>
      (w.server.viewOf(`turn:${run}:1`, u) as { body: unknown } | null)?.body;
    t.is(body(null), null);
    t.is(body("otto"), null);
    t.is(body("mel"), "MK-T1");
    t.is(body("mona"), "MK-T1");
    // the hide wrote a log row for the turns: a reader that pulls gets them blanked
    const p = w.server.pull(null, `space:${open}`, snap.cursor);
    t.true(
      "changes" in p &&
        p.changes.some(
          (c) =>
            c.key === `turn:${run}:1` &&
            c.op === "put" &&
            (c.record as { body: unknown }).body === null,
        ),
    );
    // a removal erases them at rest
    ok(t, w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
    w.server.housekeepAll();
    t.false(JSON.stringify(w.server.store.dump()).includes("MK-T"));
  });

  test(`${kind}: a server job starts, stores turns, sends deltas to the node's readers and finishes`, async (t) => {
    const { w, open } = cast(t, kind);
    const { th, run } = ask(t, w, "mel", open);
    w.server.work();
    t.deepEqual(w.jobs, [{ kind: "run", id: run }]);
    const s = w.server.runJobs.start(run, "session");
    if (!s.ok) return t.fail(s.why);
    t.is(s.job.q, "What changed?");
    t.deepEqual(s.job.history, []);
    t.false(s.job.resumed);
    t.like(w.get(`run:${run}`), { status: "running", pay: "session" });
    const listen = events(w, null, `space:${open}`);
    t.true(w.server.runJobs.delta(run, 1, 1, "partial"));
    t.is(w.server.runJobs.turn(run, 1, { text: "turn one" }), 1);
    t.true(w.server.runJobs.finish(run, 1, "The answer.", 42));
    t.like(w.get(`run:${run}`), { status: "complete", end: null });
    t.like(w.get(`thread:${th}`), { sum: "The answer.", running: false, tok: 42 });
    t.deepEqual(
      (await listen.runs()).map((e) => [e.seq, e.text]),
      [[1, "partial"]],
    );
    await listen.close();
    // a finished run takes no more writes
    t.false(w.server.runJobs.delta(run, 1, 2, "late"));
    t.is(w.server.runJobs.turn(run, 1, "late"), null);
    t.false(w.server.runJobs.finish(run, 1, "late"));
    t.deepEqual(w.server.runJobs.start(run), { ok: false, why: "done" });
    // a follow-up's job reads the branch above it
    const fu = w.id();
    const r = ok(t, w.as("otto", "followups.ask", { id: fu, thread: th, q: "And then?" })) as {
      run: string;
    };
    const s2 = w.server.runJobs.start(r.run);
    if (!s2.ok) return t.fail(s2.why);
    t.is(s2.job.q, "And then?");
    t.deepEqual(s2.job.history, [{ q: "What changed?", a: "The answer." }]);
    t.true(w.server.runJobs.finish(r.run, 1, "Then this."));
    t.like(w.get(`followup:${fu}`), { a: "Then this." });
  });

  test(`${kind}: a job's start ends a run whose person lost access, and resumes a running one`, (t) => {
    const { w, open, closed } = cast(t, kind);
    const { run } = ask(t, w, "mel", closed);
    ok(t, w.as("mel", "spaces.leave", { space: closed }));
    t.deepEqual(w.server.runJobs.start(run), { ok: false, why: "access" });
    t.like(w.get(`run:${run}`), { status: "failed", end: "access" });
    const { th, run: r2 } = ask(t, w, "mel", open);
    const a = w.server.runJobs.start(r2);
    t.true(a.ok);
    t.is(w.server.runJobs.turn(r2, 1, "kept"), 1);
    const b = w.server.runJobs.start(r2);
    if (!b.ok) return t.fail(b.why);
    t.true(b.job.resumed);
    t.deepEqual(b.job.turns, ["kept"]);
    t.true(w.server.runJobs.interrupt(r2));
    t.like(w.get(`run:${r2}`), { status: "failed", end: "interrupted" });
    t.like(w.get(`thread:${th}`), { running: false });
    // a failure ends the run with its reason
    const { run: r3 } = ask(t, w, "mel", open);
    w.server.runJobs.start(r3);
    t.true(w.server.runJobs.fail(r3, 1, "tokens"));
    t.like(w.get(`run:${r3}`), { status: "failed", end: "tokens" });
  });

  test(`${kind}: research.cancelNode stops a run, tells the runner after the call commits; retryNode runs the ask again`, (t) => {
    const cancelled: string[] = [];
    const jobs: { kind: string; id: string }[] = [];
    const runner: JobRunner = {
      start: (j) => void jobs.push(j),
      cancel: (r) => void cancelled.push(r),
    };
    const { w, open } = cast(t, kind, 1, { jobs: runner });
    const { th, run } = ask(t, w, "mel", open);
    w.server.runJobs.start(run);
    t.is(
      code(w.server.call({ u: "otto" }, "research.cancelNode", { thread: th, node: "r" })),
      "FORBIDDEN",
    );
    okCall(t, w.server.call({ u: "mel" }, "research.cancelNode", { thread: th, node: "r" }));
    t.deepEqual(cancelled, [run]);
    t.like(w.get(`run:${run}`), { status: "cancelled", end: "stopped" });
    t.like(w.get(`thread:${th}`), { running: false });
    t.false(w.server.runJobs.finish(run, 1, "late"), "a cancelled run takes no answer");
    t.is(
      code(w.server.call({ u: "mel" }, "research.cancelNode", { thread: th, node: "r" })),
      "PRECONDITION_FAILED",
    );
    // run again: a new run at the next attempt, queued as a job
    okCall(t, w.server.call({ u: "mel" }, "research.retryNode", { thread: th, node: "r" }));
    const t2 = w.get(`thread:${th}`) as { att: number; running: boolean; sum: string | null };
    t.like(t2, { att: 2, running: true, sum: null });
    t.is(
      code(w.server.call({ u: "mel" }, "research.retryNode", { thread: th, node: "r" })),
      "PRECONDITION_FAILED",
      "not while it runs",
    );
    w.server.work();
    const again = jobs.find((j) => j.id !== run);
    if (!again) return t.fail("no job for the new run");
    t.like(w.get(`run:${again.id}`), { attempt: 2, status: "queued", node: "r" });
    const s = w.server.runJobs.start(again.id);
    t.true(s.ok);
    t.true(w.server.runJobs.finish(again.id, 2, "Second answer."));
    t.like(w.get(`thread:${th}`), { sum: "Second answer.", running: false });
    // another person's key pays for nothing
    t.is(
      code(
        w.server.call({ u: "mel" }, "research.retryNode", { thread: th, node: "r", pay: "K-OTTO" }),
      ),
      "NOT_FOUND",
    );
  });

  test(`${kind}: apiKeys.*: the raw key goes to the vault, the record holds id, name, provider, status and cap`, (t) => {
    const vault = new MemoryKeyVault();
    const { w } = cast(t, kind, 1, { keys: vault });
    const raw = "sk-ant-MK-RAW-KEY-1234";
    const c = okCall(
      t,
      w.server.call({ u: "mel" }, "apiKeys.create", { raw, label: "", cap: 5000, check: true }),
    ) as { id: string };
    const k = w.get(`apikey:${c.id}`);
    t.deepEqual(k, {
      kind: "apikey",
      id: c.id,
      u: "mel",
      name: "API key 1",
      provider: "Anthropic",
      status: "checking",
      cap: 5000,
      rev: 1,
    });
    t.false(
      JSON.stringify(w.server.store.dump()).includes("MK-RAW"),
      "no raw key in the sync store",
    );
    t.is(vault.keys.get(c.id)?.raw, raw);
    t.is(code(w.server.call({ u: "mel" }, "apiKeys.create", { raw, label: "again" })), "CONFLICT");
    t.is(
      code(w.server.call({ u: "otto" }, "apiKeys.rename", { id: c.id, label: "x" })),
      "NOT_FOUND",
    );
    // the check is a job; its verdict writes the status
    w.server.work();
    t.true(w.jobs.some((j) => j.kind === "key" && j.id === c.id));
    t.true(w.server.keyChecked(c.id, false));
    t.like(w.get(`apikey:${c.id}`), { status: "invalid" });
    t.false(w.server.keyChecked(c.id, true), "no check waits");
    okCall(t, w.server.call({ u: "mel" }, "apiKeys.check", { id: c.id }));
    t.like(w.get(`apikey:${c.id}`), { status: "checking" });
    okCall(t, w.server.call({ u: "mel" }, "apiKeys.rename", { id: c.id, label: "Work" }));
    okCall(t, w.server.call({ u: "mel" }, "apiKeys.setCap", { id: c.id, cap: 0 }));
    okCall(
      t,
      w.server.call({ u: "mel" }, "apiKeys.replace", { id: c.id, raw: "sk-or-OTHER-KEY-99" }),
    );
    t.like(w.get(`apikey:${c.id}`), { name: "Work", cap: 0, provider: "OpenRouter" });
    okCall(t, w.server.call({ u: "mel" }, "apiKeys.revoke", { id: c.id }));
    t.is(w.get(`apikey:${c.id}`), undefined);
    t.false(vault.keys.has(c.id));
  });

  test(`${kind}: a stream pulls only for a commit with a row its reader may read (report-1b finding 1)`, async (t) => {
    const { w, closed } = cast(t, kind);
    const s = w.server.snapshot({ u: "otto" }, `space:${closed}`);
    const ac = new AbortController();
    const stream = openStream(
      w.server,
      { u: "otto" },
      { [`space:${closed}`]: s.cursor },
      ac.signal,
      { setInterval: () => 0, clearInterval: () => {} },
    );
    const reader = stream.getReader();
    let text = "";
    const pump = (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
    })();
    await new Promise((r) => setTimeout(r, 0));
    const pulls: string[] = [];
    const real = w.server.pull.bind(w.server);
    w.server.pull = ((...a: Parameters<typeof real>) => {
      pulls.push(a[1]);
      return real(...a);
    }) as typeof w.server.pull;
    // a member's thread in the closed space: otto (no member) reads none of it
    ok(t, w.as("mel", "threads.create", { id: w.id(), space: closed, kind: "post", q: "MEMBERS" }));
    await new Promise((r) => setTimeout(r, 0));
    t.deepEqual(pulls, [], "no pull for a commit otto reads nothing of");
    // otto's own join request is in the space's log, and his: a pull and a poke
    ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
    await new Promise((r) => setTimeout(r, 0));
    t.deepEqual(pulls, [`space:${closed}`]);
    t.regex(text, /event: poke/);
    // the space opening replaces the log's history: pulled whatever its rows
    ok(
      t,
      w.as("olga", "spaces.update", {
        id: closed,
        set: { vis: "open" },
        base: { rulesRev: 0 },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    t.is(pulls.length, 2);
    ac.abort();
    await pump;
  });
}
