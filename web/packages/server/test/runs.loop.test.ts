// The agent loop against recorded provider streams
// (`12-testing-linting-ci.md` §3.3, `05-run-lifecycle-and-streaming.md`).

import {
  messages as messagesRepo,
  nodes as nodesRepo,
  queue as queueRepo,
  runs as runsRepo,
  trees as treesRepo,
  usage,
} from "@session/db";
import { RESEARCH_SYSTEM_PROMPT } from "@session/shared";
import type { SessionEvent, Turn } from "@session/shared";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";
import { SESSION_WIDGET_AGENT_GUIDANCE, researchSystemPrompt } from "../src/runs/prompts.js";

import { createHarness, recapOf, runOf } from "./helpers.js";
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
  // An owned-tools model: the fixtures here exercise `web_search`, which the
  // grounded Gemini entry replaces with the provider's own search.
  const detail = await caller.research.createTree({
    prompt,
    model: "gpt-luna",
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

    // Event sequence numbers must be contiguous: the client applies run events
    // in sequence and treats any sequence gap as a missing event, pausing its
    // buffer and refetching the node (`client/src/stores/liveTurns.ts`).
    // Persisting a sequence increment without emitting a corresponding event
    // causes client desynchronization.
    const seqs = seqsOf(events);
    t.true(seqs.length > 3);
    t.deepEqual(
      seqs,
      seqs.map((_, index) => index + 1),
      "run event sequences are contiguous from the node's initial seq of 0",
    );

    // The node settled with a durable answer.
    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(runOf(node).status, "complete");
    t.truthy(runOf(node).responseSnapshotAt);
    t.regex(runOf(node).responsePreview ?? "", /Bloom filter/);

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

    // Conversation messages are appended once upon completion.
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
    t.true((attempts[0]?.costEstimateMicros ?? 0) > 0, "the attempt includes its cost estimate");
    // `totalUsage` is the sum over the three steps of the fixture.
    t.deepEqual(attempts[0]?.usageJson, {
      inputTokens: 4400,
      outputTokens: 180,
      reasoningTokens: 30,
      cachedTokens: 100,
    });

    // Title and recap jobs executed in the metadata pool. Recap generation is
    // skipped because the response length is below `MIN_RECAP_CHARS`, but the
    // pending recap state is cleared upon completion (`04-agent-runtime.md` §9).
    t.truthy(nodesRepo.get(harness.db, user.id, nodeId)?.title);
    t.is(recapOf(nodesRepo.get(harness.db, user.id, nodeId)), undefined);
    const pending = events.filter((event) => event.type === "research.recap.pending");
    t.deepEqual(
      pending.map((event) => event.payload["pending"]),
      [true, false],
    );
  },
);

test.serial("enforces tool call limits without exceeding the configured threshold", async (t) => {
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
  t.regex(overflow.error ?? "", /web_search invocation limit has been reached/);
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
  t.is(runOf(node).status, "failed");
  t.regex(runOf(node).error ?? "", /declined to answer/);
  t.is(runsRepo.listAttempts(harness.db, nodeId)[0]?.errorClass, "content_filter");
});

test.serial(
  "context overflow and a mid-stream error are classified into distinct classes",
  async (t) => {
    setFixtureScenario("context-too-long");
    const harness = createAgentHarness(t);
    const overflow = await launch(harness, "overflowed");
    await harness.settle();
    t.is(runsRepo.listAttempts(harness.db, overflow.nodeId)[0]?.errorClass, "context_too_long");
    t.regex(
      runOf(nodesRepo.get(harness.db, overflow.user.id, overflow.nodeId)).error ?? "",
      /Context window limit exceeded/,
    );

    setFixtureScenario("mid-stream-error");
    const dropped = await launch(harness, "dropped");
    await harness.settle();
    const node = nodesRepo.get(harness.db, dropped.user.id, dropped.nodeId);
    t.is(runOf(node).status, "failed");
    t.is(runsRepo.listAttempts(harness.db, dropped.nodeId)[0]?.errorClass, "network");
    // The partial text remains available to the reader.
    const live = runsRepo.liveWindow(harness.db, dropped.user.id, dropped.nodeId);
    t.true(
      live.turns.some((turn) =>
        turn.blocks.some(
          (block) => block.type === "text" && block.text.includes("A partial answer"),
        ),
      ),
    );
  },
);

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
  t.is(runOf(queued).status, "queued", "a 429 returns to the queue");
  t.is(runsRepo.listAttempts(harness.db, nodeId)[0]?.outcome, "rate_limited");

  const row = harness.db.$client
    .prepare("SELECT not_before, claimed_at FROM run_queue WHERE node_id = ?")
    .get(nodeId) as { not_before: number | null; claimed_at: number | null };
  t.is(row.claimed_at, null);
  t.true((row.not_before ?? 0) > Date.now(), "backoff delays row execution");

  // A claim before the backoff expires finds nothing.
  await harness.settle();
  t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).status, "queued");

  // Move the backoff into the past; the retry succeeds.
  harness.db.$client.prepare("UPDATE run_queue SET not_before = 0 WHERE node_id = ?").run(nodeId);
  await harness.settle();
  t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).status, "complete");
});

