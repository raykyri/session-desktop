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
import { weekOf } from "../src/runs/ledger.js";

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
    t.like(closedRows(t, w, run)[0], { ending: "error", output_tokens: 0, counted: 0 });
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

/** The `run_live` rows of a run. */
const liveRows = (w: RunsWorld, run: string) =>
  w.db.$client.prepare("SELECT attempt, md, seq FROM run_live WHERE run_id = ?").all(run);

/** Turn records of a run by their key prefix: found after the run record is
 * gone. */
const turnKeys = (w: RunsWorld, run: string) =>
  w.db.$client
    .prepare<[string], { key: string }>("SELECT key FROM records WHERE key LIKE ?")
    .all(`turn:${run}:%`)
    .map((r) => r.key);

/** Waits until the run has a checkpoint with text. */
const checkpointed = (w: RunsWorld, run: string) =>
  waitFor(
    () =>
      (
        w.db.$client
          .prepare("SELECT count(*) AS n FROM run_live WHERE run_id = ? AND length(md) > 0")
          .get(run) as { n: number }
      ).n > 0,
    "a checkpoint with text",
  );

test.serial(
  "E1: a thread removed in the second step of its run: its turns go, no turn after, the stream aborted, no text left, the call closed superseded",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:fetch-then-endless");
    await waitFor(() => streamedOutput(w.streamed[1]) > 50, "text of the second step");
    await checkpointed(w, run);
    t.deepEqual(turnKeys(w, run), [`turn:${run}:1:0`], "the first step committed");
    await w.olga.ok("moderation.decide", { item: `a:${thread}`, decision: "removed" });
    t.deepEqual(liveRows(w, run), [], "the checkpoint went with the run record");
    await w.rt.dispatcher.idle();
    t.is(w.rec(`run:${run}`), undefined);
    t.deepEqual(turnKeys(w, run), [], "no turn of the run is left");
    for (const [table, column, text] of [
      ["records", "body", CHUNK.trim()],
      ["records", "body", "Reading the page."],
      ["run_live", "md", CHUNK.trim()],
    ] as const)
      t.is(
        (
          w.db.$client
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} LIKE ?`)
            .get(`%${text}%`) as { n: number }
        ).n,
        0,
        `no "${text}" in ${table}`,
      );
    const [first, second] = w.rows(run).filter((r) => r.kind === "research");
    t.like(first, { state: "closed", ending: "finish" });
    t.like(second, { state: "closed", ending: "superseded" });
    t.is(second?.output_tokens, streamedOutput(w.streamed[1]));
    t.true((second?.output_tokens ?? 0) > 0, "billed for what streamed before the abort");
    t.false((w.streamed[1]?.output ?? "").length >= 3_000 * CHUNK.length, "the stream was aborted");
  },
);

test.serial(
  "E4: Stop then Run again within one millisecond leaves one live attempt; the first attempt's call closes cancel with what it streamed; the run's tok counts both attempts",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await waitFor(() => streamedOutput(w.streamed[0]) > 5, "some text");
    await w.mona.register();
    await w.mona.send([
      w.mona.envelope("research.cancelNode", { thread, node: "r" }),
      w.mona.envelope("research.retryNode", {
        thread,
        node: "r",
        base: { attempt: 1 },
        model: "claude-fable",
        effort: "medium",
      }),
    ]);
    const turnsAtRetry = w.turns(run, 1).length;
    const done = await w.settled(run, ["complete"]);
    t.is(done.attempt, 2);
    t.is(w.turns(run, 1).length, turnsAtRetry, "the first attempt wrote nothing after the retry");
    t.true(w.turns(run, 2).length > 0);
    t.false(w.thread(thread).running);
    t.is(w.rows(run).filter((r) => r.kind === "research" && r.attempt === 2).length, 1);
    const first = w.rows(run).filter((r) => r.kind === "research" && r.attempt === 1);
    t.is(first.length, 1);
    t.like(first[0], { state: "closed", ending: "cancel" });
    t.is(first[0]?.output_tokens, streamedOutput(w.streamed[0]));
    t.true((first[0]?.counted ?? 0) > 0);
    t.true(done.tok !== null && done.tok > (first[0]?.counted ?? 0));
    tokIsSum(t, w, run);
  },
);

test.serial(
  "delete (G6) of a node nobody else wrote under while its run streams: the records go, the call closes superseded",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "A root question");
    await w.settled(run);
    const calls = w.streamed.length;
    const { node, run: nodeRun } = await w.fork(w.mel, thread, "r", "fixture:endless-answer more");
    await waitFor(
      () => w.streamed.length > calls && streamedOutput(w.streamed.at(-1)) > 50,
      "some text",
    );
    await w.mel.ok("followups.delete", { thread, node });
    await w.rt.dispatcher.idle();
    t.is(w.rec(`run:${nodeRun}`), undefined);
    t.is(w.rec(`node:${node}`), undefined);
    t.deepEqual(turnKeys(w, nodeRun), []);
    t.deepEqual(liveRows(w, nodeRun), []);
    const [row] = closedRows(t, w, nodeRun);
    t.like(row, { ending: "superseded" });
    t.is(row?.output_tokens, streamedOutput(w.streamed.at(-1)));
  },
);

test.serial(
  "delete (G6) kept as a shell: the run ends cancelled with the tok and bill of what it spent, its checkpoint gone",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "A root question");
    await w.settled(run);
    const { node, run: nodeRun } = await w.fork(w.mel, thread, "r", "fixture:endless-answer more");
    await checkpointed(w, nodeRun);
    await w.mona.ok("comments.create", { id: newId(), thread, node, t: "Watching." });
    await w.mel.ok("followups.delete", { thread, node });
    t.deepEqual(liveRows(w, nodeRun), []);
    await w.rt.dispatcher.idle();
    t.like(w.run(nodeRun), { status: "cancelled", fail: { why: "stopped" }, bill: "included" });
    const [row] = closedRows(t, w, nodeRun);
    t.like(row, { ending: "superseded" });
    t.true((row?.counted ?? 0) > 0);
    tokIsSum(t, w, nodeRun);
    t.deepEqual(liveRows(w, nodeRun), []);
  },
);

test.serial(
  "a ban while the member's run streams ends it failed access with its tok: no turn after, the checkpoint gone, the call closed superseded",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "A root question");
    await w.settled(run);
    const { run: melRun } = await w.fork(w.mel, thread, "r", "fixture:endless-answer more");
    await checkpointed(w, melRun);
    await w.olga.ok("members.ban", { space: w.open, user: "mel" });
    await w.rt.dispatcher.idle();
    t.like(w.run(melRun), {
      status: "failed",
      fail: { why: "access", at: null, cls: null },
      bill: "included",
    });
    t.truthy(w.run(melRun).finishedAt);
    t.deepEqual(w.turns(melRun), [], "no turn after the ban");
    t.deepEqual(liveRows(w, melRun), []);
    const [row] = closedRows(t, w, melRun);
    t.like(row, { ending: "superseded" });
    t.true((row?.counted ?? 0) > 0);
    tokIsSum(t, w, melRun);
  },
);

test.serial(
  "a ban while the member's run is queued ends it failed access at its claim, with no model call",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:success");
    await w.olga.ok("members.ban", { space: w.open, user: "mona" });
    w.rt.dispatcher.start();
    t.like(await w.settled(run), { status: "failed", fail: { why: "access" } });
    t.deepEqual(w.rows(run), []);
    t.is(w.streamed.length, 0);
    t.is(w.rec(`answer:${thread}`), undefined);
  },
);

test.serial(
  "429 after a billed step: the re-queue writes the run's tok; a Stop during the backoff ends it cancelled and drops its checkpoint",
  async (t) => {
    const w = await runsWorld(t, { backoffMs: [5_000, 5_000, 5_000] });
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:written-step-then-throttle");
    await waitFor(() => w.run(run).status === "queued" && w.rows(run).length >= 2, "the re-queue");
    t.true((w.run(run).tok ?? 0) > 0);
    tokIsSum(t, w, run);
    t.is(w.run(run).bill, "included");
    t.is(liveRows(w, run).length, 1, "the attempt's checkpoint, kept for its next claim");
    await w.mona.ok("research.cancelNode", { thread, node: "r" });
    t.like(w.run(run), { status: "cancelled" });
    t.deepEqual(liveRows(w, run), []);
    tokIsSum(t, w, run);
  },
);

test.serial(
  "the claim refused and a boot interrupt write the run's tok and bill from the ledger",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const spend = (run: string, tokens: number) => {
      const id = w.ledger.open({
        runId: run,
        attempt: 1,
        userId: w.mona.user.id,
        payer: "included",
        week: weekOf(Date.now()),
        kind: "research",
        provider: "anthropic",
        model: "claude-fable",
        cachedInputRatio: 0.1,
        counts: { inputTokens: tokens, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
        openedAt: Date.now(),
      });
      w.ledger.close(
        id,
        { inputTokens: tokens, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
        "rate_limited",
        Date.now(),
      );
    };
    // a run that spent tokens before a crash, interrupted at boot
    const crashed = await w.ask(w.mona, w.open, "fixture:success");
    t.truthy(w.rt.store.claim(w.rt.store.queued()[0]!));
    spend(crashed.run, 700);
    t.is(w.rt.store.interruptRunning(), 1);
    t.like(w.run(crashed.run), { status: "interrupted", tok: 700, bill: "included" });
    // a queued run with spent tokens whose claim is refused
    const refused = await w.ask(w.mona, w.open, "fixture:success");
    spend(refused.run, 300);
    await w.olga.ok("members.ban", { space: w.open, user: "mona" });
    t.is(w.rt.store.claim(w.rt.store.queued()[0]!), null);
    t.like(w.run(refused.run), {
      status: "failed",
      fail: { why: "access" },
      tok: 300,
      bill: "included",
    });
  },
);

registerFixture({
  scenario: "paced-search-then-answer",
  steps: [
    {
      delayMs: 5,
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        ...Array.from({ length: 200 }, () => ({
          type: "text-delta" as const,
          id: "t0",
          delta: "Looking. ",
        })),
        { type: "text-end", id: "t0" },
        {
          type: "tool-call",
          toolCallId: "call-search-1",
          toolName: "web_search",
          input: '{"query":"bloom filters"}',
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 400, noCache: 400, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 800, text: 800, reasoning: 0 },
          },
        },
      ],
    },
    {
      parts: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "A Bloom filter is a probabilistic set." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
        },
      ],
    },
  ],
});

const MEMBER_KEY = { apiKey: "sk-ant-member-key-0000000000", sealed: "v1.member-key" };

test.serial(
  "E5: the member's key removed mid-run: the call in progress finishes and closes normally, the run ends key at its next step",
  async (t) => {
    let key: typeof MEMBER_KEY | null = MEMBER_KEY;
    const allowances: Allowances = {
      weekly: () => 0,
      billing: () => "key",
      validKey: (_u, provider) => (provider === "anthropic" ? (key?.sealed ?? null) : null),
      anthropicKey: () => key,
      openaiKey: () => null,
    };
    const w = await runsWorld(t, { allowances });
    const { run } = await w.ask(w.mona, w.open, "fixture:paced-search-then-answer");
    await waitFor(() => streamedOutput(w.streamed[0]) > 20, "the first step streaming");
    key = null;
    t.like(await w.settled(run), { status: "failed", fail: { why: "key" } });
    const rows = closedRows(t, w, run);
    t.is(rows.length, 1, "no call after the key went");
    t.like(rows[0], { ending: "finish", payer: "key:anthropic", output_tokens: 800 });
    t.is(w.turns(run).length, 1, "the step that finished is kept");
    tokIsSum(t, w, run);
  },
);

test.serial(
  "E5: the allowance reached mid-run with billing key: the next step's call carries the member's key",
  async (t) => {
    const allowances: Allowances = {
      weekly: () => 1_000,
      billing: () => "key",
      validKey: (_u, provider) => (provider === "anthropic" ? MEMBER_KEY.sealed : null),
      anthropicKey: () => MEMBER_KEY,
      openaiKey: () => null,
    };
    const w = await runsWorld(t, { allowances });
    const { run } = await w.ask(w.mona, w.open, "fixture:paced-search-then-answer");
    t.like(await w.settled(run), { status: "complete", bill: "included+key:anthropic" });
    const rows = closedRows(t, w, run);
    t.like(rows[0], { payer: "included", ending: "finish" });
    t.true(rows.length >= 2);
    for (const r of rows.slice(1)) t.like(r, { payer: "key:anthropic", ending: "finish" });
    tokIsSum(t, w, run);
  },
);

test.serial(
  "a thread its author deletes while another member's branch runs stays a shell: the branch run completes, and a new ask under the shell runs",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mel, w.open, "A root question");
    await w.settled(run);
    const branch = await w.fork(w.mona, thread, "r", "fixture:paced-answer What next?");
    await waitFor(() => w.run(branch.run).status === "running", "the branch's claim");
    t.like(await w.mel.ok("threads.delete", { id: thread }), { kept: true });
    t.like(w.thread(thread), { del: true, gone: false });
    t.like(await w.settled(branch.run), { status: "complete", fail: null });
    t.truthy(w.rec(`answer:${branch.node}`));
    const again = await w.fork(w.mona, thread, "r", "fixture:success And then?");
    t.like(await w.settled(again.run), { status: "complete", fail: null });
  },
);
