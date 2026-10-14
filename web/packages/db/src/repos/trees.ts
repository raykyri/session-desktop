// Research threads: admission, the sidebar order, summaries, and the
// thread-level flags (`docs/02-domain-model-and-database.md` §5.1, §5.9).

import type {
  DocumentSource,
  PostFormat,
  ResearchNodeStatus,
  ResearchNodeType,
  ResearchParticipant,
  ResearchTree,
  ResearchTreeDetail,
  ResearchTreeRole,
  ResearchTreeSummary,
  UserMessage,
} from "@session/shared";
import { defaultTitle, postDefaultTitle, sanitizeResearchTitle } from "@session/shared";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
} from "@session/shared/lib/researchFolders";
import { postFormatOf } from "@session/shared/lib/researchNodeTypes";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { transact } from "../connection.js";
import { newId } from "../ids.js";
import { treeMembers, treeSubscriptions } from "../schema/collaboration.js";
import { collapsedGroups, folders, treeFolderMembership } from "../schema/folders.js";
import { followupQueue } from "../schema/followups.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { treeViews, trees } from "../schema/trees.js";
import { users } from "../schema/users.js";
import { workspaces } from "../schema/workspaces.js";
import { now, strictlyAfter } from "../time.js";

import {
  ACCESS_MESSAGES,
  TreeAccessError,
  memberRow,
  rejectTrashed,
  requireTreeAccess,
  roleFor,
  treeAccess,
} from "./access.js";
import type { MemberRow, TreeAccess, TreeRole } from "./access.js";
import { forTree as feedItemForTree } from "./feedItems.js";
import type { FeedItemRemoval } from "./feedItems.js";
import { markArchived, removeResearchTree, upsertResearchRoot } from "./feedgen.js";
import { toResearchHighlight, toResearchNode, toResearchTree } from "./mappers.js";
import type { TreeRow } from "./mappers.js";
import { activeRun, deleteNodesOfTrees, hasActiveNodes } from "./subtrees.js";

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
  /** The Trash instead of the sidebar: trees in the Trash, archived or not,
   * most recently trashed first. */
  trashed?: boolean | undefined;
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

/** Every tree positioned in one sidebar section, including those in the
 * Trash: a tree in the Trash keeps its position and moves down with the
 * others when a tree is inserted above it, so Restore returns it to the same
 * place relative to them. */
function positionedPredicate(ownerId: string, workspaceId: string, archived: boolean) {
  return and(
    eq(trees.ownerId, ownerId),
    eq(trees.workspaceId, workspaceId),
    archived ? isNotNull(trees.archivedAt) : isNull(trees.archivedAt),
  );
}

/** The tree row, for a caller with at least `minimum` there
 * (`access.requireTreeAccess`). The default is the owner: most tree-level
 * changes are the owner's. */
export function requireTreeRow(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
  minimum: TreeRole = "owner",
): TreeRow {
  return requireTreeAccess(db, userId, treeId, minimum).tree;
}

/** Whether `userId` follows the thread (`tree_subscriptions`). */
export function isFollowing(db: SessionDatabase, userId: string, treeId: string): boolean {
  return (
    db
      .select({ treeId: treeSubscriptions.treeId })
      .from(treeSubscriptions)
      .where(and(eq(treeSubscriptions.userId, userId), eq(treeSubscriptions.treeId, treeId)))
      .get() !== undefined
  );
}

/** When `userId` last viewed the thread, or null. */
export function lastViewedAt(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): number | null {
  if (userId === null) {
    return null;
  }
  return (
    db
      .select({ at: treeViews.lastViewedAt })
      .from(treeViews)
      .where(and(eq(treeViews.userId, userId), eq(treeViews.treeId, treeId)))
      .get()?.at ?? null
  );
}

/** A tree row as `userId` (null: a guest) sees it: their role, their own
 * Archive, Trash and last view, and whether they follow it. */
export function treeFor(db: SessionDatabase, userId: string | null, row: TreeRow): ResearchTree {
  const standing = roleFor(db, userId, row) ?? { role: "viewer" as const, member: null };
  return toResearchTree(row, lastViewedAt(db, userId, row.id), {
    role: standing.role,
    member: standing.member,
    ...(userId === null ? {} : { followed: isFollowing(db, userId, row.id) }),
  });
}