for (const relaunch of ["retryNode", "rerunNode"] as const) {
  test.serial(
    `${relaunch} immediately after cancel succeeds; the cancelled attempt writes nothing to the node`,
    async (t) => {
      setFixtureScenario("abort");
      const harness = createAgentHarness(t);
      const { user, caller, nodeId } = await launch(harness, `quick-${relaunch}`);
      const events = collectEvents(t, harness, user.id, [nodeId]);
      await harness.agent.tick();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cancel and relaunch immediately: the cancelled attempt's stream is
      // still terminating when the new attempt is enqueued.
      await caller.research.cancelNode({ nodeId });
      setFixtureScenario("success");
      await caller.research[relaunch]({ nodeId });
      const queuedAt = events.length;
      // A claim round while the old attempt is still active.
      await harness.agent.tick();

      await harness.agent.idle();
      const waiting = nodesRepo.get(harness.db, user.id, nodeId);
      t.not(runOf(waiting).status, "failed", "the previous attempt did not fail the new attempt");
      t.is(runOf(waiting).attempt, 2);
      await harness.settle();

      const node = nodesRepo.get(harness.db, user.id, nodeId);
      t.is(runOf(node).status, "complete", "the relaunched attempt completed");
      t.is(runOf(node).attempt, 2);
      t.is(queueRepo.queuedCount(harness.db, user.id), 0);
      const content = await caller.research.getNodeContent({ nodeId });
      const text = content.turns
        .flatMap((turn) => turn.blocks)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      t.notRegex(
        text,
        /Partial text before the abort/,
        "no turns from the previous attempt are included",
      );
      const attempts = runsRepo.listAttempts(harness.db, nodeId);
      t.deepEqual(
        attempts.map((attempt) => [attempt.attempt, attempt.outcome]),
        [
          [1, "cancelled"],
          [2, "complete"],
        ],
      );
      // Nothing after the relaunch reports the old attempt failing.
      t.false(
        events
          .slice(queuedAt)
          .some(
            (event) =>
              event.type === "research.run.finished" && event.payload["status"] === "failed",
          ),
      );
    },
  );
}

test.serial("cancel aborts the stream and keeps the partial text", async (t) => {
  setFixtureScenario("abort");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "canceller");

  await harness.agent.tick();
  // Let a couple of paced deltas land before cancelling.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cancelled = await caller.research.cancelNode({ nodeId });
  t.is(runOf(cancelled).status, "cancelled");
  await harness.agent.idle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(runOf(node).status, "cancelled");
  const content = await caller.research.getNodeContent({ nodeId });
  const text = content.turns
    .flatMap((turn) => turn.blocks)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  t.regex(text, /Partial text before the abort/);
  t.is(content.responseRevision, undefined, "cancelled runs do not create a durable snapshot");
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
    t.is(runOf(interrupted).status, "interrupted");
    const row = harness.db.$client
      .prepare("SELECT resume_pending FROM nodes WHERE id = ?")
      .get(nodeId) as { resume_pending: number };
    t.is(row.resume_pending, 1, "the node is flagged for auto-resume");

    // Boot: reconciliation re-queues it at the head, and the next attempt
    // resumes rather than restarting from the beginning.
    const reconciliation = nodesRepo.reconcileOnBoot(harness.db);
    t.deepEqual(reconciliation.requeuedNodeIds, [nodeId]);
    t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).attempt, 1, "boot only re-queues");

    // The subsequent process claims the node, starts attempt 2, and continues execution.
    setFixtureScenario("success");
    const next = nextProcessAgent(harness);
    await next.settle();
    t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).attempt, 2);

    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(runOf(node).status, "complete");
    const attempts = runsRepo.listAttempts(harness.db, nodeId);
    t.is(attempts.at(-1)?.kind, "resume", "the second attempt is recorded as a resume attempt");

    const content = await caller.research.getNodeContent({ nodeId });
    const ids = content.turns.map((turn) => turn.id);
    t.is(new Set(ids).size, ids.length, "committed turn ids are unique");
    const text = content.turns
      .flatMap((turn) => turn.blocks)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    t.regex(text, /Skip list/, "the resumed attempt produced an answer");
  },
);

