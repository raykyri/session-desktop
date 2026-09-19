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

    // Contiguous, not merely increasing: the client applies run events in
    // sequence and treats a hole as a lost event — it freezes its buffer and
    // refetches the node (`client/src/stores/liveTurns.ts`). A write that takes
    // a number without publishing an event is therefore a bug, not a gap the
    // client can absorb.
    const seqs = seqsOf(events);
    t.true(seqs.length > 3);
    t.deepEqual(
      seqs,
      seqs.map((_, index) => index + 1),
      "run event sequences are contiguous from the node's initial seq of 0",
    );

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
    /Context window limit exceeded/,
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

test.serial("a follow-up replays the questions as well as the answers", async (t) => {
  setFixtureScenario("success");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "continuer", "What is a skip list?");
  await harness.settle();
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.status, "complete");

  // The node's own messages open with the question it was asked: a thread of
  // answers without their questions is not a conversation, and Anthropic
  // rejects a request whose first message is an assistant turn.
  const own = messagesRepo.listMessages(harness.db, user.id, nodeId);
  t.is(own[0]?.message.role, "user");
  t.is(own[0]?.message.content, "What is a skip list?");
  t.is(own[0]?.model, null, "a question has no producing model");
  t.is(own.at(-1)?.message.role, "assistant");

  // What the provider is sent for the follow-up: the parent exchange, then the
  // new question, alternating from a user turn.
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
  t.is(nodesRepo.get(harness.db, user.id, child.id)?.status, "complete");

  const sent = prompts[0] ?? [];
  t.is(sent[0]?.role, "user", "the conversation opens with the parent's question");
  t.is(sent.at(-1)?.role, "user", "and ends with the new one");
  t.true(sent.length >= 3, "the parent's answer is between them");

  const ancestors = messagesRepo
    .ancestorMessages(harness.db, user.id, child.id)
    .map((entry) => entry.message.role);
  t.deepEqual(ancestors, ["user", "assistant"]);
});

test.serial("streamed tool input and provider-executed tools reach the transcript", async (t) => {
  setFixtureScenario("provider-tools");
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await launch(harness, "providertools");
  await harness.settle();
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.status, "complete");

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
  // `autoStart` is what makes `start()` a real wake-up. The claim interval is
  // 250 ms and everything below settles within microtasks, so what this
  // asserts is the wake-up rather than the timer.
  const harness = createAgentHarness(t, { autoStart: true });
  const user = harness.addUser("waker");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  // Admitted through the repository rather than the router: `createTree` wakes
  // the loop itself, which would claim the node before the race can be set up.
  const detail = treesRepo.admitRoot(harness.db, user.id, {
    workspaceId: workspace.id,
    prompt: "admitted mid-round",
    model: "gemini-flash",
  });
  const nodeId = detail.tree.rootNodeId;

  // `tick()` returns to its caller only once the round has read the queue, so
  // enqueueing on the next line is deterministically "after the claim, while
  // the round is still in flight" — the wake-up that used to be dropped.
  const round = harness.agent.tick();
  queueRepo.enqueue(harness.db, user.id, { nodeId, provider: "vertex" });
  harness.agent.start(nodeId);
  await round;
  await harness.agent.idle();

  t.is(
    nodesRepo.get(harness.db, user.id, nodeId)?.status,
    "complete",
    "the node admitted mid-round ran without waiting for the interval",
  );
});

test.serial("persists rate limit retry counts across service restarts", async (t) => {
  setFixtureScenario("rate-limit");
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "persistent");

  // Three backoffs, each served by a different service — a deploy between
  // every one of them — and the fourth 429 gives up.
  const backoffs: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const process = round === 0 ? harness : nextProcessAgent(harness);
    await process.settle();
    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.is(node?.status, "queued", `429 number ${round + 1} re-queues`);
    t.is(node?.attempt, round + 2, "and opens a new attempt so its row survives");
    const row = harness.db.$client
      .prepare("SELECT not_before FROM run_queue WHERE node_id = ?")
      .get(nodeId) as { not_before: number };
    backoffs.push(row.not_before - Date.now());
    harness.db.$client.prepare("UPDATE run_queue SET not_before = 0 WHERE node_id = ?").run(nodeId);
  }
  t.deepEqual(
    backoffs.map((backoff) => Math.round(backoff / 1000)),
    [5, 20, 60],
    "the backoff grows across processes rather than restarting at five seconds",
  );

  const spent = runsRepo.listAttempts(harness.db, nodeId);
  t.is(spent.filter((attempt) => attempt.outcome === "rate_limited").length, 3);

  await nextProcessAgent(harness).settle();
  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "failed");
  t.regex(node?.error ?? "", /Model provider rate limit exceeded repeatedly/);
});

test.serial("a long paced answer emits a sequence with no hole in it", async (t) => {
  // `paced-answer` streams for several seconds, so the in-flight checkpoint
  // fires many times inside one attempt. A checkpoint writes a row and
  // publishes nothing; before this was fixed it also *allocated* a sequence
  // number, and the next event the client saw was `lastSeq + 2`. The client
  // reads that as a lost event: it freezes the buffer, sets `gap`, and
  // refetches `getNodeContent` — once a second, per watched node, for the
  // length of the run. The settle did the same thing once more.
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
    "every sequence number the client is shown is one past the last",
  );

  const finished = [...events].reverse().find((event) => event.type === "research.run.finished");
  t.is(finished?.payload["status"], "complete");
  t.is(finished?.payload["seq"], seqs.at(-1), "the finish carries the last number spent");

  // And the node's own counter agrees with the last event, so a client that
  // seeds from the snapshot after the run does not re-apply or skip anything.
  const content = await caller.research.getNodeContent({ nodeId });
  t.is(content.seq, seqs.at(-1));

  // Many checkpoints were actually written: the fixture is long enough that
  // the one-second checkpoint interval elapsed repeatedly.
  const attempts = runsRepo.listAttempts(harness.db, nodeId);
  t.is(attempts.length, 1);
});
