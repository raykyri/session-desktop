// Runs and their limits (review round 1 of phase 2, reviewer A's F1 to F5;
// the experiments e01-runs and e02-limits as tests): an admin-only model on
// the included tokens, usage of the steps a run finished whatever its end,
// a ban, a removal or an archive ending server runs, the allowance checked
// between steps, and the queued runs limit.

import { runs as runsRepo, usage } from "@session/db";
import type { RunRec, ThreadRec } from "@session/mutators";
import test from "ava";

import {
  fixtureLookup,
  fixturePageFetch,
  setFixtureScenario,
} from "../src/runs/fixtureProvider.js";

import { createHarness, type Harness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

class Clock {
  ms = Date.now();
  now = () => this.ms;
}

function world(t: Parameters<typeof createHarness>[0], env: Record<string, string> = {}) {
  const clock = new Clock();
  const h = createHarness(t, {
    env,
    sync: { clock },
    fetch: fixturePageFetch,
    runs: { toolOverrides: { lookup: fixtureLookup } },
  });
  const olgaUser = h.addUser("olga", { isAdmin: true });
  const melUser = h.addUser("mel");
  const olga = new HttpClient(h, { cookie: h.signIn(olgaUser) });
  const mel = new HttpClient(h, { cookie: h.signIn(melUser) });
  return { h, clock, olga, mel, melUser, olgaUser };
}

async function openSpace(olga: HttpClient, mel: HttpClient) {
  const sp = olga.id();
  await olga.write("spaces.create", { id: sp, name: "lounge" });
  await mel.write("spaces.join", { space: sp });
  return sp;
}

async function drive(h: Harness) {
  for (let k = 0; k < 5; k++) {
    h.deps.sync.work();
    h.deps.runs.tick();
    await h.deps.runs.idle();
  }
}

const rec = (h: Harness, key: string) => h.deps.sync.records().get(key);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ask(c: HttpClient, space: string, extra: Record<string, unknown> = {}) {
  const id = c.id();
  const r = await c.write("threads.create", { id, space, kind: "ask", q: "Q?", ...extra });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  return { th: id, run: (r.body.result as { run: string }).run };
}

async function untilRunning(h: Harness, run: string) {
  for (let k = 0; k < 300 && (rec(h, `run:${run}`) as RunRec).status !== "running"; k++)
    await wait(10);
}

const researchTokens = (h: Harness, run: string) =>
  (
    h.db.$client
      .prepare(
        "SELECT coalesce(sum(input_tokens + output_tokens), 0) AS n FROM usage_events WHERE run_id = ? AND kind = 'research'",
      )
      .get(run) as { n: number }
  ).n;

test.serial(
  "F1: an admin-only model does not run on the included tokens for a person who is not an admin",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const th = mel.id();
    for (const pay of ["session", null]) {
      const r = await mel.write("threads.create", {
        id: mel.id(),
        space: sp,
        kind: "ask",
        q: "Q?",
        model: "claude-fable",
        ...(pay !== null ? { pay } : {}),
      });
      t.like(r.body, { ok: false, error: { code: "FORBIDDEN" } }, `pay ${String(pay)}`);
    }
    // an admin runs it on the included tokens
    const a = await ask(olga, sp, { model: "claude-fable", pay: "session" });
    await drive(h);
    t.like(rec(h, `run:${a.run}`), { status: "complete", pay: "session" });
    // a key of mel's own pays for it
    const k = await mel.call("apiKeys.create", { raw: "sk-ant-MEL-KEY-0001", label: "" });
    const key = (k.body.result as { id: string }).id;
    const paid = await ask(mel, sp, { model: "claude-fable", pay: key });
    await drive(h);
    t.like(rec(h, `run:${paid.run}`), { status: "complete", pay: key });
    // Run again with the included tokens: refused online, and a run again
    // that keeps the model (no model named) ends when its job starts
    t.like(
      (await mel.call("research.retryNode", { thread: paid.th, node: "r", pay: "session" })).body,
      { ok: false, error: { code: "FORBIDDEN" } },
    );
    t.like(
      (
        await mel.call("research.retryNode", {
          thread: paid.th,
          node: "r",
          pay: "session",
          model: "claude-fable",
        })
      ).body,
      { ok: false, error: { code: "FORBIDDEN" } },
    );
    const base = (rec(h, `thread:${paid.th}`) as ThreadRec).rev;
    const named = await mel.write("threads.update", {
      id: paid.th,
      q: "Q?",
      run: true,
      model: "claude-fable",
      pay: "session",
      base: { rev: base },
    });
    t.like(named.body, { ok: false, error: { code: "FORBIDDEN" } });
    const again = await mel.write("threads.update", {
      id: paid.th,
      q: "Q?",
      run: true,
      pay: "session",
      base: { rev: base },
    });
    t.true(again.body.ok);
    await drive(h);
    const run = (again.body.result as { run: string }).run;
    t.like(rec(h, `run:${run}`), { status: "failed", end: "tokens" });
    t.is(researchTokens(h, run), 0, "the provider was not called");
    void th;
  },
);

