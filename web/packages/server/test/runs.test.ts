// The run lifecycle over the run records (`03-agents-and-research.md` E2,
// E3, G7, G8, T1, T4): the `run` record a mutator writes `queued` is the
// queue; the dispatcher claims it by compare-and-set, the loop commits a
// `turn` record per step and ends with the `answer` record, and the root
// thread's title, summary line, `tok`, `src` and `running` follow.

import type { NodeRec, RunRec } from "@session/mutators";
import test from "ava";

import { configAllowances } from "../src/runs/allowance.js";
import { attemptTurns, runContext } from "../src/runs/context.js";
import { createDispatcher } from "../src/runs/dispatcher.js";

import { newId, runsWorld, turnText, until } from "./recordRuns.js";

test.serial(
  "E2: an ask is claimed, commits a turn per step, and completes with its answer, title and summary",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "How do bloom filters work?");
    const done = await w.settled(run);
    t.is(done.status, "complete");
    t.is(done.attempt, 1);
    t.is(done.step, 3);
    t.is(done.fail, null);
    t.is(done.bill, "included");
    t.truthy(done.startedAt);
    t.truthy(done.finishedAt);
    // success-with-tools: three steps, the first two calling tools; a step
    // is one turn record, its tool results included
    const turns = w.turns(run);
    t.deepEqual(
      turns.map((x) => [x.n, x.role, x.blocks.map((b) => b.type)]),
      [
        [0, "assistant", ["text", "toolUse", "toolResult"]],
        [1, "assistant", ["toolUse", "toolResult"]],
        [2, "assistant", ["text"]],
      ],
    );
    const answer = w.rec(`answer:${thread}`);
    t.like(answer, { kind: "answer", node: "r", th: thread, u: "mona", run, attempt: 1 });
    t.true(answer?.kind === "answer" && answer.md.startsWith("A [[Bloom filter]] is"));
    t.true(answer?.kind === "answer" && answer.pages.length === 1);
    const th = w.thread(thread);
    t.false(th.running);
    t.truthy(th.t, "the title step wrote a title");
    t.truthy(th.sum, "the summary step wrote the summary line");
    t.is(th.src, 1);
    // the run's tok is the sum of its ledger rows: the research calls, the
    // title and the summary (`03` K1, K2)
    const rows = w.rows(run);
    t.true(rows.every((r) => r.state === "closed"));
    t.deepEqual(new Set(rows.map((r) => r.kind)), new Set(["research", "title", "summary"]));
    const sum = rows.reduce((n, r) => n + r.counted, 0);
    t.is(done.tok, sum);
    t.is(th.tok, sum);
    t.is(w.rec<RunRec>(`run:${run}`)?.tok, sum);
    // the in-flight checkpoint is gone with the attempt
    t.deepEqual(
      w.db.$client.prepare("SELECT count(*) AS n FROM run_live WHERE run_id = ?").get(run),
      { n: 0 },
    );
  },
);

test.serial("E3: a tool-using run moves through searching and reading to writing", async (t) => {
  const w = await runsWorld(t);
  const steps: number[] = [];
  const stop = w.sync.onRecords((keys) => {
    for (const key of keys)
      if (key.startsWith("run:")) {
        const r = w.rec<RunRec>(key);
        if (r?.status === "running" && steps.at(-1) !== r.step) steps.push(r.step);
      }
  });
  const { run } = await w.ask(w.mona, w.open, "fixture:success-with-tools");
  await w.settled(run);
  stop();
  t.deepEqual(steps, [0, 1, 2, 3]);
  t.is(w.run(run).step, 3);
});

test.serial("E3: a tool-free run jumps from planning to writing", async (t) => {
  const w = await runsWorld(t);
  const steps: number[] = [];
  const stop = w.sync.onRecords((keys) => {
    for (const key of keys)
      if (key.startsWith("run:")) {
        const r = w.rec<RunRec>(key);
        if (r?.status === "running" && steps.at(-1) !== r.step) steps.push(r.step);
      }
  });
  const { run } = await w.ask(w.mona, w.open, "fixture:success");
  await w.settled(run);
  stop();
  t.deepEqual(steps, [0, 3]);
  t.deepEqual(
    w.turns(run).map((x) => x.role),
    ["assistant"],
  );
});