/** The tree, when `userId` (null: a guest) may read it. */
export function get(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): ResearchTree | null {
  const access = treeAccess(db, userId, treeId);
  return access ? treeFor(db, userId, access.tree) : null;
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
    // A post's thread is named by its first line (`post_default_title`),
    // which `posts.updatePost` compares against to decide whether the title
    // follows an edit.
    const title =
      (input.title === undefined ? undefined : sanitizeResearchTitle(input.title)) ??
      (input.type === "post"
        ? postDefaultTitle(message?.text ?? "")
        : defaultTitle(message?.text ?? ""));
    // New roots take position 0; everything in the section moves down.
    tx.update(trees)
      .set({ position: sql`${trees.position} + 1` })
      .where(positionedPredicate(userId, input.workspaceId, false))
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
export function detail(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): ResearchTreeDetail {
  return detailFromRow(db, userId, requireTreeRow(db, userId, treeId, "viewer"));
}

/**
 * The people a thread names: its owner, its members, and every author of a
 * node or highlight in it, in that order, each once. Accounts that are gone
 * are left out (their content's author is null).
 */
export function participants(db: SessionDatabase, treeRow: TreeRow): ResearchParticipant[] {
  const ids: string[] = [treeRow.ownerId];
  const add = (id: string | null): void => {
    if (id !== null && !ids.includes(id)) ids.push(id);
  };
  for (const row of db
    .select({ userId: treeMembers.userId })
    .from(treeMembers)
    .where(eq(treeMembers.treeId, treeRow.id))
    .orderBy(asc(treeMembers.createdAt), asc(treeMembers.userId))
    .all()) {
    add(row.userId);
  }
  for (const row of db
    .selectDistinct({ authorId: nodes.authorId })
    .from(nodes)
    .where(and(eq(nodes.treeId, treeRow.id), isNotNull(nodes.authorId)))
    .all()) {
    add(row.authorId);
  }
  for (const row of db
    .selectDistinct({ authorId: highlights.authorId })
    .from(highlights)
    .innerJoin(nodes, eq(nodes.id, highlights.nodeId))
    .where(and(eq(nodes.treeId, treeRow.id), isNotNull(highlights.authorId)))
    .all()) {
    add(row.authorId);
  }
  const people = new Map(
    db
      .select({ id: users.id, login: users.login, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.id, ids))
      .all()
      .map((row) => [row.id, row]),
  );
  return ids.flatMap((id) => {
    const person = people.get(id);
    return person ? [person] : [];
  });
}

function detailFromRow(
  db: SessionDatabase,
  userId: string | null,
  treeRow: TreeRow,
): ResearchTreeDetail {
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
    participants: participants(db, treeRow),
  };
}

/**
 * The sidebar list with its counts and attention flags
 * (`docs/02` §5.9). Trees in the Trash are left out, unless `trashed` asks
 * for them alone (`trash.list`). `interrupted` counts in
 * no bucket and raises no flag: it is shown in the activity rail, and a run
 * the server is about to resume is not something the user has to act on.
 * Posts and documents have no run and count in no bucket either.
 */
export function summaries(
  db: SessionDatabase,
  userId: string,
  options: TreeListOptions = {},
): ResearchTreeSummary[] {
  const owned = db
    .select({ tree: trees, lastViewedAt: treeViews.lastViewedAt })
    .from(trees)
    .leftJoin(treeViews, and(eq(treeViews.treeId, trees.id), eq(treeViews.userId, userId)))
    .where(
      and(
        eq(trees.ownerId, userId),
        options.workspaceId ? eq(trees.workspaceId, options.workspaceId) : undefined,
        options.trashed === true
          ? isNotNull(trees.trashedAt)
          : and(
              options.includeArchived === true ? undefined : isNull(trees.archivedAt),
              isNull(trees.trashedAt),
            ),
      ),
    )
    .orderBy(
      ...(options.trashed === true
        ? [desc(trees.trashedAt), asc(trees.id)]
        : [asc(trees.position), asc(trees.id)]),
    )
    .all()
    .map((row) => ({ ...row, member: null }));
  // Shared threads the caller filed in one of this workspace's folders are
  // listed with the workspace, after its own threads (`folders.getState`
  // reports their membership).
  const filed =
    options.workspaceId && options.trashed !== true
      ? memberRows(db, userId, {
          includeArchived: options.includeArchived === true,
          folderWorkspaceId: options.workspaceId,
        })
      : [];
  return summarize(db, [...owned, ...filed]);
}

