import { findModel, type RecentActivityEvent } from "@session/shared";

import { cn } from "../lib/cn.js";
import { formatRelativeTime } from "../lib/relativeTime.js";

import { METADATA_LINE_COMPACT } from "./surfaces.js";

/**
 * The model that answered a thread's root prompt. The desktop composed this
 * from an adapter label plus a preset name; the web has one registry, so the
 * entry's own label is the whole answer.
 */
export function formatResearchModelSummary(modelId: string, origin?: string | null): string {
  if (origin === "imported") return "Imported";
  return findModel(modelId)?.label ?? "";
}

/**
 * The concise action label for Home's chronological feed. The content card
 * carries the provider and object details, so this line only orients the reader
 * in time and names the containing thread when a reply belongs to one.
 */
export function formatActivityMetadataSummary(event: RecentActivityEvent): string {
  if (event.object.kind === "research-query") {
    if (event.relationship?.kind === "follow-up") {
      return event.context?.label ? `Replied in “${event.context.label}”` : "Replied in a thread";
    }
    return "";
  }
  if (event.action.kind === "saved") return "Saved";
  const label = event.action.label.trim();
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : "Activity";
}

/**
 * Renderer for the activity grammar's metadata slots, ported from the desktop
 * `ActivityMetadataLine.tsx`. Metadata stays outside the content surface
 * because it describes the event, not the object payload.
 */
export function ActivityMetadataLine({
  event,
  className,
  showTime = true,
}: {
  event: RecentActivityEvent;
  className?: string;
  /** Research cards carry the time next to the model mark; omit it here. */
  showTime?: boolean;
}) {
  const finiteTime = showTime && Number.isFinite(event.occurredAt);
  const summary = formatActivityMetadataSummary(event);
  if (!summary && !finiteTime) return null;
  return (
    <div
      className={cn("text-fg-activity", METADATA_LINE_COMPACT, className)}
      title={finiteTime ? new Date(event.occurredAt).toLocaleString() : undefined}
    >
      <span>
        {summary}
        {finiteTime ? (
          <>
            {summary ? " " : null}
            <time dateTime={new Date(event.occurredAt).toISOString()}>
              {formatRelativeTime(event.occurredAt)}
            </time>
          </>
        ) : null}
      </span>
    </div>
  );
}
