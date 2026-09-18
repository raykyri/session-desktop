// The Home feed (`docs/02-domain-model-and-database.md` §5.9).
//
// Journal entries and root research questions are two tables with nothing in
// common but a timestamp, and the feed is one keyset-paginated stream over
// both. The merge is a `UNION ALL` of two shaped subqueries so the cursor
// predicate, the ordering, and the limit are evaluated once by SQLite rather
// than by fetching both sides whole and sorting in memory, which is what the
// desktop did when everything was already in one process's heap.
//
// The order is `(occurred_at DESC, source_rank DESC, id DESC)` with journal
// rank 0 and research rank 1, matching the shared cursor comparator so the
// client and the server agree about what "before this item" means.

import type {
  JournalEntry,
  RecentActivityCursor,
  RecentActivityItem,
  RecentActivityPage,
  RecentResearchQuery,
  RecentResearchQueryCursor,
  RecentResearchQueryPage,
} from "@session/shared";
import {
  JOURNAL_ACTIVITY_SOURCE_RANK,
  RESEARCH_ACTIVITY_SOURCE_RANK,
  journalEntrySchema,
  researchHighlightAnchorSchema,
  researchMessageAttachmentSchema,
  researchRecapSchema,
} from "@session/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { SessionDatabase } from "../connection.js";
import { parseJsonColumn, parseNullableJsonColumn } from "../json.js";

import type { NodeRow } from "./mappers.js";

const attachmentListSchema = z.array(researchMessageAttachmentSchema);

export const MIN_FEED_LIMIT = 1;
export const MAX_FEED_LIMIT = 100;
export const DEFAULT_FEED_LIMIT = 20;

export interface RecentActivityOptions {
  workspaceId?: string | null | undefined;
  limit?: number | undefined;
  before?: RecentActivityCursor | null | undefined;
  /** Bookmarked threads only. Journal entries are excluded when set: a
   * bookmark is a property of a thread, and a link has none. */
  bookmarkedOnly?: boolean | undefined;
}

interface ActivityRow {
  source: "journal" | "research";
  occurredAt: number;
  sourceRank: number;
  id: string;
}

function clampLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_FEED_LIMIT;
  if (!Number.isFinite(value)) {
    return DEFAULT_FEED_LIMIT;
  }
  return Math.min(MAX_FEED_LIMIT, Math.max(MIN_FEED_LIMIT, Math.trunc(value)));
}

/** A node row as the feed shows it. Only run nodes reach here. */
export function toRecentResearchQuery(row: NodeRow): RecentResearchQuery {
  const anchor = parseNullableJsonColumn(
    researchHighlightAnchorSchema,
    row.queryAnchorJson,
    "nodes.query_anchor_json",
  );
  const recap = parseNullableJsonColumn(researchRecapSchema, row.recapJson, "nodes.recap_json");
  return {
    nodeId: row.id,
    treeId: row.treeId,
    parentNodeId: row.parentNodeId,
    inline: row.inline,
    prompt: row.prompt,
    queryTarget: anchor?.exact ?? null,
    attachments: parseJsonColumn(
      attachmentListSchema,
      row.attachmentsJson ?? [],
      "nodes.attachments_json",
    ),
    title: row.title,
    model: row.model,
    origin: row.origin,
    status: row.status,
    createdAt: row.createdAt,
    recap: recap?.text.trim() ?? null,
  };
}

/**
 * One page of the mixed feed, newest first.
 *
 * `workspaceId` filters the research side only: journal entries belong to the
 * account rather than to a workspace, and hiding a saved link because the
 * sidebar is pointed elsewhere would lose it.
 */
