// How a run ends, over the run records (`03-agents-and-research.md` E1,
// E4, E5, K1, G6): one test per row of E5's table that is not in
// `runRecovery.test.ts` (drain, crash) or `runs.test.ts` (access), each
// checking the run record's ending and the closed ledger row of the call in
// progress, whose tokens match what the fixture provider streamed. The sum
// of a run's rows is the run record's `tok`.

import type { ExecutionContext } from "ava";
import test from "ava";

import type { Allowances } from "../src/runs/allowance.js";
import { OVERDRAFT_STOP_NOTE, RUN_CAP_NOTE } from "../src/runs/allowance.js";
import { registerFixture, setFixtureScenario } from "../src/runs/fixtureProvider.js";

import type { LedgerRow, RunsWorld } from "./recordRuns.js";
import { CHUNK, newId, runsWorld, streamedOutput, turnText, waitFor } from "./recordRuns.js";

registerFixture({
  scenario: "deployment-auth",
  steps: [{ error: { kind: "api", statusCode: 401, message: "invalid x-api-key" } }],
});

/** The research rows of a run, each closed. */
function closedRows(t: ExecutionContext, w: RunsWorld, run: string): LedgerRow[] {
  const rows = w.rows(run).filter((r) => r.kind === "research");
  t.true(rows.length > 0, "a row per provider call");
  for (const r of rows) t.is(r.state, "closed");
  return rows;
}

/** The run record's `tok` equals the sum of its rows. */
function tokIsSum(t: ExecutionContext, w: RunsWorld, run: string): void {
  const sum = w.rows(run).reduce((n, r) => n + r.counted, 0);
  t.is(w.run(run).tok, sum, "the run's tok is the sum of its rows");
}

test.serial(
  "finish: complete with the answer; the row closes with the provider's final counts",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:success");
    t.like(await w.settled(run), { status: "complete", fail: null, note: null });
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "finish" });
    const finish = w.streamed[0]?.finish;
    t.is(row?.output_tokens, finish?.outputTokens.total);
    t.is(row?.input_tokens, finish?.inputTokens.total);
    tokIsSum(t, w, run);
  },
);

test.serial(
  "cancel: Stop aborts the stream; the run ends cancelled stopped, its row closes with the last counts",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await waitFor(() => streamedOutput(w.streamed[0]) > 5, "some text");
    await w.mona.ok("research.cancelNode", { thread, node: "r" });
    const done = await w.settled(run);
    t.like(done, { status: "cancelled", fail: { why: "stopped", at: null, cls: null } });
    t.false(w.thread(thread).running);
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "cancel" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.false(
      (w.streamed[0]?.output ?? "").includes("keeps the load within a narrow band"),
      "the stream was aborted",
    );
    // the partial text stays as a turn
    t.true(turnText(w.turns(run)[0]!).startsWith("Consistent "));
    tokIsSum(t, w, run);
  },
);

test.serial(
  "delete (G6): deleting a running node someone commented under cancels its run and writes no turn after",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "A root question");
    await w.settled(run);
    // the marker of the root's question would choose the node's scenario too
    setFixtureScenario("paced-answer");
    const calls = w.streamed.length;
    const { node, run: nodeRun } = await w.fork(w.mel, thread, "r", "A branch");
    await waitFor(
      () => w.streamed.length > calls && streamedOutput(w.streamed.at(-1)) > 5,
      "some text",
    );
    await w.mona.ok("comments.create", { id: newId(), thread, node, t: "Watching this." });
    await w.mel.ok("followups.delete", { thread, node });
    const turnsAtDelete = w.turns(nodeRun).length;
    await w.rt.dispatcher.idle();
    t.like(w.run(nodeRun), { status: "cancelled", fail: { why: "stopped" } });
    t.like(w.rec(`node:${node}`), { del: true, q: "" });
    t.is(w.turns(nodeRun).length, turnsAtDelete, "no turn after the delete");
    const [row] = closedRows(t, w, nodeRun);
    t.is(row?.output_tokens, streamedOutput(w.streamed.at(-1)));
  },
);

