// Reordering math for the research sidebar's tree list. Pure list transforms:
// the caller applies the result optimistically and sends it to
// `research.trees.reorder`, which replaces exactly one visible subsequence
// (`02-domain-model-and-database.md` §5.1).

import type { ResearchTreeSummary } from "../types/research.js";

/** Moves one id to a gap in the original list (0..length), matching the
 * pointer-drop coordinates the sidebar rows report. */
export function moveResearchTreeIdToGap(ids: string[], treeId: string, gapIndex: number): string[] {
  const fromIndex = ids.indexOf(treeId);
  if (fromIndex < 0 || gapIndex < 0 || gapIndex > ids.length) {
    return ids;
  }
  if (gapIndex === fromIndex || gapIndex === fromIndex + 1) {
    return ids;
  }
  const withoutTree = ids.filter((id) => id !== treeId);
  const insertIndex = Math.max(
    0,
    Math.min(gapIndex > fromIndex ? gapIndex - 1 : gapIndex, withoutTree.length),
  );
  return [...withoutTree.slice(0, insertIndex), treeId, ...withoutTree.slice(insertIndex)];
}

/** Replaces one folder's relative order inside an active or archived master
 * list without disturbing the slots occupied by other folders. */
export function replaceResearchTreeScopeOrder(
  trees: ResearchTreeSummary[],
  workspaceId: string,
  orderedTreeIds: string[],
): ResearchTreeSummary[] {
  const scopedTrees = trees.filter((tree) => tree.workspaceId === workspaceId);
  if (scopedTrees.length !== orderedTreeIds.length) {
    return trees;
  }
  if (new Set(orderedTreeIds).size !== orderedTreeIds.length) {
    return trees;
  }
  const byId = new Map(scopedTrees.map((tree) => [tree.id, tree]));
  const replacements: ResearchTreeSummary[] = [];
  for (const treeId of orderedTreeIds) {
    const replacement = byId.get(treeId);
    if (!replacement) {
      return trees;
    }
    replacements.push(replacement);
  }
  let replacementIndex = 0;
  return trees.map((tree) => {
    if (tree.workspaceId !== workspaceId) {
      return tree;
    }
    // One replacement per scoped tree: the two lists were length-checked above.
    const replacement = replacements[replacementIndex] ?? tree;
    replacementIndex += 1;
    return replacement;
  });
}

export function moveResearchTreeIdBy(ids: string[], treeId: string, direction: -1 | 1): string[] {
  const fromIndex = ids.indexOf(treeId);
  const toIndex = fromIndex + direction;
  const from = fromIndex < 0 ? undefined : ids[fromIndex];
  const to = toIndex < 0 ? undefined : ids[toIndex];
  if (from === undefined || to === undefined) {
    return ids;
  }
  const next = [...ids];
  next[fromIndex] = to;
  next[toIndex] = from;
  return next;
}
