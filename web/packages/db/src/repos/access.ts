// Who may read and change a thread (`docs/02-domain-model-and-database.md`
// §5.16). Every repository resolves a tree, node, highlight, queue item,
// image or widget to its thread and asks this module for the caller's role
// there, instead of comparing an owner column itself.
//
// Roles, in increasing order:
// - `viewer`: reads the thread. A member with the viewer role, or anyone,
//   guests included, reading a public thread.
// - `commenter`: also asks questions, adds notes, branches, creates
//   highlights and generates recaps, and changes or deletes their own notes
//   and questions while nobody else has replied under them.
// - `owner`: `trees.owner_id`; everything else (rename, visibility, members,
//   chain order, deleting other people's branches and highlights).
//
// A thread in its owner's Trash is hidden from everyone else: the owner keeps
// the owner role, and every other caller gets no role at all. A deleted
// thread (`trees.deleted_at`, waiting for the deletion job) gives nobody a
// role, its owner included.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SessionDatabase } from "../connection.js";
import { treeMembers } from "../schema/collaboration.js";
import { followupQueue } from "../schema/followups.js";
import { highlights } from "../schema/highlights.js";
import { nodes } from "../schema/nodes.js";
import { trees } from "../schema/trees.js";

import type { NodeRow, TreeRow } from "./mappers.js";
import { subtreeIdsDepthFirst } from "./subtrees.js";

export type TreeRole = "owner" | "commenter" | "viewer";

export type MemberRow = typeof treeMembers.$inferSelect;

const RANK: Record<TreeRole, number> = { viewer: 0, commenter: 1, owner: 2 };

export function roleAtLeast(role: TreeRole, minimum: TreeRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/** A caller's standing in one thread. */
export interface TreeAccess {
  role: TreeRole;
  tree: TreeRow;
  /** The caller's member row, when they are a member. */
  member: MemberRow | null;
}

/**
 * A refusal because of the caller's role, not because the thread is missing.
 * The server answers it with `FORBIDDEN`; a thread the caller cannot read at
 * all is `NOT_FOUND`, so a private thread's id is never an existence oracle.
 */
export class TreeAccessError extends Error {
  override readonly name = "TreeAccessError";
}

/** The messages a refusal carries, one per rule. */
export const ACCESS_MESSAGES = {
  viewer: "Viewers of this thread can read it but not ask, add notes or highlight.",
  owner: "Only the owner of this thread can do this.",
  ownContent: "You can change or delete only your own notes and questions.",
  replied: "Someone else has replied under this; only the owner of this thread can change it now.",
  ownHighlight: "You can remove only your own highlights.",
  ownFollowup: "You can change only the follow-ups you asked.",
} as const;

function treeNotFound(treeId: string): Error {
  return new Error(`research tree ${treeId} was not found`);
}

function nodeNotFound(nodeId: string): Error {
  return new Error(`research node ${nodeId} was not found`);
}

/** The member row of `userId` in `treeId`, or null. */
export function memberRow(db: SessionDatabase, userId: string, treeId: string): MemberRow | null {
  return (
    db
      .select()
      .from(treeMembers)
      .where(and(eq(treeMembers.treeId, treeId), eq(treeMembers.userId, userId)))
      .get() ?? null
  );
}

/** The role a tree row gives `userId` (null: a guest), or null when the
 * caller may not read it. */
export function roleFor(
  db: SessionDatabase,
  userId: string | null,
  tree: TreeRow,
): { role: TreeRole; member: MemberRow | null } | null {
  if (tree.deletedAt !== null) {
    return null;
  }
  if (userId !== null && tree.ownerId === userId) {
    return { role: "owner", member: null };
  }
  if (tree.trashedAt !== null) {
    return null;
  }
  const member = userId === null ? null : memberRow(db, userId, tree.id);
  if (member) {
    return { role: member.role, member };
  }
  return tree.visibility === "public" ? { role: "viewer", member: null } : null;
}

/** `treeAccess(db, userId|null, treeId) → {role}|null`. */
export function treeAccess(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): TreeAccess | null {
  const tree = db.select().from(trees).where(eq(trees.id, treeId)).get();
  if (!tree) {
    return null;
  }
  const standing = roleFor(db, userId, tree);
  return standing ? { ...standing, tree } : null;
}

/**
 * The caller's access to a thread, refused below `minimum`: a thread they
 * cannot read is "not found", a role too low is a `TreeAccessError`.
 */
export function requireTreeAccess(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
  minimum: TreeRole = "viewer",
): TreeAccess {
  const access = treeAccess(db, userId, treeId);
  if (!access) {
    throw treeNotFound(treeId);
  }
  assertRole(access, minimum);
  return access;
}

export function assertRole(access: Pick<TreeAccess, "role">, minimum: TreeRole): void {
  if (roleAtLeast(access.role, minimum)) {
    return;
  }
  throw new TreeAccessError(minimum === "owner" ? ACCESS_MESSAGES.owner : ACCESS_MESSAGES.viewer);
}

/** The thread a node is in, or null for an unknown node. */
export function nodeTreeId(db: SessionDatabase, nodeId: string): string | null {
  return (
    db.select({ treeId: nodes.treeId }).from(nodes).where(eq(nodes.id, nodeId)).get()?.treeId ??
    null
  );
}

/** The thread a highlight is in. */
export function highlightTreeId(db: SessionDatabase, highlightId: string): string | null {
  return (
    db
      .select({ treeId: nodes.treeId })
      .from(highlights)
      .innerJoin(nodes, eq(nodes.id, highlights.nodeId))
      .where(eq(highlights.id, highlightId))
      .get()?.treeId ?? null
  );
}

/** The thread a queued follow-up is in. */
export function queueItemTreeId(db: SessionDatabase, itemId: string): string | null {
  return (
    db
      .select({ treeId: followupQueue.treeId })
      .from(followupQueue)
      .where(eq(followupQueue.id, itemId))
      .get()?.treeId ?? null
  );
}

/** A node and the caller's access to its thread. */
export interface NodeAccess extends TreeAccess {
  node: NodeRow;
}

/** `requireTreeAccess` for the thread that holds `nodeId`; an unknown node
 * or an unreadable thread is "not found" for the node. */
export function requireNodeAccess(
  db: SessionDatabase,
  userId: string | null,
  nodeId: string,
  minimum: TreeRole = "viewer",
): NodeAccess {
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) {
    throw nodeNotFound(nodeId);
  }
  const access = treeAccess(db, userId, node.treeId);
  if (!access) {
    throw nodeNotFound(nodeId);
  }
  assertRole(access, minimum);
  return { ...access, node };
}

