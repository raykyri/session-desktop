// Admission under the daily limits: queued questions count as spent, and
// the dispatcher checks again before a queued run starts
// (`06-auth-and-users.md` §8, `05-run-lifecycle-and-streaming.md` §8).

import { nodes as nodesRepo } from "@session/db";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";

import { createHarness, runOf } from "./helpers.js";
import { collectEvents, createAgentHarness } from "./runsHelpers.js";

const DAY = 86_400_000;

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
