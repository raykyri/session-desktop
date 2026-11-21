// The run tables beside the records (`01` D3; `03` E2, T3, T4): `run_live`
// holds one in-flight checkpoint per attempt, replaced in place, and
// `run_resumes` the automatic resumes of an attempt.

import test from "ava";

import { RunTables } from "../src/index.js";

import { createFixture } from "./helpers.js";

const row = (runId: string, attempt: number, md: string, seq: number) => ({
  runId,
  attempt,
  turnId: `${runId}-assistant-0`,
  n: 0,
  md,
  seq,
  updatedAt: 1_700_000_000_000 + seq,
});

test("a checkpoint is one row per attempt, replaced in place", (t) => {
  const { db } = createFixture(t);
  const tables = new RunTables(db);
  t.is(tables.live("R", 1), null);
  tables.putLive(row("R", 1, "Consistent ", 1));
  tables.putLive({ ...row("R", 1, "Consistent hashing", 2), n: 1, turnId: "" });
  t.deepEqual(tables.live("R", 1), {
    ...row("R", 1, "Consistent hashing", 2),
    n: 1,
    turnId: "",
  });
  t.deepEqual(tables.liveAttempts(), [{ runId: "R", attempt: 1 }]);
});

test("checkpoints are deleted by attempt, by every other attempt, or by run", (t) => {
  const { db } = createFixture(t);
  const tables = new RunTables(db);
  for (const [run, attempt] of [
    ["R", 1],
    ["R", 2],
    ["R", 3],
    ["S", 1],
  ] as const)
    tables.putLive(row(run, attempt, "text", 1));
  tables.dropOtherAttempts("R", 2);
  t.deepEqual(tables.liveAttempts(), [
    { runId: "R", attempt: 2 },
    { runId: "S", attempt: 1 },
  ]);
  tables.dropLive("R", 1);
  t.truthy(tables.live("R", 2), "another attempt's row stays");
  tables.dropLive("R", 2);
  t.is(tables.live("R", 2), null);
  tables.putLive(row("S", 2, "text", 1));
  tables.dropLive("S");
  t.deepEqual(tables.liveAttempts(), []);
});

test("resumes count per attempt", (t) => {
  const { db } = createFixture(t);
  const tables = new RunTables(db);
  t.is(tables.resumes("R", 1), 0);
  tables.setResumes("R", 1, 1);
  tables.setResumes("R", 1, 2);
  tables.setResumes("R", 2, 1);
  t.is(tables.resumes("R", 1), 2);
  t.is(tables.resumes("R", 2), 1);
  t.is(tables.resumes("S", 1), 0);
});