/**
 * The rule for changing or deleting a note, a question or a document: the
 * owner may change anything in the thread; a commenter only what they wrote,
 * and only while every node under it is theirs too. A node whose author's
 * account is gone belongs to the owner for this purpose.
 */
export function assertMayChangeNode(db: SessionDatabase, access: NodeAccess, userId: string): void {
  assertRole(access, "commenter");
  if (access.role === "owner") {
    return;
  }
  if (access.node.authorId !== userId) {
    throw new TreeAccessError(ACCESS_MESSAGES.ownContent);
  }
  const descendants = subtreeIdsDepthFirst(db, access.node.id).filter(
    (id) => id !== access.node.id,
  );
  if (descendants.length === 0) {
    return;
  }
  const foreign = db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        inArray(nodes.id, descendants),
        sql`(${nodes.authorId} is null or ${nodes.authorId} <> ${userId})`,
      ),
    )
    .get();
  if (foreign) {
    throw new TreeAccessError(ACCESS_MESSAGES.replied);
  }
}

/**
 * The rule for editing a node's text (a note, a document, an edited
 * question): only its author, or the owner when the author's account is gone,
 * and for a commenter only while nobody else has replied under it.
 */
export function assertMayEditText(db: SessionDatabase, access: NodeAccess, userId: string): void {
  assertRole(access, "commenter");
  const author = access.node.authorId;
  if (author === userId) {
    if (access.role !== "owner") assertMayChangeNode(db, access, userId);
    return;
  }
  if (author === null && access.role === "owner") {
    return;
  }
  throw new TreeAccessError(ACCESS_MESSAGES.ownContent);
}

/** Who pays for a node's run: its author, or the owner when the author's
 * account is gone. */
export function payerOf(node: Pick<NodeRow, "authorId">, tree: Pick<TreeRow, "ownerId">): string {
  return node.authorId ?? tree.ownerId;
}

