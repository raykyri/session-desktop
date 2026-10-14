// The web's additions to the research event parser (`src/research/events.ts`)
// and the web-only `interrupted` status as the desktop's reducers in
// `src/lib/researchEvents.ts` treat it. The reducers themselves are tested
// with the desktop (tests/researchEvents.test.ts).

import test from "ava";

import {
  researchNodeIsActivity,
  researchStatusContribution,
  researchSummaryFromDetail,
  patchResearchSummaryForNode,
  upsertResearchActivity,
} from "../src/lib/researchEvents.js";
import { parseSessionEvent, patchResearchNodeContent } from "../src/research/events.js";
import type { ModelInfo } from "../src/types/account.js";
import type {
  ResearchExchangeNode,
  ResearchFollowupQueueItem,
  ResearchHighlight,
  ResearchNodeStatus,
  ResearchTree,
  ResearchTreeDetail,
  RunState,
  SessionEvent,
  Turn,
} from "../src/wire/index.js";

const anchor = {
  version: 1 as const,
  projection: "answer-v1" as const,
  responseRevision: "revision-1",
  start: 2,
  end: 8,
  exact: "answer",
  prefix: "an ",
  suffix: " here",
};

const highlightA: ResearchHighlight = { id: "highlight-a", anchor, createdAt: 20 };

const model: ModelInfo = {
  id: "gemini-flash",
  label: "Gemini 3.8 Flash",
  provider: "vertex",
  adminOnly: false,
  available: true,
  supportsFiles: true,
  supportsImages: true,
};

const committedTurn: Turn = {
  id: "turn-1",
  agentId: "node-root",
  role: "assistant",
  blocks: [{ type: "text", text: "The answer" }],
  sourceIndex: 0,
};

function tree(overrides: Partial<ResearchTree> = {}): ResearchTree {
  return {
    id: "tree-1",
    title: "Research",
    rootNodeId: "node-root",
    workspaceId: "workspace-1",
    createdAt: 10,
    updatedAt: 10,
    archivedAt: null,
    lastViewedAt: 10,
    ...overrides,
  };
}

function node(
  overrides: Partial<ResearchExchangeNode> = {},
  run: Partial<RunState> = {},
): ResearchExchangeNode {
  return {
    id: "node-root",
    treeId: "tree-1",
    groupId: "workspace-1",
    parentNodeId: null,
    type: "exchange",
    message: { text: "Investigate" },
    agent: { adapter: "gemini", model: "gemini-flash", effort: null },
    run: {
      status: "queued",
      error: null,
      startedAt: null,
      completedAt: null,
      responseSnapshotAt: null,
      sessionReady: false,
      attempt: 1,
      responsePreview: null,
      ...run,
    },
    createdAt: 10,
    highlights: [],
    ...overrides,
  };
}

function withStatus(
  base: ResearchExchangeNode,
  status: ResearchNodeStatus,
  run: Partial<RunState> = {},
): ResearchExchangeNode {
  return { ...base, run: { ...base.run, status, ...run } };
}

function detail(
  nodes: ResearchExchangeNode[],
  overrides: Partial<ResearchTree> = {},
): ResearchTreeDetail {
  return { tree: tree(overrides), nodes };
}

function sessionEvent(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 100 };
}

function queuedItem(headNodeId: string): ResearchFollowupQueueItem {
  return {
    id: "item-1",
    treeId: "tree-1",
    headNodeId,
    authorId: "user-1",
    message: { text: "And then?" },
    agent: { adapter: "gemini", model: "gemini-flash", effort: null },
    position: 0,
    createdAt: 10,
    failedReason: null,
  };
}

test("parseSessionEvent recognizes the complete server event taxonomy", (t) => {
  const root = node();
  const researchTree = tree();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["research.tree.created", { tree: researchTree, node: root }],
    [
      "research.document.updated",
      {
        tree: researchTree,
        node: root,
        responseRevision: "revision-2",
        markdownChanged: true,
        removedHighlightCount: 1,
      },
    ],
    ["research.node.created", { node: root }],
    ["research.node.updated", { node: root }],
    ["research.tree.updated", { tree: researchTree }],
    ["research.tree.archived", { tree: researchTree }],
    ["research.tree.restored", { tree: researchTree }],
    ["research.highlight.created", { nodeId: root.id, highlight: highlightA }],
    ["research.highlights.removed", { nodeId: root.id, highlightIds: [highlightA.id] }],
    ["research.recap.pending", { nodeId: root.id, pending: true }],
    ["research.tree.removed", { treeId: researchTree.id }],
    [
      "research.node.removed",
      { treeId: researchTree.id, parentNodeId: root.id, removedNodeIds: ["child-1"] },
    ],
    ["research.run.started", { nodeId: root.id, attempt: 1, seq: 1, model: "gemini-flash" }],
    ["research.run.thinking", { nodeId: root.id, seq: 2, active: true }],
    ["research.turn.delta", { nodeId: root.id, seq: 3, turnId: "turn-1", text: "chunk" }],
    ["research.turn.committed", { nodeId: root.id, seq: 4, turn: committedTurn }],
    ["research.run.finished", { nodeId: root.id, attempt: 1, seq: 5, status: "complete" }],
    ["models.updated", { models: [model] }],
    [
      "research.queue.changed",
      { treeId: researchTree.id, headNodeId: root.id, items: [queuedItem(root.id)] },
    ],
    ["research.queue.changed", { treeId: researchTree.id, headNodeId: root.id, items: [] }],
  ];

  for (const [type, payload] of cases) {
    const parsed = parseSessionEvent(sessionEvent(type, payload));
    t.is(parsed.kind, "event", type);
    if (parsed.kind === "event") {
      t.is<string, string>(parsed.event.type, type);
      t.is(parsed.event.timestamp, 100);
    }
  }
});

