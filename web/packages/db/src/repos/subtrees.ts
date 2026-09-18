// Deleting nodes.
//
// `nodes.parent_node_id` is `ON DELETE RESTRICT` on purpose
// (`docs/02-domain-model-and-database.md` §3.3): an accidental delete of a
// node with children must fail loudly rather than take a subtree with it. The
// cost is that every legitimate removal has to work upward from the leaves,
// which is what these helpers do. A tree's own cascade would hit the same
// constraint, so its nodes are removed here first and the tree row is deleted
// with nothing left to cascade.

import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { nodes } from "../schema/nodes.js";

/** A node and every descendant, deepest first — the order they can be
 * deleted in. */
export function subtreeIdsDepthFirst(db: SessionDatabase, rootNodeId: string): string[] {
  const ordered: string[] = [];
  let frontier = [rootNodeId];
  const levels: string[][] = [];
  while (frontier.length > 0) {
    levels.push(frontier);
    frontier = db
      .select({ id: nodes.id })
      .from(nodes)
      .where(inArray(nodes.parentNodeId, frontier))
      .all()
      .map((row) => row.id);
  }
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    ordered.push(...(levels[index] ?? []));
  }
  return ordered;
}

/** Deletes the listed nodes deepest-first. The caller supplies an order that
 * already satisfies the constraint; this only issues the statements. */
export function deleteNodesInOrder(db: SessionDatabase, nodeIds: readonly string[]): number {
  let removed = 0;
  for (const nodeId of nodeIds) {
    removed += db
      .delete(nodes)
      .where(eq(nodes.id, nodeId))
      .returning({ id: nodes.id })
      .all().length;
  }
  return removed;
}

/** Deletes every node of the given trees, repeatedly removing the current
 * leaves. Terminates because each pass removes at least the deepest level. */
export function deleteNodesOfTrees(db: SessionDatabase, treeIds: readonly string[]): number {
  if (treeIds.length === 0) {
    return 0;
  }
  const ids = [...treeIds];
  let removed = 0;
  for (;;) {
    const parentIds = db
      .select({ id: nodes.parentNodeId })
      .from(nodes)
      .where(and(inArray(nodes.treeId, ids), isNotNull(nodes.parentNodeId)))
      .all()
      .flatMap((row) => (row.id === null ? [] : [row.id]));
    const leaves = db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        parentIds.length === 0
          ? inArray(nodes.treeId, ids)
          : and(inArray(nodes.treeId, ids), notInArray(nodes.id, parentIds)),
      )
      .all()
      .map((row) => row.id);
    if (leaves.length === 0) {
      return removed;
    }
    removed += db
      .delete(nodes)
      .where(inArray(nodes.id, leaves))
      .returning({ id: nodes.id })
      .all().length;
  }
}

/** Whether any node of these trees is still the server's responsibility. */
export function hasActiveNodes(db: SessionDatabase, treeIds: readonly string[]): boolean {
  if (treeIds.length === 0) {
    return false;
  }
  const row = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(inArray(nodes.treeId, [...treeIds]), sql`${nodes.status} IN ('queued', 'running')`))
    .get();
  return row !== undefined;
}