test.serial(
  "E2: two dispatchers racing for one queued run: one claims it, the other's compare-and-set changes nothing",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    const [queued] = w.rt.store.queued();
    if (!queued) return t.fail("nothing queued");
    t.is(queued.runId, run);
    const rev = w.run(run).rev;
    const first = w.rt.store.claim(queued);
    const second = w.rt.store.claim(queued);
    t.truthy(first);
    t.is(second, null);
    t.is(w.run(run).status, "running");
    t.is(w.run(run).rev, rev + 1, "one running transition");

    // two dispatchers over the same store and runner: one runner per attempt
    w.rt.store.close();
    const other = await runsWorld(t, { start: false });
    const { run: r2 } = await other.ask(other.mona, other.open, "fixture:success");
    const runs: string[] = [];
    const runner = {
      run: (request: { runId: string }) => {
        runs.push(request.runId);
        return other.rt.service.run(request as never);
      },
    };
    const make = () =>
      createDispatcher({
        config: other.config,
        store: other.rt.store,
        ledger: other.ledger,
        allowances: configAllowances(other.config),
        runner,
        logger: other.logger,
      });
    const a = make();
    const b = make();
    t.is(a.tick() + b.tick(), 1);
    t.deepEqual(runs, [r2]);
    await a.idle();
    await other.settled(r2);
    t.is(other.run(r2).status, "complete");
  },
);

test.serial(
  "G7: context for Continue, Branch, Branch here and Look up is the parent's path",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:success Root question");
    await w.settled(run);
    const cont = await w.fork(w.mel, thread, "r", "fixture:success Continue question");
    await w.settled(cont.run);
    // Branch beside `cont`: same parent (the root), so `cont` is not on its path
    const branch = await w.fork(w.mel, thread, "r", "fixture:success Branch question");
    await w.settled(branch.run);
    const deep = await w.fork(w.mona, thread, cont.node, "fixture:success Deep question", {
      quote: "A passage of the answer.",
      b: 0,
    });
    await w.settled(deep.run);
    const look = (await w.mel.ok("research.forkNode", {
      id: newId(),
      thread,
      parent: "r",
      kind: "lookup",
      look: "bloom filter",
      quote: "A bloom filter is a set.",
      b: 0,
      model: "claude-fable",
      effort: "medium",
    })) as { run: string };
    await w.settled(look.run);

    const ctx = (id: string) => {
      const r = w.run(id);
      const res = w.sync.server.serverApply({ me: "", mutationId: "" }, (tx) => runContext(tx, r));
      if (!res.ok || !res.result) throw new Error("no context");
      const c = res.result;
      return {
        node: c.node,
        user: c.userText,
        history: c.history.map((m) => [
          m.message.role,
          typeof m.message.content === "string"
            ? m.message.content
            : (m.message.content as { type: string; text?: string }[])
                .map((p) => p.text ?? p.type)
                .join("|"),
        ]),
        final: c.finalSteps ?? null,
      };
    };
    const rootAnswer = (w.rec(`answer:${thread}`) as { md: string }).md;
    t.snapshot(ctx(run), "Ask: the root");
    t.like(ctx(cont.run), {
      node: "ask",
      user: "fixture:success Continue question",
      final: null,
    });
    t.deepEqual(ctx(cont.run).history, [
      ["user", "fixture:success Root question"],
      ["assistant", rootAnswer],
    ]);
    t.deepEqual(ctx(branch.run).history, ctx(cont.run).history, "the sibling is not on the path");
    const d = ctx(deep.run);
    t.is(d.history.length, 4, "root and Continue exchanges");
    t.is(d.history[2]?.[1], "fixture:success Continue question");
    t.regex(d.user, /A passage of the answer\./, "Branch here quotes its passage");
    t.regex(d.user, /Deep question/);
    const l = ctx(look.run);
    t.is(l.node, "lookup");
    t.regex(l.user, /Look up "bloom filter" as it is used in this answer/);
    t.regex(l.user, /A bloom filter is a set\./);
    t.snapshot({ cont: ctx(cont.run), deep: d, look: l }, "Continue, Branch here and Look up");
    // the stored turns of the answering attempt are what the history replays
    const n = w.rec<NodeRec>(`node:${cont.node}`);
    t.truthy(n);
    const res = w.sync.server.serverApply({ me: "", mutationId: "" }, (tx) =>
      attemptTurns(tx, thread, cont.run, 1),
    );
    t.true(res.ok && res.result.length === 1);
  },
);