test.serial("a node past its automatic resumes is announced as settled", async (t) => {
  setFixtureScenario("abort");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "given-up");
  await harness.agent.tick();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await harness.agent.drain();
  const queued = await caller.followups.ask({ headNodeId: nodeId, prompt: "And then?" });
  t.is(queued.kind, "queued");
  // Simulate two prior resume attempts.
  for (const attempt of [2, 3]) {
    harness.db.$client
      .prepare(
        `INSERT INTO run_attempts (node_id, attempt, kind, model, started_at, steps, tool_calls)
           VALUES (?, ?, 'resume', 'gpt-luna', ?, 0, 0)`,
      )
      .run(nodeId, attempt, Date.now());
  }
  nodesRepo.reconcileOnBoot(harness.db);
  const events = collectEvents(t, harness, user.id, [nodeId]);
  const next = nextProcessAgent(harness);
  await next.settle();
  await new Promise((resolve) => setImmediate(resolve));
  const updated = events.find(
    (event) =>
      event.type === "research.node.updated" &&
      (event.payload["node"] as { id?: string } | undefined)?.id === nodeId,
  );
  const run = (updated?.payload["node"] as { run?: { status?: string; resumePending?: boolean } })
    ?.run;
  t.is(run?.status, "interrupted");
  t.false(run?.resumePending ?? true, "resumePending is cleared");
  t.true(events.some((event) => event.type === "feed.item.upserted"));
  // Dependent follow-ups remain queued until manually retried.
  const treeId = (updated?.payload["node"] as { treeId?: string } | undefined)?.treeId ?? "";
  t.is((await caller.followups.list({ treeId }))[nodeId]?.length, 1);
});

test.serial(
  "admission queues runs exceeding the per-user limit and reports queue positions",
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
    t.is(runOf(nodesRepo.get(harness.db, user.id, firstId)).status, "running");
    t.is(runOf(nodesRepo.get(harness.db, user.id, secondId)).status, "queued");

    const waiting = await caller.research.getNodeContent({ nodeId: secondId });
    t.is(waiting.queuePosition, 1, "the queued run reports its queue position");

    await caller.research.cancelNode({ nodeId: firstId });
    await harness.agent.idle();
    setFixtureScenario("success");
    await harness.settle();
    t.is(runOf(nodesRepo.get(harness.db, user.id, secondId)).status, "complete");
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

test.serial(
  "a follow-up includes prompt history and preceding answers in conversation context",
  async (t) => {
    setFixtureScenario("success");
    const harness = createAgentHarness(t);
    const { user, caller, nodeId } = await launch(harness, "continuer", "What is a skip list?");
    await harness.settle();
    t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).status, "complete");

    // The node's messages begin with the user prompt: Anthropic
    // requires that conversations begin with a user turn.
    const own = messagesRepo.listMessages(harness.db, user.id, nodeId);
    t.is(own[0]?.message.role, "user");
    t.is(own[0]?.message.content, "What is a skip list?");
    t.is(own[0]?.model, null, "a question has no producing model");
    t.is(own.at(-1)?.message.role, "assistant");

    // Messages sent to the provider for the follow-up: the parent exchange
    // followed by the new question, alternating from an initial user turn.
    const prompts: { role: string }[][] = [];
    setFixtureScenario((options) => {
      prompts.push(
        options.prompt
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role })),
      );
      return "success";
    });
    const child = await caller.research.forkNode({
      parentNodeId: nodeId,
      prompt: "How does it compare to a balanced tree?",
    });
    await harness.settle();
    t.is(runOf(nodesRepo.get(harness.db, user.id, child.id)).status, "complete");

    const sent = prompts[0] ?? [];
    t.is(sent[0]?.role, "user", "the conversation begins with the parent question");
    t.is(sent.at(-1)?.role, "user", "and ends with the follow-up prompt");
    t.true(sent.length >= 3, "the parent answer is positioned between prompts");

    const ancestors = messagesRepo
      .ancestorMessages(harness.db, user.id, child.id)
      .map((entry) => entry.message.role);
    t.deepEqual(ancestors, ["user", "assistant"]);
  },
);