/** Where `sharedSummaries` looks: the shared threads listed in the
 * caller's Shared place, their Archive, or their Trash. */
export type SharedPlace = "shared" | "archive" | "trash";

interface ListedRow {
  tree: TreeRow;
  lastViewedAt: number | null;
  member: MemberRow | null;
}

/** The caller's member rows outside the owner's Trash, with their trees. */
function memberRows(
  db: SessionDatabase,
  userId: string,
  options: {
    includeArchived?: boolean;
    trashed?: boolean;
    archivedOnly?: boolean;
    folderWorkspaceId?: string;
  },
): ListedRow[] {
  return db
    .select({ tree: trees, member: treeMembers, lastViewedAt: treeViews.lastViewedAt })
    .from(treeMembers)
    .innerJoin(trees, eq(trees.id, treeMembers.treeId))
    .leftJoin(treeViews, and(eq(treeViews.treeId, trees.id), eq(treeViews.userId, userId)))
    .leftJoin(folders, eq(folders.id, treeMembers.folderId))
    .where(
      and(
        eq(treeMembers.userId, userId),
        isNull(trees.trashedAt),
        options.trashed === true ? isNotNull(treeMembers.trashedAt) : isNull(treeMembers.trashedAt),
        options.trashed === true || options.includeArchived === true
          ? undefined
          : options.archivedOnly === true
            ? sql`coalesce(${treeMembers.archivedAt}, ${trees.archivedAt}) is not null`
            : sql`coalesce(${treeMembers.archivedAt}, ${trees.archivedAt}) is null`,
        options.folderWorkspaceId === undefined
          ? undefined
          : and(
              eq(folders.workspaceId, options.folderWorkspaceId),
              eq(folders.ownerId, userId),
              isNull(folders.trashedAt),
            ),
      ),
    )
    .orderBy(
      options.trashed === true ? desc(treeMembers.trashedAt) : desc(trees.updatedAt),
      asc(trees.id),
    )
    .all();
}

/**
 * The threads shared with the caller (they are a member, not the owner), for
 * the web's Shared place: `shared` lists those outside their Archive and
 * Trash, most recently updated first; `archive` those in their Archive or
 * archived by the owner; `trash` those in their own Trash, most recently
 * trashed first. A thread in its owner's Trash is in none of them.
 */
export function sharedSummaries(
  db: SessionDatabase,
  userId: string,
  place: SharedPlace = "shared",
): ResearchTreeSummary[] {
  return summarize(
    db,
    memberRows(
      db,
      userId,
      place === "trash" ? { trashed: true } : { archivedOnly: place === "archive" },
    ),
  );
}

/** Most public threads one `publicSummaries` call returns. */
const PUBLIC_LIST_LIMIT = 200;

/**
 * Public threads of every account, most recently updated first, outside
 * their owner's Archive and Trash: the guest catalog. A signed-in caller sees
 * their own role in each.
 */
export function publicSummaries(
  db: SessionDatabase,
  userId: string | null,
  options: { workspaceId?: string | null | undefined } = {},
): ResearchTreeSummary[] {
  const rows = db
    .select({ tree: trees })
    .from(trees)
    .where(
      and(
        eq(trees.visibility, "public"),
        isNull(trees.trashedAt),
        isNull(trees.archivedAt),
        options.workspaceId ? eq(trees.workspaceId, options.workspaceId) : undefined,
      ),
    )
    .orderBy(desc(trees.updatedAt), asc(trees.id))
    .limit(PUBLIC_LIST_LIMIT)
    .all();
  return summarize(
    db,
    rows.map(({ tree }) => ({
      tree,
      lastViewedAt: lastViewedAt(db, userId, tree.id),
      member: userId === null ? null : memberRow(db, userId, tree.id),
    })),
    userId,
  );
}

