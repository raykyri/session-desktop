// Runs on space threads over HTTP with the fixture provider (phase 2a): the
// included tokens, a user's API key, the payer order and the `tokens` end,
// a device run (claim, heartbeat, turn, finish), an interrupted lease and a
// too-large answer, Stop and Run again, a 429's requeue, and boot recovery.

import { runs as runsRepo, usage } from "@session/db";
import type { RunRec, ThreadRec } from "@session/mutators";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";
import { createRunsService } from "../src/runs/service.js";

import { createHarness, type Harness } from "./helpers.js";
import { HttpClient, signInDevice } from "./sync.helpers.js";

class Clock {
  ms = Date.now();
  now = () => this.ms;
}

function world(t: Parameters<typeof createHarness>[0], env: Record<string, string> = {}) {
  const clock = new Clock();
  const h = createHarness(t, { env, sync: { clock } });
  const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
  const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
  return { h, clock, olga, mel };
}

async function openSpace(olga: HttpClient, mel: HttpClient) {
  const sp = olga.id();
  await olga.write("spaces.create", { id: sp, name: "lounge" });
  await mel.write("spaces.join", { space: sp });
  return sp;
}

/** The effect worker, the queue and every attempt, to the end. */
async function drive(h: Harness) {
  for (let k = 0; k < 5; k++) {
    h.deps.sync.work();
    h.deps.runs.tick();
    await h.deps.runs.idle();
  }
}

const rec = (h: Harness, key: string) => h.deps.sync.records().get(key);
const runOf = (h: Harness, th: string) =>
  [...h.deps.sync.records().values()].filter((r): r is RunRec => r.kind === "run" && r.th === th);

async function ask(c: HttpClient, space: string, extra: Record<string, unknown> = {}) {
  const id = c.id();
  const r = await c.write("threads.create", {
    id,
    space,
    kind: "ask",
    q: "What is a skip list?",
    ...extra,
  });
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  return { th: id, run: (r.body.result as { run: string }).run };
}

test.serial(
  "an ask runs on the included tokens: turns stored, deltas streamed, the answer and usage written",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const snap = await olga.snapshot(`space:${sp}`);
    const stream = await olga.events({ [`space:${sp}`]: snap.body["cursor"] as string });
    const { th, run } = await ask(mel, sp);
    await drive(h);
    const thread = rec(h, `thread:${th}`) as ThreadRec;
    t.is(
      thread.sum,
      "A [[Skip list]] is a layered linked list that supports logarithmic search without rebalancing.",
    );
    t.false(thread.running);
    t.is(thread.tok, 560);
    t.like(rec(h, `run:${run}`), { status: "complete", end: null, pay: "session" });
    const turn = rec(h, `turn:${run}:1`) as { body: { role: string } } | undefined;
    t.is(turn?.body.role, "assistant");
    const text = await stream.until(/event: run/);
    t.regex(
      text,
      /event: run\ndata: \{"type":"run","run":"[0-9A-Z]+","attempt":1,"seq":1,"text":"A \[\[Skip list\]\]/,
    );
    await stream.close();
    const user = h.deps.db.$client.prepare("SELECT id FROM users WHERE handle = 'mel'").get() as {
      id: string;
    };
    t.deepEqual(usage.monthlyByPayer(h.db, user.id), { session: { [sp]: 560 } });
    t.like(runsRepo.attempts(h.db, run)[0], {
      outcome: "complete",
      payer: "session",
      kind: "fresh",
    });
    t.is(runsRepo.get(h.db, run), null, "released from the queue");
  },
);