test.serial(
  "G8: an asker removed from a private channel while queued ends access with no usage row",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { run } = await w.ask(w.mel, w.closed, "fixture:success");
    await w.olga.ok("members.remove", {
      space: w.closed,
      user: "mel",
      base: { adm: (w.rec(`member:${w.closed}:mel`) as { adm: string }).adm },
    });
    w.rt.dispatcher.start();
    await until(() => w.run(run).status !== "queued", "the claim");
    t.like(w.run(run), { status: "failed", fail: { why: "access", at: null, cls: null } });
    t.deepEqual(w.rows(run), []);
    t.is(w.streamed.length, 0, "no model call");
  },
);

test.serial(
  "T1: committed turns and the answer are records a pull delivers; a reader who drops every delta converges",
  async (t) => {
    const w = await runsWorld(t);
    const cursor = (await w.mel.snapshot(`space:${w.open}`)).cursor;
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await w.settled(run);
    const p = w.sync.server.pull({ u: "mel" }, `space:${w.open}`, cursor);
    if (!("changes" in p)) return t.fail("resync");
    const keys = p.changes.map((c) => c.key);
    t.true(keys.includes(`answer:${thread}`));
    t.true(keys.includes(`run:${run}`));
    t.true(keys.some((k) => k.startsWith(`turn:${run}:1:`)));
    const answer = p.changes.find((c) => c.key === `answer:${thread}`);
    const turns = w.turns(run);
    t.is(
      answer && "record" in answer && answer.record?.kind === "answer" ? answer.record.md : "",
      turns.map(turnText).join("").trim(),
    );
  },
);

test.serial(
  "C16: a fork's branch notification and a comment's notification commit with the write; a comment writes no run and no usage row",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:success");
    await w.settled(run);
    const { node, run: forkRun } = await w.fork(w.mel, thread, "r", "fixture:success More?");
    const version = (log: `space:${string}` | `user:${string}`, key: string) =>
      w.sync.store.logRow(log, key)?.version;
    const forked = version(`space:${w.open}`, `node:${node}`);
    t.truthy(forked);
    t.is(version(`space:${w.open}`, `run:${forkRun}`) === undefined, false);
    const branch = w.sync.store
      .logRows(`user:mona`, 0)
      .map((r) => ({ r, n: w.rec(r.key) }))
      .find((x) => x.n?.kind === "notif" && x.n.type === "branch");
    t.is(branch?.r.version, forked, "the notification is in the fork's commit");
    await w.settled(forkRun);

    const count = (sql: string) => w.db.$client.prepare(sql).get();
    const runs = count("SELECT count(*) AS n FROM records WHERE kind = 'run'");
    const rows = count("SELECT count(*) AS n FROM usage_events");
    const c = newId();
    await w.mona.ok("comments.create", { id: c, thread, node, t: "Good branch." });
    const commented = version(`space:${w.open}`, `comment:${c}`);
    const notif = w.sync.store
      .logRows(`user:mel`, 0)
      .map((r) => ({ r, n: w.rec(r.key) }))
      .find((x) => x.n?.kind === "notif" && x.n.type === "comment");
    t.is(notif?.r.version, commented);
    t.deepEqual(count("SELECT count(*) AS n FROM records WHERE kind = 'run'"), runs);
    t.deepEqual(count("SELECT count(*) AS n FROM usage_events"), rows);
  },
);
