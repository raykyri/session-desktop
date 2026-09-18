// The Phase 3 exit path: create → (simulated) stream → highlight → follow-up
// → cancel → retry → archive, over tRPC and the event bus
// (`00-plan.md` §5 Phase 3, `12-testing-linting-ci.md` §3.4).

import { runs as runsRepo, snapshots } from "@session/db";
import type { SessionEvent } from "@session/shared";
import { RESEARCH_DOCUMENT_BYTE_LIMIT } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { sessionEvent } from "../src/events/bus.js";

import { anchorFor, answerTurn, createHarness } from "./helpers.js";

test("a research thread runs from launch to archive", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("researcher");
  const caller = harness.caller(user);

  const workspace = await caller.workspaces.ensureDefault();
  t.truthy(workspace.id);

  // Launch. The node is admitted, queued, and handed to the run service.
  const detail = await caller.research.createTree({
    prompt: "What is a bloom filter?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const root = detail.nodes[0];
  t.truthy(root);
  t.is(root?.status, "queued");
  t.deepEqual(harness.runs.started, [root?.id]);

  // The snapshot a fresh viewer gets: no turns yet, a queue position, a seq.
  const queued = await caller.research.getNodeContent({ nodeId: root?.id ?? "" });
  t.is(queued.turns.length, 0);
  t.is(queued.queuePosition, 1);
  t.is(queued.seq, 0);

  // Stand in for the agent loop: commit a turn and publish the run events the
  // way `runs/loop.ts` will in Phase 4.
  const received: SessionEvent[] = [];
  const subscription = harness.eventBus.subscribe(user.id, "conn-1");
  harness.eventBus.setInterest(user.id, "conn-1", [root?.id ?? ""]);
  const collector = (async () => {
    for await (const event of subscription.events) {
      received.push(event);
      if (event.type === "research.run.finished") {
        break;
      }
    }
  })();

  const nodeId = root?.id ?? "";
  const answer = "A bloom filter is a probabilistic set membership structure.";
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.run.started", { nodeId, attempt: 1, seq: 1, model: "gemini-flash" }),
  );
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.turn.delta", { nodeId, seq: 2, turnId: `${nodeId}-turn`, text: answer }),
  );
  const committed = runsRepo.commitTurn(harness.db, user.id, {
    nodeId,
    turn: answerTurn(nodeId, answer),
  });
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.turn.committed", {
      nodeId,
      seq: committed.seq,
      turn: answerTurn(nodeId, answer),
    }),
  );

  // Mid-run the snapshot comes from `run_turns`.
  const live = await caller.research.getNodeContent({ nodeId });
  t.is(live.turns.length, 1);
  t.is(live.seq, committed.seq);
  t.is(live.responseRevision, undefined);

  const commit = snapshots.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, answer)],
    outcome: { status: "complete" },
  });
  harness.eventBus.emit(
    user.id,
    sessionEvent("research.run.finished", {
      nodeId,
      attempt: 1,
      seq: commit.node.attempt,
      status: "complete",
    }),
  );
  await collector;
  subscription.close();

  t.deepEqual(
    received.map((event) => event.type),
    [
      "research.run.started",
      "research.turn.delta",
      "research.turn.committed",
      "research.run.finished",
    ],
  );
  const seqs = received.map((event) => event.payload["seq"]);
  t.deepEqual(seqs.slice(0, 3), [1, 2, committed.seq]);

  // Settled: the durable snapshot wins over the live window.
  const settled = await caller.research.getNodeContent({ nodeId });
  t.is(settled.node.status, "complete");
  t.is(settled.responseRevision, commit.revision);
  t.is(settled.turns.length, 1);
  t.is(settled.queuePosition, undefined);

  // Highlight a passage of that revision.
  const highlight = await caller.highlights.create({
    nodeId,
    anchor: anchorFor(commit.revision, "bloom filter", 2),
  });
  t.is(highlight.anchor.exact, "bloom filter");
  const feed = await caller.highlights.listFeed({ workspaceId: workspace.id });
  t.is(feed.length, 1);

  // Follow up on another model.
  const child = await caller.research.forkNode({
    parentNodeId: nodeId,
    prompt: "How do false positives scale?",
    model: "deepseek-flash",
  });
  t.is(child.model, "deepseek-flash");
  t.is(child.status, "queued");
  t.deepEqual(harness.runs.started, [nodeId, child.id]);

  // Cancel it, then retry it.
  const cancelled = await caller.research.cancelNode({ nodeId: child.id });
  t.is(cancelled.status, "cancelled");
  t.deepEqual(harness.runs.cancelled, [child.id]);
  await t.throwsAsync(caller.research.cancelNode({ nodeId: child.id }), {
    message: /already in terminal status/,
  });

  const retried = await caller.research.retryNode({ nodeId: child.id });
  const retriedChild = retried.nodes.find((node) => node.id === child.id);
  t.is(retriedChild?.status, "queued");
  t.is(retriedChild?.attempt, 2);

  // Archive and restore the thread.
  await caller.research.cancelNode({ nodeId: child.id });
  const archived = await caller.research.archiveTree({ treeId: detail.tree.id });
  t.truthy(archived.archivedAt);
  t.is((await caller.research.listTrees()).length, 0);
  t.is((await caller.research.listTrees({ includeArchived: true })).length, 1);
  const restored = await caller.research.restoreTree({ treeId: detail.tree.id });
  t.is(restored.archivedAt ?? null, null);
});

