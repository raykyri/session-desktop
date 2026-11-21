// Runs across a drain, a crash and a boot (`03-agents-and-research.md` E2,
// K1; `05-run-lifecycle-and-streaming.md` §7): a drain ends an attempt
// `interrupted` with its partial text kept as a turn; a crash leaves the
// record `running` and its ledger row `open`, and boot closes the row with
// its last checkpoint, marks the run `interrupted` and resumes it, at most
// twice, replaying the turns it committed.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabase } from "@session/db";
import test from "ava";

import { bootServer } from "../src/boot.js";
import { configAllowances } from "../src/runs/allowance.js";
import { MAX_AUTO_RESUMES } from "../src/runs/dispatcher.js";
import { setFixtureScenario } from "../src/runs/fixtureProvider.js";
import { createProviders } from "../src/runs/providers.js";
import { createRunsRuntime } from "../src/runs/runtime.js";
import { SqliteLedger } from "../src/runs/sqliteLedger.js";
import { SyncService } from "../src/sync/service.js";

import type { LedgerRow } from "./recordRuns.js";
import { runsWorld, streamedOutput, turnText, waitFor } from "./recordRuns.js";
import { fakeNetwork, recordingProviders } from "./runsHelpers.js";

test.serial(
  "a drain ends the attempt interrupted, keeps its partial text as a turn and closes its row; boot resumes it",
  async (t) => {
    const w = await runsWorld(t);
    const { thread, run } = await w.ask(w.mona, w.open, "fixture:paced-answer");
    await waitFor(() => streamedOutput(w.streamed[0]) > 10, "some text");
    await w.rt.service.drain();
    const r = w.run(run);
    t.like(r, { status: "interrupted", fail: { why: "interrupted", at: null, cls: null } });
    t.false(w.thread(thread).running);
    const turns = w.turns(run);
    t.is(turns.length, 1);
    t.true(turnText(turns[0]!).startsWith("Consistent "), "the partial text is the turn");
    const [row] = w.rows(run);
    t.like(row, { state: "closed", ending: "drain" });
    t.is(row?.output_tokens, streamedOutput(w.streamed[0]));
    t.is(r.tok, row?.counted ?? null);

    // the next process boots: the run is queued again as a resume and finishes
    await w.rt.close();
    const providers = recordingProviders(createProviders(w.config));
    const next = createRunsRuntime({
      config: w.config,
      db: w.db,
      sync: w.sync,
      ledger: w.ledger,
      allowances: configAllowances(w.config),
      logger: w.logger,
      providers,
      fetch: fakeNetwork().fetch,
      pollMs: 20,
    });
    t.teardown(() => next.close());
    setFixtureScenario("success");
    t.like(next.dispatcher.boot(), { closedRows: 0, interrupted: 0, resumed: 1 });
    next.dispatcher.start();
    await waitFor(() => w.run(run).status === "complete", "the resumed run");
    await next.dispatcher.idle();
    const done = w.run(run);
    t.is(done.attempt, 1, "a resume continues the attempt");
    const all = w.turns(run);
    t.true(all.length >= 2, "the resume kept the interrupted turn and added its own");
    t.true(turnText(all[0]!).startsWith("Consistent "));
    // the resumed request replays the partial text as the assistant's
    const replayed = JSON.stringify(providers.streamed[0]?.prompt ?? []);
    t.true(replayed.includes(turnText(all[0]!).slice(0, 60)), "the partial text is replayed");
    t.is(
      done.tok,
      w.rows(run).reduce((n, x) => n + x.counted, 0),
      "the run's tok sums every row of every process",
    );
  },
);

