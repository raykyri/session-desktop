// Research threads: admission, the sidebar order, summaries, and the
// thread-level flags (`docs/02-domain-model-and-database.md` §5.1, §5.9).

import type {
  DocumentSource,
  PostFormat,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeSummary,
  UserMessage,
} from "@session/shared";
import { defaultTitle, sanitizeResearchTitle } from "@session/shared";
import { postFormatOf } from "@session/shared/lib/researchNodeTypes";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { treeViews, trees } from "../schema/trees.js";
import { workspaces } from "../schema/workspaces.js";
import { now, strictlyAfter } from "../time.js";

import { markArchived, removeResearchTree, upsertResearchRoot } from "./feedgen.js";
import { toResearchHighlight, toResearchNode, toResearchTree } from "./mappers.js";
import type { TreeRow } from "./mappers.js";
import { deleteNodesOfTrees, hasActiveNodes } from "./subtrees.js";

/** The agent a node runs on (an exchange) or defaults its follow-ups to (a
 * post or document): a registry model id and a reasoning effort, null for
 * the model's default. */
export interface NodeAgentInput {
  model: string;
  effort?: string | null | undefined;
}

export interface AdmitRootInput {
  workspaceId: string;
  type: ResearchNodeType;
  /** A post's text, an exchange's question, or the question an imported
   * report answers. Required except for an authored document. */
  message?: UserMessage | null | undefined;
  /** Posts only; derived from the text when absent. */
  format?: PostFormat | undefined;
  /** Documents only. */
  source?: DocumentSource | undefined;
  agent: NodeAgentInput;
  title?: string | undefined;
  /** Exchanges only: `queued` for a run to be admitted (the default). */
  status?: ResearchNodeStatus | undefined;
  /** Supplied only by tests and by an importer that minted ids beforehand. */
  treeId?: string | undefined;
  nodeId?: string | undefined;
}

export interface TreeListOptions {
  workspaceId?: string | null | undefined;
  includeArchived?: boolean | undefined;
}

/** The trees one sidebar section lists: not archived (or archived), and not
 * in the Trash. */
function sectionPredicate(ownerId: string, workspaceId: string, archived: boolean) {
  return and(
    eq(trees.ownerId, ownerId),
    eq(trees.workspaceId, workspaceId),
    archived ? isNotNull(trees.archivedAt) : isNull(trees.archivedAt),
    isNull(trees.trashedAt),
  );
}

function requireTreeRow(db: SessionDatabase, userId: string, treeId: string): TreeRow {
  const row = db
    .select()
    .from(trees)
    .where(and(eq(trees.ownerId, userId), eq(trees.id, treeId)))
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return row;
}

/** When `userId` last viewed the thread, or null. */
export function lastViewedAt(db: SessionDatabase, userId: string, treeId: string): number | null {
  return (
    db
      .select({ at: treeViews.lastViewedAt })
      .from(treeViews)
      .where(and(eq(treeViews.userId, userId), eq(treeViews.treeId, treeId)))
      .get()?.at ?? null
  );
}

/** A tree row as `userId` sees it. */
export function treeFor(db: SessionDatabase, userId: string, row: TreeRow): ResearchTree {
  return toResearchTree(row, lastViewedAt(db, userId, row.id));
}

export function get(db: SessionDatabase, userId: string, treeId: string): ResearchTree | null {
  const row = db
    .select()
    .from(trees)
    .where(and(eq(trees.ownerId, userId), eq(trees.id, treeId)))
    .get();
  return row ? treeFor(db, userId, row) : null;
}

function writeView(db: SessionDatabase, userId: string, treeId: string, at: number): void {
  db.insert(treeViews)
    .values({ userId, treeId, lastViewedAt: at })
    .onConflictDoUpdate({
      target: [treeViews.userId, treeViews.treeId],
      set: { lastViewedAt: at },
    })
    .run();
}

