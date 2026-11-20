// The follow-up queue, rerun, chain order and fork parity over tRPC
// (`03-api-and-events.md` §2, steps 2.7 and 2.8 of the desktop-parity plan).

import { auth, nodes as nodesRepo, runs as runsRepo, snapshots } from "@session/db";
import type { ResearchFollowupQueueItem, SessionEvent } from "@session/shared";
import { nodeEffort, nodeModelId } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";

import type { Harness } from "./helpers.js";
import { answerTurn, createHarness, runOf } from "./helpers.js";
import { collectEvents, createAgentHarness } from "./runsHelpers.js";

async function thread(harness: Harness, login: string, model = "gpt-luna") {
  const user = harness.addUser(login);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is consistent hashing?",
    model,
    workspaceId: workspace.id,
  });
  return { user, caller, workspace, treeId: detail.tree.id, rootId: detail.tree.rootNodeId };
}

/** Commits an answer for a node the noop run service never runs. */
function complete(harness: Harness, userId: string, nodeId: string, text = "An answer.") {
  nodesRepo.setStatus(harness.db, userId, nodeId, "running");
  return snapshots.commit(harness.db, userId, {
    nodeId,
    turns: [answerTurn(nodeId, text)],
    outcome: { status: "complete" },
  });
}

function queueEvents(events: readonly SessionEvent[]): ResearchFollowupQueueItem[][] {
  return events
    .filter((event) => event.type === "research.queue.changed")
    .map((event) => event.payload["items"] as ResearchFollowupQueueItem[]);
}

test.serial("a follow-up asked while the answer streams is sent when it completes", async (t) => {
  setFixtureScenario("slow-stream");
  const harness = createAgentHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "streamer");
  const events = collectEvents(t, harness, user.id, []);

  // The claim round opens the stream and returns while it runs.
  await harness.agent.tick();
  t.is(runOf(nodesRepo.get(harness.db, user.id, rootId)).status, "running");

  const asked = await caller.followups.ask({ headNodeId: rootId, prompt: "And rebalancing?" });
  if (asked.kind !== "queued") {
    t.fail("a follow-up of a running answer is queued");
    return;
  }
  t.is(asked.item.headNodeId, rootId);
  t.is(asked.item.agent.model, "gpt-luna", "the agent defaults to the chain tail's");
  const detail = await caller.research.getTree({ treeId });
  t.deepEqual(
    detail.queues?.[rootId]?.map((item) => item.id),
    [asked.item.id],
  );
  t.deepEqual(Object.keys(await caller.followups.list({ treeId })), [rootId]);

  // The answer completes; its settlement sends the queued follow-up.
  await harness.agent.idle();
  const sent = (await caller.research.getTree({ treeId })).nodes.find(
    (node) => node.parentNodeId === rootId,
  );
  t.truthy(sent, "the queued follow-up became the root's inline child");
  t.true(sent?.inline);
  t.is(sent?.type === "exchange" ? sent.message.text : null, "And rebalancing?");
  t.is((await caller.research.getTree({ treeId })).queues, undefined);
  t.deepEqual(
    queueEvents(events).map((items) => items.map((item) => item.id)),
    [[asked.item.id], []],
    "the queue is published when the item is queued and when it is sent",
  );
  t.true(
    events.some(
      (event) =>
        event.type === "research.node.created" &&
        (event.payload["node"] as { id: string }).id === sent?.id,
    ),
  );

  await harness.settle();
  t.is(runOf(nodesRepo.get(harness.db, user.id, sent?.id ?? "")).status, "complete");

  // With the chain free, asking sends at once.
  const now = await caller.followups.ask({ headNodeId: rootId, prompt: "And replication?" });
  t.is(now.kind, "sent");
  if (now.kind === "sent") {
    t.is(now.node.parentNodeId, sent?.id, "it continues the chain's last node");
  }
});

