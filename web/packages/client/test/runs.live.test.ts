// The client's rule for run deltas (`03-agents-and-research.md` T1, T3): a
// delta applies only when its `seq` is the next for its `(run, attempt)`;
// a duplicate and a delta of an older attempt are dropped; a gap reads
// `/live`; and a reader that misses every delta still ends on the answer the
// records carry.

import type { RunRec, StoredRecord } from "@session/mutators";
import test from "ava";

import { runTextOf } from "../src/replica/queries.js";
import { RunLiveTexts, type LiveRead, type RunDelta } from "../src/replica/runLive.js";
import type { ReplicaSource } from "../src/replica/source.js";

const d = (seq: number, text: string, o: Partial<RunDelta> = {}): RunDelta => ({
  run: "R",
  attempt: 1,
  seq,
  n: 0,
  text,
  ...o,
});

function texts(answer: (run: string) => LiveRead | null = () => null) {
  const reads: string[] = [];
  let changes = 0;
  const pending: (() => void)[] = [];
  const live = new RunLiveTexts({
    read: (run) => {
      reads.push(run);
      return new Promise((resolve) => pending.push(() => resolve(answer(run))));
    },
    onChange: () => (changes += 1),
  });
  const settle = async () => {
    while (pending.length) {
      pending.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { live, reads, settle, changes: () => changes };
}

test("T3: deltas in order apply; a duplicate and a lower seq are dropped", (t) => {
  const { live, reads } = texts();
  live.apply(d(1, "Consistent "));
  live.apply(d(2, "hashing "));
  live.apply(d(2, "hashing "));
  live.apply(d(1, "Consistent "));
  live.apply(d(3, "places"));
  t.like(live.get("R"), { attempt: 1, n: 0, seq: 3, text: "Consistent hashing places" });
  t.deepEqual(reads, []);
});

test("T3: a gap reads /live, which replaces the text with the checkpoint and its seq", async (t) => {
  const { live, reads, settle } = texts(() => ({
    attempt: 1,
    live: { n: 0, text: "Consistent hashing places both keys", seq: 5 },
  }));
  live.apply(d(1, "Consistent "));
  live.apply(d(4, "both "));
  t.deepEqual(reads, ["R"]);
  t.like(live.get("R"), { seq: 1, text: "Consistent " }, "nothing applies past the gap");
  await settle();
  t.like(live.get("R"), { seq: 5, text: "Consistent hashing places both keys" });
  live.apply(d(6, " and nodes"));
  t.is(live.get("R")?.text, "Consistent hashing places both keys and nodes");
});

test("T3: a delta of an older attempt is dropped; a newer attempt starts over", async (t) => {
  const { live, reads, settle } = texts(() => ({
    attempt: 2,
    live: { n: 0, text: "Second try so far", seq: 9 },
  }));
  live.apply(d(1, "First ", { attempt: 2 }));
  live.apply(d(7, "late text of attempt one", { attempt: 1 }));
  t.like(live.get("R"), { attempt: 2, text: "First " });
  // a newer attempt seen past its first delta reads /live
  live.apply(d(4, "x", { attempt: 3 }));
  t.deepEqual(reads, ["R"]);
  await settle();
  t.like(live.get("R"), { attempt: 2 }, "an older answer does not replace a newer attempt");
});

test("T3: a delta of the next turn replaces the text; a reconnect reads /live again", async (t) => {
  const { live, reads, settle } = texts(() => ({ attempt: 1, live: null }));
  live.apply(d(1, "Looking this up."));
  live.apply(d(2, "A Bloom filter", { n: 1 }));
  t.like(live.get("R"), { n: 1, text: "A Bloom filter" });
  live.reconnected();
  t.deepEqual(reads, ["R"]);
  await settle();
  t.is(live.get("R"), null, "the run has nothing streaming any more");
});

/** A replica holding a run and its committed turns, with live text. */
function source(records: StoredRecord[], liveText: ReplicaSource["liveText"] | null) {
  const byKey = new Map(records.map((r) => [`${r.kind}:${"id" in r ? r.id : ""}`, r]));
  return {
    me: null,
    ready: () => true,
    get: (key: string) => byKey.get(key),
    list: (kind: string) => records.filter((r) => r.kind === kind),
    all: () => [],
    complete: () => true,
    version: () => 0,
    subscribe: () => () => {},
    mutate: () => Promise.reject(new Error("no writes")),
    now: () => 0,
    ...(liveText ? { liveText } : {}),
  } as unknown as ReplicaSource;
}

const run: RunRec = {
  kind: "run",
  id: "R",
  th: "T",
  s: "S",
  node: "r",
  u: "mona",
  model: "gemini-flash",
  effort: "medium",
  pay: "included",
  status: "running",
  attempt: 1,
  step: 3,
  fail: null,
  tok: null,
  bill: null,
  note: null,
  createdAt: "2026-11-21T10:00:00Z",
  startedAt: "2026-11-21T10:00:00Z",
  finishedAt: null,
  rev: 2,
};

const turn = (n: number, text: string): StoredRecord => ({
  kind: "turn",
  run: "R",
  attempt: 1,
  n,
  th: "T",
  s: "S",
  role: "assistant",
  blocks: [{ type: "text", text }],
  createdAt: "2026-11-21T10:00:00Z",
  rev: 1,
});

test("T1: a reader that received every delta and one that dropped them all show the same text once the turns commit", (t) => {
  const streamed = new RunLiveTexts({ read: () => Promise.resolve(null), onChange: () => {} });
  const parts = ["Consistent ", "hashing ", "places keys on a ring."];
  parts.forEach((text, i) => streamed.apply(d(i + 1, text)));
  // while streaming: the delta reader shows the text, the other nothing yet
  const withDeltas = source([run], (r) => streamed.get(r));
  const without = source([run], null);
  t.is(runTextOf(withDeltas, run), "Consistent hashing places keys on a ring.");
  t.is(runTextOf(without, run), "");
  // the turn commits: both read it from the record, and the held text
  // belongs to the next turn, which has none yet
  const committed = [run, turn(0, "Consistent hashing places keys on a ring.")];
  const after = (live: ReplicaSource["liveText"] | null) => runTextOf(source(committed, live), run);
  t.is(
    after((r) => streamed.get(r)),
    "Consistent hashing places keys on a ring.",
    "a held text of a committed turn is not shown twice",
  );
  t.is(after(null), "Consistent hashing places keys on a ring.");
});

test("T3: a delta of an older attempt changes nothing and reads nothing, at any seq", (t) => {
  const { live, reads } = texts();
  live.apply(d(1, "Second try ", { attempt: 2 }));
  live.apply(d(2, "late text of attempt one", { attempt: 1 }));
  t.deepEqual(reads, [], "no /live read right after the old attempt's delta");
  live.apply(d(1, "first text of attempt one", { attempt: 1 }));
  t.like(live.get("R"), { attempt: 2, seq: 1, text: "Second try " });
  t.deepEqual(reads, []);
});

test("T3: /live for an older attempt does not replace a newer one", async (t) => {
  const { live, reads, settle } = texts(() => ({
    attempt: 1,
    live: { n: 0, text: "Attempt one's checkpoint", seq: 50 },
  }));
  live.apply(d(1, "Second try ", { attempt: 2 }));
  live.reconnected();
  t.deepEqual(reads, ["R"]);
  await settle();
  t.like(live.get("R"), { attempt: 2, seq: 1, text: "Second try " });
});

test("T3: a /live answer older than the deltas that arrived during the read does not rewind", async (t) => {
  const { live, settle } = texts(() => ({
    attempt: 1,
    live: { n: 0, text: "Consistent hashing ", seq: 2 },
  }));
  live.apply(d(1, "Consistent "));
  live.reconnected();
  live.apply(d(2, "hashing "));
  live.apply(d(3, "places"));
  await settle();
  t.like(live.get("R"), { seq: 3, text: "Consistent hashing places" });
});

test("T3: a failed /live read is tried again with a growing wait until it answers; a drop stops it", async (t) => {
  let failures = 2;
  const reads: number[] = [];
  const started = Date.now();
  const live = new RunLiveTexts({
    read: () => {
      reads.push(Date.now() - started);
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error("503"));
      }
      return Promise.resolve({ attempt: 1, live: { n: 0, text: "Read at last", seq: 4 } });
    },
    onChange: () => {},
    retryMs: 20,
    maxRetryMs: 40,
  });
  live.apply(d(2, "a gap"));
  const until = async (ok: () => boolean) => {
    while (!ok()) await new Promise((r) => setTimeout(r, 5));
  };
  await until(() => live.get("R") !== null);
  t.like(live.get("R"), { seq: 4, text: "Read at last" });
  t.is(reads.length, 3);
  // A timer never fires early, so the second wait is at least the doubled
  // 40 ms; comparing the two measured gaps fails when a loaded machine
  // delays the first. (2 ms of slack for Date.now's rounding.)
  t.true((reads[1] ?? 0) - (reads[0] ?? 0) >= 18, "it waits retryMs first");
  t.true((reads[2] ?? 0) - (reads[1] ?? 0) >= 38, "then twice as long");

  // a run dropped while its read is failing is not read again
  failures = 100;
  live.apply(d(9, "another gap"));
  await until(() => reads.length === 4);
  live.drop("R");
  await new Promise((r) => setTimeout(r, 120));
  t.is(reads.length, 4);
  t.is(live.get("R"), null);
});

test("T3: the answer of a read begun before a drop is ignored", async (t) => {
  const { live, settle } = texts(() => ({
    attempt: 1,
    live: { n: 0, text: "Text of a run that ended", seq: 8 },
  }));
  live.apply(d(3, "a gap"));
  live.drop("R");
  await settle();
  t.is(live.get("R"), null);
});
