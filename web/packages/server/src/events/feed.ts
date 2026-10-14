import { feeds } from "@session/db";
import type { feedItems, SessionDatabase } from "@session/db";

import type { EventBus } from "./bus.js";
import { sessionEvent } from "./bus.js";

interface FeedEventDeps {
  db: SessionDatabase;
  eventBus: EventBus;
}

export function emitFeedItemUpsertedForNode(deps: FeedEventDeps, nodeId: string): void {
  const event = feeds.eventItemForNode(deps.db, nodeId);
  if (event) deps.eventBus.emitAll(sessionEvent("feed.item.upserted", { ...event }));
}

export function emitFeedItemRemoved(
  eventBus: EventBus,
  item: NonNullable<ReturnType<typeof feedItems.forNode>> | null,
): void {
  if (item) eventBus.emitAll(sessionEvent("feed.item.removed", { ...item }));
}
