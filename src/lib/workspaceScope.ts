import type { GroupInfo, ResearchTreeSummary } from "../types";

type WorkspaceScope = GroupInfo["scope"];

export function groupsForScope(groups: GroupInfo[], scope: WorkspaceScope): GroupInfo[] {
  return groups.filter((group) => group.scope === scope);
}

export function researchAttention(trees: ResearchTreeSummary[]) {
  return trees.reduce(
    (attention, tree) => ({
      runningCount: attention.runningCount + tree.runningCount,
      // Unseen failures, not lifetime failedCount: viewing the tree clears
      // the failure indicator on the Research toggle.
      failedCount: attention.failedCount + Number(tree.hasUnseenFailure),
      unseenCount: attention.unseenCount + Number(tree.hasUnseenUpdate),
    }),
    { runningCount: 0, failedCount: 0, unseenCount: 0 },
  );
}

