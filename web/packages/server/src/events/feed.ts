// `feed.item.*` events (`03-api-and-events.md` §3). The All Users feed lists
// public threads, so a public thread's feed changes go to every signed-in
// connection; a private thread's go to its owner alone, whose own feeds
// (`mine`, `workspace`) list it.

import { access, feeds, sharing } from "@session/db";
import type { feedItems, SessionDatabase } from "@session/db";

import type { EventBus } from "./bus.js";
import { sessionEvent } from "./bus.js";

type FeedItemDescriptor = NonNullable<ReturnType<typeof feedItems.forNode>>;

interface FeedEventDeps {
  db: SessionDatabase;
  eventBus: EventBus;
}

/** Everyone signed in, or one account. */
type FeedTarget = { kind: "all" } | { kind: "owner"; userId: string };

/** Who receives a feed event about the thread rooted at `nodeId`: everyone
 * for a public thread, else its owner; null when the thread is gone. */
function feedAudience(db: SessionDatabase, nodeId: string): FeedTarget | null {
  const treeId = access.nodeTreeId(db, nodeId);
  if (treeId === null) return null;
  const audience = sharing.audience(db, treeId);
  if (!audience) return null;
  return audience.public ? { kind: "all" } : { kind: "owner", userId: audience.ownerId };
}

function deliver(deps: FeedEventDeps, target: FeedTarget, type: string, payload: object): void {
  const event = sessionEvent(type, { ...payload });
  if (target.kind === "all") deps.eventBus.emitAll(event);
  else deps.eventBus.emit(target.userId, event);
}

export function emitFeedItemUpsertedForNode(deps: FeedEventDeps, nodeId: string): void {
  const event = feeds.eventItemForNode(deps.db, nodeId);
  if (!event) return;
  const target = feedAudience(deps.db, event.id);
  if (target !== null) deliver(deps, target, "feed.item.upserted", event);
}

/**
 * `feed.item.removed` for a row an operation deleted, to whoever could see
 * it (`feedItems.FeedItemRemoval`, read before the operation): everyone
 * signed in for a public thread, else its owner.
 */
export function emitFeedItemRemoved(
  deps: Pick<FeedEventDeps, "eventBus">,
  removal: feedItems.FeedItemRemoval,
): void {
  const event = sessionEvent("feed.item.removed", { ...removal.item });
  if (removal.public) deps.eventBus.emitAll(event);
  else deps.eventBus.emit(removal.ownerId, event);
}

/** A thread became public or private: the All Users feed gains or loses its
 * root, and the owner's own feeds keep it. */
export function emitFeedVisibilityChanged(
  deps: FeedEventDeps,
  rootNodeId: string,
  visibility: "public" | "private",
): void {
  const event = feeds.eventItemForNode(deps.db, rootNodeId);
  if (!event) return;
  if (visibility === "public") {
    deps.eventBus.emitAll(sessionEvent("feed.item.upserted", { ...event }));
    return;
  }
  const descriptor: FeedItemDescriptor = {
    id: event.id,
    kind: event.kind,
    authorId: event.authorId,
    occurredAt: event.occurredAt,
    sourceRank: event.sourceRank,
    workspaceId: event.workspaceId,
  };
  deps.eventBus.emitAll(sessionEvent("feed.item.removed", { ...descriptor }));
  const owner = feedAudience(deps.db, rootNodeId);
  if (owner?.kind === "owner") {
    deps.eventBus.emit(owner.userId, sessionEvent("feed.item.upserted", { ...event }));
  }
}
