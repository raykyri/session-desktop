// Updates to the sidebar's research tree lists and the activity list that
// keep unchanged entries (and unchanged lists) identical, so memoized
// consumers skip them.
import { reconcileResearchActivity } from "../research/snapshots.js";
import type { ResearchNode, ResearchTreeDetail, ResearchTreeSummary } from "../wire/index.js";

import { researchNodeIsActivity } from "./researchEvents.js";

/** Splits trees into the active and the archived list. */
export function partitionResearchTrees(trees: ResearchTreeSummary[]) {
  return {
    active: trees.filter((tree) => !tree.archivedAt),
    archived: trees.filter((tree) => Boolean(tree.archivedAt)),
  };
}

/** Replaces the tree with the summary's id, or adds the summary (first when
 * `prepend`). */
export function upsertResearchTreeSummary(
  trees: ResearchTreeSummary[],
  summary: ResearchTreeSummary,
  prepend = false,
): ResearchTreeSummary[] {
  const index = trees.findIndex((tree) => tree.id === summary.id);
  if (index === -1) {
    return prepend ? [summary, ...trees] : [...trees, summary];
  }
  if (trees[index] === summary) {
    return trees;
  }
  const next = [...trees];
  next[index] = summary;
  return next;
}

export function removeResearchTreeSummary(
  trees: ResearchTreeSummary[],
  treeId: string,
): ResearchTreeSummary[] {
  return trees.some((tree) => tree.id === treeId)
    ? trees.filter((tree) => tree.id !== treeId)
    : trees;
}

/** Applies `patch` to every tree; the list is kept when no tree changed. */
export function patchResearchTreeSummaries(
  trees: ResearchTreeSummary[],
  patch: (tree: ResearchTreeSummary) => ResearchTreeSummary,
): ResearchTreeSummary[] {
  let changed = false;
  const next = trees.map((tree) => {
    const patched = patch(tree);
    changed ||= patched !== tree;
    return patched;
  });
  return changed ? next : trees;
}

/** Replaces one tree's activity nodes with those of its fetched detail,
 * ordered by creation time. */
export function replaceResearchActivityForTree(
  activity: ResearchNode[],
  detail: ResearchTreeDetail,
): ResearchNode[] {
  const otherTrees = activity.filter((node) => node.treeId !== detail.tree.id);
  const treeActivity = detail.nodes.filter(researchNodeIsActivity);
  const next = [...otherTrees, ...treeActivity].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  return reconcileResearchActivity(activity, next);
}