test.serial("streamed tool input and provider-executed tools reach the transcript", async (t) => {
  setFixtureScenario("provider-tools");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "providertools");
  await harness.settle();
  t.is(runOf(nodesRepo.get(harness.db, user.id, nodeId)).status, "complete");

  const content = await caller.research.getNodeContent({ nodeId });
  const blocks = content.turns.flatMap((turn) => turn.blocks);
  const uses = blocks.filter((block) => block.type === "toolUse");
  const results = blocks.filter((block) => block.type === "toolResult");

  // A tool call whose input arrived as `tool-input-delta` parts is
  // indistinguishable downstream from one that arrived whole.
  const search = uses.find((use) => use.id === "call-search-1");
  t.is(search?.name, "web_search");
  t.deepEqual(search?.input, { query: "bloom filter false positive rate" });
  t.truthy(
    results.find((result) => result.toolUseId === "call-search-1"),
    "the owned tool still ran and returned",
  );

  // The provider ran the other two itself; they are rendered like any other.
  t.deepEqual(
    uses.filter((use) => use.name === "google_search").map((use) => use.id),
    ["provider-1", "provider-2"],
  );
  const ok = results.find((result) => result.toolUseId === "provider-1");
  t.false(ok?.isError);
  const failed = results.find((result) => result.toolUseId === "provider-2");
  t.true(failed?.isError, "a failure inside the provider is a failed tool result");
  t.deepEqual(
    failed?.type === "toolResult" ? failed.content : null,
    { error: '{"code":"UNAVAILABLE","detail":"grounding quota exhausted"}' },
    "and its payload is readable rather than [object Object]",
  );
});

test.serial("a wake-up during a claim round is not lost", async (t) => {
  setFixtureScenario("success");
  // `autoStart: true` enables immediate dispatch on `start()`. Because the
  // claim interval is 250 ms and test operations resolve via microtasks, this
  // verifies event-driven claiming rather than the timer.
  const harness = createAgentHarness(t, { autoStart: true });
  const user = harness.addUser("waker");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  // Admitted through the repository rather than the router: `createTree` wakes
  // the loop itself, which would claim the node before the race can be set up.
  const detail = treesRepo.admitRoot(harness.db, user.id, {
    type: "exchange",
    workspaceId: workspace.id,
    message: { text: "admitted mid-round" },
    agent: { model: "gemini-flash" },
  });
  const nodeId = detail.tree.rootNodeId;

  // Enqueueing during claim processing simulates receiving a wake-up notification
  // while a claim pass is in flight.
  const round = harness.agent.tick();
  queueRepo.enqueue(harness.db, user.id, { nodeId, provider: "vertex" });
  harness.agent.start(nodeId);
  await round;
  await harness.agent.idle();

  t.is(
    runOf(nodesRepo.get(harness.db, user.id, nodeId)).status,
    "complete",
    "the node admitted during the claim pass ran without waiting for the interval",
  );
});

