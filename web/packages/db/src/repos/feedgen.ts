// Materializes root research questions into `feed_items`
// (`docs/02-domain-model-and-database.md` §5.9).

import { RESEARCH_ACTIVITY_SOURCE_RANK } from "@session/shared";
import { eq } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { feedItems } from "../schema/feedItems.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

export function upsertResearchRoot(db: SessionDatabase, nodeId: string): boolean {
  const row = db
    .select({ node: nodes, tree: trees })
    .from(nodes)
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(eq(nodes.id, nodeId))
    .get();
  if (!row || row.node.parentNodeId !== null || row.tree.archivedAt !== null) {
    db.delete(feedItems).where(eq(feedItems.nodeId, nodeId)).run();
    return false;
  }
  db.insert(feedItems)
    .values({
      id: row.node.id,
      authorId: row.node.userId,
      kind: "research",
      occurredAt: row.node.createdAt,
      sourceRank: RESEARCH_ACTIVITY_SOURCE_RANK,
      nodeId: row.node.id,
      treeId: row.tree.id,
      workspaceId: row.tree.workspaceId,
    })
    .onConflictDoUpdate({
      target: feedItems.id,
      set: {
        authorId: row.node.userId,
        kind: "research",
        occurredAt: row.node.createdAt,
        sourceRank: RESEARCH_ACTIVITY_SOURCE_RANK,
        nodeId: row.node.id,
        treeId: row.tree.id,
        workspaceId: row.tree.workspaceId,
      },
    })
    .run();
  return true;
}

export function upsertResearchTree(db: SessionDatabase, treeId: string): boolean {
  const tree = db
    .select({ rootNodeId: trees.rootNodeId })
    .from(trees)
    .where(eq(trees.id, treeId))
    .get();
  return tree ? upsertResearchRoot(db, tree.rootNodeId) : false;
}

export function removeResearchTree(db: SessionDatabase, treeId: string): boolean {
  return db.delete(feedItems).where(eq(feedItems.treeId, treeId)).run().changes > 0;
}

export function markArchived(db: SessionDatabase, treeId: string, archived: boolean): void {
  if (archived) removeResearchTree(db, treeId);
  else upsertResearchTree(db, treeId);
}