test.serial(
  "past the included tokens the default API key pays; with neither, the run ends `tokens`",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t, { SESSION_INCLUDED_TOKENS: "100" });
    const sp = await openSpace(olga, mel);
    const melId = (
      h.deps.db.$client.prepare("SELECT id FROM users WHERE handle = 'mel'").get() as { id: string }
    ).id;
    usage.record(h.db, melId, {
      payer: "session",
      spaceId: sp,
      kind: "research",
      provider: "x",
      inputTokens: 100,
    });
    const none = await ask(mel, sp, { model: "claude-fable" });
    await drive(h);
    t.like(rec(h, `run:${none.run}`), { status: "failed", end: "tokens" });
    t.like(rec(h, `thread:${none.th}`), { running: false, sum: null });
    // a key of mel's: it pays for an Anthropic model
    const k = await mel.call("apiKeys.create", { raw: "sk-ant-MEL-KEY-0001", label: "" });
    const key = (k.body.result as { id: string }).id;
    const paid = await ask(mel, sp, { model: "claude-fable" });
    await drive(h);
    t.like(rec(h, `run:${paid.run}`), { status: "complete", pay: key });
    t.true(usage.monthlyUsed(h.db, melId, key) > 0);
    // a key named as the payer pays whatever the included tokens have left
    const named = await ask(mel, sp, { model: "claude-fable", pay: key });
    await drive(h);
    t.like(rec(h, `run:${named.run}`), { status: "complete", pay: key });
    // a Google model is not paid by an Anthropic key: `key`
    const wrong = await ask(mel, sp, { model: "gemini-flash", pay: key });
    await drive(h);
    t.like(rec(h, `run:${wrong.run}`), { status: "failed", end: "key" });
    // a key the check rejected pays nothing
    const bad = await mel.call("apiKeys.create", {
      raw: "sk-ant-REVOKED-0002",
      label: "x",
      check: true,
    });
    const badId = (bad.body.result as { id: string }).id;
    await drive(h);
    t.like(rec(h, `apikey:${badId}`), { status: "invalid" });
    const keys = (await (
      await h.request("/api/me/api-keys", { cookie: (mel.auth as { cookie: string }).cookie })
    ).json()) as { id: string; reason?: string }[];
    t.is(keys.find((x) => x.id === badId)?.reason, "it was revoked");
  },
);