/** Counts, flags and per-person fields for listed rows, in their order. */
function summarize(
  db: SessionDatabase,
  treeRows: readonly ListedRow[],
  userId?: string | null,
): ResearchTreeSummary[] {
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
  return treeRows.map(({ tree: row, lastViewedAt: viewedAt, member }) => {
    const entry = counts.get(row.id);
    const unseen = (settledAt: number | null | undefined): boolean =>
      settledAt !== null && settledAt !== undefined && (viewedAt === null || settledAt > viewedAt);
    const role: ResearchTreeRole =
      member !== null
        ? member.role
        : userId === undefined || (userId !== null && row.ownerId === userId)
          ? "owner"
          : "viewer";
    const trashedAt = role === "owner" ? row.trashedAt : (member?.trashedAt ?? null);
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
      archivedAt: (role === "owner" ? null : member?.archivedAt) ?? row.archivedAt,
      ...(trashedAt === null ? {} : { trashedAt }),
      hasUnseenUpdate: unseen(entry?.latestSettlement),
      hasUnseenFailure: unseen(entry?.latestFailure),
      ownerId: row.ownerId,
      visibility: row.visibility,
      role,
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
  return transact(db, (tx) => {
    rejectTrashed(requireTreeRow(tx, userId, treeId));
    const row = tx
      .update(trees)
      .set({ title: clean, updatedAt: now() })
      .where(and(eq(trees.ownerId, userId), eq(trees.id, treeId)))
      .returning()
      .get();
    if (!row) {
      throw new Error(`research tree ${treeId} was not found`);
    }
    return treeFor(tx, userId, row);
  });
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
    const row = requireTreeRow(tx, userId, treeId, "viewer");
    writeView(tx, userId, row.id, now());
    return treeFor(tx, userId, row);
  });
}

/**
 * The caller's member row, for the per-person operations a member performs
 * on a shared thread (Archive, Trash, leaving). Refused for the owner, who
 * changes the thread itself, and for a reader who is not a member.
 */
export function requireMember(db: SessionDatabase, userId: string, treeId: string): TreeAccess {
  const access = requireTreeAccess(db, userId, treeId, "viewer");
  if (access.member === null) {
    throw new TreeAccessError(ACCESS_MESSAGES.owner);
  }
  return access;
}

/** Sets or clears a member's own Archive or Trash flag. */
export function setMemberFlag(
  db: SessionDatabase,
  userId: string,
  treeId: string,
  patch: Partial<Pick<MemberRow, "archivedAt" | "trashedAt">>,
): ResearchTree {
  if (Object.keys(patch).length > 0) {
    db.update(treeMembers)
      .set(patch)
      .where(and(eq(treeMembers.treeId, treeId), eq(treeMembers.userId, userId)))
      .run();
  }
  return treeFor(db, userId, requireTreeRow(db, userId, treeId, "viewer"));
}

/** The caller's role in the thread, when they may read it; for the
 * procedures that act differently for the owner and for a member. */
export function roleOf(db: SessionDatabase, userId: string, treeId: string): TreeRole {
  return requireTreeAccess(db, userId, treeId, "viewer").role;
}

/** Where Home lists a tree: the Trash, the Archive, Drafts, a folder outside
 * the Trash, or Unfiled. The desktop's `researchTreePlace`
 * (`lib/researchFolders.ts`), with the Trash ahead of the rest. */
function listedPlace(db: SessionDatabase, row: TreeRow): string {
  if (row.trashedAt !== null) return RESEARCH_TRASH_FOLDER_ID;
  if (row.archivedAt !== null) return RESEARCH_ARCHIVE_FOLDER_ID;
  const membership = db
    .select({
      systemPlace: treeFolderMembership.systemPlace,
      folderId: folders.id,
      folderTrashedAt: folders.trashedAt,
    })
    .from(treeFolderMembership)
    .leftJoin(folders, eq(folders.id, treeFolderMembership.folderId))
    .where(eq(treeFolderMembership.treeId, row.id))
    .get();
  if (membership?.systemPlace === "drafts") return RESEARCH_DRAFTS_FOLDER_ID;
  if (membership?.folderId != null && membership.folderTrashedAt === null) {
    return membership.folderId;
  }
  return RESEARCH_UNFILED_FOLDER_ID;
}

