import type { RecentActivityCursor } from "@session/shared";
import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";

export type FeedScope = "all" | "mine" | "workspace";

export interface FeedStreamOptions {
  scope: FeedScope;
  userId?: string | null | undefined;
  workspaceId?: string | null | undefined;
  bookmarkedOnly?: boolean | undefined;
  before?: RecentActivityCursor | null | undefined;
  limit: number;
}

export interface FeedStreamRow {
  source: "journal" | "research";
  occurredAt: number;
  sourceRank: number;
  id: string;
  authorId: string;
  workspaceId: string | null;
  bookmarked: boolean;
}

export interface FeedItemDescriptor {
  id: string;
  kind: "journal" | "research";
  authorId: string;
  occurredAt: number;
  sourceRank: number;
  workspaceId: string | null;
  bookmarked: boolean;
}

interface DescriptorRow {
  id: string;
  kind: "journal" | "research";
  authorId: string;
  occurredAt: number;
  sourceRank: number;
  workspaceId: string | null;
  bookmarked: number | boolean;
}

export function stream(db: SessionDatabase, options: FeedStreamOptions): FeedStreamRow[] {
  if (options.scope !== "all" && !options.userId) return [];
  const cursor = options.before ?? null;
  const rows = db.all<Omit<FeedStreamRow, "bookmarked"> & { bookmarked: number | boolean }>(sql`
    SELECT fi.kind AS source, fi.occurred_at AS occurredAt, fi.source_rank AS sourceRank,
      fi.id, fi.author_id AS authorId, fi.workspace_id AS workspaceId,
      coalesce(t.bookmarked, 0) AS bookmarked
    FROM feed_items fi
    LEFT JOIN trees t ON t.id = fi.tree_id
    WHERE 1 = 1
      ${options.scope === "all" ? sql`` : sql`AND fi.author_id = ${options.userId}`}
      ${
        options.scope === "workspace" && options.workspaceId
          ? sql`AND (fi.kind = 'journal' OR fi.workspace_id = ${options.workspaceId})`
          : sql``
      }
      ${options.bookmarkedOnly ? sql`AND fi.kind = 'research' AND t.bookmarked = 1` : sql``}
      ${
        cursor
          ? sql`AND (fi.occurred_at < ${cursor.occurredAt}
              OR (fi.occurred_at = ${cursor.occurredAt}
                AND (fi.source_rank < ${cursor.sourceRank}
                  OR (fi.source_rank = ${cursor.sourceRank} AND fi.id < ${cursor.id}))))`
          : sql``
      }
    ORDER BY fi.occurred_at DESC, fi.source_rank DESC, fi.id DESC
    LIMIT ${options.limit}
  `);
  return rows.map((row) => ({
    ...row,
    bookmarked: row.bookmarked === 1 || row.bookmarked === true,
  }));
}

function descriptors(db: SessionDatabase, predicate: ReturnType<typeof sql>): FeedItemDescriptor[] {
  return db
    .all<DescriptorRow>(
      sql`
      SELECT fi.id, fi.kind, fi.author_id AS authorId, fi.occurred_at AS occurredAt,
        fi.source_rank AS sourceRank, fi.workspace_id AS workspaceId,
        coalesce(t.bookmarked, 0) AS bookmarked
      FROM feed_items fi
      LEFT JOIN trees t ON t.id = fi.tree_id
      WHERE ${predicate}
    `,
    )
    .map((row) => ({ ...row, bookmarked: row.bookmarked === 1 || row.bookmarked === true }));
}

export function forJournal(db: SessionDatabase, journalId: string): FeedItemDescriptor | null {
  return descriptors(db, sql`fi.journal_id = ${journalId}`)[0] ?? null;
}

export function forNode(db: SessionDatabase, nodeId: string): FeedItemDescriptor | null {
  return descriptors(db, sql`fi.node_id = ${nodeId}`)[0] ?? null;
}

export function forTree(db: SessionDatabase, treeId: string): FeedItemDescriptor | null {
  return descriptors(db, sql`fi.tree_id = ${treeId}`)[0] ?? null;
}

export function forWorkspace(db: SessionDatabase, workspaceId: string): FeedItemDescriptor[] {
  return descriptors(db, sql`fi.workspace_id = ${workspaceId}`);
}