test.serial("a send refused at dispatch waits on its item until retried", async (t) => {
  setFixtureScenario("success");
  const harness = createAgentHarness(t, {
    env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "2" },
  });
  const { user, caller, treeId, rootId } = await thread(harness, "limited");
  await harness.agent.tick();
  const first = await caller.followups.ask({ headNodeId: rootId, prompt: "First" });
  const second = await caller.followups.ask({ headNodeId: rootId, prompt: "Second" });
  t.is(first.kind, "queued");
  t.is(second.kind, "queued");
  await caller.followups.ask({ headNodeId: rootId, prompt: "Third" });

  // The root's attempt is the first run of the day, the first follow-up the
  // second; the second follow-up is checked against its author and refused.
  await harness.settle();
  await harness.settle();
  let queue = (await caller.followups.list({ treeId }))[rootId] ?? [];
  t.deepEqual(
    queue.map((item) => item.message.text),
    ["Second", "Third"],
  );
  t.regex(queue[0]?.failedReason ?? "", /daily research limit/);
  t.is(queue[1]?.failedReason, null, "only the first item records the refusal");

  // Retrying under the same limit is refused again.
  queue = await caller.followups.retry({ itemId: queue[0]?.id ?? "" });
  t.regex(queue[0]?.failedReason ?? "", /daily research limit/);

  // Cancelling the refused item moves the next one up; it is refused in turn.
  queue = await caller.followups.cancel({ itemId: queue[0]?.id ?? "" });
  t.deepEqual(
    queue.map((item) => [item.message.text, item.failedReason !== null]),
    [["Third", true]],
  );

  // A raised limit and a retry send it.
  auth.setUserLimits(harness.db, user.id, { dailyRuns: 10 });
  queue = await caller.followups.retry({ itemId: queue[0]?.id ?? "" });
  t.deepEqual(queue, []);
  await harness.settle();
  const nodes = (await caller.research.getTree({ treeId })).nodes;
  t.deepEqual(
    nodes.map((node) => (node.type === "exchange" ? node.message.text : "")),
    ["What is consistent hashing?", "First", "Third"],
  );
  t.true(nodes.every((node) => runOf(node).status === "complete"));
});

test("queued follow-ups wait while the thread is archived and send on restore", async (t) => {
  const harness = createHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "archivist", "gemini-flash");
  nodesRepo.setStatus(harness.db, user.id, rootId, "running");
  const asked = await caller.followups.ask({
    headNodeId: rootId,
    prompt: "Later",
    model: "deepseek-flash",
    effort: "high",
  });
  t.is(asked.kind, "queued");
  await caller.research.archiveTree({ treeId });
  complete(harness, user.id, rootId);
  // The settlement's dispatch is the run service's; here it is invoked by the
  // next trigger, a restore.
  await caller.research.restoreTree({ treeId });
  const child = (await caller.research.getTree({ treeId })).nodes.find(
    (node) => node.parentNodeId === rootId,
  );
  t.truthy(child);
  t.is(child ? nodeModelId(child) : null, "deepseek-flash");
  t.is(child ? nodeEffort(child) : null, "high");
  t.true(harness.runs.started.includes(child?.id ?? ""));
});

test("follow-up queue procedures validate their input and scope", async (t) => {
  const harness = createHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "owner", "gemini-flash");
  const stranger = harness.caller(harness.addUser("stranger"));
  nodesRepo.setStatus(harness.db, user.id, rootId, "running");
  await t.throwsAsync(
    caller.followups.ask({ headNodeId: rootId, prompt: "x", model: "gemini-flash", effort: "max" }),
    { message: /does not accept the reasoning effort 'max'/ },
  );
  const asked = await caller.followups.ask({ headNodeId: rootId, prompt: "Mine" });
  if (asked.kind !== "queued") {
    t.fail("expected a queued item");
    return;
  }
  await t.throwsAsync(stranger.followups.ask({ headNodeId: rootId, prompt: "Theirs" }), {
    message: /was not found/,
  });
  await t.throwsAsync(stranger.followups.cancel({ itemId: asked.item.id }), {
    message: /was not found/,
  });
  await t.throwsAsync(stranger.followups.list({ treeId }), { message: /was not found/ });
  t.deepEqual(await caller.followups.cancel({ itemId: asked.item.id }), []);
});

