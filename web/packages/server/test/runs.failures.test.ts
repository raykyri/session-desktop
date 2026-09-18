// The paths a run takes when it does not finish: an unconfigured model, the
// wall-clock cap, a snapshot that cannot be written, and an attempt that threw
// somewhere the loop does not expect (`04-agent-runtime.md` §3,
// `05-run-lifecycle-and-streaming.md` §10).

import { nodes as nodesRepo, runs as runsRepo } from "@session/db";
import { MAX_RESPONSE_SNAPSHOT_BYTES } from "@session/shared";
import type { SessionEvent, Turn } from "@session/shared";
import test from "ava";

import type { EventBus } from "../src/events/bus.js";
import { setFixtureScenario } from "../src/runs/fixtureProvider.js";
import type { Providers } from "../src/runs/providers.js";
import { createRunsService } from "../src/runs/service.js";
import { commitAnswer } from "../src/runs/snapshots.js";

import { collectEvents, createAgentHarness } from "./runsHelpers.js";

async function launch(
  harness: ReturnType<typeof createAgentHarness>,
  login: string,
  model = "gemini-flash",
) {
  const user = harness.addUser(login, { isAdmin: true });
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is a bloom filter?",
    model,
    workspaceId: workspace.id,
  });
  return { user, caller, nodeId: detail.nodes[0]?.id ?? "" };
}

function turnOf(nodeId: string, role: string, text: string): Turn {
  return {
    id: `${nodeId}-${role}-0`,
    agentId: nodeId,
    role,
    blocks: [{ type: "text", text }],
    sourceIndex: 0,
    timestamp: 1,
  };
}

test.serial("a model the process cannot resolve fails the node, not the process", async (t) => {
  // Admission checks the configured credential; this is the other side of it —
  // a model that passed admission and is gone by the time the loop runs.
  const providers: Providers = { fixtures: true, resolve: () => null };
  const harness = createAgentHarness(t, { providers });
  const { user, nodeId } = await launch(harness, "unresolvable");
  const events = collectEvents(t, harness, user.id, [nodeId]);

  await harness.settle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "failed");
  t.regex(node?.error ?? "", /gemini-flash is not configured on this deployment/);
  t.deepEqual(
    runsRepo.listAttempts(harness.db, nodeId),
    [],
    "nothing was attempted, so no attempt is recorded",
  );
  const finished = events.find((event) => event.type === "research.run.finished");
  t.is(finished?.payload["status"], "failed");
  t.is(finished?.payload["seq"], 1, "the failure is the first sequence a client has to apply");
  t.is(
    harness.db.$client.prepare(`SELECT 1 FROM run_queue WHERE node_id = ?`).get(nodeId),
    undefined,
    "the queue row is released",
  );
});

test.serial("a run that outlasts the wall-clock cap is stopped and classified", async (t) => {
  setFixtureScenario("timeout");
  const harness = createAgentHarness(t, { env: { SESSION_RUN_TIMEOUT_SECONDS: "1" } });
  const { user, caller, nodeId } = await launch(harness, "slowpoke");

  await harness.settle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "failed");
  t.regex(node?.error ?? "", /exceeded the maximum duration allowed/);
  const attempt = runsRepo.listAttempts(harness.db, nodeId)[0];
  t.is(attempt?.outcome, "failed");
  t.is(attempt?.errorClass, "timeout", "a timeout is not a network error or an unknown one");

  // Whatever the model produced before the cap is still readable.
  const content = await caller.research.getNodeContent({ nodeId });
  const text = content.turns
    .flatMap((turn) => turn.blocks)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  t.regex(text, /Sentence 0/);
  t.is(content.responseRevision, undefined, "a stopped run has no durable snapshot");
});

test.serial("an attempt that throws where the loop does not expect it still settles", async (t) => {
  setFixtureScenario("success");
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "stranded");

  // An event bus that fails is the cheapest stand-in for the class of throw
  // this guard exists for — a SQLite write that fails while the last turn is
  // committed is the realistic one, and neither is reachable through the
  // loop's own error handling.
  const hostile: EventBus = Object.create(harness.eventBus) as EventBus;
  hostile.emit = (userId: string, event: SessionEvent): void => {
    if (event.type === "research.run.started") {
      throw new Error("the event bus fell over");
    }
    harness.eventBus.emit(userId, event);
  };

  const service = createRunsService({
    config: harness.config,
    db: harness.db,
    eventBus: hostile,
    logger: harness.logger,
    autoStart: false,
  });
  t.teardown(() => service.drain());
  await service.tick();
  await service.idle();

  const node = nodesRepo.get(harness.db, user.id, nodeId);
  t.is(node?.status, "failed", "a node nothing is running must not stay `running`");
  t.regex(node?.error ?? "", /Research execution terminated unexpectedly/);
  t.is(
    harness.db.$client.prepare(`SELECT 1 FROM run_queue WHERE node_id = ?`).get(nodeId),
    undefined,
    "and its queue slot is freed",
  );
});

test.serial("prevents snapshot commit while the response stream remains active", async (t) => {
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "unstable");
  nodesRepo.setStatus(harness.db, user.id, nodeId, "running");

  let read = 0;
  const shifting = commitAnswer({
    db: harness.db,
    userId: user.id,
    nodeId,
    status: "complete",
    readTurns: () => {
      read += 1;
      return [turnOf(nodeId, "assistant", `answer revision ${read}`)];
    },
  });
  t.false(shifting.committed);
  t.regex(shifting.reason ?? "", /Response content changed concurrently/);
  t.is(read, 2, "two reads, no third attempt");

  // A settled read with no assistant text is the other refusal: a run that
  // finished with nothing to show is a failure, not an empty answer.
  const empty = commitAnswer({
    db: harness.db,
    userId: user.id,
    nodeId,
    status: "complete",
    readTurns: () => [turnOf(nodeId, "user", "a tool result and nothing else")],
  });
  t.false(empty.committed);
  t.regex(empty.reason ?? "", /completed without generating response content/);
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.status, "running", "neither settled the node");
});

test.serial("rejects responses exceeding snapshot byte limit with an error", async (t) => {
  const harness = createAgentHarness(t);
  const { user, nodeId } = await launch(harness, "verbose");
  nodesRepo.setStatus(harness.db, user.id, nodeId, "running");

  // Held only in the reader: the row never has to be written for the cap to
  // reject it, which is the point of checking the size before the transaction.
  const huge = [turnOf(nodeId, "assistant", "x".repeat(MAX_RESPONSE_SNAPSHOT_BYTES + 1))];
  t.throws(
    () =>
      commitAnswer({
        db: harness.db,
        userId: user.id,
        nodeId,
        status: "complete",
        readTurns: () => huge,
      }),
    { message: /response exceeded the maximum snapshot storage limit/ },
  );
  t.is(
    harness.db.$client.prepare(`SELECT 1 FROM response_snapshots WHERE node_id = ?`).get(nodeId),
    undefined,
    "and nothing was written",
  );
});