test("parseSessionEvent carries the run event payloads through unchanged", (t) => {
  const started = parseSessionEvent(
    sessionEvent("research.run.started", {
      nodeId: "node-root",
      attempt: 2,
      seq: 7,
      model: "gemini-pro",
    }),
  );
  t.deepEqual(started, {
    kind: "event",
    event: {
      type: "research.run.started",
      nodeId: "node-root",
      attempt: 2,
      seq: 7,
      model: "gemini-pro",
      timestamp: 100,
    },
  });

  const delta = parseSessionEvent(
    sessionEvent("research.turn.delta", {
      nodeId: "node-root",
      seq: 8,
      turnId: "turn-1",
      text: " more",
    }),
  );
  t.deepEqual(delta, {
    kind: "event",
    event: {
      type: "research.turn.delta",
      nodeId: "node-root",
      seq: 8,
      turnId: "turn-1",
      text: " more",
      timestamp: 100,
    },
  });

  const committed = parseSessionEvent(
    sessionEvent("research.turn.committed", {
      nodeId: "node-root",
      seq: 9,
      turn: committedTurn,
    }),
  );
  t.deepEqual(committed, {
    kind: "event",
    event: {
      type: "research.turn.committed",
      nodeId: "node-root",
      seq: 9,
      turn: committedTurn,
      timestamp: 100,
    },
  });
});

test("a finished run keeps its error only when the server sent one", (t) => {
  const failed = parseSessionEvent(
    sessionEvent("research.run.finished", {
      nodeId: "node-root",
      attempt: 1,
      seq: 5,
      status: "failed",
      error: "provider stream closed",
    }),
  );
  t.deepEqual(failed, {
    kind: "event",
    event: {
      type: "research.run.finished",
      nodeId: "node-root",
      attempt: 1,
      seq: 5,
      status: "failed",
      error: "provider stream closed",
      timestamp: 100,
    },
  });

  const interrupted = parseSessionEvent(
    sessionEvent("research.run.finished", {
      nodeId: "node-root",
      attempt: 1,
      seq: 5,
      status: "interrupted",
    }),
  );
  t.deepEqual(interrupted, {
    kind: "event",
    event: {
      type: "research.run.finished",
      nodeId: "node-root",
      attempt: 1,
      seq: 5,
      status: "interrupted",
      timestamp: 100,
    },
  });
});

test("malformed run and model events are rejected rather than applied", (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    // Missing `seq`: the ordering rule cannot be applied without it.
    ["research.run.started", { nodeId: "node-root", attempt: 1, model: "gemini-flash" }],
    ["research.run.thinking", { nodeId: "node-root", seq: 1, active: "yes" }],
    ["research.turn.delta", { nodeId: "node-root", seq: 1, turnId: "turn-1" }],
    ["research.turn.committed", { nodeId: "node-root", seq: 1, turn: { id: "turn-1" } }],
    ["research.run.finished", { nodeId: "node-root", attempt: 1, seq: 1, status: "paused" }],
    ["models.updated", { models: [{ ...model, provider: "openai" }] }],
    ["models.updated", { models: {} }],
  ];
  for (const [type, payload] of cases) {
    t.deepEqual(parseSessionEvent(sessionEvent(type, payload)), { kind: "malformed", type }, type);
  }
});

test("a tree removal says whether the tree moved to the Trash", (t) => {
  // The desktop sends `trashed: true` for a move to the Trash; the web server
  // adds `removedBy`. A deletion carries neither flag, and `trashed: false`
  // reads as a deletion.
  const removal = (payload: Record<string, unknown>) =>
    parseSessionEvent(sessionEvent("research.tree.removed", payload));
  t.deepEqual(removal({ treeId: "tree-1", trashed: true, removedBy: "user-1" }), {
    kind: "event",
    event: { type: "research.tree.removed", treeId: "tree-1", trashed: true, timestamp: 100 },
  });
  for (const payload of [{ treeId: "tree-1" }, { treeId: "tree-1", trashed: false }]) {
    t.deepEqual(removal(payload), {
      kind: "event",
      event: { type: "research.tree.removed", treeId: "tree-1", timestamp: 100 },
    });
  }
});

