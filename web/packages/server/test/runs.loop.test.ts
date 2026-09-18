// The agent loop against recorded provider streams
// (`12-testing-linting-ci.md` §3.3, `05-run-lifecycle-and-streaming.md`).

import { messages as messagesRepo, nodes as nodesRepo, runs as runsRepo, usage } from "@session/db";
import type { SessionEvent, Turn } from "@session/shared";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";

import { createHarness } from "./helpers.js";
import { collectEvents, createAgentHarness, nextProcessAgent } from "./runsHelpers.js";

function typesOf(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

function seqsOf(events: readonly SessionEvent[]): number[] {
  return events.flatMap((event) =>
    typeof event.payload["seq"] === "number" ? [event.payload["seq"]] : [],
  );
}

async function launch(
  harness: ReturnType<typeof createAgentHarness>,
  login: string,
  prompt = "What is a bloom filter?",
) {
  const user = harness.addUser(login);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt,
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  return { user, caller, workspace, nodeId };
}

test.serial(
  "a successful run streams, persists, snapshots, and schedules its metadata",
  async (t) => {
    setFixtureScenario("success-with-tools");
    const harness = createAgentHarness(t);
    const { user, caller, nodeId } = await launch(harness, "researcher");
    const events = collectEvents(t, harness, user.id, [nodeId]);

    await harness.settle();

    // Events arrive in the documented order, with a strictly increasing `seq`.
    const types = typesOf(events);
    const at = (type: string): number => types.indexOf(type);
    t.is(types.at(0), "research.node.updated", "the run to running is published first");
    t.true(at("research.run.started") > 0);
    t.true(at("research.run.thinking") > at("research.run.started"), "thinking follows the start");
    t.true(at("research.turn.delta") > at("research.run.started"), "deltas follow the start");
    t.true(
      at("research.turn.committed") > at("research.turn.delta"),
      "a turn is committed after its deltas",
    );
    t.true(
      at("research.run.finished") > at("research.turn.committed"),
      "the run finishes after its last committed turn",
    );
    t.true(
      types.lastIndexOf("research.node.updated") > at("research.run.finished"),
      "a terminal node update follows the finish",
    );

    const seqs = seqsOf(events);
    t.true(seqs.length > 3);
    t.deepEqual(
      seqs,
      [...seqs].sort((left, right) => left - right),
      "run event sequences never go backwards",
    );
    t.is(new Set(seqs).size, seqs.length, "no sequence number is reused");

    // The node settled with a durable answer.
    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(node?.status, "complete");
    t.truthy(node?.responseSnapshotAt);
    t.regex(node?.responsePreview ?? "", /Bloom filter/);

    const content = await caller.research.getNodeContent({ nodeId });
    t.truthy(content.responseRevision);
    const blocks = content.turns.flatMap((turn: Turn) => turn.blocks);
    t.true(blocks.some((block) => block.type === "toolUse" && block.name === "web_search"));
    t.true(blocks.some((block) => block.type === "toolUse" && block.name === "web_fetch"));
    t.true(blocks.some((block) => block.type === "toolResult"));
    t.true(
      blocks.some((block) => block.type === "text" && block.text.includes("[[Bloom filter]]")),
      "the answer keeps its wikilinks",
    );

    // `run_turns` is cleared by the snapshot commit.
    t.is(runsRepo.liveWindow(harness.db, user.id, nodeId).turns.length, 0);

    // The conversation was appended, once, and only for a completed node.
    const stored = messagesRepo.listMessages(harness.db, user.id, nodeId);
    t.true(stored.length >= 2);
    t.true(stored.some((entry) => entry.message.role === "assistant"));
    t.true(stored.some((entry) => entry.message.role === "tool"));

    // Usage was recorded for the attempt and for each tool call.
    const totals = usage.dailyTotals(harness.db, user.id);
    t.true(totals.inputTokens > 0);
    t.true(totals.outputTokens > 0);
    t.is(totals.runs, 1);
    const attempts = runsRepo.listAttempts(harness.db, nodeId);
    t.is(attempts.length, 1);
    t.is(attempts[0]?.outcome, "complete");
    t.is(attempts[0]?.kind, "fresh");
    t.true((attempts[0]?.steps ?? 0) >= 3);
    t.is(attempts[0]?.toolCalls, 2, "one search and one fetch");
    t.true((attempts[0]?.costEstimateMicros ?? 0) > 0, "the attempt carries its cost estimate");
    // `totalUsage` is the sum over the three steps of the fixture.
    t.deepEqual(attempts[0]?.usageJson, {
      inputTokens: 4400,
      outputTokens: 180,
      reasoningTokens: 30,
      cachedTokens: 100,
    });

    // Title and recap ran on the metadata pool. The recap is declined — this
    // answer is under `MIN_RECAP_CHARS` — but the pending flag is still
    // settled on the way out (`04-agent-runtime.md` §9).
    t.truthy(nodesRepo.get(harness.db, user.id, nodeId)?.title);
    t.is(nodesRepo.get(harness.db, user.id, nodeId)?.recap, undefined);
    const pending = events.filter((event) => event.type === "research.recap.pending");
    t.deepEqual(
      pending.map((event) => event.payload["pending"]),
      [true, false],
    );
  },
);

test.serial("the tool budget is spent, not exceeded", async (t) => {
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "budgeter");
  // Twenty searches, then one more that must come back as the budget error.
  setFixtureScenario((options) => {
    void options;
    return "success-with-tools";
  });

  const { ToolBudget, createToolCaches } = await import("../src/runs/tools/context.js");
  const { createWebSearchTool } = await import("../src/runs/tools/webSearch.js");
  const budget = new ToolBudget();
  const tool = createWebSearchTool(
    {
      config: harness.config,
      db: harness.db,
      userId: user.id,
      nodeId,
      logger: harness.logger,
      fetch: harness.deps.fetch ?? globalThis.fetch,
      budget,
      caches: createToolCaches(),
      recordUsage: () => undefined,
    },
    new AbortController().signal,
  );
  t.truthy(tool);
  const execute = tool?.execute;
  if (!execute) {
    t.fail("the search tool has no executor");
    return;
  }
  const options = { toolCallId: "call", messages: [] } as never;
  for (let index = 0; index < 20; index += 1) {
    const result = (await execute({ query: `query ${index}` }, options)) as {
      results: unknown[];
      error?: string;
    };
    t.is(result.error, undefined, `search ${index + 1} is within budget`);
  }
  const overflow = (await execute({ query: "one too many" }, options)) as { error?: string };
  t.regex(overflow.error ?? "", /budget for this run is spent/);
  t.is(budget.searches, 21);
});

