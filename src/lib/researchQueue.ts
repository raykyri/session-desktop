// The thread page's view of the follow-up queues the backend holds
// (src-tauri/src/state/research_followups.rs): `research.queue.changed`
// events, which useResearchEvents receives and the open thread applies, and
// the one-time handover of the queues earlier builds kept in localStorage.

import type { QueuedResearchFollowup } from "@session/shared/lib/researchBranchView";
import type { ParsedResearchEvent } from "@session/shared/lib/researchEvents";
import type { ResearchFollowupQueueItem, ResearchImageAttachment } from "../types";
import { clearLegacyResearchQueuedFollowups, legacyResearchQueuedFollowups } from "./researchNavigation";

type ResearchQueueChangedEvent = Extract<ParsedResearchEvent, { type: "research.queue.changed" }>;

const listeners = new Set<(event: ResearchQueueChangedEvent) => void>();

/** Hands a chain's new queue to the open thread pages. */
export function publishResearchQueueChanged(event: ResearchQueueChangedEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

/** Calls `listener` with every chain queue change. Returns the unsubscribe. */
export function subscribeResearchQueueChanges(
  listener: (event: ResearchQueueChangedEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A backend queue item as the queue rows show it. */
export function queuedResearchFollowup(item: ResearchFollowupQueueItem): QueuedResearchFollowup {
  const images = (item.message.attachments ?? []).filter(
    (attachment): attachment is ResearchImageAttachment => attachment.kind === "image",
  );
  return {
    id: item.id,
    prompt: item.message.text,
    createdAt: item.createdAt,
    ...(images.length > 0 ? { images } : {}),
    ...(item.failedReason ? { failed: item.failedReason } : {}),
  };
}

/** Hands the queued follow-ups earlier builds stored in localStorage to the
 * backend, once: the stored copy is removed after the backend accepted
 * them. The backend skips ids it already holds, so a repeated handover
 * (another window, a request that failed after the backend stored them)
 * queues nothing twice. */
export async function migrateLegacyResearchQueues(
  importFollowups: (
    items: {
      id: string;
      headNodeId: string;
      prompt: string;
      createdAt: number;
      images: readonly ResearchImageAttachment[];
    }[],
  ) => Promise<unknown>,
): Promise<void> {
  const legacy = legacyResearchQueuedFollowups();
  if (legacy.length === 0) {
    return;
  }
  await importFollowups(
    legacy.map(({ headNodeId, item }) => ({
      id: item.id,
      headNodeId,
      prompt: item.prompt,
      createdAt: item.createdAt,
      images: item.images ?? [],
    })),
  );
  clearLegacyResearchQueuedFollowups();
}
