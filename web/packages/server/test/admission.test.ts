// Admission under the daily limits and the queued-per-account cap: checked
// again right before the node is admitted, so concurrent launches cannot
// pass together, and again by the dispatcher before a queued run starts
// (`06-auth-and-users.md` §8, `05-run-lifecycle-and-streaming.md` §8).

import { nodes as nodesRepo, queue as queueRepo, snapshots } from "@session/db";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";

import type { Harness } from "./helpers.js";
import { answerTurn, createHarness, runOf } from "./helpers.js";
import { collectEvents, createAgentHarness } from "./runsHelpers.js";

const DAY = 86_400_000;

/** A root question whose answer is complete, so follow-ups can be sent at
 * once. */
async function answeredRoot(harness: Harness, caller: ReturnType<Harness["caller"]>, n: number) {
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: `Root ${n}`,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  const userId = detail.nodes[0]?.authorId ?? "";
  snapshots.commit(harness.db, userId, {
    nodeId,
    turns: [answerTurn(nodeId, "an answer")],
    outcome: { status: "complete" },
  });
  queueRepo.release(harness.db, nodeId);
  return nodeId;
}

function refusals(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [(result.reason as TRPCError).code] : [],
  );
}

test("concurrent questions cannot pass the queued-per-account cap together", async (t) => {
  const harness = createHarness(t, { env: { SESSION_QUEUED_PER_USER: "1" } });
  const user = harness.addUser("racer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((n) =>
      caller.research.createTree({
        prompt: `Concurrent ${n}`,
        model: "gemini-flash",
        workspaceId: workspace.id,
      }),
    ),
  );
  t.is(results.filter((result) => result.status === "fulfilled").length, 1);
  t.deepEqual(refusals(results), Array(4).fill("TOO_MANY_REQUESTS"));
  t.is(queueRepo.queuedCount(harness.db, user.id), 1);
});

test("concurrent follow-ups cannot pass the queued-per-account cap together", async (t) => {
  const harness = createHarness(t, { env: { SESSION_QUEUED_PER_USER: "1" } });
  const user = harness.addUser("fork-racer");
  const caller = harness.caller(user);
  const parent = await answeredRoot(harness, caller, 1);
  const forks = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((n) =>
      caller.research.forkNode({ parentNodeId: parent, prompt: `Branch ${n}` }),
    ),
  );
  t.is(forks.filter((result) => result.status === "fulfilled").length, 1);
  t.is(queueRepo.queuedCount(harness.db, user.id), 1);

  const other = createHarness(t, { env: { SESSION_QUEUED_PER_USER: "1" } });
  const asker = other.addUser("ask-racer");
  const askCaller = other.caller(asker);
  const heads: string[] = [];
  for (const n of [1, 2, 3, 4, 5]) heads.push(await answeredRoot(other, askCaller, n));
  const asks = await Promise.allSettled(
    heads.map((headNodeId, n) => askCaller.followups.ask({ headNodeId, prompt: `Ask ${n}` })),
  );
  t.is(asks.filter((result) => result.status === "fulfilled").length, 1);
  t.is(queueRepo.queuedCount(other.db, asker.id), 1);
});

test("concurrent questions cannot pass the daily run limit together", async (t) => {
  const harness = createHarness(t, {
    env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "2" },
  });
  const user = harness.addUser("daily-racer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((n) =>
      caller.research.createTree({
        prompt: `Concurrent ${n}`,
        model: "gemini-flash",
        workspaceId: workspace.id,
      }),
    ),
  );
  t.is(results.filter((result) => result.status === "fulfilled").length, 2);
  t.deepEqual(refusals(results), Array(3).fill("TOO_MANY_REQUESTS"));
});

test("queued questions count against the daily run limit at admission", async (t) => {
  const harness = createHarness(t, {
    env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "2" },
  });
  const user = harness.addUser("reserver");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const launch = (prompt: string) =>
    caller.research.createTree({ prompt, model: "gemini-flash", workspaceId: workspace.id });
  // Nothing has started yet; the two queued questions are the day's two runs.
  await launch("first");
  await launch("second");
  await t.throwsAsync(launch("third"), { message: /daily research limit/ });
  // A question that leaves the queue without running gives its run back.
  const trees = await caller.research.listTrees({ workspaceId: workspace.id });
  await caller.research.cancelNode({ nodeId: trees[0]?.rootNodeId ?? "" });
  await t.notThrowsAsync(launch("fourth"));
});

test.serial(
  "the dispatcher holds a queued run until midnight when the payer's day is spent",
  async (t) => {
    setFixtureScenario("success");
    const harness = createAgentHarness(t, {
      env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "2" },
    });
    const user = harness.addUser("over-limit");
    const admin = harness.addUser("limits-admin", { isAdmin: true });
    const caller = harness.caller(user);
    const workspace = await caller.workspaces.ensureDefault();
    const first = await caller.research.createTree({
      prompt: "first",
      model: "gemini-flash",
      workspaceId: workspace.id,
    });
    const second = await caller.research.createTree({
      prompt: "second",
      model: "gemini-flash",
      workspaceId: workspace.id,
    });
    const firstId = first.nodes[0]?.id ?? "";
    const secondId = second.nodes[0]?.id ?? "";
    const events = collectEvents(t, harness, user.id, [firstId, secondId]);
    // Both were admitted under a limit of two; the limit is lowered before
    // either starts.
    await harness.caller(admin).admin.setLimits({ userId: user.id, dailyRuns: 1 });

    await harness.settle();
    t.is(runOf(nodesRepo.get(harness.db, user.id, firstId)).status, "complete");
    const held = nodesRepo.get(harness.db, user.id, secondId);
    t.is(runOf(held).status, "queued", "the second run did not start");
    t.regex(runOf(held).error ?? "", /daily research limit resets at midnight UTC/);
    const row = harness.db.$client
      .prepare(
        "SELECT claimed_at AS claimedAt, not_before AS notBefore FROM run_queue WHERE node_id = ?",
      )
      .get(secondId) as { claimedAt: number | null; notBefore: number | null };
    t.is(row.claimedAt, null);
    t.is(
      row.notBefore,
      Math.floor(Date.now() / DAY) * DAY + DAY,
      "held until the next UTC midnight",
    );
    await new Promise((resolve) => setImmediate(resolve));
    t.true(
      events.some(
        (event) =>
          event.type === "research.node.updated" &&
          (event.payload["node"] as { id?: string; run?: { error?: string } }).id === secondId &&
          /daily research limit/.test(
            (event.payload["node"] as { run?: { error?: string } }).run?.error ?? "",
          ),
      ),
      "readers are told why it waits",
    );

    // Raising the limit releases it without waiting for midnight.
    await harness.caller(admin).admin.setLimits({ userId: user.id, dailyRuns: 5 });
    await harness.settle();
    const ran = nodesRepo.get(harness.db, user.id, secondId);
    t.is(runOf(ran).status, "complete");
    t.is(runOf(ran).error ?? null, null);
  },
);
