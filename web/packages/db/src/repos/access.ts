// Who may read and change a thread. Today that is its owner alone: every
// repository scopes a tree by `trees.owner_id` and a node, highlight or queue
// item by the tree it belongs to, never by its own author column. Phase 5
// (collaboration) replaces these predicates with role checks against
// `tree_members`.

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

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