test.serial(
  "a crash leaves the run running and its row open; boot closes the row with its last checkpoint, interrupts and resumes the run, replaying its turns",
  async (t) => {
    const checkpointMs = 100;
    const w = await runsWorld(t, { ledgerCheckpointMs: checkpointMs });
    const { run } = await w.ask(w.mona, w.open, "fixture:fetch-then-endless");
    await waitFor(() => streamedOutput(w.streamed[1]) > 600, "600 tokens of the second step");
    // The kill: the database file as it is at this instant.
    const dir = mkdtempSync(join(tmpdir(), "session-crash-"));
    t.teardown(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "session.db");
    const killedAt = Date.now();
    w.db.$client.exec(`VACUUM INTO '${path}'`);
    const streamedAtKill = streamedOutput(w.streamed[1]);
    await w.rt.close();

    const db = openDatabase(path);
    const sync = new SyncService({ db, config: w.config, logger: w.logger });
    const ledger = new SqliteLedger(db);
    const rows = () =>
      db.$client
        .prepare<[string], LedgerRow>("SELECT * FROM usage_events WHERE run_id = ? ORDER BY rowid")
        .all(run);
    const runOf = () => sync.store.byKey(`run:${run}`);
    t.like(runOf(), { status: "running" });
    t.deepEqual(
      rows().map((x) => x.state),
      ["closed", "open"],
      "the first call closed, the second open",
    );
    const providers = recordingProviders(createProviders(w.config));
    const rt = createRunsRuntime({
      config: w.config,
      db,
      sync,
      ledger,
      allowances: configAllowances(w.config),
      logger: w.logger,
      providers,
      fetch: fakeNetwork().fetch,
      pollMs: 20,
    });
    t.teardown(async () => {
      await rt.close();
      sync.drain();
      closeDatabase(db);
    });
    setFixtureScenario("success");
    const report = bootServer({
      databasePath: path,
      sync,
      ledger,
      logger: w.logger,
      dispatcher: rt.dispatcher,
    });
    t.is(report.closedRows, 1);
    t.is(report.interrupted, 1);
    const open = rows()[1]!;
    t.like(open, { state: "closed", ending: "boot" });
    t.true(open.output_tokens > 0, "checkpoints were written");
    t.true(open.output_tokens <= streamedAtKill);
    t.true(killedAt - open.updated_at < checkpointMs * 3, "the last checkpoint is recent");
    // at most one checkpoint interval of output (5 ms a chunk of 10 tokens)
    // goes unbilled
    t.true(streamedAtKill - open.output_tokens <= (checkpointMs * 2 * 10) / 5);

    await waitFor(
      () => runOf()?.kind === "run" && (runOf() as { status: string }).status === "complete",
      "the resume",
    );
    await rt.dispatcher.idle();
    // the resume replayed the committed step as context: its request holds
    // the tool call and its result
    t.true(providers.streamed.length >= 1);
    const prompt = providers.streamed[0]?.prompt ?? [];
    const parts = prompt.flatMap((m) =>
      typeof m.content === "string"
        ? []
        : (m.content as { type: string; toolCallId?: string }[]).map(
            (p) => `${m.role}:${p.type}:${p.toolCallId ?? ""}`,
          ),
    );
    t.true(parts.includes("assistant:tool-call:call-fetch-1"), "the fetch is replayed");
    t.true(parts.includes("tool:tool-result:call-fetch-1"), "with its result");
    t.true(JSON.stringify(prompt).includes("Reading the page."));
    const turns = db.$client
      .prepare<[string], { body: string }>(
        "SELECT body FROM records WHERE kind = 'turn' AND key LIKE ? ORDER BY key",
      )
      .all(`turn:${run}:1:%`)
      .map((x) => JSON.parse(x.body) as { n: number; blocks: { type: string }[] })
      .sort((a, b) => a.n - b.n);
    // the step committed before the crash stayed, and the resume added its
    // answer after it; the crashed step's text was never committed
    t.deepEqual(
      turns.map((x) => [x.n, x.blocks.map((b) => b.type)]),
      [
        [0, ["text", "toolUse", "toolResult"]],
        [1, ["text"]],
      ],
    );
    const done = runOf() as { tok: number };
    t.is(
      done.tok,
      rows().reduce((n, x) => n + x.counted, 0),
    );
  },
);

test.serial(
  "boot resumes an interrupted attempt at most twice; then it stays interrupted with Run again",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { run } = await w.ask(w.mona, w.open, "fixture:success");
    for (let k = 0; k <= MAX_AUTO_RESUMES; k += 1) {
      const [queued] = w.rt.store.queued();
      t.truthy(queued && w.rt.store.claim(queued), `claim ${k}`);
      // the process dies with the run running
      t.is(w.rt.store.interruptRunning(), 1);
      const report = w.rt.dispatcher.boot();
      t.is(report.resumed, k < MAX_AUTO_RESUMES ? 1 : 0);
    }
    t.like(w.run(run), { status: "interrupted", attempt: 1 });
    // Run again starts a new attempt, which has its own two resumes
    await w.mona.ok("research.retryNode", {
      thread: w.run(run).th,
      node: "r",
      base: { attempt: 1 },
      model: "claude-fable",
      effort: "medium",
    });
    t.like(w.run(run), { status: "queued", attempt: 2 });
  },
);