function rootMessage(input: AdmitRootInput): UserMessage | null {
  const message = input.message ?? null;
  if (message === null) {
    if (input.type === "document" && input.source === "authored") {
      return null;
    }
    throw new Error("research prompt cannot be empty");
  }
  const text = message.text.trim();
  if (text === "") {
    throw new Error("research prompt cannot be empty");
  }
  return {
    text,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
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
  const message = rootMessage(input);
  if (input.agent.model.trim() === "") {
    throw new Error("research model cannot be empty");
  }
  if (input.type === "document" && input.source === undefined) {
    throw new Error("a research document needs a source");
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
      defaultTitle(message?.text ?? "");
    // New roots take position 0; everything visible in the section moves down.
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(sectionPredicate(userId, input.workspaceId, false))
      .run();
    const treeRow = tx
      .insert(trees)
      .values({
        id: treeId,
        ownerId: userId,
        workspaceId: input.workspaceId,
        title,
        rootNodeId: nodeId,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        trashedAt: null,
        parentTreeId: null,
        visibility: "private",
        position: 0,
      })
      .returning()
      .get();
    tx.insert(nodes)
      .values({
        id: nodeId,
        treeId,
        parentNodeId: null,
        authorId: userId,
        inline: false,
        type: input.type,
        messageJson: message,
        anchorJson: null,
        format: input.type === "post" ? (input.format ?? postFormatOf(message?.text ?? "")) : null,
        source: input.type === "document" ? (input.source ?? null) : null,
        model: input.agent.model,
        effort: input.agent.effort ?? null,
        title: null,
        responsePreview: null,
        status: input.type === "exchange" ? (input.status ?? "queued") : null,
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
    writeView(tx, userId, treeId, at);
    upsertResearchRoot(tx, nodeId);
    return detailFromRow(tx, userId, treeRow);
  });
}

/** Every node of a tree, ordered `(created_at, id)` — the one ordering the
 * domain uses (`docs/02` §5.1). */
export function detail(db: SessionDatabase, userId: string, treeId: string): ResearchTreeDetail {
  return detailFromRow(db, userId, requireTreeRow(db, userId, treeId));
}

function detailFromRow(db: SessionDatabase, userId: string, treeRow: TreeRow): ResearchTreeDetail {
  const nodeRows = db
    .select()
    .from(nodes)
    .where(eq(nodes.treeId, treeRow.id))
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .all();
  const nodeIds = nodeRows.map((row) => row.id);
  const highlightsByNode = new Map<string, ReturnType<typeof toResearchHighlight>[]>();
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
  }
  return {
    tree: treeFor(db, userId, treeRow),
    nodes: nodeRows.map((row) =>
      toResearchNode(row, {
        workspaceId: treeRow.workspaceId,
        highlights: highlightsByNode.get(row.id) ?? [],
      }),
    ),
  };
}

/**
 * The sidebar list with its counts and attention flags
 * (`docs/02` §5.9). Trees in the Trash are left out. `interrupted` counts in
 * no bucket and raises no flag: it is shown in the activity rail, and a run
 * the server is about to resume is not something the user has to act on.
 * Posts and documents have no run and count in no bucket either.
 */
export function summaries(
  db: SessionDatabase,
  userId: string,
  options: TreeListOptions = {},
): ResearchTreeSummary[] {
  const treeRows = db
    .select({ tree: trees, lastViewedAt: treeViews.lastViewedAt })
    .from(trees)
    .leftJoin(treeViews, and(eq(treeViews.treeId, trees.id), eq(treeViews.userId, userId)))
    .where(
      and(
        eq(trees.ownerId, userId),
        options.workspaceId ? eq(trees.workspaceId, options.workspaceId) : undefined,
        options.includeArchived === true ? undefined : isNull(trees.archivedAt),
        isNull(trees.trashedAt),
      ),
    )
    .orderBy(asc(trees.position), asc(trees.id))
    .all();
  if (treeRows.length === 0) {
    return [];
  }
  const treeIds = treeRows.map((row) => row.tree.id);
  const grouped = db
    .select({
      treeId: nodes.treeId,
      status: nodes.status,
      total: sql<number>`count(*)`,
      latestSettlement: sql<number | null>`max(${nodes.completedAt})`,
    })
    .from(nodes)
    .where(and(inArray(nodes.treeId, treeIds), isNotNull(nodes.status)))
    .groupBy(nodes.treeId, nodes.status)
    .all();
  const rootTypes = new Map(
    db
      .select({ id: nodes.id, type: nodes.type })
      .from(nodes)
      .where(
        inArray(
          nodes.id,
          treeRows.map((row) => row.tree.rootNodeId),
        ),
      )
      .all()
      .map((row) => [row.id, row.type]),
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
  return treeRows.map(({ tree: row, lastViewedAt: viewedAt }) => {
    const entry = counts.get(row.id);
    const unseen = (settledAt: number | null | undefined): boolean =>
      settledAt !== null && settledAt !== undefined && (viewedAt === null || settledAt > viewedAt);
    return {
      id: row.id,
      title: row.title,
      rootNodeId: row.rootNodeId,
      type: rootTypes.get(row.rootNodeId) ?? "exchange",
      workspaceId: row.workspaceId,
      runningCount: entry?.running ?? 0,
      failedCount: entry?.failed ?? 0,
      completedCount: entry?.completed ?? 0,
      cancelledCount: entry?.cancelled ?? 0,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      hasUnseenUpdate: unseen(entry?.latestSettlement),
      hasUnseenFailure: unseen(entry?.latestFailure),
    };
  });
}

/**
 * Replaces the order of exactly one visible sidebar section.
 *
 * The section is `(workspace_id, archived)`, without the Trash; positions are
 * scoped to it, so archived threads and other workspaces keep their places
 * untouched. The three rejections are the desktop's (`state.rs:3792`) with
 * its messages: a stale count, a duplicate, and an id from another section.
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
      .where(sectionPredicate(userId, workspaceId, archived))
      .orderBy(asc(trees.position), asc(trees.id))
      .all()
      .map((row) => row.id);
    if (treeIds.length !== expected.length) {
      throw new Error(
        "Reorder conflict: tree sequence is stale. Refresh the list before reordering.",
      );
    }
    const known = new Set(expected);
    const seen = new Set<string>();
    for (const treeId of treeIds) {
      if (seen.has(treeId)) {
        throw new Error("Invalid reorder request: list contains duplicate tree IDs.");
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
    throw new Error("Research thread title is required.");
  }
  const row = db
    .update(trees)
    .set({ title: clean, updatedAt: now() })
    .where(and(eq(trees.ownerId, userId), eq(trees.id, treeId)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return treeFor(db, userId, row);
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
    .where(and(eq(trees.ownerId, userId), eq(trees.id, treeId)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`research tree ${treeId} was not found`);
  }
  return treeFor(db, userId, row);
}

/** Viewing acknowledges unseen updates and failures, for this person only. */
export function markViewed(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    writeView(tx, userId, row.id, now());
    return treeFor(tx, userId, row);
  });
}

