// The keyset cursor for the mixed Home feed. Journal entries and research
// questions come from two tables and are merged under one order:
// `occurredAt` DESC, `sourceRank` DESC, `id` DESC. Source rank is a
// deterministic tie-breaker for items captured in the same millisecond —
// research (1) sorts ahead of journal (0).
//
// Ported from the desktop `src/lib/journal.ts`; the server's SQL keyset
// predicate must apply the same comparison (`02-domain-model-and-database.md`
// §5.9), or a page boundary will drop or repeat an item. Ids compare by code
// unit, matching the byte-wise comparison the desktop backend used for the
// ASCII ids both sides generate.

import type { RecentActivityItem } from "../types/activity.js";
import type { RecentActivityCursor } from "../types/research.js";

export const JOURNAL_ACTIVITY_SOURCE_RANK = 0;
export const RESEARCH_ACTIVITY_SOURCE_RANK = 1;

/** Feed-wide identity of an item: ids are unique per source, not across
 * sources, so the source prefix is part of the identity. */
export function recentActivityItemId(item: RecentActivityItem): string {
  return item.kind === "journal" ? `journal:${item.entry.id}` : `research:${item.query.nodeId}`;
}

export function recentActivityItemCursor(item: RecentActivityItem): RecentActivityCursor {
  return {
    occurredAt: item.occurredAt,
    sourceRank:
      item.kind === "journal" ? JOURNAL_ACTIVITY_SOURCE_RANK : RESEARCH_ACTIVITY_SOURCE_RANK,
    id: item.kind === "journal" ? item.entry.id : item.query.nodeId,
  };
}

/** Whether `candidate` sorts strictly after `boundary` in the feed, which is
 * what "older than the cursor" means for a DESC keyset. */
export function activityCursorIsBefore(
  candidate: RecentActivityCursor,
  boundary: RecentActivityCursor,
): boolean {
  return (
    candidate.occurredAt < boundary.occurredAt ||
    (candidate.occurredAt === boundary.occurredAt &&
      (candidate.sourceRank < boundary.sourceRank ||
        (candidate.sourceRank === boundary.sourceRank && candidate.id < boundary.id)))
  );
}

/** Code-unit comparison, the same one `activityCursorIsBefore` applies. The
 * desktop sorted feed items with `localeCompare` while its cursor predicate
 * compared bytes, so the two disagreed on mixed-case ids and a page boundary
 * could drop or repeat an item. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Feed order: newest first, research before journal on a tie, then by id
 * descending. */
export function compareRecentActivityItems(
  left: RecentActivityItem,
  right: RecentActivityItem,
): number {
  const leftCursor = recentActivityItemCursor(left);
  const rightCursor = recentActivityItemCursor(right);
  return (
    rightCursor.occurredAt - leftCursor.occurredAt ||
    rightCursor.sourceRank - leftCursor.sourceRank ||
    compareIds(rightCursor.id, leftCursor.id)
  );
}
