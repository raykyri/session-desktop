// What the reader of a thread may do in it (web only), mirroring the
// server's rules (`db/src/repos/access.ts`, `02-domain-model-and-database.md`
// §5.16) so the page offers only what the server accepts:
//
// - viewer (a member, or anyone signed in reading a public thread) and guest:
//   read only;
// - commenter: also asks, branches, writes follow-up notes, highlights and
//   generates recaps; renames, deletes and edits only what they wrote, and
//   only while nobody else has replied under it; relaunches only their own
//   questions;
// - owner: everything else (rename, chain order, visibility, members,
//   invitations, editing the root document, deleting anyone's branch or
//   highlight).
//
// An archived thread is read-only for everyone, as on the desktop.

import type {
  ResearchFollowupQueueItem,
  ResearchHighlight,
  ResearchNode,
  ResearchTree,
  ResearchTreeRole,
} from "@session/shared";

/** The reader's role; `guest` is someone signed out reading a public
 * thread. */
export type ThreadRole = ResearchTreeRole | "guest";

export interface ThreadPermissions {
  role: ThreadRole;
  /** The signed-in reader, or null for a guest. */
  userId: string | null;
  /** The thread's owner, when the server said. */
  ownerId: string | null;
  archived: boolean;
  isOwner: boolean;
  /** The owner or a commenter, whether or not the thread is archived: the
   * menus show their items (disabled in the Archive, as on the desktop). */
  contributor: boolean;
  /** Asks, branches, follow-up notes, highlights, recaps: a commenter's or
   * the owner's, outside the Archive. */
  canContribute: boolean;
  /** Messages column order and the thread's title: the owner's. */
  canReorder: boolean;
  canRenameThread: boolean;
  /** Visibility, members and invitations: the owner's. */
  canShare: boolean;
  /** Notify me: anyone signed in. */
  canFollow: boolean;
}

/** The reader's permissions in `tree`. A tree without a role (the owner's
 * own thread before sharing existed, or a test fixture) is the owner's. */
export function threadPermissions(
  tree: Pick<ResearchTree, "role" | "ownerId" | "archivedAt"> | undefined,
  userId: string | null,
): ThreadPermissions {
  const role: ThreadRole = userId === null ? "guest" : (tree?.role ?? "owner");
  const archived = tree?.archivedAt != null;
  const isOwner = role === "owner";
  const contributor = role === "owner" || role === "commenter";
  return {
    role,
    userId,
    ownerId: tree?.ownerId ?? (isOwner ? userId : null),
    archived,
    isOwner,
    contributor,
    canContribute: contributor && !archived,
    canReorder: isOwner && !archived,
    canRenameThread: isOwner && !archived,
    canShare: isOwner,
    canFollow: userId !== null,
  };
}

/** Every node under `nodeId`, not including it. */
function descendants(nodes: readonly ResearchNode[], nodeId: string): ResearchNode[] {
  const children = new Map<string, ResearchNode[]>();
  for (const node of nodes) {
    const parent = node.parentNodeId ?? null;
    if (parent === null) continue;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  const found: ResearchNode[] = [];
  const stack = [...(children.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as ResearchNode;
    found.push(next);
    stack.push(...(children.get(next.id) ?? []));
  }
  return found;
}

/** Whether someone other than `userId` wrote a node under `nodeId`. */
export function someoneElseReplied(
  nodes: readonly ResearchNode[],
  nodeId: string,
  userId: string | null,
): boolean {
  return descendants(nodes, nodeId).some((node) => (node.authorId ?? null) !== userId);
}

/** Rename or delete a message or note (`assertMayChangeNode`): the owner
 * any; a commenter their own while nobody else replied under it. */
export function mayChangeNode(
  permissions: ThreadPermissions,
  nodes: readonly ResearchNode[],
  node: ResearchNode,
): boolean {
  if (permissions.archived) return false;
  if (permissions.isOwner) return true;
  if (permissions.role !== "commenter" || permissions.userId === null) return false;
  if ((node.authorId ?? null) !== permissions.userId) return false;
  return !someoneElseReplied(nodes, node.id, permissions.userId);
}

/** Replace a note's or document's text, or edit a failed question
 * (`assertMayEditText`): its author, or the owner when the author's account
 * is gone; for a commenter only while nobody else replied under it. */
export function mayEditText(
  permissions: ThreadPermissions,
  nodes: readonly ResearchNode[],
  node: ResearchNode,
): boolean {
  if (permissions.archived || permissions.userId === null) return false;
  if (permissions.role !== "owner" && permissions.role !== "commenter") return false;
  const author = node.authorId === undefined ? permissions.ownerId : node.authorId;
  if (author === permissions.userId) {
    return permissions.isOwner || !someoneElseReplied(nodes, node.id, permissions.userId);
  }
  return author === null && permissions.isOwner;
}

/** Retry or Rerun (`assertMayRelaunch`): only the person who pays for the
 * run, the question's author (the owner when the author's account is
 * gone). */
export function mayRelaunch(permissions: ThreadPermissions, node: ResearchNode): boolean {
  if (!permissions.canContribute) return false;
  const payer = node.authorId == null ? permissions.ownerId : node.authorId;
  return payer === permissions.userId;
}

/** Stop a running question: its author or the owner. */
export function mayCancel(permissions: ThreadPermissions, node: ResearchNode): boolean {
  if (permissions.userId === null) return false;
  if (permissions.isOwner) return true;
  return permissions.role === "commenter" && node.authorId === permissions.userId;
}

/** Remove a highlight: the owner any; a commenter their own. */
export function mayRemoveHighlight(
  permissions: ThreadPermissions,
  highlight: ResearchHighlight,
): boolean {
  if (!permissions.contributor) return false;
  if (permissions.isOwner) return true;
  return highlight.authorId === permissions.userId;
}

/** Whether the Highlight button over a selection may act on the saved
 * highlights the selection covers (`ids`): removing them, or merging them
 * into a longer one, deletes each of them. */
export function mayChangeHighlights(
  permissions: ThreadPermissions,
  highlights: readonly ResearchHighlight[],
  ids: readonly string[],
): boolean {
  if (ids.length === 0) return true;
  const byId = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  return ids.every((id) => {
    const highlight = byId.get(id);
    return highlight !== undefined && mayRemoveHighlight(permissions, highlight);
  });
}

/** Cancel a queued follow-up: its author or the owner. */
export function mayCancelQueued(
  permissions: ThreadPermissions,
  item: ResearchFollowupQueueItem,
): boolean {
  if (permissions.userId === null) return false;
  return permissions.isOwner || item.authorId === permissions.userId;
}

/** Send a refused queued follow-up again: its author, who pays for it. */
export function mayRetryQueued(
  permissions: ThreadPermissions,
  item: ResearchFollowupQueueItem,
): boolean {
  return permissions.canContribute && item.authorId === permissions.userId;
}