test.serial("deltas are coalesced and the answer still arrives whole", async (t) => {
  setFixtureScenario("slow-stream");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "pacer");
  const events = collectEvents(t, harness, user.id, [nodeId]);

  await harness.settle();

  const deltas = events.filter((event) => event.type === "research.turn.delta");
  t.true(deltas.length > 0);
  t.true(deltas.length < 9, "nine text deltas over 180 ms arrive as fewer events");
  t.is(
    deltas.map((event) => event.payload["text"]).join(""),
    "Consistent hashing maps keys and nodes onto one ring.",
    "coalescing loses no text",
  );
  t.deepEqual(
    new Set(deltas.map((event) => event.payload["turnId"])),
    new Set([`${nodeId}-assistant-0`]),
    "every delta names the turn it belongs to",
  );

  const content = await caller.research.getNodeContent({ nodeId });
  t.is(
    content.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    "Consistent hashing maps keys and nodes onto one ring.",
  );
});

test.serial("a refusal fails the node with the content-filter class", async (t) => {
  setFixtureScenario("refusal");
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "refused");
  await harness.settle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "failed");
  t.regex(node?.error ?? "", /declined to answer/);
  t.is(runsRepo.listAttempts(harness.db, nodeId)[0]?.errorClass, "content_filter");
});

test.serial("context overflow and a mid-stream error are classified apart", async (t) => {
  setFixtureScenario("context-too-long");
  const harness = createAgentHarness(t);
  const overflow = await launch(harness, "overflowed");
  await harness.settle();
  t.is(runsRepo.listAttempts(harness.db, overflow.nodeId)[0]?.errorClass, "context_too_long");
  t.regex(
    nodesRepo.get(harness.db, overflow.user.id, overflow.nodeId)?.error ?? "",
    /outgrown the model's context/,
  );

  setFixtureScenario("mid-stream-error");
  const dropped = await launch(harness, "dropped");
  await harness.settle();
  const node = nodesRepo.get(harness.db, dropped.user.id, dropped.nodeId);
  t.is(node?.status, "failed");
  t.is(runsRepo.listAttempts(harness.db, dropped.nodeId)[0]?.errorClass, "network");
  // The partial text survives for the reader.
  const live = runsRepo.liveWindow(harness.db, dropped.user.id, dropped.nodeId);
  t.true(
    live.turns.some((turn) =>
      turn.blocks.some((block) => block.type === "text" && block.text.includes("A partial answer")),
    ),
  );
});

