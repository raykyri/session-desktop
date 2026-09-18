// Research threads: admission, the sidebar order, summaries, and the
// thread-level flags (`docs/02-domain-model-and-database.md` §5.1, §5.9).

import type {
  ResearchMessageAttachment,
  ResearchNodeStatus,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
} from "@session/shared";
import { defaultTitle, sanitizeResearchTitle } from "@session/shared";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { nodeDocuments } from "../schema/documents.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { workspaces } from "../schema/workspaces.js";
import { now, strictlyAfter } from "../time.js";

import { attachWithin } from "./documents.js";
import { toResearchHighlight, toResearchNode, toResearchTree } from "./mappers.js";
import { deleteNodesOfTrees, hasActiveNodes } from "./subtrees.js";

export interface AdmitRootInput {
  workspaceId: string;
  /** The bare question, or the prompt an imported report was filed under. */
  prompt: string;
  /** Registry id. Metadata and imports still record which model owns them. */
  model: string;
  title?: string | undefined;
  kind?: "run" | "document" | undefined;
  origin?: "imported" | null | undefined;
  /** `queued` for a run to be admitted, `complete` for imported content that
   * already has its answer. */
  status?: ResearchNodeStatus | undefined;
  attachments?: ResearchMessageAttachment[] | undefined;
  documentIds?: string[] | undefined;
  /** Supplied only by tests and by an importer that minted ids beforehand. */
  treeId?: string | undefined;
  nodeId?: string | undefined;
}

export interface TreeListOptions {
  workspaceId?: string | null | undefined;
  includeArchived?: boolean | undefined;
}

function requireTreeRow(
  db: SessionDatabase,
  userId: string,
  treeId: string,
): typeof trees.$inferSelect {
  const row = db
    .select()
    .from(trees)
    .where(and(eq(trees.userId, userId), eq(trees.id, treeId)))
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return row;
}

export function get(db: SessionDatabase, userId: string, treeId: string): ResearchTree | null {
  const row = db
    .select()
    .from(trees)
    .where(and(eq(trees.userId, userId), eq(trees.id, treeId)))
    .get();
  return row ? toResearchTree(row) : null;
}

/**
 * Creates a thread and its root node in one transaction, at the top of the
 * sidebar.
 *
 * The two rows reference each other (`trees.root_node_id`,
 * `nodes.tree_id`) and neither is meaningful alone, which is why this is the
 * only way a tree comes into existence (`docs/02` §5.1).
 */
export function admitRoot(
  db: SessionDatabase,
  userId: string,
  input: AdmitRootInput,
): ResearchTreeDetail {
  const prompt = input.prompt.trim();
  if (prompt === "") {
    throw new Error("research prompt cannot be empty");
  }
  if (input.model.trim() === "") {
    throw new Error("research model cannot be empty");
  }
  return transact(db, (tx) => {
    const workspace = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, input.workspaceId)))
      .get();
    if (!workspace) {
      throw new Error(`research workspace ${input.workspaceId} was not found`);
    }
    const treeId = input.treeId ?? newId();
    const nodeId = input.nodeId ?? newId();
    const at = now();
    const title =
      (input.title === undefined ? undefined : sanitizeResearchTitle(input.title)) ??
      defaultTitle(prompt);
    // New roots take position 0; everything visible in the section moves down.
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(
        and(
          eq(trees.userId, userId),
          eq(trees.workspaceId, input.workspaceId),
          isNull(trees.archivedAt),
        ),
      )
      .run();
    const treeRow = tx
      .insert(trees)
      .values({
        id: treeId,
        userId,
        workspaceId: input.workspaceId,
        title,
        rootNodeId: nodeId,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        lastViewedAt: at,
        followed: false,
        bookmarked: false,
        starred: 0,
        position: 0,
      })
      .returning()
      .get();
    tx.insert(nodes)
      .values({
        id: nodeId,
        userId,
        treeId,
        parentNodeId: null,
        inline: false,
        prompt,
        queryAnchorJson: null,
        attachmentsJson: input.attachments ?? [],
        title: null,
        responsePreview: null,
        model: input.model,
        kind: input.kind ?? "run",
        origin: input.origin ?? null,
        status: input.status ?? "queued",
        error: null,
        attempt: 1,
        runSeq: 0,
        resumePending: false,
        responseSnapshotAt: null,
        createdAt: at,
        startedAt: null,
        completedAt: null,
        recapJson: null,
      })
      .run();
    // Through the checked path: an id the caller supplied is not an id the
    // caller owns, and an unchecked insert here lets one account attach
    // another's document — permanently, because `documents.remove` refuses a
    // document a node references (`06-auth-and-users.md` §4).
    attachWithin(tx, userId, nodeId, input.documentIds ?? []);
    return detailFromRow(tx, treeRow);
  });
}