test.serial(
  "429: re-queued with backoff three times, then failed rate with at 60 s ahead; each call closed at 0",
  async (t) => {
    const w = await runsWorld(t, { backoffMs: [10, 10, 10] });
    const { run } = await w.ask(w.mona, w.open, "fixture:rate-limit");
    const before = Date.now();
    const done = await w.settled(run, ["failed"]);
    t.is(done.fail?.why, "rate");
    t.true((done.fail?.at ?? 0) >= before + 60_000);
    const rows = closedRows(t, w, run);
    t.is(rows.length, 4, "the first call and three retries");
    for (const r of rows) t.like(r, { ending: "rate_limited", output_tokens: 0, counted: 0 });
    t.deepEqual(w.turns(run), []);
    t.deepEqual(w.failures, ["rate"]);
  },
);

test.serial(
  "other provider error: failed error with its class; the row closes with the last counts",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:mid-stream-error");
    const done = await w.settled(run);
    t.like(done, { status: "failed", fail: { why: "error" } });
    t.truthy(done.fail?.cls);
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "error" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.true((row?.output_tokens ?? 0) > 0);
    t.true(turnText(w.turns(run)[0]!).startsWith("A partial answer"), "the partial text stays");
    tokIsSum(t, w, run);

    // refused before streaming: closed at 0
    const tooLong = await w.ask(w.mona, w.open, "fixture:context-too-long");
    t.like(await w.settled(tooLong.run), {
      status: "failed",
      fail: { why: "error", cls: "context_too_long" },
    });
    t.like(closedRows(t, w, tooLong.run)[0], { ending: "error", output_tokens: 0 });
  },
);

test.serial(
  "deployment credential rejected: failed error auth, counted in session_run_failures_total, closed at 0",
  async (t) => {
    const w = await runsWorld(t);
    const { run } = await w.ask(w.mona, w.open, "fixture:deployment-auth");
    t.like(await w.settled(run), { status: "failed", fail: { why: "error", cls: "auth" } });
    t.like(closedRows(t, w, run)[0], { output_tokens: 0, counted: 0 });
    t.deepEqual(w.failures, ["auth"]);
  },
);

test.serial(
  "person's key rejected mid-run: failed key, the key marked invalid, closed at 0",
  async (t) => {
    const key = { apiKey: "sk-ant-member-key-0000000000", sealed: "v1.member-key" };
    const rejected: string[] = [];
    const allowances: Allowances = {
      weekly: () => 0,
      billing: () => "key",
      validKey: (_u, provider) => (provider === "anthropic" ? key.sealed : null),
      anthropicKey: () => key,
      openaiKey: () => null,
      keyRejected: (_u, _p, sealed) => rejected.push(sealed),
    };
    const w = await runsWorld(t, { allowances });
    const { run } = await w.ask(w.mona, w.open, "fixture:deployment-auth");
    t.like(await w.settled(run), { status: "failed", fail: { why: "key" } });
    t.deepEqual(rejected, [key.sealed]);
    const [row] = closedRows(t, w, run);
    t.like(row, { payer: "key:anthropic", output_tokens: 0 });
  },
);