test.serial("a rate limit re-queues with backoff instead of failing", async (t) => {
  let attempt = 0;
  setFixtureScenario(() => {
    attempt += 1;
    return attempt === 1 ? "rate-limit" : "success";
  });
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "throttled");

  await harness.settle();
  const queued = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(queued?.status, "queued", "a 429 goes back to the queue");
  t.is(runsRepo.listAttempts(harness.db, nodeId)[0]?.outcome, "rate_limited");

  const row = harness.db.$client
    .prepare("SELECT not_before, claimed_at FROM run_queue WHERE node_id = ?")
    .get(nodeId) as { not_before: number | null; claimed_at: number | null };
  t.is(row.claimed_at, null);
  t.true((row.not_before ?? 0) > Date.now(), "the backoff holds the row back");

  // A claim before the backoff expires finds nothing.
  await harness.settle();
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.status, "queued");

  // Move the backoff into the past; the retry succeeds.
  harness.db.$client.prepare("UPDATE run_queue SET not_before = 0 WHERE node_id = ?").run(nodeId);
  await harness.settle();
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.status, "complete");
});

test.serial("cancel aborts the stream and keeps the partial text", async (t) => {
  setFixtureScenario("abort");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "canceller");

  await harness.agent.tick();
  // Let a couple of paced deltas land before cancelling.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cancelled = await caller.research.cancelNode({ nodeId });
  t.is(cancelled.status, "cancelled");
  await harness.agent.idle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "cancelled");
  const content = await caller.research.getNodeContent({ nodeId });
  const text = content.turns
    .flatMap((turn) => turn.blocks)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  t.regex(text, /Partial text before the abort/);
  t.is(content.responseRevision, undefined, "a cancelled run has no durable snapshot");
});

test.serial(
  "drain interrupts open runs and boot resumes them without duplicate turns",
  async (t) => {
    setFixtureScenario("abort");
    const harness = createAgentHarness(t);
    const { user, caller, nodeId } = await launch(harness, "deployer");

    await harness.agent.tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await harness.agent.drain();

    const interrupted = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(interrupted?.status, "interrupted");
    const row = harness.db.$client
      .prepare("SELECT resume_pending FROM nodes WHERE id = ?")
      .get(nodeId) as { resume_pending: number };
    t.is(row.resume_pending, 1, "the node is flagged for auto-resume");

    // Boot: reconciliation re-queues it at the head, and the next attempt
    // resumes rather than starting over.
    const reconciliation = nodesRepo.reconcileOnBoot(harness.db);
    t.deepEqual(reconciliation.requeuedNodeIds, [nodeId]);
    t.is(nodesRepo.get(harness.db, user.id, nodeId)?.attempt, 1, "boot only re-queues");

    // The next process claims it, opens attempt 2, and continues.
    setFixtureScenario("success");
    const next = nextProcessAgent(harness);
    await next.settle();
    t.is(nodesRepo.get(harness.db, user.id, nodeId)?.attempt, 2);

    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(node?.status, "complete");
    const attempts = runsRepo.listAttempts(harness.db, nodeId);
    t.is(attempts.at(-1)?.kind, "resume", "the second attempt is recorded as a resume");

    const content = await caller.research.getNodeContent({ nodeId });
    const ids = content.turns.map((turn) => turn.id);
    t.is(new Set(ids).size, ids.length, "no turn id is committed twice");
    const text = content.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    t.regex(text, /Skip list/, "the resumed attempt's answer is there");
  },
);

test.serial(
  "admission holds runs above the per-user cap and reports queue positions",
  async (t) => {
    setFixtureScenario("abort");
    const harness = createAgentHarness(t, { env: { SESSION_RUNS_PER_USER: "1" } });
    const user = harness.addUser("crowded");
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

    await harness.agent.tick();
    t.is(nodesRepo.get(harness.db, user.id, firstId)?.status, "running");
    t.is(nodesRepo.get(harness.db, user.id, secondId)?.status, "queued");

    const waiting = await caller.research.getNodeContent({ nodeId: secondId });
    t.is(waiting.queuePosition, 1, "the held run reports where it stands");

    await caller.research.cancelNode({ nodeId: firstId });
    await harness.agent.idle();
    setFixtureScenario("success");
    await harness.settle();
    t.is(nodesRepo.get(harness.db, user.id, secondId)?.status, "complete");
  },
);

test.serial(
  "a node whose model has no credential fails with an operator-facing message",
  async (t) => {
    const harness = createHarness(t, { env: { ANTHROPIC_API_KEY: "" } });
    const user = harness.addUser("ungated", { isAdmin: true });
    const caller = harness.caller(user);
    const workspace = await caller.workspaces.ensureDefault();
    await t.throwsAsync(
      caller.research.createTree({
        prompt: "gated",
        model: "claude-fable",
        workspaceId: workspace.id,
      }),
      { message: /not configured on this deployment/ },
    );
  },
);
