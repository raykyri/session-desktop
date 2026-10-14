// Thread access for procedures and the event bus (`03-api-and-events.md` §2,
// `02-domain-model-and-database.md` §5.16). The rules are in
// `@session/db`'s `access` repository; this module answers them with tRPC
// codes and gives the bus a thread's audience.

import type { SessionDatabase } from "@session/db";
import { access, sharing, users } from "@session/db";
import type { ResearchTree, SessionEvent, ThreadViewer } from "@session/shared";

import type { EventBus, TreeDirectory } from "../events/bus.js";
import { sessionEvent } from "../events/bus.js";
import { repo } from "../trpc/errors.js";

export type TreeRole = access.TreeRole;

/** `treeAccess(db, userId|null, treeId)`: the caller's role, or null when
 * they may not read the thread. */
export function treeRole(
  db: SessionDatabase,
  userId: string | null,
  treeId: string,
): TreeRole | null {
  return access.treeAccess(db, userId, treeId)?.role ?? null;
}

/** The caller's access to a thread, refused below `minimum`: `NOT_FOUND`
 * for a thread they may not read, `FORBIDDEN` for a role too low. */
export function requireTreeRole(
  ctx: { db: SessionDatabase; user: { id: string } | null },
  treeId: string,
  minimum: TreeRole = "viewer",
): access.TreeAccess {
  return repo(() => access.requireTreeAccess(ctx.db, ctx.user?.id ?? null, treeId, minimum));
}

/** `requireTreeRole` for the thread that holds a node. */
export function requireNodeRole(
  ctx: { db: SessionDatabase; user: { id: string } | null },
  nodeId: string,
  minimum: TreeRole = "viewer",
): access.NodeAccess {
  return repo(() => access.requireNodeAccess(ctx.db, ctx.user?.id ?? null, nodeId, minimum));
}

/** The bus's view of the database: a thread's audience and a person's
 * name and picture for presence. */
export function treeDirectory(db: SessionDatabase): TreeDirectory {
  return {
    audience: (treeId) => sharing.audience(db, treeId),
    viewer: (userId): ThreadViewer | null => {
      const user = users.findById(db, userId);
      return user
        ? {
            userId: user.id,
            login: user.login,
            name: user.name ?? null,
            avatarUrl: user.avatarUrl ?? null,
          }
        : null;
    },
  };
}

/** Publishes a thread's event to its audience (`EventBus.emitToTree`). */
export function emitToTree(
  eventBus: EventBus,
  treeId: string,
  type: string,
  payload: Record<string, unknown>,
  also: readonly string[] = [],
): SessionEvent {
  const event = sessionEvent(type, payload);
  eventBus.emitToTree(treeId, event, also);
  return event;
}

/** A tree without the reader's own fields, for everyone but the person it
 * was read for: the role, the last view and Follow are per person. */
export function sharedTree(tree: ResearchTree): ResearchTree {
  const shared = { ...tree };
  delete shared.role;
  delete shared.lastViewedAt;
  delete shared.followed;
  return shared;
}

/** The thread a node is in, for the emitters that hold only a node id. */
export function treeIdOfNode(db: SessionDatabase, nodeId: string): string | null {
  return access.nodeTreeId(db, nodeId);
}