/** Every node of a tree, ordered `(created_at, id)` — the one ordering the
 * domain uses (`docs/02` §5.1). */
export function detail(db: SessionDatabase, userId: string, treeId: string): ResearchTreeDetail {
  return detailFromRow(db, requireTreeRow(db, userId, treeId));
}

function detailFromRow(
  db: SessionDatabase,
  treeRow: typeof trees.$inferSelect,
): ResearchTreeDetail {
  const nodeRows = db
    .select()
    .from(nodes)
    .where(eq(nodes.treeId, treeRow.id))
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all();
  const nodeIds = nodeRows.map((row) => row.id);
  const highlightsByNode = new Map<string, ReturnType<typeof toResearchHighlight>[]>();
  const documentsByNode = new Map<string, string[]>();
  if (nodeIds.length > 0) {
    for (const row of db
      .select()
      .from(highlights)
      .where(inArray(highlights.nodeId, nodeIds))
      .orderBy(asc(highlights.createdAt), asc(highlights.id))
      .all()) {
      const list = highlightsByNode.get(row.nodeId) ?? [];
      list.push(toResearchHighlight(row));
      highlightsByNode.set(row.nodeId, list);
    }
    for (const row of db
      .select()
      .from(nodeDocuments)
      .where(inArray(nodeDocuments.nodeId, nodeIds))
      .orderBy(asc(nodeDocuments.position))
      .all()) {
      const list = documentsByNode.get(row.nodeId) ?? [];
      list.push(row.documentId);
      documentsByNode.set(row.nodeId, list);
    }
  }
  return {
    tree: toResearchTree(treeRow),
    nodes: nodeRows.map((row) =>
      toResearchNode(row, {
        workspaceId: treeRow.workspaceId,
        highlights: highlightsByNode.get(row.id) ?? [],
        documentIds: documentsByNode.get(row.id) ?? [],
      }),
    ),
  };
}

/**
 * The sidebar list with its counts and attention flags
 * (`docs/02` §5.9). `interrupted` counts in no bucket and raises no flag: it
 * is shown in the activity rail, and a run the server is about to resume is
 * not something the user has to act on.
 */
export function summaries(
  db: SessionDatabase,
  userId: string,
  options: TreeListOptions = {},
): ResearchTreeSummary[] {
  const treeRows = db
    .select()
    .from(trees)
    .where(
      and(
        eq(trees.userId, userId),
        options.workspaceId ? eq(trees.workspaceId, options.workspaceId) : undefined,
        options.includeArchived === true ? undefined : isNull(trees.archivedAt),
      ),
    )
    .orderBy(asc(trees.position), asc(trees.id))
    .all();
  if (treeRows.length === 0) {
    return [];
  }
  const treeIds = treeRows.map((row) => row.id);
  const grouped = db
    .select({
      treeId: nodes.treeId,
      status: nodes.status,
      total: sql<number>`count(*)`,
      latestSettlement: sql<number | null>`max(${nodes.completedAt})`,
    })
    .from(nodes)
    .where(inArray(nodes.treeId, treeIds))
    .groupBy(nodes.treeId, nodes.status)
    .all();
  const rootKinds = new Map(
    db
      .select({ id: nodes.id, kind: nodes.kind })
      .from(nodes)
      .where(
        inArray(
          nodes.id,
          treeRows.map((row) => row.rootNodeId),
        ),
      )
      .all()
      .map((row) => [row.id, row.kind]),
  );
  interface Counts {
    running: number;
    failed: number;
    completed: number;
    cancelled: number;
    latestSettlement: number | null;
    latestFailure: number | null;
  }
  const counts = new Map<string, Counts>();
  const merge = (left: number | null, right: number | null): number | null =>
    left === null ? right : right === null ? left : Math.max(left, right);
  for (const row of grouped) {
    const entry = counts.get(row.treeId) ?? {
      running: 0,
      failed: 0,
      completed: 0,
      cancelled: 0,
      latestSettlement: null,
      latestFailure: null,
    };
    if (row.status === "queued" || row.status === "running") {
      entry.running += row.total;
    } else if (row.status === "failed") {
      entry.failed += row.total;
      entry.latestFailure = merge(entry.latestFailure, row.latestSettlement);
    } else if (row.status === "complete") {
      entry.completed += row.total;
    } else if (row.status === "cancelled") {
      entry.cancelled += row.total;
    }
    entry.latestSettlement = merge(entry.latestSettlement, row.latestSettlement);
    counts.set(row.treeId, entry);
  }
  return treeRows.map((row) => {
    const entry = counts.get(row.id);
    const unseen = (settledAt: number | null | undefined): boolean =>
      settledAt !== null &&
      settledAt !== undefined &&
      (row.lastViewedAt === null || settledAt > row.lastViewedAt);
    return {
      id: row.id,
      title: row.title,
      rootNodeId: row.rootNodeId,
      kind: rootKinds.get(row.rootNodeId) ?? "run",
      workspaceId: row.workspaceId,
      runningCount: entry?.running ?? 0,
      failedCount: entry?.failed ?? 0,
      completedCount: entry?.completed ?? 0,
      cancelledCount: entry?.cancelled ?? 0,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      followed: row.followed,
      bookmarked: row.bookmarked,
      hasUnseenUpdate: unseen(entry?.latestSettlement),
      hasUnseenFailure: unseen(entry?.latestFailure),
    };
  });
}

