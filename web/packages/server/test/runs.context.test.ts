// A server run's context (review round 1 of phase 2, reviewer A's F7 and
// phase 2a design finding 4; the experiment e02-limits E2b as a test): a
// resumed run continues after its stored turns, and a follow-up's context
// holds the tool calls and results of the answers before it. Review round 2
// of phase 2 (the experiment e03-context as tests): hidden earlier asks stay
// out of another member's run (reviewer A's finding 3); a resumed run's
// thread keeps the tokens of all its attempts (finding 7); and a resumed
// attempt numbers its in-flight events above every one sent before, with a
// gap (reviewer B's finding 6).

import { runs as runsRepo, usage } from "@session/db";
import type { ThreadRec } from "@session/mutators";
import test from "ava";

import {
  fixtureLookup,
  fixturePageFetch,
  setFixtureScenario,
} from "../src/runs/fixtureProvider.js";
import { SEQ_PERSIST_EVERY } from "../src/runs/loop.js";
import { createRunsService } from "../src/runs/service.js";

import { createHarness, type Harness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

function world(t: Parameters<typeof createHarness>[0], env: Record<string, string> = {}) {
  const h = createHarness(t, {
    env,
    fetch: fixturePageFetch,
    runs: { toolOverrides: { lookup: fixtureLookup } },
  });
  const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
  const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
  return { h, olga, mel };
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

async function ask(c: HttpClient, space: string) {
  const id = c.id();
  const r = await c.write("threads.create", { id, space, kind: "ask", q: "Q?" });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  return { th: id, run: (r.body.result as { run: string }).run };
}

/** A provider call's prompt: each message's role, part types and JSON. */
const promptOf = (options: unknown) =>
  (options as { prompt: { role: string; content: unknown }[] }).prompt.map((m) => ({
    role: m.role,
    parts:
      typeof m.content === "string"
        ? ["text"]
        : (m.content as { type: string }[]).map((p) => p.type),
    text: JSON.stringify(m.content),
  }));
type Prompt = ReturnType<typeof promptOf>;

const assistant = (id: string, n: number, blocks: unknown[]) => ({
  id: `${id}-${n}`,
  agentId: id,
  role: "assistant",
  blocks: blocks as never,
  sourceIndex: n,
});

/** A run that the last process claimed and started, then stopped. */
async function interrupted(h: Harness, mel: HttpClient, sp: string) {
  const { th, run } = await ask(mel, sp);
  h.deps.sync.work();
  runsRepo.claim(h.db, run);
  if (!h.deps.sync.runJobs.start(run, "session").ok) throw new Error("not started");
  return { th, run };
}

const nextProcess = (h: Harness) =>
  createRunsService({
    config: h.config,
    db: h.db,
    sync: h.deps.sync,
    keys: h.deps.keys,
    logger: h.logger,
    autoStart: false,
    fetch: fixturePageFetch,
    toolOverrides: { lookup: fixtureLookup },
  });

test.serial(
  "F7: a resumed run continues after its stored turns: the tool call and its result go to the model and are not done again",
  async (t) => {
    const prompts: Prompt[] = [];
    setFixtureScenario((options) => {
      prompts.push(promptOf(options));
      return "success";
    });
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await interrupted(h, mel, sp);
    const jobs = h.deps.sync.runJobs;
    jobs.turn(
      run,
      1,
      assistant(run, 0, [
        { type: "text", text: "Looking it up." },
        {
          type: "toolUse",
          id: "call-1",
          name: "web_fetch",
          input: { url: "https://example.com/a" },
        },
      ]),
    );
    jobs.turn(run, 1, {
      id: `${run}-user-0`,
      agentId: run,
      role: "user",
      blocks: [
        { type: "toolResult", toolUseId: "call-1", content: { text: "PAGE TEXT" }, isError: false },
      ],
      sourceIndex: 1,
    });
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    t.like(rec(h, `run:${run}`), { status: "complete" });
    t.is(prompts.length, 1);
    const p = prompts[0] ?? [];
    t.deepEqual(
      p.map((m) => [m.role, m.parts]),
      [
        ["system", ["text"]],
        ["user", ["text"]],
        ["assistant", ["text", "tool-call"]],
        ["tool", ["tool-result"]],
      ],
    );
    t.regex(p[3]?.text ?? "", /PAGE TEXT/);
    const turns = [...h.deps.sync.records().keys()].filter((k) => k.startsWith(`turn:${run}:`));
    t.deepEqual(turns.sort(), [`turn:${run}:1`, `turn:${run}:2`, `turn:${run}:3`]);
    t.truthy((rec(h, `thread:${th}`) as ThreadRec).sum);
    t.like(runsRepo.attempts(h.db, run)[0], { kind: "resume", outcome: "complete" });
    await next.drain();
  },
);

test.serial(
  "F7: a tool call stored without its result is done again; the call is not given to the model",
  async (t) => {
    const prompts: Prompt[] = [];
    setFixtureScenario((options) => {
      prompts.push(promptOf(options));
      return "success";
    });
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { run } = await interrupted(h, mel, sp);
    h.deps.sync.runJobs.turn(
      run,
      1,
      assistant(run, 0, [{ type: "toolUse", id: "call-1", name: "web_fetch", input: {} }]),
    );
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    t.like(rec(h, `run:${run}`), { status: "complete" });
    t.deepEqual(
      (prompts[0] ?? []).map((m) => m.role),
      ["system", "user"],
    );
    await next.drain();
  },
);

test.serial(
  "F7: a run whose answer turn was stored before the process stopped is finished from it, with no provider call",
  async (t) => {
    let calls = 0;
    setFixtureScenario(() => {
      calls++;
      return "success";
    });
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await interrupted(h, mel, sp);
    h.deps.sync.runJobs.turn(
      run,
      1,
      assistant(run, 0, [{ type: "text", text: "THE STORED ANSWER" }]),
    );
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    t.is(calls, 0);
    t.like(rec(h, `run:${run}`), { status: "complete" });
    t.is((rec(h, `thread:${th}`) as ThreadRec).sum, "THE STORED ANSWER");
    await next.drain();
  },
);

test.serial(
  "design finding 4: a follow-up's context holds the tool calls and results of the answer before it",
  async (t) => {
    const prompts: Prompt[] = [];
    setFixtureScenario((options) => {
      prompts.push(promptOf(options));
      return "success-with-tools";
    });
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th } = await ask(mel, sp);
    await drive(h);
    const sum = (rec(h, `thread:${th}`) as ThreadRec).sum ?? "";
    t.true(sum.length > 0);
    t.like((await mel.write("followups.ask", { id: mel.id(), thread: th, q: "And then?" })).body, {
      ok: true,
    });
    await drive(h);
    // the follow-up's first provider call
    const first = prompts[3] ?? [];
    t.deepEqual(
      first.map((m) => [m.role, m.parts]),
      [
        ["system", ["text"]],
        ["user", ["text"]],
        // web_search is not a tool of this model (its own grounding is):
        // its call and result are a line of text
        ["assistant", ["text", "text"]],
        ["assistant", ["tool-call"]],
        ["tool", ["tool-result"]],
        ["assistant", ["text"]],
        ["user", ["text"]],
      ],
    );
    t.regex(first[2]?.text ?? "", /\[web_search /);
    t.true((first[5]?.text ?? "").includes(sum.slice(0, 30)));
    t.regex(first[6]?.text ?? "", /And then\?/);
  },
);

test.serial(
  "E3a: hidden earlier asks (the thread's and a follow-up) stay out of another member's run",
  async (t) => {
    const prompts: string[] = [];
    setFixtureScenario((options) => {
      prompts.push(JSON.stringify((options as { prompt: unknown }).prompt));
      return "success-with-tools";
    });
    const { h, olga, mel } = world(t);
    const otto = new HttpClient(h, { cookie: h.signIn(h.addUser("otto")) });
    const sp = await openSpace(olga, mel);
    await otto.write("spaces.join", { space: sp });
    const th = mel.id();
    await mel.write("threads.create", {
      id: th,
      space: sp,
      kind: "ask",
      q: "SECRET THREAD QUESTION",
    });
    await drive(h);
    const fu = mel.id();
    await mel.write("research.forkNode", {
      id: fu,
      thread: th,
      parent: "r",
      q: "SECRET FOLLOW-UP",
    });
    await drive(h);
    const sum = (rec(h, `thread:${th}`) as ThreadRec).sum ?? "";
    t.true(sum.length > 40);
    // the moderator hides both
    for (const item of [`a:${th}`, `f:${th}:${fu}`])
      t.like(
        (await olga.write("moderation.decide", { item, decision: "hidden" })).body,
        { ok: true },
        item,
      );
    // otto asks below the hidden follow-up: neither reaches his run
    prompts.length = 0;
    t.like(
      (
        await otto.write("research.forkNode", {
          id: otto.id(),
          thread: th,
          parent: fu,
          q: "OTTO ASKS",
        })
      ).body,
      { ok: true },
    );
    await drive(h);
    const first = prompts[0] ?? "";
    t.true(first.includes("OTTO ASKS"));
    t.false(first.includes("SECRET THREAD QUESTION"));
    t.false(first.includes(sum.slice(0, 40)));
    t.false(first.includes("SECRET FOLLOW-UP"));
    // the author reads both unredacted: they reach her run
    prompts.length = 0;
    await mel.write("research.forkNode", { id: mel.id(), thread: th, parent: fu, q: "MEL ASKS" });
    await drive(h);
    t.true((prompts[0] ?? "").includes("SECRET THREAD QUESTION"));
    t.true((prompts[0] ?? "").includes("SECRET FOLLOW-UP"));
  },
);

/** Tokens the last process recorded for run `run`, of a step it finished. */
const recordStep = (h: Harness, run: string, sp: string, tokens: number) => {
  const userId = (
    h.db.$client.prepare("SELECT user_id AS id FROM run_queue WHERE run_id = ?").get(run) as {
      id: string;
    }
  ).id;
  usage.record(h.db, userId, {
    runId: run,
    payer: "session",
    spaceId: sp,
    kind: "research",
    provider: "google",
    inputTokens: tokens - 40,
    outputTokens: 40,
  });
};

const recorded = (h: Harness, run: string) => usage.tokensOfRun(h.db, run);

test.serial(
  "E3b: a resumed run's thread keeps the tokens of all its attempts, also when finished from its stored answer",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    // the last process finished a tool step (940 tokens) and stored its
    // turns, then stopped
    const a = await interrupted(h, mel, sp);
    recordStep(h, a.run, sp, 940);
    const jobs = h.deps.sync.runJobs;
    jobs.turn(
      a.run,
      1,
      assistant(a.run, 0, [
        { type: "toolUse", id: "c1", name: "web_fetch", input: { url: "https://example.com" } },
      ]),
    );
    jobs.turn(a.run, 1, {
      id: `${a.run}-1`,
      agentId: a.run,
      role: "user",
      blocks: [{ type: "toolResult", toolUseId: "c1", content: "page", isError: false }],
      sourceIndex: 1,
    });
    // the last process stored this one's answer turn, then stopped
    const b = await interrupted(h, mel, sp);
    recordStep(h, b.run, sp, 700);
    jobs.turn(b.run, 1, assistant(b.run, 0, [{ type: "text", text: "THE STORED ANSWER" }]));
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    t.like(rec(h, `run:${a.run}`), { status: "complete" });
    t.true(recorded(h, a.run) > 940);
    t.is((rec(h, `thread:${a.th}`) as ThreadRec).tok, recorded(h, a.run));
    t.like(rec(h, `run:${b.run}`), { status: "complete" });
    t.is((rec(h, `thread:${b.th}`) as ThreadRec).tok, 700);
    await next.drain();
  },
);

test.serial(
  "E3b: a resumed run whose payer runs out keeps the tokens of all its attempts",
  async (t) => {
    setFixtureScenario("success-with-tools");
    const { h, olga, mel } = world(t, { SESSION_INCLUDED_TOKENS: "1000" });
    const sp = await openSpace(olga, mel);
    // the last process finished a step (940 tokens), then stopped
    const { th, run } = await interrupted(h, mel, sp);
    recordStep(h, run, sp, 940);
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    // 60 left when it resumed: one more step, then it ends
    t.like(rec(h, `run:${run}`), { status: "failed", end: "tokens" });
    t.is(recorded(h, run), 940 + 940);
    t.like(rec(h, `thread:${th}`), { sum: null, running: false, tok: 940 + 940 });
    await next.drain();
  },
);

/** Run `run`'s in-flight events as the job sends them: each one's number,
 * and the number stored in `run_queue` at that moment. */
function deltas(h: Harness, run: string) {
  const sent: { seq: number; stored: number }[] = [];
  const jobs = h.deps.sync.runJobs;
  const real = jobs.delta.bind(jobs);
  jobs.delta = (id, attempt, seq, text) => {
    if (id === run) sent.push({ seq, stored: runsRepo.get(h.db, id)?.seq ?? -1 });
    return real(id, attempt, seq, text);
  };
  return sent;
}

test.serial(
  "B6: the event number stored for a run is never below one sent, and a resumed attempt's numbers start past it with a gap",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    // a fresh attempt: from 1, each sent number at or below the stored one
    const fresh = await ask(mel, sp);
    const sent = deltas(h, fresh.run);
    await drive(h);
    t.like(rec(h, `run:${fresh.run}`), { status: "complete" });
    t.true(sent.length > 0);
    t.is(sent[0]?.seq, 1);
    t.is(sent[0]?.stored, SEQ_PERSIST_EVERY, "stored ahead before the first event");
    for (const e of sent) t.true(e.stored >= e.seq, JSON.stringify(e));
    // the last process sent events up to 7 (the stored number at or above
    // it), then stopped
    const { run } = await interrupted(h, mel, sp);
    runsRepo.setSeq(h.db, run, 7);
    const resumed = deltas(h, run);
    const next = nextProcess(h);
    next.recover();
    next.tick();
    await next.idle();
    t.like(rec(h, `run:${run}`), { status: "complete" });
    t.true(resumed.length > 0);
    t.is(resumed[0]?.seq, 9, "7 + 1 is skipped: the first resumed event is not next to the last");
    for (const e of resumed) t.true(e.stored >= e.seq, JSON.stringify(e));
    t.is(runsRepo.get(h.db, run), null, "released");
    await next.drain();
  },
);