/**
 * Who may start another attempt of an existing question (Retry, Rerun): the
 * person who pays for it, its author; the owner only for a question whose
 * author's account is gone. Nobody can make someone else pay for a run.
 */
export function assertMayRelaunch(access: NodeAccess, userId: string): void {
  assertRole(access, "commenter");
  if (payerOf(access.node, access.tree) !== userId) {
    throw new TreeAccessError(ACCESS_MESSAGES.ownContent);
  }
}

/** `trees` rows that are not deleted (`trees.deleted_at`). Every query on
 * `trees` that does not go through `treeReadableBy`, `treeJoinedBy` or
 * `treeAccess` includes it. For a `WHERE` on `trees`. */
export function treeLive(): SQL {
  return sql`${trees.deletedAt} is null`;
}

/**
 * `trees` rows `userId` (null: a guest) may read: their own, those shared
 * with them, and public ones, except a thread in its owner's Trash and a
 * deleted one. For a `WHERE` on `trees`.
 */
export function treeReadableBy(userId: string | null): SQL {
  const visible = sql`(${trees.trashedAt} is null and (${trees.visibility} = 'public'${
    userId === null
      ? sql``
      : sql` or exists (select 1 from ${treeMembers} where ${treeMembers.treeId} = ${trees.id} and ${treeMembers.userId} = ${userId})`
  }))`;
  return userId === null
    ? sql`(${treeLive()} and ${visible})`
    : sql`(${treeLive()} and (${trees.ownerId} = ${userId} or ${visible}))`;
}

/** Trees `userId` owns or is a member of (not public reading), outside the
 * owner's Trash unless they own it, and not deleted. For a `WHERE` on
 * `trees`. */
export function treeJoinedBy(userId: string): SQL {
  return sql`(${treeLive()} and (${trees.ownerId} = ${userId} or (${trees.trashedAt} is null and exists (select 1 from ${treeMembers} where ${treeMembers.treeId} = ${trees.id} and ${treeMembers.userId} = ${userId}))))`;
}

/** `nodes.tree_id` names a tree `userId` may read. For a `WHERE` on
 * `nodes`. */
export function nodeReadableBy(userId: string | null): SQL {
  return sql`exists (select 1 from ${trees} where ${trees.id} = ${nodes.treeId} and ${treeReadableBy(userId)})`;
}

/** `userId` pays for the node's runs (`payerOf`). For a `WHERE` on
 * `nodes`. */
export function nodePaidBy(userId: string): SQL {
  return sql`coalesce(${nodes.authorId}, (select ${trees.ownerId} from ${trees} where ${trees.id} = ${nodes.treeId})) = ${userId}`;
}

/** The highlight's node is in a tree `userId` may read. For a `WHERE` on
 * `highlights`. */
export function highlightReadableBy(userId: string | null): SQL {
  return sql`exists (select 1 from ${nodes} inner join ${trees} on ${trees.id} = ${nodes.treeId} where ${nodes.id} = ${highlights.nodeId} and ${treeReadableBy(userId)})`;
}

/** The desktop's `RESEARCH_TRASHED_EDIT_ERROR` (`state.rs`). */
const TRASHED_EDIT_ERROR = "restore this research from the Trash before changing it";

/**
 * Refuses a user edit to a thread in its owner's Trash (the desktop's
 * `reject_trashed_research_tree`). Only the owner can still reach such a
 * thread. A member's own Trash is a per-person flag on their member row: it
 * hides the thread from that member's lists and does not lock it.
 */
export function rejectTrashed(tree: { trashedAt: number | null }): void {
  if (tree.trashedAt !== null) {
    throw new Error(TRASHED_EDIT_ERROR);
  }
}

/** `rejectTrashed` for the thread that holds `nodeId`. An unknown node is
 * left to the caller's own lookup. */
export function rejectTrashedNode(db: SessionDatabase, nodeId: string): void {
  const row = db
    .select({ trashedAt: trees.trashedAt })
    .from(nodes)
    .innerJoin(trees, eq(trees.id, nodes.treeId))
    .where(eq(nodes.id, nodeId))
    .get();
  if (row) {
    rejectTrashed(row);
  }
}