test.serial("a rerun of an inline follow-up waits behind its parent's rerun", async (t) => {
  setFixtureScenario("success");
  const harness = createAgentHarness(t);
  const { user, caller, rootId } = await thread(harness, "rerunner");
  await harness.settle();
  const asked = await caller.followups.ask({ headNodeId: rootId, prompt: "Inline" });
  if (asked.kind !== "sent") {
    t.fail("expected the follow-up to be sent at once");
    return;
  }
  const childId = asked.node.id;
  await harness.settle();
  t.is(runOf(nodesRepo.get(harness.db, user.id, childId)).status, "complete");

  // A complete answer is rerun in place.
  const rerunRoot = await caller.research.rerunNode({ nodeId: rootId });
  t.is(runOf(rerunRoot.nodes.find((node) => node.id === rootId)).status, "queued");
  t.is(snapshots.read(harness.db, user.id, rootId), null, "the old answer is gone");
  // Its inline follow-up may be rerun behind it.
  await caller.research.rerunNode({ nodeId: childId });
  await t.throwsAsync(caller.research.rerunNode({ nodeId: childId }), {
    message: /cannot be rerun/,
  });

  await harness.settle();
  await harness.settle();
  const root = runOf(nodesRepo.get(harness.db, user.id, rootId));
  const child = runOf(nodesRepo.get(harness.db, user.id, childId));
  t.is(root.status, "complete");
  t.is(child.status, "complete");
  const childAttempt = runsRepo.listAttempts(harness.db, childId).at(-1);
  t.true(
    (childAttempt?.startedAt ?? 0) >= (root.completedAt ?? Infinity),
    "the follow-up started after its parent's new answer",
  );
  t.is(child.attempt, 2);
});

test("setChainOrder stores exactly the chain and refuses a stale one", async (t) => {
  const harness = createHarness(t);
  const { user, caller, rootId } = await thread(harness, "orderer", "gemini-flash");
  complete(harness, user.id, rootId);
  const asked = await caller.followups.ask({ headNodeId: rootId, prompt: "Second" });
  if (asked.kind !== "sent") {
    t.fail("expected a send");
    return;
  }
  const head = await caller.research.setChainOrder({
    headNodeId: rootId,
    nodeIds: [asked.node.id, rootId],
  });
  t.deepEqual(head.chainOrder, [asked.node.id, rootId]);
  await t.throwsAsync(caller.research.setChainOrder({ headNodeId: rootId, nodeIds: [rootId] }), {
    message: /The conversation changed/,
  });
  await t.throwsAsync(
    caller.research.setChainOrder({ headNodeId: asked.node.id, nodeIds: [asked.node.id] }),
    { message: /does not start a conversation/ },
  );
});

test("forkNode takes an agent and replaces a failed question", async (t) => {
  const harness = createHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "forker", "gemini-flash");
  complete(harness, user.id, rootId);
  await t.throwsAsync(
    caller.research.forkNode({
      parentNodeId: rootId,
      prompt: "x",
      agent: { model: "gemini-flash", effort: "xhigh" },
    }),
    { message: /does not accept the reasoning effort/ },
  );
  const failed = await caller.research.forkNode({
    parentNodeId: rootId,
    prompt: "Typo questoin",
    inline: true,
  });
  nodesRepo.setStatus(harness.db, user.id, failed.id, "failed", { error: "boom" });

  const received: SessionEvent[] = [];
  const subscription = harness.eventBus.subscribe(user.id, "conn-fork");
  t.teardown(() => subscription.close());
  void (async () => {
    for await (const event of subscription.events) received.push(event);
  })();

  const edited = await caller.research.forkNode({
    parentNodeId: rootId,
    prompt: "Typo question",
    inline: true,
    replacesNodeId: failed.id,
    agent: { model: "deepseek-flash", effort: "low" },
  });
  t.is(nodeModelId(edited), "deepseek-flash");
  t.is(nodeEffort(edited), "low");
  const nodes = (await caller.research.getTree({ treeId })).nodes;
  t.deepEqual(
    nodes.map((node) => node.id),
    [rootId, edited.id],
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  t.deepEqual(received.map((event) => event.type).slice(0, 2), [
    "research.node.removed",
    "research.node.created",
  ]);
  t.deepEqual(received[0]?.payload["removedNodeIds"], [failed.id]);
});

