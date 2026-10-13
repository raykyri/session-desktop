import type { GroupInfo, ResearchTreeSummary } from "../types";

type WorkspaceScope = GroupInfo["scope"];

export function groupsForScope(groups: GroupInfo[], scope: WorkspaceScope): GroupInfo[] {
  return groups.filter((group) => group.scope === scope);
}

export function researchAttention(trees: ResearchTreeSummary[]) {
  return trees.reduce(
    (attention, tree) => ({
      runningCount: attention.runningCount + tree.runningCount,
      // Unseen failures, not the lifetime failedCount: one flaky follow-up
      // must not brand the Research toggle with "!" forever — viewing the
      // tree acknowledges it.
      failedCount: attention.failedCount + Number(tree.hasUnseenFailure),
      unseenCount: attention.unseenCount + Number(tree.hasUnseenUpdate),
    }),
    { runningCount: 0, failedCount: 0, unseenCount: 0 },
  );
}

