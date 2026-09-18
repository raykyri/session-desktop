// Workspaces (`docs/02-domain-model-and-database.md` §3.2,
// `docs/03-api-and-events.md` §2).

import type { Workspace } from "@session/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";
import { workspaces } from "../schema/workspaces.js";
import { now } from "../time.js";

import { ensure as ensurePreferences, update as updatePreferences } from "./preferences.js";
import { deleteNodesOfTrees } from "./subtrees.js";

export const DEFAULT_WORKSPACE_NAME = "Research";

/** Active and pending run statuses that indicate in-flight execution. */
const ACTIVE_STATUSES = ["queued", "running"] as const;

function toWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("Workspace name is required.");
  }
  return trimmed;
}

export function list(db: SessionDatabase, userId: string): Workspace[] {
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.userId, userId))
    .orderBy(asc(workspaces.position), asc(workspaces.id))
    .all()
    .map(toWorkspace);
}

export function get(db: SessionDatabase, userId: string, workspaceId: string): Workspace | null {
  const row = db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId)))
    .get();
  return row ? toWorkspace(row) : null;
}

/** Appends a workspace at the end of the user's order. */
export function create(db: SessionDatabase, userId: string, name: string): Workspace {
  const workspaceName = normalizeName(name);
  return transact(db, (tx) => {
    const last = tx
      .select({ position: workspaces.position })
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .orderBy(sql`${workspaces.position} desc`)
      .get();
    const at = now();
    const row = tx
      .insert(workspaces)
      .values({
        id: newId(),
        userId,
        name: workspaceName,
        position: last === undefined ? 0 : last.position + 1,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
    return toWorkspace(row);
  });
}

export function rename(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
  name: string,
): Workspace {
  const row = db
    .update(workspaces)
    .set({ name: normalizeName(name), updatedAt: now() })
    .where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId)))
    .returning()
    .get();
  if (!row) {
    throw new Error(`research workspace ${workspaceId} was not found`);
  }
  return toWorkspace(row);
}

/**
 * Deletes a workspace and every tree in it.
 *
 * Rejects deletion while a run is queued or active, preventing orphaned
 * provider streams and writes to deleted node records. Cancel active runs
 * before deleting the workspace.
 */
export function remove(
  db: SessionDatabase,
  userId: string,
  workspaceId: string,
): { removedTreeIds: string[] } {
  return transact(db, (tx) => {
    const workspace = tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId)))
      .get();
    if (!workspace) {
      throw new Error(`research workspace ${workspaceId} was not found`);
    }
    const active = tx
      .select({ id: nodes.id })
      .from(nodes)
      .innerJoin(trees, eq(trees.id, nodes.treeId))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(trees.workspaceId, workspaceId),
          inArray(nodes.status, [...ACTIVE_STATUSES]),
        ),
      )
      .get();
    if (active) {
      throw new Error("Cannot delete workspace: all active research runs must be cancelled first.");
    }
    const removedTreeIds = tx
      .select({ id: trees.id })
      .from(trees)
      .where(and(eq(trees.userId, userId), eq(trees.workspaceId, workspaceId)))
      .all()
      .map((row) => row.id);
    // Leaves before parents: `nodes.parent_node_id` is RESTRICT, so the tree
    // cascade cannot delete a parent while its children are still there.
    deleteNodesOfTrees(tx, removedTreeIds);
    tx.delete(workspaces)
      .where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId)))
      .run();
    const preferences = ensurePreferences(tx, userId);
    if (preferences.defaultWorkspaceId === workspaceId) {
      updatePreferences(tx, userId, { defaultWorkspaceId: null });
    }
    return { removedTreeIds };
  });
}

/** Replaces the workspace order. Rejects a list that is not a permutation of
 * the user's workspaces, for the same reason `trees.reorder` does: a stale
 * client would otherwise silently drop a workspace out of the sidebar. */
export function reorder(db: SessionDatabase, userId: string, workspaceIds: string[]): Workspace[] {
  return transact(db, (tx) => {
    const existing = tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.userId, userId))
      .all()
      .map((row) => row.id);
    if (existing.length !== workspaceIds.length) {
      throw new Error("Reorder conflict: workspace list is stale. Refresh and retry.");
    }
    const seen = new Set<string>();
    const known = new Set(existing);
    for (const workspaceId of workspaceIds) {
      if (seen.has(workspaceId)) {
        throw new Error("Invalid workspace order: list contains duplicate workspace IDs.");
      }
      if (!known.has(workspaceId)) {
        throw new Error(`workspace ${workspaceId} is not in this account`);
      }
      seen.add(workspaceId);
    }
    const at = now();
    workspaceIds.forEach((workspaceId, position) => {
      tx.update(workspaces)
        .set({ position, updatedAt: at })
        .where(and(eq(workspaces.userId, userId), eq(workspaces.id, workspaceId)))
        .run();
    });
    return list(tx, userId);
  });
}

/** Resolves the default workspace for new research, falling back to the first ordered workspace or creating a initial default workspace if none exists. */
export function ensureDefault(db: SessionDatabase, userId: string): Workspace {
  return transact(db, (tx) => {
    const preferences = ensurePreferences(tx, userId);
    if (preferences.defaultWorkspaceId !== null) {
      const preferred = get(tx, userId, preferences.defaultWorkspaceId);
      if (preferred) {
        return preferred;
      }
    }
    const first = list(tx, userId)[0];
    if (first) {
      updatePreferences(tx, userId, { defaultWorkspaceId: first.id });
      return first;
    }
    const created = create(tx, userId, DEFAULT_WORKSPACE_NAME);
    updatePreferences(tx, userId, { defaultWorkspaceId: created.id });
    return created;
  });
}

export function setDefault(db: SessionDatabase, userId: string, workspaceId: string): Workspace {
  return transact(db, (tx) => {
    const workspace = get(tx, userId, workspaceId);
    if (!workspace) {
      throw new Error(`research workspace ${workspaceId} was not found`);
    }
    updatePreferences(tx, userId, { defaultWorkspaceId: workspaceId });
    return workspace;
  });
}

/** Returns the total count of research trees per workspace for sidebar display badges. */
export function treeCounts(db: SessionDatabase, userId: string): Map<string, number> {
  const rows = db
    .select({ workspaceId: trees.workspaceId, value: sql<number>`count(*)` })
    .from(trees)
    .where(eq(trees.userId, userId))
    .groupBy(trees.workspaceId)
    .all();
  return new Map(rows.map((row) => [row.workspaceId, row.value]));
}
