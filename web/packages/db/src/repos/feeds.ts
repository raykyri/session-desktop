// The Home feed (`docs/02-domain-model-and-database.md` §5.9).
//
// Root research nodes are materialized into `feed_items` by the source
// repositories. Reads apply one keyset predicate to that stream, then project
// the selected nodes into the desktop's `RecentResearchQuery` with the
// desktop's own `recentResearchQueryFromNode`.
//
// The order is `(occurred_at DESC, source_rank DESC, id DESC)`, matching the
// shared cursor comparator so the client and the server agree about what
// "before this item" means.

import type {
  RecentActivityCursor,
  RecentActivityItem,
  RecentActivityPage,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  RecentResearchQueryPage,
} from "@session/shared";
import { recentResearchQueryFromNode } from "@session/shared/lib/activity";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

import { treeReadableBy } from "./access.js";
import * as feedItemsRepo from "./feedItems.js";
import type { FeedItemDescriptor, FeedScope } from "./feedItems.js";
import type { NodeRow } from "./mappers.js";
import { toResearchNode } from "./mappers.js";

export const MIN_FEED_LIMIT = 1;
export const MAX_FEED_LIMIT = 100;
export const DEFAULT_FEED_LIMIT = 20;

export interface RecentActivityOptions {
  scope?: FeedScope | undefined;
  workspaceId?: string | null | undefined;
  limit?: number | undefined;
  before?: RecentActivityCursor | null | undefined;
}

function clampLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_FEED_LIMIT;
  if (!Number.isFinite(value)) {
    return DEFAULT_FEED_LIMIT;
  }
  return Math.min(MAX_FEED_LIMIT, Math.max(MIN_FEED_LIMIT, Math.trunc(value)));
}

/** A node row as the feed shows it. Highlights and the workspace play no part
 * in a feed entry, so the node is built without them. */
export function toRecentResearchQuery(row: NodeRow): RecentResearchQuery {
  const query = recentResearchQueryFromNode(
    toResearchNode(row, { workspaceId: "", highlights: [] }),
    true,
  );
  if (query === null) {
    throw new Error(`research node ${row.id} has no feed entry`);
  }
  return query;
}

/** Rows by id, for the ids a feed page selected. */
function nodeRows(db: SessionDatabase, ids: readonly string[]): Map<string, NodeRow> {
  if (ids.length === 0) {
    return new Map();
  }
  return new Map(
    db
      .select()
      .from(nodes)
      .where(inArray(nodes.id, [...ids]))
      .all()
      .map((row) => [row.id, row]),
  );
}

/** The direct follow-ups shown under each feed root: questions and notes,
 * oldest first. */
function childrenByParent(
  db: SessionDatabase,
  parentIds: readonly string[],
): Map<string, RecentResearchQuery[]> {
  const byParent = new Map<string, RecentResearchQuery[]>();
  if (parentIds.length === 0) {
    return byParent;
  }
  for (const row of db
    .select()
    .from(nodes)
    .where(and(inArray(nodes.parentNodeId, [...parentIds]), ne(nodes.type, "document")))
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all()) {
    if (row.parentNodeId === null) {
      continue;
    }
    const list = byParent.get(row.parentNodeId) ?? [];
    list.push(toRecentResearchQuery(row));
    byParent.set(row.parentNodeId, list);
  }
  return byParent;
}