export function recentActivity(
  db: SessionDatabase,
  userId: string,
  options: RecentActivityOptions = {},
): RecentActivityPage {
  const limit = clampLimit(options.limit);
  const cursor = options.before ?? null;
  const keyset = cursor
    ? sql`WHERE occurred_at < ${cursor.occurredAt}
        OR (occurred_at = ${cursor.occurredAt}
          AND (source_rank < ${cursor.sourceRank}
            OR (source_rank = ${cursor.sourceRank} AND id < ${cursor.id})))`
    : sql``;
  const journalSide = options.bookmarkedOnly
    ? sql`SELECT 'journal' AS source, 0 AS occurred_at, ${JOURNAL_ACTIVITY_SOURCE_RANK} AS source_rank, '' AS id WHERE 0`
    : sql`SELECT 'journal' AS source, je.created_at AS occurred_at,
            ${JOURNAL_ACTIVITY_SOURCE_RANK} AS source_rank, je.id AS id
          FROM journal_entries je
          WHERE je.user_id = ${userId} AND je.kind IN ('link', 'tweet')`;
  const rows = db.all<ActivityRow>(sql`
    SELECT source, occurred_at AS occurredAt, source_rank AS sourceRank, id FROM (
      ${journalSide}
      UNION ALL
      SELECT 'research' AS source, n.created_at AS occurred_at,
        ${RESEARCH_ACTIVITY_SOURCE_RANK} AS source_rank, n.id AS id
      FROM nodes n
      JOIN trees t ON t.id = n.tree_id
      WHERE n.user_id = ${userId}
        AND n.parent_node_id IS NULL
        AND n.kind = 'run'
        AND t.archived_at IS NULL
        ${options.workspaceId ? sql`AND t.workspace_id = ${options.workspaceId}` : sql``}
        ${options.bookmarkedOnly ? sql`AND t.bookmarked = 1` : sql``}
    )
    ${keyset}
    ORDER BY occurred_at DESC, source_rank DESC, id DESC
    LIMIT ${limit + 1}
  `);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const journalIds = page.filter((row) => row.source === "journal").map((row) => row.id);
  const researchIds = page.filter((row) => row.source === "research").map((row) => row.id);
  const entries = new Map<string, JournalEntry>();
  if (journalIds.length > 0) {
    for (const row of db.all<{ id: string; entryJson: string }>(sql`
      SELECT id, entry_json AS entryJson FROM journal_entries
      WHERE user_id = ${userId} AND id IN (${sql.join(
        journalIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `)) {
      entries.set(
        row.id,
        parseJsonColumn(
          journalEntrySchema,
          JSON.parse(row.entryJson) as unknown,
          "journal_entries.entry_json",
        ),
      );
    }
  }
  const queries = new Map<string, RecentResearchQuery>();
  const childrenByParent = new Map<string, RecentResearchQuery[]>();
  if (researchIds.length > 0) {
    const idList = sql.join(
      researchIds.map((id) => sql`${id}`),
      sql`, `,
    );
    for (const row of db.all<NodeRow>(sql`SELECT * FROM nodes WHERE id IN (${idList})`)) {
      queries.set(row.id, toRecentResearchQuery(normalizeNodeRow(row)));
    }
    for (const row of db.all<NodeRow>(sql`
      SELECT * FROM nodes
      WHERE parent_node_id IN (${idList}) AND kind = 'run'
      ORDER BY created_at ASC, id ASC
    `)) {
      const node = normalizeNodeRow(row);
      if (node.parentNodeId === null) {
        continue;
      }
      const list = childrenByParent.get(node.parentNodeId) ?? [];
      list.push(toRecentResearchQuery(node));
      childrenByParent.set(node.parentNodeId, list);
    }
  }
  const items: RecentActivityItem[] = page.flatMap((row): RecentActivityItem[] => {
    if (row.source === "journal") {
      const entry = entries.get(row.id);
      return entry ? [{ kind: "journal" as const, occurredAt: row.occurredAt, entry }] : [];
    }
    const query = queries.get(row.id);
    if (!query) {
      return [];
    }
    return [
      {
        kind: "research-query" as const,
        occurredAt: row.occurredAt,
        query: { ...query, children: childrenByParent.get(row.id) ?? [] },
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

/**
 * Raw `SELECT *` gives snake_case columns and SQLite's integers for booleans
 * and JSON text for the JSON columns; the drizzle mappers expect the shapes
 * the query builder produces. This is the one place raw rows are used, for the
 * `IN (…)` forms the builder cannot express over a keyset union, so the
 * conversion lives here rather than in the mapper.
 */
function normalizeNodeRow(row: Record<string, unknown>): NodeRow {
  const parse = (value: unknown): unknown =>
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    treeId: String(row["tree_id"]),
    parentNodeId: (row["parent_node_id"] as string | null) ?? null,
    inline: row["inline"] === 1 || row["inline"] === true,
    prompt: String(row["prompt"]),
    queryAnchorJson: parse(row["query_anchor_json"]) as NodeRow["queryAnchorJson"],
    attachmentsJson: (parse(row["attachments_json"]) ?? []) as NodeRow["attachmentsJson"],
    title: (row["title"] as string | null) ?? null,
    responsePreview: (row["response_preview"] as string | null) ?? null,
    model: String(row["model"]),
    kind: row["kind"] as NodeRow["kind"],
    origin: (row["origin"] as NodeRow["origin"]) ?? null,
    status: row["status"] as NodeRow["status"],
    error: (row["error"] as string | null) ?? null,
    attempt: Number(row["attempt"]),
    runSeq: Number(row["run_seq"]),
    resumePending: row["resume_pending"] === 1 || row["resume_pending"] === true,
    responseSnapshotAt: (row["response_snapshot_at"] as number | null) ?? null,
    createdAt: Number(row["created_at"]),
    startedAt: (row["started_at"] as number | null) ?? null,
    completedAt: (row["completed_at"] as number | null) ?? null,
    recapJson: parse(row["recap_json"]) as NodeRow["recapJson"],
  };
}

export interface RecentQueriesOptions {
  limit?: number | undefined;
  before?: RecentResearchQueryCursor | null | undefined;
  workspaceId?: string | null | undefined;
}

/** Root questions alone, newest first — the research-only half of the feed. */
export function recentQueries(
  db: SessionDatabase,
  userId: string,
  options: RecentQueriesOptions = {},
): RecentResearchQueryPage {
  const limit = clampLimit(options.limit);
  const cursor = options.before ?? null;
  const rows = db.all<NodeRow>(sql`
    SELECT n.* FROM nodes n
    JOIN trees t ON t.id = n.tree_id
    WHERE n.user_id = ${userId}
      AND n.parent_node_id IS NULL
      AND n.kind = 'run'
      AND t.archived_at IS NULL
      ${options.workspaceId ? sql`AND t.workspace_id = ${options.workspaceId}` : sql``}
      ${
        cursor
          ? sql`AND (n.created_at < ${cursor.createdAt}
              OR (n.created_at = ${cursor.createdAt} AND n.id < ${cursor.nodeId}))`
          : sql``
      }
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ${limit + 1}
  `);
  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map((row) =>
    toRecentResearchQuery(normalizeNodeRow(row)),
  );
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, nodeId: last.nodeId } : null,
  };
}
