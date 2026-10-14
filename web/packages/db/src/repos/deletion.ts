// Deleting threads in the background (`docs/02-domain-model-and-database.md`
// §5.18).
//
// A thread with thousands of messages, turns and widget revisions takes
// seconds to delete, and SQLite holds its one write lock for all of it. So
// Delete now, Empty Trash and removing a workspace only mark the threads
// (`markTreesDeleted`): `trees.deleted_at` is set and the rows that tie the
// thread to people (members, invitations, follows, views, filing, collapsed
// groups, the Home feed row, inbox notifications, queued follow-ups) are
// deleted at once, in the caller's transaction. From then on no query or
// access check sees the thread (`access.treeLive`, `treeReadableBy`,
// `treeJoinedBy`, `roleFor`).
//
// The rest is deleted by `step`, which the server's deletion job calls
// between requests (`server/src/research/deletion.ts`): each call deletes a
// bounded number of rows in its own transaction: the next batch of the
// thread's nodes deepest first, the rows that can be numerous per node
// before the nodes themselves, and the thread row once no node is left.
// Nothing is kept in memory between steps, so a restart resumes from what is
// left. A removed workspace whose threads still have rows is marked
// the same way (`workspaces.deleted_at`) and deleted after its last thread.

import { and, asc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import {
  treeInvites,
  treeMemberRemovals,
  treeMembers,
  treeSubscriptions,
} from "../schema/collaboration.js";
import { researchDrafts } from "../schema/drafts.js";
import { feedItems } from "../schema/feedItems.js";
import {
  collapsedGroups,
  collapsedPlaces,
  folders,
  treeFolderMembership,
} from "../schema/folders.js";
import { followupQueue } from "../schema/followups.js";
import { highlights } from "../schema/highlights.js";
import { notifications } from "../schema/notifications.js";
import { nodeMessages, nodeSummaries, runAttempts, runTurns } from "../schema/runs.js";
import { responseSnapshots } from "../schema/snapshots.js";
import { treeViews, trees } from "../schema/trees.js";
import { widgetRevisions } from "../schema/widgets.js";
import { workspaces } from "../schema/workspaces.js";
import { now } from "../time.js";

import { dropRefs } from "./imageRefs.js";
import { deepestFirstBatches, deleteNodeBatches, nodeLevels } from "./subtrees.js";

/** The per-person and per-thread rows deleted when a thread is marked: what
 * would let anyone reach it, or list it. Each has a `tree_id` column. */
export const MARK_DELETED_TABLES = [
  treeMembers,
  treeInvites,
  treeMemberRemovals,
  treeSubscriptions,
  treeViews,
  collapsedGroups,
  treeFolderMembership,
  feedItems,
  notifications,
  followupQueue,
] as const;

/** Tables keyed by `node_id` whose rows can be numerous per node (a run's
 * turns, its messages, a widget's revisions). `step` deletes them in bounded
 * batches before it deletes the nodes, so no node delete cascades into an
 * unbounded number of rows. The other `node_id` tables (`run_queue`,
 * `feed_items`, `followup_queue`) hold at most a row or two per node. */
export const NODE_DEPENDENT_TABLES = [
  runTurns,
  nodeMessages,
  widgetRevisions,
  highlights,
  runAttempts,
  responseSnapshots,
  nodeSummaries,
] as const;

/** The rows removing a workspace deletes at once, besides its threads: each
 * has a `workspace_id` column and would otherwise cascade from the
 * workspace row. */
export const WORKSPACE_DEPENDENT_TABLES = [
  folders,
  collapsedPlaces,
  researchDrafts,
  feedItems,
] as const;

/**
 * Marks threads deleted, inside the caller's transaction (which has checked
 * the caller may delete them and that none has an active run). The threads
 * disappear from every list and access check now; `step` deletes their rows
 * later. A thread listed under one of them that is not itself marked loses
 * its parent, as `parent_tree_id`'s `ON DELETE SET NULL` would do.
 */
export function markTreesDeleted(
  db: SessionDatabase,
  treeIds: readonly string[],
  at: number = now(),
): void {
  if (treeIds.length === 0) {
    return;
  }
  const ids = [...new Set(treeIds)];
  db.update(trees).set({ deletedAt: at }).where(inArray(trees.id, ids)).run();
  db.update(trees)
    .set({ parentTreeId: null })
    .where(and(inArray(trees.parentTreeId, ids), notInArray(trees.id, ids)))
    .run();
  const queued = db
    .select({ id: followupQueue.id })
    .from(followupQueue)
    .where(inArray(followupQueue.treeId, ids))
    .all()
    .map((row) => row.id);
  dropRefs(db, "queue", queued);
  for (const table of MARK_DELETED_TABLES) {
    db.run(
      sql`delete from ${table} where tree_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  }
}

/**
 * Removes a workspace, inside the caller's transaction, after its threads
 * were marked deleted: the rows that hang off it (folders and their filing,
 * collapsed trays, drafts and their image references, feed rows) go now and
 * a member's Trash entry filed under it falls back to their default
 * workspace. The row itself is deleted now when no thread names it any
 * more, else marked and left to `step`.
 */
export function markWorkspaceDeleted(
  db: SessionDatabase,
  workspaceId: string,
  at: number = now(),
): void {
  const drafts = db
    .select({ id: researchDrafts.id })
    .from(researchDrafts)
    .where(eq(researchDrafts.workspaceId, workspaceId))
    .all()
    .map((row) => row.id);
  dropRefs(db, "draft", drafts);
  for (const table of WORKSPACE_DEPENDENT_TABLES) {
    db.run(sql`delete from ${table} where workspace_id = ${workspaceId}`);
  }
  db.update(treeMembers)
    .set({ trashWorkspaceId: null })
    .where(eq(treeMembers.trashWorkspaceId, workspaceId))
    .run();
  const named = db
    .select({ id: trees.id })
    .from(trees)
    .where(eq(trees.workspaceId, workspaceId))
    .limit(1)
    .get();
  if (named) {
    db.update(workspaces).set({ deletedAt: at }).where(eq(workspaces.id, workspaceId)).run();
  } else {
    db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
  }
}

/** How much one `step` may delete. */
export interface StepLimits {
  /** Rows of the node-dependent tables, across all of them. */
  rows: number;
  /** Nodes. */
  nodes: number;
}

/** Sized so a step takes a few milliseconds on the deployment's volume:
 * long enough to make progress, short enough that a request waiting for the
 * write lock does not notice it. */
export const DEFAULT_STEP_LIMITS: StepLimits = { rows: 2000, nodes: 250 };

/** What one `step` did. */
export interface DeletionStep {
  /** The thread worked on, or null when the step finished a workspace. */
  treeId: string | null;
  /** The workspace deleted, when the step finished one. */
  workspaceId: string | null;
  /** Node-dependent rows deleted. */
  rows: number;
  /** Nodes deleted. */
  nodes: number;
  /** The thread's (or the workspace's) row was deleted: it is gone. */
  finished: boolean;
}

/**
 * Deletes the next bounded batch of a marked thread's rows, in one
 * transaction, oldest marked thread first; or a marked workspace no thread
 * names any more. Null when nothing is left to delete.
 */
export function step(
  db: SessionDatabase,
  limits: StepLimits = DEFAULT_STEP_LIMITS,
): DeletionStep | null {
  return transact(db, (tx) => {
    const tree = tx
      .select({ id: trees.id })
      .from(trees)
      .where(isNotNull(trees.deletedAt))
      .orderBy(asc(trees.deletedAt), asc(trees.id))
      .limit(1)
      .get();
    if (tree) {
      return stepTree(tx, tree.id, limits);
    }
    const workspace = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          isNotNull(workspaces.deletedAt),
          sql`not exists (select 1 from ${trees} where ${trees.workspaceId} = ${workspaces.id})`,
        ),
      )
      .orderBy(asc(workspaces.deletedAt), asc(workspaces.id))
      .limit(1)
      .get();
    if (workspace) {
      tx.delete(workspaces).where(eq(workspaces.id, workspace.id)).run();
      return { treeId: null, workspaceId: workspace.id, rows: 0, nodes: 0, finished: true };
    }
    return null;
  });
}

function stepTree(db: SessionDatabase, treeId: string, limits: StepLimits): DeletionStep {
  const batches = deepestFirstBatches(nodeLevels(db, [treeId]), limits.nodes);
  const nodeIds = batches.flat();
  if (nodeIds.length === 0) {
    // Nothing under the thread is left, so its own delete cascades only into
    // what `markTreesDeleted` already emptied.
    db.delete(trees).where(eq(trees.id, treeId)).run();
    return { treeId, workspaceId: null, rows: 0, nodes: 0, finished: true };
  }
  // The batch's numerous dependents first, so deleting the nodes cascades
  // into a bounded number of rows; when they exceed the budget, the next
  // step picks the same batch and continues.
  let rows = 0;
  for (const table of NODE_DEPENDENT_TABLES) {
    const budget = limits.rows - rows;
    if (budget <= 0) {
      break;
    }
    rows += deleteDependents(db, table, nodeIds, budget);
  }
  if (rows >= limits.rows) {
    return { treeId, workspaceId: null, rows, nodes: 0, finished: false };
  }
  const nodes = deleteNodeBatches(db, batches);
  return { treeId, workspaceId: null, rows, nodes, finished: false };
}

/** Deletes up to `limit` rows of `table` that belong to `nodeIds`. Every
 * table in `NODE_DEPENDENT_TABLES` has a `node_id` column with an index. */
function deleteDependents(
  db: SessionDatabase,
  table: SQLiteTable,
  nodeIds: readonly string[],
  limit: number,
): number {
  let removed = 0;
  for (let start = 0; start < nodeIds.length && removed < limit; start += 500) {
    const ids = nodeIds.slice(start, start + 500);
    removed += db.run(sql`
      delete from ${table}
       where rowid in (
         select rowid from ${table}
          where node_id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
          limit ${limit - removed}
       )
    `).changes;
  }
  return removed;
}

/** Runs `step` until nothing is left. For tests, and for an operator who
 * wants the deletions finished before a backup. Returns how many steps ran. */
export function drain(db: SessionDatabase, limits: StepLimits = DEFAULT_STEP_LIMITS): number {
  let steps = 0;
  while (step(db, limits) !== null) {
    steps += 1;
  }
  return steps;
}

/** Whether any thread or workspace is waiting to be deleted. */
export function pending(db: SessionDatabase): boolean {
  return (
    db.select({ id: trees.id }).from(trees).where(isNotNull(trees.deletedAt)).limit(1).get() !==
      undefined ||
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(isNotNull(workspaces.deletedAt))
      .limit(1)
      .get() !== undefined
  );
}