/** One page of the feed, newest first. */
export function recentActivity(
  db: SessionDatabase,
  userId: string | null,
  options: RecentActivityOptions = {},
): RecentActivityPage {
  const limit = clampLimit(options.limit);
  const rows = feedItemsRepo.stream(db, {
    scope: options.scope ?? "workspace",
    userId,
    workspaceId: options.workspaceId ?? null,
    before: options.before ?? null,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((row) => row.id);
  const roots = nodeRows(db, ids);
  const children = childrenByParent(db, ids);
  const items: RecentActivityItem[] = page.flatMap((row): RecentActivityItem[] => {
    const root = roots.get(row.id);
    if (!root) {
      return [];
    }
    return [
      {
        kind: "research-query" as const,
        occurredAt: row.occurredAt,
        workspaceId: row.workspaceId,
        query: { ...toRecentResearchQuery(root), children: children.get(row.id) ?? [] },
      },
    ];
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      hasMore && last
        ? { occurredAt: last.occurredAt, sourceRank: last.sourceRank, id: last.id }
        : null,
  };
}

export interface FeedEventItem extends FeedItemDescriptor {
  item: RecentActivityItem;
}

export function eventItem(
  db: SessionDatabase,
  descriptor: FeedItemDescriptor,
): FeedEventItem | null {
  const root = nodeRows(db, [descriptor.id]).get(descriptor.id);
  if (!root) return null;
  return {
    ...descriptor,
    item: {
      kind: "research-query",
      occurredAt: descriptor.occurredAt,
      workspaceId: descriptor.workspaceId,
      query: {
        ...toRecentResearchQuery(root),
        children: childrenByParent(db, [descriptor.id]).get(descriptor.id) ?? [],
      },
    },
  };
}

export function eventItemForNode(db: SessionDatabase, nodeId: string): FeedEventItem | null {
  const descriptor = feedItemsRepo.forNode(db, nodeId);
  return descriptor ? eventItem(db, descriptor) : null;
}

export interface RecentQueriesOptions {
  limit?: number | undefined;
  before?: RecentResearchQueryCursor | null | undefined;
  workspaceId?: string | null | undefined;
}

/**
 * Root questions and notes alone, newest first — the research-only half of
 * the feed. Documents, archived threads and threads in the Trash are left
 * out.
 *
 * Driven from the owner's `trees` rows (`trees_sidebar_idx` on `owner_id`),
 * each joined to its root by primary key, rather than from `nodes`, whose
 * `created_at` order would otherwise lead the planner through every
 * account's roots. `CROSS JOIN` keeps that join order.
 */
export function recentQueries(
  db: SessionDatabase,
  userId: string,
  options: RecentQueriesOptions = {},
): RecentResearchQueryPage {
  const limit = clampLimit(options.limit);
  const cursor = options.before ?? null;
  const conditions = [
    sql`${trees.ownerId} = ${userId}`,
    sql`${trees.archivedAt} IS NULL`,
    sql`${trees.trashedAt} IS NULL`,
    sql`${nodes.id} = ${trees.rootNodeId}`,
    sql`${nodes.parentNodeId} IS NULL`,
    sql`${nodes.type} <> 'document'`,
    ...(options.workspaceId ? [sql`${trees.workspaceId} = ${options.workspaceId}`] : []),
    ...(cursor
      ? [
          sql`(${nodes.createdAt} < ${cursor.createdAt} OR (${nodes.createdAt} = ${cursor.createdAt} AND ${nodes.id} < ${cursor.nodeId}))`,
        ]
      : []),
  ];
  const ids = db.all<{ id: string }>(
    sql`SELECT ${nodes.id} AS id FROM ${trees} CROSS JOIN ${nodes} WHERE ${sql.join(
      conditions,
      sql` AND `,
    )} ORDER BY ${nodes.createdAt} DESC, ${nodes.id} DESC LIMIT ${limit + 1}`,
  );
  const byId = nodeRows(
    db,
    ids.map((row) => row.id),
  );
  const rows = ids.flatMap((row) => {
    const node = byId.get(row.id);
    return node ? [{ node }] : [];
  });
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
    toRecentResearchQuery(row.node),
  );
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, nodeId: last.nodeId } : null,
  };
}

/** Most thread ids one `recentQueriesForTrees` call reads. */
export const MAX_FEED_TREE_IDS = 200;

/** The root entries of the named threads, with their direct follow-ups: the
 * desktop's `list_recent_activity_for_trees`, which loads the Home cards whose
 * roots the newest feed page did not include. Threads the caller cannot read,
 * archived threads and threads in the Trash are left out; a repeated id is
 * read once. The result follows the order of `treeIds`. */
export function recentQueriesForTrees(
  db: SessionDatabase,
  userId: string,
  treeIds: readonly string[],
): RecentResearchQuery[] {
  const ids = [...new Set(treeIds)].slice(0, MAX_FEED_TREE_IDS);
  if (ids.length === 0) {
    return [];
  }
  const rows = db
    .select({ node: nodes })
    .from(nodes)
    .innerJoin(trees, eq(trees.rootNodeId, nodes.id))
    .where(
      and(
        inArray(trees.id, ids),
        treeReadableBy(userId),
        isNull(nodes.parentNodeId),
        isNull(trees.archivedAt),
        isNull(trees.trashedAt),
      ),
    )
    .all();
  const byTree = new Map(rows.map((row) => [row.node.treeId, row.node]));
  const roots = ids.flatMap((id) => {
    const root = byTree.get(id);
    return root ? [root] : [];
  });
  const children = childrenByParent(
    db,
    roots.map((root) => root.id),
  );
  return roots.map((root) => ({
    ...toRecentResearchQuery(root),
    children: children.get(root.id) ?? [],
  }));
}