/**
 * The children that go with a tree when it is archived, unarchived, moved to
 * or out of the Trash, or deleted: the trees whose `parent_tree_id` names it
 * and that are listed in the same place (the desktop's `groupChildren` in
 * `useResearchGroupActions.tsx`). A child has no children of its own, so a
 * child's group is empty. Sidebar order.
 */
export function groupChildren(db: SessionDatabase, row: TreeRow): TreeRow[] {
  if (row.parentTreeId !== null) {
    return [];
  }
  const place = listedPlace(db, row);
  return db
    .select()
    .from(trees)
    .where(
      and(
        eq(trees.parentTreeId, row.id),
        ne(trees.id, row.id),
        eq(trees.ownerId, row.ownerId),
        eq(trees.workspaceId, row.workspaceId),
      ),
    )
    .orderBy(asc(trees.position), asc(trees.id))
    .all()
    .filter((child) => listedPlace(db, child) === place);
}

/** A tree a group operation changed, and the children that went with it. */
export interface TreeGroupChange {
  tree: ResearchTree;
  children: ResearchTree[];
  /** The Home feed rows the operation deleted, for `feed.item.removed`. */
  removedFeedItems: FeedItemRemoval[];
}

/** The feed rows of `rows`, with who could see them, read before an
 * operation deletes them. */
export function feedItemsOf(db: SessionDatabase, rows: readonly TreeRow[]): FeedItemRemoval[] {
  return rows.flatMap((row) => {
    const item = feedItemForTree(db, row.id);
    return item ? [{ item, public: row.visibility === "public", ownerId: row.ownerId }] : [];
  });
}

function archiveRow(db: SessionDatabase, userId: string, row: TreeRow): ResearchTree {
  if (row.archivedAt !== null) {
    return treeFor(db, userId, row);
  }
  const at = now();
  db.update(trees)
    .set({ position: sql`${trees.position} + 1` })
    .where(positionedPredicate(userId, row.workspaceId, true))
    .run();
  const tree = setFlag(db, userId, row.id, {
    archivedAt: at,
    position: 0,
    updatedAt: strictlyAfter(row.updatedAt, at),
  });
  markArchived(db, row.id, true);
  return tree;
}

function unarchiveRow(db: SessionDatabase, userId: string, row: TreeRow): ResearchTree {
  if (row.archivedAt === null) {
    return treeFor(db, userId, row);
  }
  const at = now();
  db.update(trees)
    .set({ position: sql`${trees.position} + 1` })
    .where(positionedPredicate(userId, row.workspaceId, false))
    .run();
  const tree = setFlag(db, userId, row.id, {
    archivedAt: null,
    position: 0,
    updatedAt: strictlyAfter(row.updatedAt, at),
  });
  markArchived(db, row.id, false);
  return tree;
}

/**
 * Moves the thread, and the children listed under it, into the archived
 * section. The children go first so that the parent ends up at position 0.
 */
export function archiveGroup(db: SessionDatabase, userId: string, treeId: string): TreeGroupChange {
  return transact(db, (tx) => {
    if (roleOf(tx, userId, treeId) !== "owner") {
      // A member's Archive is their own: the thread alone, for them alone.
      requireMember(tx, userId, treeId);
      return {
        tree: setMemberFlag(tx, userId, treeId, { archivedAt: now() }),
        children: [],
        removedFeedItems: [],
      };
    }
    const row = requireTreeRow(tx, userId, treeId);
    rejectTrashed(row);
    const childRows = groupChildren(tx, row);
    const removedFeedItems = feedItemsOf(tx, [row, ...childRows]);
    const children = childRows.map((child) => archiveRow(tx, userId, child));
    return { tree: archiveRow(tx, userId, row), children, removedFeedItems };
  });
}

