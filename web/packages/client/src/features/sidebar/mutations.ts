// The two sidebar writes that reorder things, with optimistic updates and
// rollback (`10-home-feed-journal-encyclopedia.md` §7).
//
// Apply optimistic reordering immediately during drag operations to avoid visual lag before server confirmation. They are plain functions over a `QueryClient` rather than
// `useMutation` hooks because the sidebar calls them from pointer handlers and
// the tests call them without a component.

import type { ResearchFolderState, ResearchTreeSummary } from "@session/shared";
import type { QueryClient } from "@tanstack/react-query";

import { reorderResearchTrees, setResearchFolders } from "../../api/api.js";
import { queryKeys } from "../../api/queries.js";
import { pushErrorToast } from "../../lib/toast.js";

/** Reorders one `(workspace, archived)` section of a cached list in place,
 * leaving every other row at the index it already had — the same subsequence
 * replacement `research.reorderTrees` performs on the server. */
export function applyOrderToSection(
  trees: ResearchTreeSummary[],
  workspaceId: string,
  archived: boolean,
  orderedTreeIds: string[],
): ResearchTreeSummary[] {
  const positions: number[] = [];
  const byId = new Map<string, ResearchTreeSummary>();
  for (const [index, tree] of trees.entries()) {
    if (tree.workspaceId !== workspaceId) continue;
    if (Boolean(tree.archivedAt) !== archived) continue;
    positions.push(index);
    byId.set(tree.id, tree);
  }
  // Abort if the target list does not contain the complete section being
  // moved; applying a partial order would drop rows.
  if (positions.length !== orderedTreeIds.length) return trees;
  if (new Set(orderedTreeIds).size !== orderedTreeIds.length) return trees;
  const replacements = orderedTreeIds.map((treeId) => byId.get(treeId));
  if (replacements.some((tree) => tree === undefined)) return trees;
  const next = [...trees];
  for (const [slot, index] of positions.entries()) {
    // Both arrays have the same length, checked above.
    next[index] = replacements[slot] as ResearchTreeSummary;
  }
  return next;
}

/**
 * Writes a folder state: stars, membership, collapsed flags, folder records.
 * Optimistically updates each cached copy, sends the mutation, and restores
 * the previous state on failure.
 */
export async function applyFolderState(
  client: QueryClient,
  workspaceId: string,
  next: ResearchFolderState,
): Promise<boolean> {
  const key = queryKeys.folders(workspaceId);
  const previous = client.getQueryData<ResearchFolderState>(key);
  client.setQueryData(key, next);
  try {
    // Replace the optimistic cache state with the authoritative state returned
    // by the server.
    client.setQueryData(key, await setResearchFolders(workspaceId, next));
    return true;
  } catch (error) {
    if (previous === undefined) client.removeQueries({ queryKey: key });
    else client.setQueryData(key, previous);
    pushErrorToast("Failed to save folder changes", error);
    return false;
  }
}

/** Writes a new order for one section of the thread list. */
export async function applyTreeOrder(
  client: QueryClient,
  workspaceId: string,
  archived: boolean,
  treeIds: string[],
): Promise<boolean> {
  const snapshots: [readonly unknown[], ResearchTreeSummary[]][] = [];
  for (const query of client.getQueryCache().findAll({ queryKey: ["trees"] })) {
    const trees = query.state.data as ResearchTreeSummary[] | undefined;
    if (!trees) continue;
    const reordered = applyOrderToSection(trees, workspaceId, archived, treeIds);
    if (reordered === trees) continue;
    snapshots.push([query.queryKey, trees]);
    client.setQueryData(query.queryKey, reordered);
  }
  try {
    await reorderResearchTrees({ workspaceId, archived, treeIds });
    return true;
  } catch (error) {
    for (const [key, trees] of snapshots) client.setQueryData(key, trees);
    pushErrorToast("Failed to save new order", error);
    return false;
  }
}
