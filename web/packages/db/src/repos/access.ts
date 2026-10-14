// Who may read and change a thread. Today that is its owner alone: every
// repository scopes a tree by `trees.owner_id` and a node, highlight or queue
// item by the tree it belongs to, never by its own author column. Phase 5
// (collaboration) replaces these predicates with role checks against
// `tree_members`.

import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

/** `nodes.tree_id` names a tree `userId` owns. For a `WHERE` on `nodes`. */
export function nodeOwnedBy(userId: string): SQL {
  return sql`exists (select 1 from ${trees} where ${trees.id} = ${nodes.treeId} and ${trees.ownerId} = ${userId})`;
}

/** The highlight's node is in a tree `userId` owns. For a `WHERE` on
 * `highlights`. */
export function highlightOwnedBy(userId: string): SQL {
  return sql`exists (select 1 from ${nodes} inner join ${trees} on ${trees.id} = ${nodes.treeId} where ${nodes.id} = ${highlights.nodeId} and ${trees.ownerId} = ${userId})`;
}

/** The desktop's `RESEARCH_TRASHED_EDIT_ERROR` (`state.rs`). */
const TRASHED_EDIT_ERROR = "restore this research from the Trash before changing it";

/**
 * Refuses a user edit to a thread in the Trash (the desktop's
 * `reject_trashed_research_tree`). A thread in the Trash is listed only
 * there, and Restore returns it unchanged. Run bookkeeping is not an edit and
 * is not refused; moving a thread to the Trash is refused while it has an
 * active run, so none is in progress.
 *
 * Phase 5: the Trash is per person. Today only the owner can reach a thread,
 * so the owner's Trash is the thread's `trashed_at`. When members arrive, a
 * member hiding a shared thread is a per-person row and does not lock it;
 * only the owner's `trashed_at` does.
 */
export function rejectTrashed(tree: { trashedAt: number | null }): void {
  if (tree.trashedAt !== null) {
    throw new Error(TRASHED_EDIT_ERROR);
  }
}

/** `rejectTrashed` for the thread that holds `nodeId`. An unknown node is
 * left to the caller's own lookup. */
export function rejectTrashedNode(db: SessionDatabase, nodeId: string): void {
  const row = db
    .select({ trashedAt: trees.trashedAt })
    .from(nodes)
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(eq(nodes.id, nodeId))
    .get();
  if (row) {
    rejectTrashed(row);
  }
}
