// Wire-shaped research objects for the cache and event tests. They are built
// by hand rather than by a factory in `shared` because what these tests check
// is that the client accepts what the server actually sends: a fixture that
// drifted from the schema should fail `parseResearchEvent`, not be repaired.

import type { ResearchNode, ResearchTree, ResearchTreeSummary } from "@session/shared";

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
    followed: false,
    bookmarked: false,
    ...overrides,
  };
}

export function node(overrides: Partial<ResearchNode> = {}): ResearchNode {
  return {
    id: "n1",
    treeId: "t1",
    workspaceId: "w1",
    parentNodeId: null,
    prompt: "What is collective memory?",
    documentIds: [],
    title: null,
    responsePreview: null,
    model: "gemini-flash",
    status: "running",
    attempt: 1,
    responseSnapshotAt: null,
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    completedAt: null,
    highlights: [],
    ...overrides,
  };
}

export function summary(overrides: Partial<ResearchTreeSummary> = {}): ResearchTreeSummary {
  return {
    id: "t1",
    title: "Collective memory",
    rootNodeId: "n1",
    kind: "run",
    workspaceId: "w1",
    runningCount: 1,
    failedCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    updatedAt: 1_700_000_000_000,
    archivedAt: null,
    followed: false,
    bookmarked: false,
    hasUnseenUpdate: false,
    hasUnseenFailure: false,
    ...overrides,
  };
}