test.serial(
  "F2: a stopped run records the tokens of the steps it finished, and so does one that times out",
  async (t) => {
    // two tool steps (900+40 and 1400+20 tokens), then an answer that
    // streams until it is stopped
    let call = 0;
    setFixtureScenario(() => (++call <= 2 ? "success-with-tools" : "paced-answer"));
    const { h, olga, mel, melUser } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await ask(mel, sp);
    h.deps.sync.work();
    h.deps.runs.tick();
    await untilRunning(h, run);
    for (let k = 0; k < 300 && researchTokens(h, run) < 2360; k++) await wait(10);
    t.like((await mel.call("research.cancelNode", { thread: th, node: "r" })).body, { ok: true });
    await h.deps.runs.idle();
    t.like(rec(h, `run:${run}`), { status: "cancelled", end: "stopped" });
    t.is(researchTokens(h, run), 2360);
    t.is(usage.weeklyUsed(h.db, melUser.id, "session"), 2360);
    t.like(runsRepo.attempts(h.db, run)[0], {
      outcome: "cancelled",
      steps: 2,
      usageJson: { inputTokens: 2300, outputTokens: 60 },
    });
    t.true((runsRepo.attempts(h.db, run)[0]?.costEstimateMicros ?? 0) > 0);
  },
);

test.serial("F2: a run that times out after a tool step records that step", async (t) => {
  let call = 0;
  setFixtureScenario(() => (++call <= 1 ? "success-with-tools" : "timeout"));
  const { h, olga, mel } = world(t, { SESSION_RUN_TIMEOUT_SECONDS: "1" });
  const sp = await openSpace(olga, mel);
  const { run } = await ask(mel, sp);
  await drive(h);
  t.like(rec(h, `run:${run}`), { status: "failed", end: "interrupted" });
  t.is(researchTokens(h, run), 940);
});

test.serial(
  "F3: after a ban a server run takes no turn, no text and no answer, and has ended `access`",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await ask(mel, sp);
    h.deps.sync.work(); // queued in run_queue, not started yet
    const job = h.deps.sync.runJobs.start(run, "session");
    t.true(job.ok);
    t.like((await olga.write("members.ban", { space: sp, user: "mel" })).body, { ok: true });
    t.like(rec(h, `run:${run}`), { status: "failed", end: "access" });
    t.is(
      h.deps.sync.runJobs.turn(run, 1, {
        id: "t1",
        agentId: run,
        role: "assistant",
        blocks: [{ type: "text", text: "after the ban" }],
        sourceIndex: 0,
      }),
      null,
    );
    t.false(h.deps.sync.runJobs.delta(run, 1, 1, "text"));
    t.false(h.deps.sync.runJobs.finish(run, 1, "ANSWER AFTER THE BAN", 10));
    const guest = new HttpClient(h, null);
    const snap = await guest.snapshot(`space:${sp}`);
    const thr = (snap.body["records"] as { key: string; record: ThreadRec }[]).find(
      (r) => r.key === `thread:${th}`,
    );
    t.like(thr?.record, { sum: null, running: false });
  },
);

test.serial("F3: the job's checks end a run whose person lost access", async (t) => {
  // the access change committed without ending the run (a path that does
  // not call accessChanged): the next call of the job ends it
  setFixtureScenario("success");
  const { h, olga, mel } = world(t);
  const sp = await openSpace(olga, mel);
  const { run } = await ask(mel, sp);
  h.deps.sync.work();
  t.true(h.deps.sync.runJobs.start(run, "session").ok);
  h.deps.sync.run((tx) => {
    const ban = {
      kind: "ban" as const,
      id: `${sp}:mel`,
      sp,
      u: "mel",
      createdAt: "2026-01-01T00:00:00Z",
    };
    h.deps.sync.commit(tx, [[`ban:${sp}:mel`, ban]], h.deps.sync.time(tx));
  });
  t.like(rec(h, `run:${run}`), { status: "running" });
  t.false(h.deps.sync.runJobs.holds(run, 1));
  t.like(rec(h, `run:${run}`), { status: "failed", end: "access" });
});

