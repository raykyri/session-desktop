import test from "ava";

import {
  addResearchNodeHighlight,
  parseResearchEvent,
  patchResearchDetailHighlightCreated,
  patchResearchDetailHighlightsRemoved,
  patchResearchDetailNode,
  patchResearchDetailTree,
  patchResearchNodeContent,
  patchResearchSummaryForCreatedNode,
  patchResearchSummaryForNode,
  patchResearchSummaryForRemovedNodes,
  patchResearchSummaryTree,
  removeResearchDetailNodes,
  removeResearchNodeHighlights,
  removeResearchNodes,
  researchNodeIsActivity,
  researchStatusContribution,
  researchSummaryFromDetail,
  upsertResearchActivity,
  upsertResearchNode,
} from "../src/research/events.js";
import type { ModelInfo } from "../src/types/account.js";
import type { SessionEvent } from "../src/types/events.js";
import type {
  ResearchHighlight,
  ResearchNode,
  ResearchTree,
  ResearchTreeDetail,
} from "../src/types/research.js";
import type { Turn } from "../src/types/turn.js";

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
const highlightB: ResearchHighlight = {
  id: "highlight-b",
  anchor: { ...anchor, start: 12, end: 17, exact: "other" },
  createdAt: 21,
};

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

function node(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "node-root",
    treeId: "tree-1",
    workspaceId: "workspace-1",
    parentNodeId: null,
    prompt: "Investigate",
    responsePreview: null,
    model: "gemini-flash",
    documentIds: [],
    attempt: 1,
    kind: "run",
    status: "queued",
    error: null,
    responseSnapshotAt: null,
    createdAt: 10,
    startedAt: null,
    completedAt: null,
    highlights: [],
    ...overrides,
  };
}

function detail(nodes: ResearchNode[], overrides: Partial<ResearchTree> = {}): ResearchTreeDetail {
  return { tree: tree(overrides), nodes };
}

function sessionEvent(type: string, payload: Record<string, unknown>): SessionEvent {
  return { type, payload, timestamp: 100 };
}

test("parseResearchEvent recognizes the complete server event taxonomy", (t) => {
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
    ["research.highlight.removed", { nodeId: root.id, highlightId: highlightA.id }],
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
  ];

  for (const [type, payload] of cases) {
    const parsed = parseResearchEvent(sessionEvent(type, payload));
    t.is(parsed.kind, "event", type);
    if (parsed.kind === "event") {
      t.is<string, string>(parsed.event.type, type);
      t.is(parsed.event.timestamp, 100);
    }
  }
});