test.serial("persists rate limit retry counts across service restarts", async (t) => {
  setFixtureScenario("rate-limit");
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "persistent");

  // Verify backoff progression across service instances; after three
  // rate-limited attempts, the fourth attempt fails.
  const backoffs: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const process = round === 0 ? harness : nextProcessAgent(harness);
    await process.settle();
    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(runOf(node).status, "queued", `429 number ${round + 1} re-queues`);
    t.is(runOf(node).attempt, round + 2, "and creates a new attempt record");
    const row = harness.db.$client
      .prepare("SELECT not_before FROM run_queue WHERE node_id = ?")
      .get(nodeId) as { not_before: number };
    backoffs.push(row.not_before - Date.now());
    harness.db.$client.prepare("UPDATE run_queue SET not_before = 0 WHERE node_id = ?").run(nodeId);
  }
  t.deepEqual(
    backoffs.map((backoff) => Math.round(backoff / 1000)),
    [5, 20, 60],
    "the backoff duration increases across processes rather than resetting",
  );

  const spent = runsRepo.listAttempts(harness.db, nodeId);
  t.is(spent.filter((attempt) => attempt.outcome === "rate_limited").length, 3);

  await nextProcessAgent(harness).settle();
  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(runOf(node).status, "failed");
  t.regex(runOf(node).error ?? "", /Model provider rate limit exceeded repeatedly/);
});

test.serial("a long paced answer emits a sequence with no hole in it", async (t) => {
  // `paced-answer` streams over multiple intervals, triggering in-flight
  // checkpoints. Checkpoint writes persist state without publishing sequence
  // increments; sequence numbers must remain contiguous for clients.
  setFixtureScenario("paced-answer");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "pacer", "Explain consistent hashing");
  const events = collectEvents(t, harness, user.id, [nodeId]);

  await harness.settle();

  const seqs = seqsOf(events);
  t.true(seqs.length > 10, "the paced stream produced a long run of events");
  t.deepEqual(
    seqs,
    seqs.map((_, index) => index + 1),
    "sequence numbers increment contiguously",
  );

  const finished = [...events].reverse().find((event) => event.type === "research.run.finished");
  t.is(finished?.payload["status"], "complete");
  t.is(finished?.payload["seq"], seqs.at(-1), "the finish event carries the final sequence number");

  // And the node's own counter agrees with the last event, so a client that
  // seeds from the snapshot after the run does not re-apply or skip anything.
  const content = await caller.research.getNodeContent({ nodeId });
  t.is(content.seq, seqs.at(-1));

  // Many checkpoints were actually written: the fixture is long enough that
  // the one-second checkpoint interval elapsed repeatedly.
  const attempts = runsRepo.listAttempts(harness.db, nodeId);
  t.is(attempts.length, 1);
});

test.serial("the widget guidance reflects the research inline widgets user setting", async (t) => {
  const harness = createAgentHarness(t);
  const systems: string[] = [];
  setFixtureScenario((options) => {
    for (const message of options.prompt) {
      if (message.role === "system") systems.push(message.content);
    }
    return "success";
  });
  const { caller } = await launch(harness, "widgetsoff");
  await harness.settle();
  t.true(systems.some((system) => system.includes(SESSION_WIDGET_AGENT_GUIDANCE)));

  systems.length = 0;
  await caller.settings.update({ settings: { researchInlineWidgets: false } });
  const workspace = await caller.workspaces.ensureDefault();
  await caller.research.createTree({
    prompt: "And without widgets?",
    model: "gpt-luna",
    workspaceId: workspace.id,
  });
  await harness.settle();
  t.true(systems.length > 0);
  t.false(systems.some((system) => system.includes(SESSION_WIDGET_AGENT_GUIDANCE)));
  t.true(systems.every((system) => system.startsWith(RESEARCH_SYSTEM_PROMPT)));
  t.false(researchSystemPrompt(null, { widgets: false }).includes(SESSION_WIDGET_AGENT_GUIDANCE));
});

test("research prompts omit linking guidance and retain custom instructions", (t) => {
  t.true(researchSystemPrompt().startsWith(RESEARCH_SYSTEM_PROMPT));
  t.true(researchSystemPrompt().includes(SESSION_WIDGET_AGENT_GUIDANCE));
  t.false(researchSystemPrompt().includes("Web previews do not run scripts"));
  t.is(researchSystemPrompt("  "), researchSystemPrompt());
  t.is(
    researchSystemPrompt("Be concise."),
    `${researchSystemPrompt()}\n\n<research-instructions>\nBe concise.\n</research-instructions>`,
  );
  t.false(researchSystemPrompt().includes("research-linking"));
});