for (const [name, act, end] of [
  ["a ban", "ban", "access"],
  ["archiving the space", "archive", "interrupted"],
] as const)
  test.serial(`F3: ${name} while the run streams stops the loop; no answer lands`, async (t) => {
    setFixtureScenario("slow-stream");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await ask(mel, sp);
    h.deps.sync.work();
    h.deps.runs.tick();
    await untilRunning(h, run);
    const w =
      act === "ban"
        ? await olga.write("members.ban", { space: sp, user: "mel" })
        : await olga.write("spaces.archive", { id: sp, archived: true });
    t.like(w.body, { ok: true });
    t.like(rec(h, `run:${run}`), { status: "failed", end });
    await h.deps.runs.idle();
    t.like(rec(h, `run:${run}`), { status: "failed", end });
    t.like(rec(h, `thread:${th}`), { sum: null, running: false });
    t.like(runsRepo.attempts(h.db, run)[0], { outcome: "cancelled" });
    t.is(runsRepo.get(h.db, run), null, "released from the queue");
  });

test.serial(
  "F4: the weekly allowance is checked between steps: a run ends `tokens` once it is used up",
  async (t) => {
    setFixtureScenario("success-with-tools");
    const { h, olga, mel, melUser } = world(t, { SESSION_INCLUDED_TOKENS: "1000" });
    const sp = await openSpace(olga, mel);
    usage.record(h.db, melUser.id, {
      payer: "session",
      spaceId: sp,
      kind: "research",
      provider: "x",
      inputTokens: 900,
    });
    const a = await ask(mel, sp);
    const b = await ask(mel, sp);
    await drive(h);
    for (const x of [a, b]) {
      t.like(rec(h, `run:${x.run}`), { status: "failed", end: "tokens", pay: "session" });
      t.like(rec(h, `thread:${x.th}`), { sum: null, running: false, tok: 940 });
      t.is(researchTokens(h, x.run), 940, "one step, then it stopped");
    }
    t.is(usage.weeklyUsed(h.db, melUser.id, "session"), 900 + 2 * 940);
  },
);

test.serial("F4: a key's monthly cap is checked between steps too", async (t) => {
  setFixtureScenario("success-with-tools");
  const { h, olga, mel } = world(t);
  const sp = await openSpace(olga, mel);
  const k = await mel.call("apiKeys.create", {
    raw: "sk-or-MEL-KEY-0001",
    label: "",
    cap: 1000,
  });
  const key = (k.body.result as { id: string }).id;
  const r = await ask(mel, sp, { model: "deepseek-flash", pay: key });
  await drive(h);
  // 940 after the first step, 2360 after the second: over the cap
  t.like(rec(h, `run:${r.run}`), { status: "failed", end: "tokens", pay: key });
  t.is(researchTokens(h, r.run), 2360);
});

test.serial(
  "F5: SESSION_QUEUED_PER_USER bounds a person's queued and running server runs",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t, { SESSION_QUEUED_PER_USER: "3" });
    const sp = await openSpace(olga, mel);
    const answers = [];
    for (let k = 0; k < 5; k++)
      answers.push(
        await mel.write("threads.create", { id: mel.id(), space: sp, kind: "ask", q: `Q${k}` }),
      );
    t.deepEqual(
      answers.map((a) => (a.body.ok ? true : a.body.error?.code)),
      [true, true, true, "TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS"],
    );
    t.is(answers[3]?.status, 429);
    // a post starts no run; another person's asks are theirs
    t.like(
      (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "post", q: "p" })).body,
      { ok: true },
    );
    t.like(
      (await olga.write("threads.create", { id: olga.id(), space: sp, kind: "ask", q: "o" })).body,
      { ok: true },
    );
    // Run again of one of the three replaces its run: allowed
    const first = answers[0]?.body.result as { id: string };
    t.like((await mel.call("research.cancelNode", { thread: first.id, node: "r" })).body, {
      ok: true,
    });
    t.like((await mel.call("research.retryNode", { thread: first.id, node: "r" })).body, {
      ok: true,
    });
    t.like(
      (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "ask", q: "Q5" })).body,
      { ok: false, error: { code: "TOO_MANY_REQUESTS" } },
    );
    // once they end, asking works again
    await drive(h);
    t.like(
      (await mel.write("threads.create", { id: mel.id(), space: sp, kind: "ask", q: "Q6" })).body,
      { ok: true },
    );
  },
);