/**
 * Replaces the order of exactly one visible sidebar section.
 *
 * The section is `(workspace_id, archived)`; positions are scoped to it, so
 * archived threads and other workspaces keep their places untouched. The three
 * rejections are the desktop's (`state.rs:3792`) with its messages: a stale
 * count, a duplicate, and an id from another section.
 */
export function reorder(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  archived: boolean,
  treeIds: string[],
): void {
  transact(db, (tx) => {
    const expected = tx
      .select({ id: trees.id })
      .from(trees)
      .where(
        and(
          eq(trees.userId, userId),
          eq(trees.workspaceId, workspaceId),
          archived ? isNotNull(trees.archivedAt) : isNull(trees.archivedAt),
        ),
      )
      .orderBy(asc(trees.position), asc(trees.id))
      .all()
      .map((row) => row.id);
    if (treeIds.length !== expected.length) {
      throw new Error("research tree order is stale; refresh before reordering");
    }
    const known = new Set(expected);
    const seen = new Set<string>();
    for (const treeId of treeIds) {
      if (seen.has(treeId)) {
        throw new Error("research tree order contains a duplicate tree");
      }
      if (!known.has(treeId)) {
        throw new Error(`research tree ${treeId} is not in the requested sidebar section`);
      }
      seen.add(treeId);
    }
    treeIds.forEach((treeId, position) => {
      tx.update(trees).set({ position }).where(eq(trees.id, treeId)).run();
    });
  });
}

/** Bumps `updated_at` strictly forward. Called by every node mutation,
 * including failure (`state.rs:11431`). */
export function touchTree(db: SessionDatabase, treeId: string, at: number = now()): void {
  db.update(trees)
    .set({ updatedAt: sql`max(${at}, ${trees.updatedAt} + 1)` })
    .where(eq(trees.id, treeId))
    .run();
}

export function rename(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  title: string,
): ResearchTree {
  const clean = sanitizeResearchTitle(title);
  if (clean === undefined) {
    throw new Error("a research thread needs a title");
  }
  const row = db
    .update(trees)
    .set({ title: clean, updatedAt: now() })
    .where(and(eq(trees.userId, userId), eq(trees.id, treeId)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return toResearchTree(row);
}

function setFlag(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  patch: Partial<typeof trees.$inferInsert>,
): ResearchTree {
  const row = db
    .update(trees)
    .set(patch)
    .where(and(eq(trees.userId, userId), eq(trees.id, treeId)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return toResearchTree(row);
}

export function setFollowed(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  followed: boolean,
): ResearchTree {
  return setFlag(db, userId, treeId, { followed });
}

export function setBookmarked(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  bookmarked: boolean,
): ResearchTree {
  return setFlag(db, userId, treeId, { bookmarked });
}

/** Viewing acknowledges unseen updates and failures. */
export function markViewed(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return setFlag(db, userId, treeId, { lastViewedAt: now() });
}

/** Moves the thread into the archived section at position 0. */
export function archive(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (row.archivedAt !== null) {
      return toResearchTree(row);
    }
    const at = now();
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(
        and(
          eq(trees.userId, userId),
          eq(trees.workspaceId, row.workspaceId),
          isNotNull(trees.archivedAt),
        ),
      )
      .run();
    return setFlag(tx, userId, treeId, {
      archivedAt: at,
      position: 0,
      updatedAt: strictlyAfter(row.updatedAt, at),
    });
  });
}

export function restore(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (row.archivedAt === null) {
      return toResearchTree(row);
    }
    const at = now();
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(
        and(
          eq(trees.userId, userId),
          eq(trees.workspaceId, row.workspaceId),
          isNull(trees.archivedAt),
        ),
      )
      .run();
    return setFlag(tx, userId, treeId, {
      archivedAt: null,
      position: 0,
      updatedAt: strictlyAfter(row.updatedAt, at),
    });
  });
}

/** Deletes the thread and everything under it. Refused while a run in it is
 * still the server's responsibility, for the reason `workspaces.remove`
 * gives. */
export function remove(db: SessionDatabase, userId: string, treeId: string): void {
  transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (hasActiveNodes(tx, [row.id])) {
      throw new Error("cancel this research before removing it");
    }
    deleteNodesOfTrees(tx, [row.id]);
    tx.delete(trees).where(eq(trees.id, row.id)).run();
  });
}
