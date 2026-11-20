// A server run's context (review round 1 of phase 2, reviewer A's F7 and
// phase 2a design finding 4; the experiment e02-limits E2b as a test): a
// resumed run continues after its stored turns, and a follow-up's context
// holds the tool calls and results of the answers before it.

import { runs as runsRepo } from "@session/db";
import type { ThreadRec } from "@session/mutators";
import test from "ava";

import {
  fixtureLookup,
  fixturePageFetch,
  setFixtureScenario,
} from "../src/runs/fixtureProvider.js";
import { createRunsService } from "../src/runs/service.js";

import { createHarness, type Harness } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

function world(t: Parameters<typeof createHarness>[0]) {
  const h = createHarness(t, {
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
