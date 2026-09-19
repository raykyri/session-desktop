import { JOURNAL_ACTIVITY_SOURCE_RANK, RESEARCH_ACTIVITY_SOURCE_RANK } from "@session/shared";
import { and, eq, isNull } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { feedItems } from "../schema/feedItems.js";
import { journalEntries } from "../schema/journal.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

export function upsertJournalEntry(
  db: SessionDatabase,
  userId: string,
  journalId: string,
): boolean {
  const row = db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.userId, userId), eq(journalEntries.id, journalId)))
    .get();
  if (!row) return false;
  db.insert(feedItems)
    .values({
      id: row.id,
      authorId: row.userId,
      kind: "journal",
      occurredAt: row.createdAt,
      sourceRank: JOURNAL_ACTIVITY_SOURCE_RANK,
      journalId: row.id,
      nodeId: null,
      treeId: null,
      workspaceId: null,
    })
    .onConflictDoUpdate({
      target: feedItems.id,
      set: {
        authorId: row.userId,
        kind: "journal",
        occurredAt: row.createdAt,
        sourceRank: JOURNAL_ACTIVITY_SOURCE_RANK,
        journalId: row.id,
        nodeId: null,
        treeId: null,
        workspaceId: null,
      },
    })
    .run();
  return true;
}

export function removeJournalEntry(db: SessionDatabase, journalId: string): boolean {
  return db.delete(feedItems).where(eq(feedItems.journalId, journalId)).run().changes > 0;
}

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
      journalId: null,
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
        journalId: null,
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

export function backfill(db: SessionDatabase): void {
  for (const row of db
    .select({ userId: journalEntries.userId, id: journalEntries.id })
    .from(journalEntries)
    .all()) {
    upsertJournalEntry(db, row.userId, row.id);
  }
  for (const row of db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(isNull(nodes.parentNodeId))
    .all()) {
    upsertResearchRoot(db, row.id);
  }
}
