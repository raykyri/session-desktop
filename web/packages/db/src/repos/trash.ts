// The Trash: trees and folders with `trashed_at` set. Every other list leaves
// them out (`trees.summaries`, `feeds.recentQueries`, the highlight feed, the
// Home feed through `feedgen`).
//
// The listing is here; step 2.4 of the desktop-parity plan adds moving a tree
// to the Trash (refused while a run is active), restoring it, and emptying
// the Trash (trees and folders, in one transaction).

import type { ResearchTreeSummary } from "@session/shared";
import { and, desc, eq, isNotNull } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

/** The workspace's trees in the Trash, most recently trashed first. */
export function list(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): ResearchTreeSummary[] {
  return db
    .select({ tree: trees, rootType: nodes.type })
    .from(trees)
    .innerJoin(nodes, eq(nodes.id, trees.rootNodeId))
    .where(
      and(
        eq(trees.ownerId, userId),
        eq(trees.workspaceId, workspaceId),
        isNotNull(trees.trashedAt),
      ),
    )
    .orderBy(desc(trees.trashedAt), desc(trees.id))
    .all()
    .map(({ tree, rootType }) => ({
      id: tree.id,
      title: tree.title,
      rootNodeId: tree.rootNodeId,
      type: rootType,
      workspaceId: tree.workspaceId,
      runningCount: 0,
      failedCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      updatedAt: tree.updatedAt,
      archivedAt: tree.archivedAt,
      trashedAt: tree.trashedAt,
      hasUnseenUpdate: false,
      hasUnseenFailure: false,
    }));
}