test("parseSessionEvent separates unrelated, unsupported, and malformed events", (t) => {
  // `models.updated` is parsed despite its prefix; other non-research types
  // stay unrelated, so the unsupported path keeps meaning "a research event
  // this build does not know".
  t.deepEqual(parseSessionEvent(sessionEvent("settings.updated", {})), {
    kind: "notResearch",
  });
  t.deepEqual(parseSessionEvent(sessionEvent("research.future.changed", {})), {
    kind: "unsupported",
    type: "research.future.changed",
  });
  t.deepEqual(parseSessionEvent(sessionEvent("research.node.updated", { node: {} })), {
    kind: "malformed",
    type: "research.node.updated",
  });
  t.deepEqual(
    parseSessionEvent(
      sessionEvent("research.queue.changed", {
        treeId: "tree-1",
        headNodeId: "node-root",
        items: [{ ...queuedItem("node-root"), message: null }],
      }),
    ),
    { kind: "malformed", type: "research.queue.changed" },
  );
  t.deepEqual(parseSessionEvent(sessionEvent("research.recap.pending", { nodeId: "node-root" })), {
    kind: "malformed",
    type: "research.recap.pending",
  });
  t.deepEqual(
    parseSessionEvent(
      sessionEvent("research.highlights.removed", {
        nodeId: "node-root",
        highlightIds: ["valid", 3],
      }),
    ),
    { kind: "malformed", type: "research.highlights.removed" },
  );
});

test("node validation demands the envelope and accepts the web's interrupted status", (t) => {
  const valid = node({}, { status: "interrupted", attempt: 2 });
  t.is(parseSessionEvent(sessionEvent("research.node.updated", { node: valid })).kind, "event");
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["missing groupId", { ...valid, groupId: undefined }],
    ["missing run", { ...valid, run: undefined }],
    ["unknown status", { ...valid, run: { ...valid.run, status: "paused" } }],
  ];
  for (const [label, candidate] of rejected) {
    t.is(
      parseSessionEvent(sessionEvent("research.node.updated", { node: candidate })).kind,
      "malformed",
      label,
    );
  }
});

test("a node update carries the queue position when the node is still waiting", (t) => {
  const queued = node();
  const parsed = parseSessionEvent(
    sessionEvent("research.node.updated", { node: queued, queuePosition: 4 }),
  );
  t.is(parsed.kind, "event");
  t.deepEqual(parsed.kind === "event" ? parsed.event : null, {
    type: "research.node.updated",
    node: queued,
    queuePosition: 4,
    timestamp: 100,
  });
  // Absent once the run is admitted: the key is omitted, not set to undefined.
  const admitted = parseSessionEvent(sessionEvent("research.node.updated", { node: queued }));
  t.false(admitted.kind === "event" && "queuePosition" in admitted.event);
  // A non-numeric position is a malformed event rather than a silent drop.
  t.is(
    parseSessionEvent(
      sessionEvent("research.node.updated", { node: queued, queuePosition: "soon" }),
    ).kind,
    "malformed",
  );
});

test("patchResearchNodeContent replaces the node and tracks the queue position", (t) => {
  const queued = node();
  const content = { node: queued, turns: [], queuePosition: 4 };
  const advanced = patchResearchNodeContent(content, {
    node: queued,
    queuePosition: 2,
  });
  t.is(advanced?.queuePosition, 2);

  // Admission drops the position rather than leaving a stale place in line.
  const running = withStatus(queued, "running", { startedAt: 20 });
  const started = patchResearchNodeContent(content, { node: running });
  t.is(started?.node, running);
  t.false(started !== null && "queuePosition" in started);
  t.deepEqual(started?.turns, []);

  // Identity is preserved when nothing moved, and other nodes are ignored.
  const unchanged = patchResearchNodeContent(content, { node: queued, queuePosition: 4 });
  t.is(unchanged, content);
  const other = patchResearchNodeContent(content, { node: node({ id: "node-other" }) });
  t.is(other, content);
  t.is(patchResearchNodeContent(null, { node: queued }), null);
});

test("a summary counts an interrupted run in no bucket", (t) => {
  const nodes = [
    withStatus(node(), "complete", { completedAt: 10 }),
    withStatus(node({ id: "resuming", parentNodeId: "node-root", createdAt: 11 }), "interrupted"),
  ];
  const summary = researchSummaryFromDetail(detail(nodes));
  t.is(summary.completedCount, 1);
  t.is(summary.runningCount, 0);
  t.is(summary.failedCount, 0);
  t.is(summary.hasUnseenFailure, false);
});

