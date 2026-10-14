// Wire-shaped research objects for the cache and event tests. They are built
// by hand rather than by a factory in `shared` because what these tests check
// is that the client accepts what the server actually sends: a fixture that
// drifted from the schema should fail `parseSessionEvent`, not be repaired.

import type {
  ResearchExchangeNode,
  ResearchHighlightAnchor,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchTree,
  ResearchTreeSummary,
  RunState,
} from "@session/shared";
import { findModel } from "@session/shared";

export function tree(overrides: Partial<ResearchTree> = {}): ResearchTree {
  return {
    id: "t1",
    title: "Collective memory",
    rootNodeId: "n1",
    workspaceId: "w1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    archivedAt: null,
    lastViewedAt: null,
    ...overrides,
  };
}

/** Overrides for `node`: the envelope's own fields, plus the run's fields and
 * the message text and model at the top level so a test can name them
 * directly. `type: "document"` builds an imported report. */
export type NodeOverrides = Partial<
  Omit<ResearchExchangeNode, "type" | "run" | "message" | "agent"> & RunState
> & {
  type?: "exchange" | "document";
  prompt?: string;
  model?: string;
  attachments?: ResearchMessageAttachment[];
  queryAnchor?: ResearchHighlightAnchor | null;
};

export function node(overrides: NodeOverrides = {}): ResearchNode {
  const {
    type = "exchange",
    prompt = "What is collective memory?",
    model = "gemini-flash",
    attachments,
    queryAnchor,
    status = "running",
    error = null,
    startedAt = 1_700_000_000_000,
    completedAt = null,
    responseSnapshotAt = null,
    responsePreview = null,
    attempt = 1,
    sessionReady,
    errorKind,
    ...base
  } = overrides;
  const shared = {
    id: "n1",
    treeId: "t1",
    groupId: "w1",
    parentNodeId: null,
    title: null,
    createdAt: 1_700_000_000_000,
    highlights: [],
    ...(queryAnchor ? { anchor: { kind: "passage" as const, anchor: queryAnchor } } : {}),
    ...base,
  };
  const message = { text: prompt, ...(attachments ? { attachments } : {}) };
  const agent = { adapter: findModel(model)?.adapter ?? model, model, effort: null };
  if (type === "document") {
    return {
      ...shared,
      type: "document",
      message,
      source: "imported",
      followUpAgent: agent,
      responseSnapshotAt,
    };
  }
  return {
    ...shared,
    type: "exchange",
    message,
    agent,
    run: {
      status,
      error,
      startedAt,
      completedAt,
      responseSnapshotAt,
      responsePreview,
      attempt,
      sessionReady: sessionReady ?? status === "complete",
      ...(errorKind === undefined ? {} : { errorKind }),
    },
  };
}

export function summary(overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id: "t1",
    title: "Collective memory",
    rootNodeId: "n1",
    type: "exchange",
    workspaceId: "w1",
    runningCount: 1,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    updatedAt: 1_700_000_000_000,
    archivedAt: null,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    ...overrides,
  };
}
