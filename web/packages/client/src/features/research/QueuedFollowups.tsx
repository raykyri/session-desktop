// The follow-ups the server holds for the chain on screen
// (`ResearchTreeDetail.queues`): each one's question, why its last send was
// refused, and Cancel and Retry. The thread page is rebuilt on the desktop's
// columns in phase 4, which shows these in the messages column instead.

import type { ResearchFollowupQueueItem } from "@session/shared";

import { ControlButton } from "../../ui/Button.js";

export function QueuedFollowups({
  items,
  busy,
  onCancel,
  onRetry,
}: {
  items: readonly ResearchFollowupQueueItem[];
  busy: boolean;
  onCancel: (item: ResearchFollowupQueueItem) => void;
  onRetry: (item: ResearchFollowupQueueItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ol aria-label="Queued follow-ups" className="mb-3 flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-3 rounded-md border border-dashed border-current/20 px-3 py-2 text-sm"
        >
          <div className="min-w-0 flex-1">
            <p className="line-clamp-3 whitespace-pre-wrap">{item.message.text}</p>
            <p className="mt-1 text-xs opacity-70">
              {item.failedReason ?? "Queued. Sent when the answer above finishes."}
            </p>
          </div>
          {item.failedReason === null ? null : (
            <ControlButton size="sm" disabled={busy} onClick={() => onRetry(item)}>
              Retry
            </ControlButton>
          )}
          <ControlButton size="sm" disabled={busy} onClick={() => onCancel(item)}>
            Cancel
          </ControlButton>
        </li>
      ))}
    </ol>
  );
}