/** `archiveGroup`, answering with the thread alone. */
export function archive(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return archiveGroup(db, userId, treeId).tree;
}

/** Unarchives the thread and its children in the Archive, the children
 * first, so that the parent ends up at position 0. */
export function restoreGroup(db: SessionDatabase, userId: string, treeId: string): TreeGroupChange {
  return transact(db, (tx) => {
    if (roleOf(tx, userId, treeId) !== "owner") {
      // Clears the member's own Archive; a thread its owner archived stays
      // archived for everyone until the owner restores it.
      requireMember(tx, userId, treeId);
      return {
        tree: setMemberFlag(tx, userId, treeId, { archivedAt: null }),
        children: [],
        removedFeedItems: [],
      };
    }
    const row = requireTreeRow(tx, userId, treeId);
    rejectTrashed(row);
    const children = groupChildren(tx, row).map((child) => unarchiveRow(tx, userId, child));
    return { tree: unarchiveRow(tx, userId, row), children, removedFeedItems: [] };
  });
}

/** `restoreGroup`, answering with the thread alone. */
export function restore(db: SessionDatabase, userId: string, treeId: string): ResearchTree {
  return restoreGroup(db, userId, treeId).tree;
}

/** Sets `trashed_at` on one tree and drops its Home feed row. Its position,
 * archive state, folder membership and parent stay, so Restore puts it
 * back. */
export function trashRow(
  db: SessionDatabase,
  userId: string,
  row: TreeRow,
  at: number,
): ResearchTree {
  if (row.trashedAt !== null) {
    return treeFor(db, userId, row);
  }
  const tree = setFlag(db, userId, row.id, { trashedAt: at, trashedBy: userId });
  removeResearchTree(db, row.id);
  return tree;
}

/** Clears `trashed_at` on one tree. The trees at or after its position in
 * its section move down one, so it returns to that position. */
export function untrashRow(db: SessionDatabase, userId: string, row: TreeRow): ResearchTree {
  if (row.trashedAt === null) {
    return treeFor(db, userId, row);
  }
  const archived = row.archivedAt !== null;
  db.update(trees)
    .set({ position: sql`${trees.position} + 1` })
    .where(
      and(sectionPredicate(userId, row.workspaceId, archived), gte(trees.position, row.position)),
    )
    .run();
  const tree = setFlag(db, userId, row.id, { trashedAt: null, trashedBy: null });
  markArchived(db, row.id, archived);
  return tree;
}

/** What `remove` deleted. */
export interface RemovedTrees {
  workspaceId: string;
  treeIds: string[];
  /** Whether any of them was in the Trash. */
  trashed: boolean;
  /** Their Home feed rows, for `feed.item.removed`. */
  removedFeedItems: FeedItemRemoval[];
  /** True when the caller was a member and left the thread instead: nothing
   * was deleted, and only the caller no longer has it. */
  left?: boolean;
  /** When `left`: what leaving took away (`leave`). */
  departure?: Departure;
}

/** A member's queued follow-ups in one thread, deleted. */
export interface QueuedFollowupsDropped {
  removedFollowupIds: string[];
  /** The chains whose queues changed, for `research.queue.changed`. */
  changedHeadNodeIds: string[];
}

/** What leaving or being removed took away from a member: their queued
 * follow-ups, deleted with the membership, and their active questions. */
export interface Departure extends QueuedFollowupsDropped {
  treeId: string;
  memberId: string;
  /** Their questions still queued or running, which the caller cancels: a
   * person who can no longer read the thread cannot keep a run in it. */
  activeNodeIds: string[];
}

/** Deletes `memberId`'s queued follow-ups in a thread, inside the caller's
 * transaction: on leaving, removal, and becoming a viewer. */
