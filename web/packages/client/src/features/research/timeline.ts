// Projects a node's turns into timeline messages, empty-state placeholders,
// and run durations.
//
// Pure, so the projection is testable without a DOM. The desktop kept the same
// derivation behind a per-node cache keyed on content identity; here the query
// cache already hands back a stable `Turn[]` unless the node changed, so the
// memo lives on the component instead (09 §4, §9).

import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  countResearchDocumentWords,
  isActiveResearchStatus,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
} from "@session/shared";
import type { MessageItem, ResearchNode, ResearchNodeContent, Turn } from "@session/shared";

import { TIMELINE_ITEM_RENDER_WINDOW } from "./layout.js";

/**
 * The turns a segment renders: the committed ones, plus the text streamed since
 * the last commit as a synthetic trailing assistant turn.
 *
 * The synthetic turn carries the in-flight turn id when the stream has
 * announced one, so the timeline key of the growing text block is the same
 * before and after the commit — which is what lets React reconcile the same DOM
 * node instead of remounting the answer (`05-run-lifecycle-and-streaming.md`
 * §4, the flash-free swap).
 */
export function timelineTurns(
  nodeId: string,
  turns: readonly Turn[],
  inFlightText: string,
  inFlightTurnId: string | null,
): Turn[] {
  if (!inFlightText) return turns as Turn[];
  return [
    ...turns,
    {
      id: inFlightTurnId ?? `${nodeId}::in-flight`,
      agentId: nodeId,
      role: "assistant",
      blocks: [{ type: "text", text: inFlightText }],
      sourceIndex: turns.length,
    },
  ];
}

export interface SegmentView {
  node: ResearchNode;
  content: ResearchNodeContent | undefined;
  isDocument: boolean;
  showAllTurns: boolean;
  showFullTrace: boolean;
  /** Every item of the full trace. */
  timelineItems: MessageItem[];
  /** The trace or the collapsed answer, depending on the segment's toggle. */
  displayedTimelineItems: MessageItem[];
  /** The window actually rendered (the tail, since the answer is at the
   * bottom). */
  visibleTimelineItems: MessageItem[];
  hiddenTimelineItemCount: number;
  /** Whether a full-trace toggle is worth offering at all. */
  hasTranscriptActivity: boolean;
  /** The collapsed answer's source text: what Copy writes and what the word
   * count counts. */
  rawAnswer: string;
  answerWordCount: number;
  /** The markdown a `document` root's editor opens with. */
  editableDocumentMarkdown: string | null;
}

export function buildSegmentView(input: {
  node: ResearchNode;
  content: ResearchNodeContent | undefined;
  turns: readonly Turn[];
  showAllTurns: boolean;
  showFullTrace: boolean;
}): SegmentView {
  const { node, content, turns, showAllTurns, showFullTrace } = input;
  const isDocument = (node.kind ?? "run") === "document";
  // Normalize the whole response before windowing it: the item boundaries keep
  // a call with its result and preserve text → tools → continued-text ordering.
  const timelineItems = buildTimelineItems(turns as Turn[]);
  const answerTimelineItems = timelineItemsAfterLastToolCall(timelineItems);
  const hasTranscriptActivity = timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems = showFullTrace ? timelineItems : answerTimelineItems;
  // A run's trace reads bottom-up — the answer is the tail — so the window
  // keeps the newest items and the expander sits above them.
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const rawAnswer = assistantTextFromTimelineItems(answerTimelineItems);

  let editableDocumentMarkdown: string | null = null;
  if (isDocument) {
    for (const turn of turns) {
      for (const block of turn.blocks) {
        if (block.type === "text") {
          editableDocumentMarkdown = block.text;
          break;
        }
      }
      if (editableDocumentMarkdown !== null) break;
    }
  }

  return {
    node,
    content,
    isDocument,
    showAllTurns,
    showFullTrace,
    timelineItems,
    displayedTimelineItems,
    visibleTimelineItems,
    hiddenTimelineItemCount: displayedTimelineItems.length - visibleTimelineItems.length,
    hasTranscriptActivity,
    rawAnswer,
    answerWordCount: countResearchDocumentWords(rawAnswer),
    editableDocumentMarkdown,
  };
}

/**
 * What an answer pane says when its collapsed fold is empty. The cascade is the
 * desktop's, with `interrupted` added: the server auto-resumes it, so the copy
 * says so rather than presenting a dead end (09 §7,
 * `05-run-lifecycle-and-streaming.md` §3).
 */
export function answerEmptyStateText(input: {
  node: ResearchNode;
  sourceError: string | undefined;
  hasAnyTimelineItem: boolean;
}): string | null {
  const { node, sourceError, hasAnyTimelineItem } = input;
  if (node.status === "failed") return node.error ?? "The run failed.";
  if (node.status === "cancelled") return "The run was cancelled.";
  if (node.status === "interrupted") return "The run was interrupted. Resuming…";
  if (sourceError) return `The response is no longer available: ${sourceError}`;
  if (node.status === "complete") {
    return "The run finished, but the answer could not be loaded.";
  }
  if (isActiveResearchStatus(node.status)) {
    // Nothing at all yet: the status line under the answer already reads
    // "Working…", so a second line here would repeat it.
    return hasAnyTimelineItem ? "Generating response…" : null;
  }
  return "No response was generated.";
}

export function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The duration line, or null when there is nothing to say. An active run's
 * elapsed time rides the "Working…" status line, so it is bare — a prefix
 * there would only restate the status — and a run that has not started yet
 * says nothing, since that line already reports it. A settled run's label goes
 * in the answer footer, where it needs the prefix to read as run time.
 * Computed by the page so the once-per-second tick only re-renders the
 * segments whose text actually changes. */
export function durationLabel(node: ResearchNode, now: number): string | null {
  if (!node.startedAt) return null;
  const elapsed = formatRunDuration((node.completedAt ?? now) - node.startedAt);
  if (isActiveResearchStatus(node.status)) return elapsed;
  return node.status === "complete" ? elapsed : `Ran for ${elapsed}`;
}

export function statusLabel(status: ResearchNode["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Working…";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}