test.serial(
  "a drain while a tool call runs commits the step without the unanswered call; the boot resume's request is accepted and the run completes",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    await w.rt.close();
    const network = fakeNetwork();
    let pending = 0;
    const slow = { on: true };
    // a page fetch that never answers until it is aborted
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (!slow.on) return network.fetch(input, init);
      pending += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
    const providers = recordingProviders(createProviders(w.config));
    const make = () =>
      createRunsRuntime({
        config: w.config,
        db: w.db,
        sync: w.sync,
        ledger: w.ledger,
        allowances: configAllowances(w.config),
        logger: w.logger,
        providers,
        fetch,
        pollMs: 20,
        toolOverrides: {
          lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
        },
      });
    const first = make();
    first.dispatcher.start();
    const { run } = await w.ask(w.mona, w.open, "fixture:success-with-tools");
    await waitFor(() => pending > 0, "a tool request in flight");
    first.dispatcher.stop();
    await first.service.drain();
    first.store.close();
    t.like(w.run(run), { status: "interrupted" });
    const blocks = w.turns(run).flatMap((x) => x.blocks.map((b) => b.type));
    t.false(blocks.includes("toolUse"), "the unanswered call is not committed");
    t.true(blocks.includes("text"), "the step's text is");

    slow.on = false;
    const calls = providers.streamed.length;
    const next = make();
    t.teardown(() => next.close());
    t.like(next.dispatcher.boot(), { resumed: 1 });
    next.dispatcher.start();
    await waitFor(() => !["queued", "running"].includes(w.run(run).status), "the resume");
    await next.dispatcher.idle();
    t.like(w.run(run), { status: "complete", attempt: 1, fail: null });
    t.true(providers.streamed.length > calls, "the resumed request was made");
    t.truthy(providers.streamed[calls]?.finish, "and answered");
  },
);

test.serial(
  "a crash between a resume's record write and its count rolls back both: the resume is never left uncounted",
  async (t) => {
    const w = await runsWorld(t, { start: false });
    const { run } = await w.ask(w.mona, w.open, "fixture:success");
    t.truthy(w.rt.store.claim(w.rt.store.queued()[0]!));
    t.is(w.rt.store.interruptRunning(), 1);
    // the counter's write fails, as a process killed at that statement
    w.db.$client.exec(
      "CREATE TRIGGER die BEFORE INSERT ON run_resumes BEGIN SELECT RAISE(ABORT, 'killed'); END",
    );
    t.throws(() => w.rt.dispatcher.boot());
    t.like(w.run(run), { status: "interrupted" }, "the record write was rolled back with it");
    w.db.$client.exec("DROP TRIGGER die");
    t.like(w.rt.dispatcher.boot(), { resumed: 1 });
    t.like(w.run(run), { status: "queued" });
    t.is(
      (
        w.db.$client.prepare("SELECT resumes FROM run_resumes WHERE run_id = ?").get(run) as {
          resumes: number;
        }
      ).resumes,
      1,
    );
  },
);

test.serial(
  "L1: the wall clock counts from the run's first claim: a resume started near the limit times out at once",
  async (t) => {
    const w = await runsWorld(t, {
      start: false,
      env: { SESSION_RUN_TIMEOUT_SECONDS: "5" },
    });
    const { run } = await w.ask(w.mona, w.open, "fixture:endless-answer");
    // the run's first claim was five seconds ago
    w.sync.server.serverApply({ me: "", mutationId: "" }, (tx) => {
      const r = tx.byKey(`run:${run}`);
      if (r?.kind === "run")
        tx.put({ ...r, startedAt: new Date(Date.now() - 5_000).toISOString() });
    });
    const started = Date.now();
    w.rt.dispatcher.start();
    t.like(await w.settled(run), { status: "failed", fail: { why: "error", cls: "timeout" } });
    t.true(Date.now() - started < 3_000, `${Date.now() - started} ms`);
  },
);
