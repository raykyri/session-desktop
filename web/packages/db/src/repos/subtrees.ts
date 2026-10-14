// Deleting nodes.
//
// `nodes.parent_node_id` is `ON DELETE RESTRICT` on purpose
// (`docs/02-domain-model-and-database.md` §3.3): an accidental delete of a
// node with children must fail loudly rather than take a subtree with it. The
// cost is that every legitimate removal has to work upward from the leaves,
// which is what these helpers do. A tree's own cascade would hit the same
// constraint, so its nodes are removed here first and the tree row is deleted
// with nothing left to cascade.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

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

/** Most ids one `DELETE ... WHERE id IN (...)` names, well under SQLite's
 * bound-parameter limit. */
const DELETE_CHUNK = 500;

/**
 * Deletes every node of the given trees. The `(id, parent)` pairs are read
 * once and each node's depth computed in memory; the nodes are then deleted
 * a depth at a time, deepest first, in chunks. A row's `RESTRICT` check runs
 * as it is deleted, so one statement must not hold a parent and its child:
 * a depth never does. Linear in the number of nodes, however deep a chain
 * is; the earlier leaf-peeling loop read the whole set once per level.
 */
export function deleteNodesOfTrees(db: SessionDatabase, treeIds: readonly string[]): number {
  if (treeIds.length === 0) {
    return 0;
  }
  const rows = db
    .select({ id: nodes.id, parentId: nodes.parentNodeId })
    .from(nodes)
    .where(inArray(nodes.treeId, [...treeIds]))
    .all();
  const children = new Map<string, string[]>();
  const known = new Set(rows.map((row) => row.id));
  const roots: string[] = [];
  for (const row of rows) {
    if (row.parentId === null || !known.has(row.parentId)) {
      roots.push(row.id);
      continue;
    }
    const list = children.get(row.parentId) ?? [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const levels: string[][] = [];
  for (let frontier = roots; frontier.length > 0;) {
    levels.push(frontier);
    frontier = frontier.flatMap((id) => children.get(id) ?? []);
  }
  let removed = 0;
  for (let depth = levels.length - 1; depth >= 0; depth -= 1) {
    const level = levels[depth] ?? [];
    for (let start = 0; start < level.length; start += DELETE_CHUNK) {
      removed += db
        .delete(nodes)
        .where(inArray(nodes.id, level.slice(start, start + DELETE_CHUNK)))
        .returning({ id: nodes.id })
        .all().length;
    }
  }
  return removed;
}

/**
 * A node whose run is still the server's responsibility, for a `WHERE` on
 * `nodes`: `queued`, `running`, or `interrupted` while a resume is pending.
 * An `interrupted` node the runtime gave up resuming (`resume_pending = 0`,
 * `nodes.clearResumePending`) is settled: it can be removed like a failed
 * node. Deleting a node with a pending resume is refused because its
 * `run_queue` row is about to be claimed.
 */
export function activeRun(): SQL {
  return sql`(${nodes.status} IN ('queued', 'running') OR (${nodes.status} = 'interrupted' AND ${nodes.resumePending} = 1))`;
}

/** Whether any node of the given trees has an active run (`activeRun`). */
export function hasActiveNodes(db: SessionDatabase, treeIds: readonly string[]): boolean {
  if (treeIds.length === 0) {
    return false;
  }
  const row = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(inArray(nodes.treeId, [...treeIds]), activeRun()))
    .get();
  return row !== undefined;
}