test("parseResearchEvent carries the run event payloads through unchanged", (t) => {
  const started = parseResearchEvent(
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

  const delta = parseResearchEvent(
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

  const committed = parseResearchEvent(
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
  const failed = parseResearchEvent(
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

  const interrupted = parseResearchEvent(
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
    ["research.run.finished", { nodeId: "node-root", attempt: 1, seq: 1, status: "starting" }],
    ["models.updated", { models: [{ ...model, provider: "openai" }] }],
    ["models.updated", { models: {} }],
  ];
  for (const [type, payload] of cases) {
    t.deepEqual(parseResearchEvent(sessionEvent(type, payload)), { kind: "malformed", type }, type);
  }
});

test("parseResearchEvent separates unrelated, unsupported, and malformed events", (t) => {
  // `models.updated` is parsed despite its prefix; other non-research types
  // stay unrelated, so the unsupported path keeps meaning "a research event
  // this build does not know".
  t.deepEqual(parseResearchEvent(sessionEvent("journal.entry.updated", {})), {
    kind: "notResearch",
  });
  t.deepEqual(parseResearchEvent(sessionEvent("research.future.changed", {})), {
    kind: "unsupported",
    type: "research.future.changed",
  });
  t.deepEqual(parseResearchEvent(sessionEvent("research.node.updated", { node: {} })), {
    kind: "malformed",
    type: "research.node.updated",
  });
  t.deepEqual(parseResearchEvent(sessionEvent("research.recap.pending", { nodeId: "node-root" })), {
    kind: "malformed",
    type: "research.recap.pending",
  });
  t.deepEqual(
    parseResearchEvent(
      sessionEvent("research.highlights.removed", {
        nodeId: "node-root",
        highlightIds: ["valid", 3],
      }),
    ),
    { kind: "malformed", type: "research.highlights.removed" },
  );
});

test("node validation demands the web node shape", (t) => {
  const valid = node({ status: "interrupted", attempt: 2, documentIds: ["doc-1"] });
  t.is(parseResearchEvent(sessionEvent("research.node.updated", { node: valid })).kind, "event");
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["missing workspaceId", { ...valid, workspaceId: undefined }],
    ["missing model", { ...valid, model: undefined }],
    ["missing attempt", { ...valid, attempt: undefined }],
    ["missing documentIds", { ...valid, documentIds: undefined }],
    ["non-string documentIds", { ...valid, documentIds: [1] }],
    ["desktop status", { ...valid, status: "starting" }],
  ];
  for (const [label, candidate] of rejected) {
    t.is(
      parseResearchEvent(sessionEvent("research.node.updated", { node: candidate })).kind,
      "malformed",
      label,
    );
  }
  // The desktop's terminal-era fields are simply absent; nothing requires them.
  t.is(
    parseResearchEvent(
      sessionEvent("research.node.updated", { node: { ...valid, groupId: undefined } }),
    ).kind,
    "event",
  );
});

test("a node update carries the queue position when the node is still waiting", (t) => {
  const queued = node({ status: "queued" });
  const parsed = parseResearchEvent(
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
  const admitted = parseResearchEvent(sessionEvent("research.node.updated", { node: queued }));
  t.false(admitted.kind === "event" && "queuePosition" in admitted.event);
  // A non-numeric position is a malformed event rather than a silent drop.
  t.is(
    parseResearchEvent(
      sessionEvent("research.node.updated", { node: queued, queuePosition: "soon" }),
    ).kind,
    "malformed",
  );
});

test("patchResearchNodeContent replaces the node and tracks the queue position", (t) => {
  const queued = node({ status: "queued" });
  const content = { node: queued, turns: [], children: [], queuePosition: 4 };
  const advanced = patchResearchNodeContent(content, {
    type: "research.node.updated",
    node: queued,
    queuePosition: 2,
    timestamp: 100,
  });
  t.is(advanced?.queuePosition, 2);

  // Admission drops the position rather than leaving a stale place in line.
  const running = node({ status: "running", startedAt: 20 });
  const started = patchResearchNodeContent(content, {
    type: "research.node.updated",
    node: running,
    timestamp: 100,
  });
  t.is(started?.node, running);
  t.false(started !== null && "queuePosition" in started);
  t.deepEqual(started?.turns, []);

  // Identity is preserved when nothing moved, and other nodes are ignored.
  const unchanged = patchResearchNodeContent(content, {
    type: "research.node.updated",
    node: queued,
    queuePosition: 4,
    timestamp: 100,
  });
  t.is(unchanged, content);
  const other = patchResearchNodeContent(content, {
    type: "research.node.updated",
    node: node({ id: "node-other" }),
    timestamp: 100,
  });
  t.is(other, content);
  t.is(
    patchResearchNodeContent(null, { type: "research.node.updated", node: queued, timestamp: 1 }),
    null,
  );
});

test("researchSummaryFromDetail exactly derives counts, kind, and unseen attention", (t) => {
  const nodes = [
    node({ kind: "document", status: "complete", completedAt: 10 }),
    node({ id: "running", parentNodeId: "node-root", status: "running", createdAt: 11 }),
    node({ id: "failed-old", status: "failed", completedAt: 9, createdAt: 12 }),
    node({ id: "failed-new", status: "failed", completedAt: 14, createdAt: 13 }),
    node({ id: "cancelled", status: "cancelled", completedAt: 13, createdAt: 14 }),
  ];
  t.deepEqual(researchSummaryFromDetail(detail(nodes)), {
    id: "tree-1",
    title: "Research",
    rootNodeId: "node-root",
    kind: "document",
    workspaceId: "workspace-1",
    runningCount: 1,
    failedCount: 2,
    completedCount: 1,
    cancelledCount: 1,
    updatedAt: 10,
    archivedAt: null,
    followed: false,
    bookmarked: false,
    hasUnseenUpdate: true,
    hasUnseenFailure: true,
  });

  const viewed = researchSummaryFromDetail(detail(nodes, { lastViewedAt: 14 }));
  t.is(viewed.hasUnseenUpdate, false);
  t.is(viewed.hasUnseenFailure, false);
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
  const running = node({ status: "running", startedAt: 20 });
  const summary = researchSummaryFromDetail(detail([running]));
  t.is(summary.runningCount, 1);
  const interrupted = { ...running, status: "interrupted" as const, completedAt: 60 };
  const patched = patchResearchSummaryForNode(summary, running, interrupted, 61);
  t.is(patched.runningCount, 0);
  t.is(patched.failedCount, 0);
  // An interruption reports that the deployment stopped an attempt, not that
  // the question was answered; the resumed attempt's settlement lights the flag.
  t.is(patched.hasUnseenUpdate, false);
  t.is(patched.hasUnseenFailure, false);

  const resumed = { ...interrupted, status: "queued" as const, completedAt: null };
  t.is(patchResearchSummaryForNode(patched, interrupted, resumed, 62).runningCount, 1);
});

test("node collection helpers upsert in server order and remove without no-op churn", (t) => {
  const later = node({ id: "node-z", createdAt: 30 });
  const earlier = node({ id: "node-a", createdAt: 20 });
  const current = [later];
  const inserted = upsertResearchNode(current, earlier);
  t.deepEqual(
    inserted.map((entry) => entry.id),
    ["node-a", "node-z"],
  );
  t.is(upsertResearchNode(inserted, earlier), inserted);

  const updated = { ...earlier, responsePreview: "Live preview" };
  const replaced = upsertResearchNode(inserted, updated);
  t.is(replaced[0], updated);
  t.is(replaced[1], later);
  t.is(removeResearchNodes(replaced, ["missing"]), replaced);
  t.deepEqual(removeResearchNodes(replaced, new Set(["node-a"])), [later]);
});

test("the activity list holds queued, running, and interrupted work", (t) => {
  const active = node({ status: "running" });
  t.is(researchNodeIsActivity(active), true);
  const activity = upsertResearchActivity([], active);

  // A deploy interrupts the attempt: the node stays listed because the server
  // re-queues every resume-pending node on boot.
  const interrupted = { ...active, status: "interrupted" as const };
  t.is(researchNodeIsActivity(interrupted), true);
  const stillListed = upsertResearchActivity(activity, interrupted);
  t.is(stillListed.length, 1);
  t.is(stillListed[0], interrupted);

  const settled = { ...interrupted, status: "complete" as const, completedAt: 30 };
  t.is(researchNodeIsActivity(settled), false);
  t.deepEqual(upsertResearchActivity(stillListed, settled), []);
});

test("detail node/tree/remove helpers touch only their matching tree", (t) => {
  const root = node();
  const current = detail([root]);
  const updatedRoot = { ...root, status: "running" as const };
  const withNode = patchResearchDetailNode(current, updatedRoot);
  t.not(withNode, current);
  t.is(withNode?.nodes[0], updatedRoot);
  t.is(patchResearchDetailNode(current, node({ treeId: "other" })), current);

  const renamed = tree({ title: "Renamed", updatedAt: 20 });
  const withTree = patchResearchDetailTree(withNode, renamed);
  t.is(withTree?.tree, renamed);
  t.is(patchResearchDetailTree(current, tree({ id: "other" })), current);

  t.is(removeResearchDetailNodes(current, "other", [root.id]), current);
  t.deepEqual(removeResearchDetailNodes(current, current.tree.id, [root.id])?.nodes, []);
  t.is(removeResearchDetailNodes(current, current.tree.id, ["missing"]), current);
});

test("highlight helpers are idempotent and preserve unrelated highlights", (t) => {
  const root = node({ highlights: [highlightA] });
  t.is(addResearchNodeHighlight(root, highlightA), root);
  const added = addResearchNodeHighlight(root, highlightB);
  t.deepEqual(added.highlights, [highlightA, highlightB]);
  t.is(removeResearchNodeHighlights(added, ["missing"]), added);
  t.deepEqual(removeResearchNodeHighlights(added, [highlightA.id]).highlights, [highlightB]);

  const current = detail([root]);
  const withHighlight = patchResearchDetailHighlightCreated(current, root.id, highlightB);
  t.deepEqual(withHighlight?.nodes[0]?.highlights, [highlightA, highlightB]);
  t.is(patchResearchDetailHighlightCreated(withHighlight, root.id, highlightB), withHighlight);
  const withoutHighlights = patchResearchDetailHighlightsRemoved(withHighlight, root.id, [
    highlightA.id,
    highlightB.id,
  ]);
  t.deepEqual(withoutHighlights?.nodes[0]?.highlights, []);
  t.is(
    patchResearchDetailHighlightsRemoved(withoutHighlights, "unknown", [highlightA.id]),
    withoutHighlights,
  );
});

test("summary node patch handles active transitions without changing bucket totals", (t) => {
  const queued = node({ status: "queued" });
  const summary = researchSummaryFromDetail(detail([queued]));
  const running = { ...queued, status: "running" as const, startedAt: 50 };
  const patched = patchResearchSummaryForNode(summary, queued, running, 51);
  t.is(patched.runningCount, 1);
  t.is(patched.completedCount, 0);
  t.is(patched.updatedAt, 51);
  t.is(patched.hasUnseenUpdate, false);
});

test("summary node patch moves counts and lights attention only on a new settlement", (t) => {
  const running = node({ status: "running", startedAt: 20 });
  const summary = researchSummaryFromDetail(detail([running]));
  const failed = {
    ...running,
    status: "failed" as const,
    error: "boom",
    completedAt: 60,
  };
  const settled = patchResearchSummaryForNode(summary, running, failed, 61);
  t.is(settled.runningCount, 0);
  t.is(settled.failedCount, 1);
  t.is(settled.hasUnseenUpdate, true);
  t.is(settled.hasUnseenFailure, true);

  const metadataOnly = { ...failed, responseSnapshotAt: 70 };
  t.is(patchResearchSummaryForNode(settled, failed, metadataOnly, 70), settled);
});

test("summary node patch clamps inconsistent counts and ignores mismatched records", (t) => {
  const running = node({ status: "running" });
  const summary = { ...researchSummaryFromDetail(detail([running])), runningCount: 0 };
  const complete = { ...running, status: "complete" as const, completedAt: 40 };
  const patched = patchResearchSummaryForNode(summary, running, complete, 40);
  t.is(patched.runningCount, 0);
  t.is(patched.completedCount, 1);
  t.is(patchResearchSummaryForNode(summary, node({ id: "different" }), complete, 40), summary);
});

test("summary structural patches add and remove cached status contributions", (t) => {
  const root = node({ status: "complete", completedAt: 20 });
  const summary = researchSummaryFromDetail(detail([root]));
  const child = node({
    id: "child",
    parentNodeId: root.id,
    status: "queued",
    createdAt: 30,
  });
  const added = patchResearchSummaryForCreatedNode(summary, child, 31);
  t.is(added.runningCount, 1);
  t.is(added.completedCount, 1);
  t.is(added.updatedAt, 31);
  t.is(patchResearchSummaryForCreatedNode(summary, node({ treeId: "other" }), 31), summary);

  const failed = node({
    id: "failed-child",
    parentNodeId: root.id,
    status: "failed",
    completedAt: 35,
    createdAt: 35,
  });
  const withFailed = patchResearchSummaryForCreatedNode(added, failed, 36);
  const removed = patchResearchSummaryForRemovedNodes(withFailed, "tree-1", [child, failed], 40);
  t.is(removed.runningCount, 0);
  t.is(removed.failedCount, 0);
  t.is(removed.completedCount, 1);
  t.is(removed.updatedAt, 40);
  t.is(patchResearchSummaryForRemovedNodes(summary, "other", [root], 40), summary);
});

test("tree summary patch adopts authoritative metadata and preserves derived fields", (t) => {
  const summary = researchSummaryFromDetail(
    detail([node({ status: "failed", completedAt: 30 })], { lastViewedAt: 10 }),
  );
  const archived = tree({ title: "Renamed", archivedAt: 50, updatedAt: 45 });
  const patched = patchResearchSummaryTree(summary, archived);
  t.is(patched.title, "Renamed");
  t.is(patched.archivedAt, 50);
  t.is(patched.updatedAt, 45);
  t.is(patched.failedCount, summary.failedCount);
  t.is(patched.hasUnseenFailure, summary.hasUnseenFailure);
  t.is(patchResearchSummaryTree(patched, archived), patched);

  // Follow / Bookmark flags ride the same tree event without touching recency.
  t.is(summary.followed, false);
  t.is(summary.bookmarked, false);
  const followed = patchResearchSummaryTree(patched, { ...archived, followed: true });
  t.is(followed.followed, true);
  t.is(followed.bookmarked, false);
  t.is(followed.updatedAt, 45);
  const bookmarked = patchResearchSummaryTree(followed, {
    ...archived,
    followed: true,
    bookmarked: true,
  });
  t.is(bookmarked.bookmarked, true);
  t.is(
    patchResearchSummaryTree(bookmarked, { ...archived, followed: true, bookmarked: true }),
    bookmarked,
  );
});