test("a gated model is refused for a non-admin and allowed for an admin", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("plain");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  await t.throwsAsync(
    caller.research.createTree({
      prompt: "gated",
      model: "claude-fable",
      workspaceId: workspace.id,
    }),
    { message: /not available on this account/ },
  );
  const models = (await caller.system.runtimeConfig()).models.map((model) => model.id);
  t.false(models.includes("claude-fable"));

  const admin = harness.addUser("chief", { isAdmin: true });
  const adminCaller = harness.caller(admin);
  const adminWorkspace = await adminCaller.workspaces.ensureDefault();
  const detail = await adminCaller.research.createTree({
    prompt: "gated",
    model: "claude-fable",
    workspaceId: adminWorkspace.id,
  });
  t.is(detail.nodes[0]?.model, "claude-fable");
  t.true((await adminCaller.system.runtimeConfig()).models.some((m) => m.id === "claude-fable"));
});

test("a model without a credential is unavailable and cannot be launched", async (t) => {
  const harness = createHarness(t, { env: { ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" } });
  const admin = harness.addUser("chief", { isAdmin: true });
  const caller = harness.caller(admin);
  const workspace = await caller.workspaces.ensureDefault();
  const models = await caller.system.runtimeConfig();
  t.false(models.models.find((model) => model.id === "claude-fable")?.available);
  t.true(models.models.find((model) => model.id === "gemini-flash")?.available);
  await t.throwsAsync(
    caller.research.createTree({ prompt: "x", model: "gpt-luna", workspaceId: workspace.id }),
    { message: /not configured on this deployment/ },
  );
});

test("daily limits refuse a launch only when enforcement is on", async (t) => {
  const harness = createHarness(t, {
    env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "1" },
  });
  const user = harness.addUser("limited");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "first",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  // `daily_runs` counts attempts, which `run_attempts` records; simulate the
  // first attempt starting.
  runsRepo.startAttempt(harness.db, {
    nodeId: detail.nodes[0]?.id ?? "",
    attempt: 1,
    kind: "fresh",
    model: "gemini-flash",
  });
  await t.throwsAsync(
    caller.research.createTree({
      prompt: "second",
      model: "gemini-flash",
      workspaceId: workspace.id,
    }),
    { message: /daily research limit/ },
  );
  // An admin is exempt.
  const admin = harness.addUser("chief", { isAdmin: true });
  const adminCaller = harness.caller(admin);
  const adminWorkspace = await adminCaller.workspaces.ensureDefault();
  await t.notThrowsAsync(
    adminCaller.research.createTree({
      prompt: "exempt",
      model: "gemini-flash",
      workspaceId: adminWorkspace.id,
    }),
  );
});

test("a second inline follow-up is a conflict and a foreign id is not found", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("owner");
  const stranger = harness.addUser("stranger");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "root",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  snapshots.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, "an answer")],
    outcome: { status: "complete" },
  });
  await caller.research.forkNode({ parentNodeId: nodeId, prompt: "more", inline: true });
  await t.throwsAsync(
    caller.research.forkNode({ parentNodeId: nodeId, prompt: "again", inline: true }),
    { message: /inline follow-up/ },
  );
  // Another account's node is `NOT_FOUND`, never `FORBIDDEN`.
  await t.throwsAsync(harness.caller(stranger).research.getNodeContent({ nodeId }), {
    message: /was not found/,
  });
});

test("an imported report becomes a complete document thread", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("importer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.importReport({
    markdown: "# Bloom filters\n\nA short imported report.",
    prompt: "imported report",
    workspaceId: workspace.id,
  });
  const node = detail.nodes[0];
  t.is(node?.status, "complete");
  t.is(node?.kind, "document");
  t.is(node?.origin, "imported");
  t.is(detail.tree.title, "Bloom filters");
  const content = await caller.research.getNodeContent({ nodeId: node?.id ?? "" });
  t.true(content.turns.length > 0);
  t.truthy(content.responseRevision);
  // Nothing was queued: an import has no run.
  t.deepEqual(harness.runs.started, []);
});

test("recap generation needs the agent loop; applying a candidate does not", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("summarizer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "root",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  const commit = snapshots.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, "an answer worth summarizing")],
    outcome: { status: "complete" },
  });

  t.is(typeof (await caller.recaps.defaultInstructions()), "string");
  await t.throwsAsync(
    caller.recaps.generateCandidate({
      nodeId,
      expectedResponseRevision: commit.revision,
      instructions: "Summarize in one sentence.",
    }),
    { message: /not available on this server/ },
  );
  t.is(harness.runs.metadata.at(-1)?.kind, "recap");

  const node = await caller.recaps.applyCandidate({
    nodeId,
    expectedResponseRevision: commit.revision,
    candidate: {
      id: "candidate-1",
      text: "A summary.",
      responseRevision: commit.revision,
      generatedAt: Date.now(),
      model: "gemini-flash",
      instructions: "Summarize in one sentence.",
    },
  });
  t.is(node.recap?.text, "A summary.");

  // Without a metadata runner the title falls back to the one the node has.
  const title = await caller.research.generateTitle({ nodeId });
  t.is(typeof title, "string");
  t.is(harness.runs.metadata.at(-1)?.kind, "title");
});

test("an oversized import is a bad request, not a server error", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("importer"));
  const workspace = await caller.workspaces.ensureDefault();
  const error = await t.throwsAsync(
    caller.research.importReport({
      markdown: "#".repeat(RESEARCH_DOCUMENT_BYTE_LIMIT + 1),
      prompt: "too much",
      workspaceId: workspace.id,
    }),
  );
  t.is((error as TRPCError).code, "BAD_REQUEST");
});

test("a foreign id in a reorder is not found rather than a bad request", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("owner2"));
  const stranger = harness.caller(harness.addUser("stranger2"));
  await caller.workspaces.ensureDefault();
  const foreign = await stranger.workspaces.ensureDefault();
  const error = await t.throwsAsync(caller.workspaces.reorder({ workspaceIds: [foreign.id] }));
  t.is((error as TRPCError).code, "NOT_FOUND");
});