test("research status contributions match the summary's four counters", (t) => {
  t.deepEqual(researchStatusContribution("queued"), {
    runningCount: 1,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
  });
  t.deepEqual(researchStatusContribution("running"), researchStatusContribution("queued"));
  t.is(researchStatusContribution("complete").completedCount, 1);
  t.is(researchStatusContribution("failed").failedCount, 1);
  t.is(researchStatusContribution("cancelled").cancelledCount, 1);
  // The summary has no interrupted column: the node has neither a live run to
  // count nor an outcome to bucket until it is resumed or retried.
  t.deepEqual(researchStatusContribution("interrupted"), {
    runningCount: 0,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
  });
});

test("an interruption moves counts without lighting attention", (t) => {
  const running = withStatus(node(), "running", { startedAt: 20 });
  const summary = researchSummaryFromDetail(detail([running]));
  t.is(summary.runningCount, 1);
  const interrupted = withStatus(running, "interrupted", { completedAt: 60 });
  const patched = patchResearchSummaryForNode(summary, running, interrupted, 61);
  t.is(patched.runningCount, 0);
  t.is(patched.failedCount, 0);
  // An interruption reports that the deployment stopped an attempt, not that
  // the question was answered; the resumed attempt's settlement lights the flag.
  t.is(patched.hasUnseenUpdate, false);
  t.is(patched.hasUnseenFailure, false);

  const resumed = withStatus(interrupted, "queued", { completedAt: null });
  t.is(patchResearchSummaryForNode(patched, interrupted, resumed, 62).runningCount, 1);
});

test("the activity list holds queued, running, and interrupted work", (t) => {
  const active = withStatus(node(), "running");
  t.is(researchNodeIsActivity(active), true);
  const activity = upsertResearchActivity([], active);

  // A deploy interrupts the attempt: the node stays listed because the server
  // re-queues every resume-pending node on boot.
  const interrupted = withStatus(active, "interrupted");
  t.is(researchNodeIsActivity(interrupted), true);
  const stillListed = upsertResearchActivity(activity, interrupted);
  t.is(stillListed.length, 1);
  t.is(stillListed[0], interrupted);

  const settled = withStatus(interrupted, "complete", { completedAt: 30 });
  t.is(researchNodeIsActivity(settled), false);
  t.deepEqual(upsertResearchActivity(stillListed, settled), []);
});

test("the collaboration events parse, and a half-empty notification is refused", (t) => {
  const envelope = (type: string, payload: Record<string, unknown>): SessionEvent => ({
    type,
    payload,
    timestamp: 5,
  });
  t.deepEqual(
    parseSessionEvent(
      envelope("notification.requested", {
        id: "n1",
        title: "Research finished",
        body: "What is a bloom filter?",
        tone: "success",
        timeoutMs: 8000,
        createdAt: 4,
        href: "/r/t1?sel=n",
        kind: "runFinished",
        treeId: "t1",
      }),
    ),
    {
      kind: "event",
      event: {
        type: "notification.requested",
        notification: {
          id: "n1",
          title: "Research finished",
          body: "What is a bloom filter?",
          tone: "success",
          timeoutMs: 8000,
          createdAt: 4,
          href: "/r/t1?sel=n",
          kind: "runFinished",
          treeId: "t1",
        },
        timestamp: 5,
      },
    },
  );
  t.is(
    parseSessionEvent(envelope("notification.requested", { id: "n1", title: "No body" })).kind,
    "malformed",
  );
  // An external link is dropped rather than followed.
  const external = parseSessionEvent(
    envelope("notification.requested", {
      id: "n2",
      title: "x",
      body: "y",
      timeoutMs: 1,
      createdAt: 1,
      href: "https://example.com",
    }),
  );
  t.true(
    external.kind === "event" &&
      external.event.type === "notification.requested" &&
      external.event.notification.href === undefined,
  );
  t.deepEqual(
    parseSessionEvent(
      envelope("research.presence.changed", {
        treeId: "t1",
        viewers: [{ userId: "u", login: "u", name: null, avatarUrl: null }],
      }),
    ),
    {
      kind: "event",
      event: {
        type: "research.presence.changed",
        treeId: "t1",
        viewers: [{ userId: "u", login: "u", name: null, avatarUrl: null }],
        timestamp: 5,
      },
    },
  );
  t.deepEqual(parseSessionEvent(envelope("research.sharing.changed", { treeId: "t1" })), {
    kind: "event",
    event: { type: "research.sharing.changed", treeId: "t1", timestamp: 5 },
  });
  t.is(parseSessionEvent(envelope("research.sharing.changed", {})).kind, "malformed");
});