/** Moves the thread into the archived section at position 0. */
export function archive(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (row.archivedAt !== null) {
      return treeFor(tx, userId, row);
    }
    const at = now();
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(sectionPredicate(userId, row.workspaceId, true))
      .run();
    const tree = setFlag(tx, userId, treeId, {
      archivedAt: at,
      position: 0,
      updatedAt: strictlyAfter(row.updatedAt, at),
    });
    markArchived(tx, treeId, true);
    return tree;
  });
}

export function restore(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (row.archivedAt === null) {
      return treeFor(tx, userId, row);
    }
    const at = now();
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(sectionPredicate(userId, row.workspaceId, false))
      .run();
    const tree = setFlag(tx, userId, treeId, {
      archivedAt: null,
      position: 0,
      updatedAt: strictlyAfter(row.updatedAt, at),
    });
    markArchived(tx, treeId, false);
    return tree;
  });
}

/** Deletes the thread and everything under it. Refused while a run in it is
 * still the server's responsibility, for the reason `workspaces.remove`
 * gives. */
export function remove(db: SessionDatabase, userId: string, treeId: string): void {
  transact(db, (tx) => {
    const row = requireTreeRow(tx, userId, treeId);
    if (hasActiveNodes(tx, [row.id])) {
      throw new Error("Cannot delete research thread with an active run: cancel the run first.");
    }
    removeResearchTree(tx, row.id);
    deleteNodesOfTrees(tx, [row.id]);
    tx.delete(trees).where(eq(trees.id, row.id)).run();
  });
}