test.serial(
  "wall clock: failed error timeout; the stream is aborted and the row closes with the last counts",
  async (t) => {
    const w = await runsWorld(t, { env: { SESSION_RUN_TIMEOUT_SECONDS: "1" } });
    const { run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    t.like(await w.settled(run), { status: "failed", fail: { why: "error", cls: "timeout" } });
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "timeout" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.true((row?.output_tokens ?? 0) > 0);
    tokIsSum(t, w, run);
  },
);

test.serial(
  "per-run token cap: complete with the note; the row closes with the last counts",
  async (t) => {
    const w = await runsWorld(t, {
      env: { SESSION_RUN_MAX_TOKENS: "2000" },
      ledgerCheckpointMs: 50,
    });
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:endless-answer");
    t.like(await w.settled(run), { status: "complete", note: RUN_CAP_NOTE });
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "run_cap" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.true((w.rec(`answer:${thread}`) as { md: string }).md.startsWith(CHUNK.trim()));
    tokIsSum(t, w, run);
  },
);

test.serial(
  "allowance reached mid-run with billing pause: the run continues on overdraft and completes",
  async (t) => {
    const w = await runsWorld(t, {
      env: { SESSION_WEEKLY_TOKENS: "1000", SESSION_OVERDRAFT_TOKENS: "200000" },
    });
    const { run } = await w.ask(w.mona, w.open, "fixture:success-with-tools");
    t.like(await w.settled(run), { status: "complete", note: null, bill: "included" });
    const rows = closedRows(t, w, run);
    t.true(rows.length >= 3);
    for (const r of rows) t.like(r, { payer: "included" });
    tokIsSum(t, w, run);
  },
);

test.serial(
  "overdraft limit reached: complete with the note; the partial step is the last turn",
  async (t) => {
    const w = await runsWorld(t, {
      env: { SESSION_WEEKLY_TOKENS: "1500", SESSION_OVERDRAFT_TOKENS: "1500" },
      ledgerCheckpointMs: 50,
    });
    const { run } = await w.ask(w.mona, w.open, "fixture:endless-answer");
    t.like(await w.settled(run), { status: "complete", note: OVERDRAFT_STOP_NOTE });
    const [row] = closedRows(t, w, run);
    t.like(row, { ending: "overdraft" });
    t.true((row?.counted ?? 0) >= 3_000);
    t.true(turnText(w.turns(run).at(-1)!).startsWith(CHUNK));
    tokIsSum(t, w, run);
  },
);

test.serial(
  "E1: a thread removed while its run streams: no turn after the removal, the stream aborted, no text left, the row closed",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:fetch-free-endless");
    await waitFor(() => streamedOutput(w.streamed[0]) > 50, "some text");
    await waitFor(
      () =>
        w.db.$client.prepare("SELECT count(*) AS n FROM run_live WHERE run_id = ?").get(run) !==
          undefined &&
        (
          w.db.$client.prepare("SELECT count(*) AS n FROM run_live WHERE run_id = ?").get(run) as {
            n: number;
          }
        ).n > 0,
      "a checkpoint",
    );
    await w.olga.ok("moderation.decide", { item: `a:${thread}`, decision: "removed" });
    await w.rt.dispatcher.idle();
    t.is(w.rec(`run:${run}`), undefined, "the run went with the thread");
    t.deepEqual(w.turns(run), []);
    // nothing of the streamed text is stored anywhere (`01` D4)
    const text = CHUNK.trim();
    for (const [table, column] of [
      ["records", "body"],
      ["run_live", "md"],
    ] as const)
      t.is(
        (
          w.db.$client
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} LIKE ?`)
            .get(`%${text}%`) as { n: number }
        ).n,
        0,
        `no text in ${table}`,
      );
    t.false((w.streamed[0]?.output ?? "").length >= 3_000 * CHUNK.length, "the stream was aborted");
    const [row] = w.rows(run);
    t.like(row, { state: "closed" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.true((row?.output_tokens ?? 0) > 0, "billed for what streamed before the abort");
  },
);

test.serial(
  "E4: cancel then Run again within one millisecond leaves one live attempt",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await waitFor(() => streamedOutput(w.streamed[0]) > 5, "some text");
    await w.mona.register();
    const { answers } = await w.mona.send([
      w.mona.envelope("research.cancelNode", { thread, node: "r" }),
      w.mona.envelope("research.retryNode", {
        thread,
        node: "r",
        base: { attempt: 1 },
        model: "claude-fable",
        effort: "medium",
      }),
    ]);
    t.true(answers.every((a) => a.ok));
    const first = w.turns(run, 1).length;
    const done = await w.settled(run, ["complete"]);
    t.is(done.attempt, 2);
    t.is(w.turns(run, 1).length, first, "the first attempt wrote nothing after the retry");
    t.true(w.turns(run, 2).length > 0);
    const byAttempt = new Map<number, LedgerRow[]>();
    for (const r of w.rows(run).filter((x) => x.kind === "research"))
      byAttempt.set(r.attempt, [...(byAttempt.get(r.attempt) ?? []), r]);
    t.like(byAttempt.get(1)?.[0], { state: "closed" });
    t.is(byAttempt.get(1)?.length, 1);
    t.is(byAttempt.get(2)?.length, 1);
    t.false(w.thread(thread).running);
    tokIsSum(t, w, run);
  },
);

registerFixture({
  scenario: "fetch-free-endless",
  steps: [
    {
      delayMs: 5,
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        ...Array.from({ length: 3_000 }, () => ({
          type: "text-delta" as const,
          id: "t0",
          delta: CHUNK,
        })),
        { type: "text-end", id: "t0" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 30_000, text: 30_000, reasoning: 0 },
          },
        },
      ],
    },
  ],
});
