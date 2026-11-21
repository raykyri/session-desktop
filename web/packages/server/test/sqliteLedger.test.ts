// The ledger over `usage_events` (`runs/sqliteLedger.ts`; `03` K1, K5) gives
// the in-memory ledger's answers, and `usage.listRuns` reads a run's question
// from the run records through the asker's current scope (`recordRunTexts`),
// a removed thread's run listed without it (the K5 test against the real
// store).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDatabase, openDatabase, users } from "@session/db";
import type { ExecutionContext } from "ava";
import test from "ava";

import type { Ledger, LedgerCounts, Payer } from "../src/runs/ledger.js";
import { ZERO_COUNTS, weekOf } from "../src/runs/ledger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";
import { recordRunTexts } from "../src/runs/recordRunTexts.js";
import { SqliteLedger } from "../src/runs/sqliteLedger.js";

import { createHarness } from "./helpers.js";
import { channels, MODEL, newId } from "./syncHttp.js";

const NOW = Date.UTC(2026, 10, 24, 12);
const HOUR = 3_600_000;

function sqliteLedger(t: ExecutionContext): { ledger: SqliteLedger; userIds: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "session-ledger-"));
  const db = openDatabase(join(dir, "session.db"));
  t.teardown(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });
  const userIds = ["a", "b"].map(
    (login, k) =>
      users.createActive(
        db,
        { provider: "github", providerUserId: String(70 + k), login, name: login },
        { handle: `ledger_${login}` },
      ).id,
  );
  return { ledger: new SqliteLedger(db), userIds };
}

/** The same calls on a ledger, and what it answers. */
function exercise(ledger: Ledger, [a, b]: string[]) {
  const counts = (input: number, output = 0, cached = 0): LedgerCounts => ({
    ...ZERO_COUNTS,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
  });
  const open = (runId: string, userId: string, payer: Payer, at: number, attempt = 1) =>
    ledger.open({
      runId,
      attempt,
      userId,
      payer,
      week: weekOf(at),
      kind: "research",
      provider: "anthropic",
      model: "claude-fable",
      cachedInputRatio: 0.1,
      counts: counts(100),
      openedAt: at,
    });
  const r1 = open("run-1", a ?? "", "included", NOW - 2 * HOUR);
  ledger.checkpoint(r1, counts(100, 50), NOW - 2 * HOUR + 2000);
  ledger.close(r1, counts(1000, 400, 900), "finish", NOW - 2 * HOUR + 4000);
  // closing again changes nothing; nor does a checkpoint after the close
  ledger.close(r1, counts(5, 5), "cancel", NOW);
  ledger.checkpoint(r1, counts(7, 7), NOW);
  const r2 = open("run-2", a ?? "", "included", NOW - HOUR);
  ledger.checkpoint(r2, counts(200, 30), NOW - HOUR + 2000);
  const r3 = open("run-2", a ?? "", "key:anthropic", NOW - HOUR + 10, 2);
  ledger.close(r3, counts(300, 10), "finish", NOW);
  open("run-old", a ?? "", "included", NOW - 8 * 24 * HOUR);
  open("run-b", b ?? "", "included", NOW);
  const before = {
    included: ledger.includedUsage(a ?? "", weekOf(NOW)),
    run2: ledger.runTokens("run-2"),
    run2a2: ledger.runTokens("run-2", 2),
    runs: ledger.runsOf(a ?? "", weekOf(NOW)).map((r) => ({ ...r, payers: [...r.payers].sort() })),
  };
  const closed = ledger.closeOpen(NOW + 1);
  return { before, closed, after: ledger.includedUsage(a ?? "", weekOf(NOW)) };
}

test("the SQLite ledger answers as the in-memory one: open rows counted, a close is final, boot closes what is open", (t) => {
  const { ledger, userIds } = sqliteLedger(t);
  const got = exercise(ledger, userIds);
  const want = exercise(new MemoryLedger(), userIds);
  t.deepEqual(got, want);
  // cached input at the ratio: 1000 in (900 cached) and 400 out counts 100 + 90 + 400
  t.is(got.before.included, 590 + 230);
  t.is(got.closed, 3);
});

test("K5: usage.listRuns reads each run's question from its records; a removed thread's run is listed without it", async (t) => {
  const h = createHarness(t, { deps: { now: () => NOW } });
  const { olga, mel, open, closed } = await channels(h);
  const sqlLedger = new SqliteLedger(h.db);
  h.deps.ledger = sqlLedger;
  h.deps.runTexts = recordRunTexts({
    source: h.sync.store,
    handleOf: (id) => users.findById(h.db, id)?.handle ?? null,
  });
  const ask = async (p: typeof mel, space: string, q: string) => {
    const id = newId();
    const r = (await p.ok("threads.create", { id, space, kind: "ask", q, ...MODEL })) as {
      run: string;
    };
    return { thread: id, run: r.run };
  };
  const kept = await ask(mel, open, "The kept question");
  const removed = await ask(mel, open, "The removed question");
  const left = await ask(mel, closed, "The left question");
  for (const [k, r] of [kept, removed, left].entries())
    sqlLedger.open({
      runId: r.run,
      attempt: 1,
      userId: mel.user.id,
      payer: "included",
      week: weekOf(NOW),
      kind: "research",
      provider: "anthropic",
      model: "claude-fable",
      cachedInputRatio: 0.1,
      counts: { ...ZERO_COUNTS, inputTokens: 10 },
      openedAt: NOW - k * HOUR,
    });
  await olga.ok("moderation.decide", {
    item: `a:${removed.thread}`,
    decision: "removed",
    note: "Off topic.",
  });
  await mel.ok("spaces.leave", { space: closed });
  const page = await h.caller(mel.user).usage.listRuns();
  t.deepEqual(
    page.runs.map((run) => [run.runId, run.question, run.missing]),
    [
      [kept.run, "The kept question", null],
      [removed.run, null, "removed"],
      [left.run, null, "unavailable"],
    ],
  );
  t.false(JSON.stringify(page).includes("The removed question"));
  t.false(JSON.stringify(page).includes("The left question"));
  t.is(page.runs[1]?.tokens, 10);
});