export function dropQueuedFollowups(
  db: SessionDatabase,
  treeId: string,
  memberId: string,
): QueuedFollowupsDropped {
  const queued = db
    .select({ id: followupQueue.id, headNodeId: followupQueue.headNodeId })
    .from(followupQueue)
    .where(and(eq(followupQueue.treeId, treeId), eq(followupQueue.authorId, memberId)))
    .all();
  if (queued.length > 0) {
    db.delete(followupQueue)
      .where(
        inArray(
          followupQueue.id,
          queued.map((row) => row.id),
        ),
      )
      .run();
  }
  return {
    removedFollowupIds: queued.map((row) => row.id),
    changedHeadNodeIds: [...new Set(queued.map((row) => row.headNodeId))].sort(),
  };
}

/** Deletes a departing member's queued follow-ups and lists their active
 * questions, inside the caller's transaction. */
export function depart(db: SessionDatabase, treeId: string, memberId: string): Departure {
  const dropped = dropQueuedFollowups(db, treeId, memberId);
  const activeNodeIds = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.treeId, treeId), eq(nodes.authorId, memberId), activeRun()))
    .all()
    .map((row) => row.id);
  return { treeId, memberId, ...dropped, activeNodeIds };
}

/** A membership `leave` removed. */
export interface LeftTree {
  member: MemberRow;
  departure: Departure;
}

/**
 * Removes the caller's membership of a shared thread (`sharing.leave`, and
 * Delete or Empty Trash by a member). Their nodes and highlights stay in the
 * thread; their queued follow-ups are deleted, and their active questions
 * are listed for the caller to stop (`depart`).
 */
export function leave(db: SessionDatabase, userId: string, treeId: string): LeftTree {
  return transact(db, (tx) => {
    const access = requireMember(tx, userId, treeId);
    const departure = depart(tx, treeId, userId);
    tx.delete(treeMembers)
      .where(and(eq(treeMembers.treeId, treeId), eq(treeMembers.userId, userId)))
      .run();
    tx.delete(treeSubscriptions)
      .where(and(eq(treeSubscriptions.treeId, treeId), eq(treeSubscriptions.userId, userId)))
      .run();
    tx.delete(collapsedGroups)
      .where(and(eq(collapsedGroups.treeId, treeId), eq(collapsedGroups.userId, userId)))
      .run();
    // `requireMember` refuses a caller without a row.
    return { member: access.member as MemberRow, departure };
  });
}

/**
 * Deletes the thread and everything under it, in or out of the Trash, with
 * the children listed under it (`groupChildren`). Refused while a run in any
 * of them is still the server's responsibility, for the reason
 * `workspaces.remove` gives. A child listed elsewhere stays and loses its
 * parent (`parent_tree_id` is `ON DELETE SET NULL`).
 */
export function remove(db: SessionDatabase, userId: string, treeId: string): RemovedTrees {
  return transact(db, (tx) => {
    const access = requireTreeAccess(tx, userId, treeId, "viewer");
    if (access.role !== "owner") {
      // A member's Delete is leaving: the thread stays for everyone else.
      const { member, departure } = leave(tx, userId, treeId);
      return {
        workspaceId: access.tree.workspaceId,
        treeIds: [treeId],
        trashed: member.trashedAt !== null,
        removedFeedItems: [],
        left: true,
        departure,
      };
    }
    const row = requireTreeRow(tx, userId, treeId);
    const group = [...groupChildren(tx, row), row];
    const ids = group.map((member) => member.id);
    if (hasActiveNodes(tx, ids)) {
      throw new Error("Cannot delete research thread with an active run: cancel the run first.");
    }
    const removedFeedItems = feedItemsOf(tx, group);
    deleteTreeRows(tx, ids);
    return {
      workspaceId: row.workspaceId,
      treeIds: ids,
      trashed: group.some((member) => member.trashedAt !== null),
      removedFeedItems,
    };
  });
}

/** Deletes trees, their feed rows and everything under them. The caller has
 * checked for active runs. Membership, collapsed groups and views cascade;
 * children elsewhere lose their parent. */
export function deleteTreeRows(db: SessionDatabase, treeIds: readonly string[]): void {
  if (treeIds.length === 0) {
    return;
  }
  for (const treeId of treeIds) {
    removeResearchTree(db, treeId);
  }
  deleteNodesOfTrees(db, treeIds);
  db.delete(trees)
    .where(inArray(trees.id, [...treeIds]))
    .run();
}