test.serial(
  "a device run: claim, heartbeat, turn and finish over the bearer token; an ended lease is interrupted; a large answer too_large",
  async (t) => {
    const { h, clock, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const d = await signInDevice(h, mel);
    const dev = new HttpClient(h, { bearer: d.token });
    const executor = { kind: "device", cli: "claude", device: d.device };
    const { th, run } = await ask(mel, sp, { executor });
    await drive(h);
    t.like(rec(h, `run:${run}`), { status: "queued" }, "no server job runs a device run");
    // a browser session drives no device run
    t.like((await mel.call("runs.claim", { run, device: d.device })).body, {
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const c = await dev.call("runs.claim", { run, device: d.device });
    t.like(c.body, {
      ok: true,
      result: { attempt: 1, turns: [{ q: "What is a skip list?", a: "" }] },
    });
    clock.ms += 60_000;
    t.like((await dev.call("runs.heartbeat", { run, device: d.device, attempt: 1 })).body, {
      ok: true,
    });
    t.like(
      (
        await dev.call("runs.turn", {
          run,
          device: d.device,
          attempt: 1,
          turn: "Reading the source.",
        })
      ).body,
      { ok: true },
    );
    t.like(rec(h, `turn:${run}:1`), { body: "Reading the source.", node: "r" });
    t.like(
      (
        await dev.call("runs.finish", {
          run,
          device: d.device,
          attempt: 1,
          answer: "A skip list is…",
        })
      ).body,
      {
        ok: true,
        result: { status: "complete" },
      },
    );
    t.like(rec(h, `thread:${th}`), { sum: "A skip list is…", running: false });
    // the lease ends 90 s after the last heartbeat: interrupted
    const r2 = await ask(mel, sp, { executor });
    await dev.call("runs.claim", { run: r2.run, device: d.device });
    clock.ms += 91_000;
    t.like(
      (await dev.call("runs.turn", { run: r2.run, device: d.device, attempt: 1, turn: "late" }))
        .body,
      {
        ok: false,
        error: { code: "PRECONDITION_FAILED" },
      },
    );
    t.like(rec(h, `run:${r2.run}`), { status: "failed", end: "interrupted" });
    // an answer over 200 KB is not saved
    const r3 = await ask(mel, sp, { executor });
    await dev.call("runs.claim", { run: r3.run, device: d.device });
    t.like(
      (
        await dev.call("runs.finish", {
          run: r3.run,
          device: d.device,
          attempt: 1,
          answer: "x".repeat(200 * 1024 + 1),
        })
      ).body,
      {
        ok: true,
        result: { status: "too_large" },
      },
    );
    t.like(rec(h, `run:${r3.run}`), { status: "failed", end: "too_large" });
    t.like(rec(h, `thread:${r3.th}`), { sum: null, running: false });
  },
);

test.serial("Stop ends a running job; Run again starts a new attempt", async (t) => {
  setFixtureScenario("slow-stream");
  const { h, olga, mel } = world(t);
  const sp = await openSpace(olga, mel);
  const { th, run } = await ask(mel, sp);
  h.deps.sync.work();
  h.deps.runs.tick();
  for (let k = 0; k < 100 && (rec(h, `run:${run}`) as RunRec).status !== "running"; k++)
    await new Promise((r) => setTimeout(r, 10));
  t.like(rec(h, `run:${run}`), { status: "running" });
  t.like((await mel.call("research.cancelNode", { thread: th, node: "r" })).body, { ok: true });
  await h.deps.runs.idle();
  t.like(rec(h, `run:${run}`), { status: "cancelled", end: "stopped" });
  t.like(rec(h, `thread:${th}`), { running: false, sum: null });
  t.like(runsRepo.attempts(h.db, run)[0], { outcome: "cancelled" });
  setFixtureScenario("success");
  t.like((await mel.call("research.retryNode", { thread: th, node: "r" })).body, { ok: true });
  await drive(h);
  const again = runOf(h, th).find((r) => r.id !== run);
  t.like(again, { attempt: 2, status: "complete" });
  t.like(rec(h, `thread:${th}`), { att: 2, running: false });
  t.truthy((rec(h, `thread:${th}`) as ThreadRec).sum);
});

test.serial("a 429 requeues the run with backoff, and the next attempt answers", async (t) => {
  let calls = 0;
  setFixtureScenario(() => (calls++ === 0 ? "rate-limit" : "success"));
  const { h, olga, mel } = world(t);
  const sp = await openSpace(olga, mel);
  const { run } = await ask(mel, sp);
  await drive(h);
  const q = runsRepo.get(h.db, run);
  t.truthy(q?.notBefore, "held back");
  h.db.$client.prepare("UPDATE run_queue SET not_before = 0").run();
  await drive(h);
  t.like(rec(h, `run:${run}`), { status: "complete" });
  t.deepEqual(
    runsRepo.attempts(h.db, run).map((a) => a.outcome),
    ["rate_limited", "complete"],
  );
});

test.serial(
  "boot recovery: a run running when the process stopped is resumed, and ended `interrupted` after too many resumes",
  async (t) => {
    setFixtureScenario("success");
    const { h, olga, mel } = world(t);
    const sp = await openSpace(olga, mel);
    const { th, run } = await ask(mel, sp);
    h.deps.sync.work();
    // the last process claimed it and started it, then stopped
    runsRepo.claim(h.db, run);
    t.true(h.deps.sync.runJobs.start(run, "session").ok);
    const next = createRunsService({
      config: h.config,
      db: h.db,
      sync: h.deps.sync,
      keys: h.deps.keys,
      logger: h.logger,
      autoStart: false,
    });
    next.recover();
    next.tick();
    await next.idle();
    t.like(rec(h, `run:${run}`), { status: "complete" });
    t.truthy((rec(h, `thread:${th}`) as ThreadRec).sum);
    t.like(runsRepo.attempts(h.db, run)[0], { kind: "resume" });
    // a run that keeps getting interrupted ends
    const r2 = await ask(mel, sp);
    h.deps.sync.work();
    runsRepo.claim(h.db, r2.run);
    h.deps.sync.runJobs.start(r2.run);
    for (let k = 0; k < 3; k++) {
      runsRepo.claim(h.db, r2.run);
      next.recover();
    }
    t.like(rec(h, `run:${r2.run}`), { status: "failed", end: "interrupted" });
    t.is(runsRepo.get(h.db, r2.run), null);
    await next.drain();
  },
);