test("queued follow-ups wait while the thread is in the Trash and send on restore", async (t) => {
  const harness = createHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "trasher", "gemini-flash");
  nodesRepo.setStatus(harness.db, user.id, rootId, "running");
  const asked = await caller.followups.ask({ headNodeId: rootId, prompt: "Later" });
  t.is(asked.kind, "queued");
  complete(harness, user.id, rootId);
  await caller.research.trashTree({ treeId });
  await t.throwsAsync(caller.followups.ask({ headNodeId: rootId, prompt: "Trashed" }), {
    message: /restore this research from the Trash/,
  });
  await t.throwsAsync(caller.research.rerunNode({ nodeId: rootId }), {
    message: /restore this research from the Trash/,
  });
  await t.throwsAsync(caller.research.setChainOrder({ headNodeId: rootId, nodeIds: [rootId] }), {
    message: /restore this research from the Trash/,
  });
  t.is((await caller.followups.list({ treeId }))[rootId]?.length, 1, "the item waits");

  await caller.research.restoreTreeFromTrash({ treeId });
  t.deepEqual(await caller.followups.list({ treeId }), {});
  const child = (await caller.research.getTree({ treeId })).nodes.find(
    (node) => node.parentNodeId === rootId,
  );
  t.true(child?.inline);
  t.true(harness.runs.started.includes(child?.id ?? ""));
});

test("a follow-up behind an answer that stopped is refused, as the desktop's ask box does", async (t) => {
  const harness = createHarness(t);
  const { user, caller, treeId, rootId } = await thread(harness, "staller", "gemini-flash");
  nodesRepo.setStatus(harness.db, user.id, rootId, "failed", { error: "boom" });
  const refused = await t.throwsAsync<TRPCError>(
    caller.followups.ask({ headNodeId: rootId, prompt: "Anyway?" }),
  );
  t.is(refused?.code, "PRECONDITION_FAILED");
  t.is(
    refused?.message,
    "The last answer stopped with an error. Retry it or edit its question to continue.",
  );
  t.deepEqual(await caller.followups.list({ treeId }), {});
});

test("an edited branch question announces the queue it takes over", async (t) => {
  const harness = createHarness(t);
  const { user, caller, rootId } = await thread(harness, "rebrancher", "gemini-flash");
  complete(harness, user.id, rootId);
  const branch = await caller.research.forkNode({ parentNodeId: rootId, prompt: "Branch" });
  const asked = await caller.followups.ask({ headNodeId: branch.id, prompt: "Behind it" });
  t.is(asked.kind, "queued");
  nodesRepo.setStatus(harness.db, user.id, branch.id, "failed", { error: "boom" });
  const events: SessionEvent[] = [];
  const subscription = harness.eventBus.subscribe(user.id, "conn-rebranch");
  t.teardown(() => subscription.close());
  void (async () => {
    for await (const event of subscription.events) events.push(event);
  })();
  const edited = await caller.research.forkNode({
    parentNodeId: rootId,
    prompt: "Branch, edited",
    replacesNodeId: branch.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const changes = events.filter((event) => event.type === "research.queue.changed");
  t.deepEqual(
    changes.map((event) => [
      event.payload["headNodeId"],
      (event.payload["items"] as ResearchFollowupQueueItem[]).map((item) => item.message.text),
    ]),
    [
      [branch.id, []],
      [edited.id, ["Behind it"]],
    ],
  );
});
