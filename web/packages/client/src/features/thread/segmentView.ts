// The content-derived render state of one answer, ported from the desktop
// `researchSegmentView.ts`: which timeline items it shows, its copy text, word
// count and editable Markdown. Pure, so it is testable without a DOM.

import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  formatPlainTextTranscript,
  stripSessionWidgetBlocks,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
} from "@session/shared";
import type { MessageItem, ResearchNode, ResearchNodeContent, Turn } from "@session/shared";
import { countResearchDocumentWords } from "@session/shared/lib/researchDocuments";
import { documentHoldsMarkdown, documentSource } from "@session/shared/lib/researchNodeTypes";

/** How many timeline items an answer renders until the reader asks for the
 * rest. */
export const TIMELINE_ITEM_RENDER_WINDOW = 100;

export interface SegmentView {
  node: ResearchNode;
  content: ResearchNodeContent | undefined;
  /** A transcript document: its whole timeline is the document. */
  isConversation: boolean;
  showAllTurns: boolean;
  showFullTrace: boolean;
  timelineItems: MessageItem[];
  /** The full trace or the answer after the last tool call. */
  displayedTimelineItems: MessageItem[];
  /** The rendered window: the newest items of a run, the first items of a
   * conversation. */
  visibleTimelineItems: MessageItem[];
  hiddenTimelineItemCount: number;
  hasTranscriptActivity: boolean;
  /** The answer's source text: what Copy writes and the word count counts. */
  rawAnswer: string;
  conversationCopyText: string | null;
  answerWordCount: number;
  /** The Markdown an authored or imported document's editor opens with. */
  editableDocumentMarkdown: string | null;
}

/**
 * The turns an answer renders: the committed ones, plus the text streamed
 * since the last commit as a trailing assistant turn. The trailing turn
 * carries the in-flight turn id when the stream has announced one, so the
 * growing text keeps one timeline key across the commit
 * (`05-run-lifecycle-and-streaming.md` §4).
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

export function buildSegmentView(input: {
  node: ResearchNode;
  content: ResearchNodeContent | undefined;
  turns: readonly Turn[];
  showAllTurns: boolean;
  showFullTrace: boolean;
}): SegmentView {
  const { node, content, turns, showAllTurns, showFullTrace } = input;
  const isConversation =
    documentSource(node) === "transcript" ||
    (content ? documentSource(content.node) === "transcript" : false);
  const timelineItems = buildTimelineItems(turns as Turn[]);
  const answerTimelineItems = timelineItemsAfterLastToolCall(timelineItems);
  const hasTranscriptActivity =
    !isConversation && timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems =
    isConversation || showFullTrace ? timelineItems : answerTimelineItems;
  // A run's answer is at its end, a conversation starts with its question.
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : isConversation
        ? displayedTimelineItems.slice(0, TIMELINE_ITEM_RENDER_WINDOW)
        : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const rawAnswer = assistantTextFromTimelineItems(answerTimelineItems);
  const conversationCopyText = isConversation
    ? formatPlainTextTranscript(turns as Turn[], "Assistant")
    : null;
  let editableDocumentMarkdown: string | null = null;
  if (documentHoldsMarkdown(content?.node ?? node)) {
    for (const turn of turns) {
      const block = turn.blocks.find((candidate) => candidate.type === "text");
      if (block?.type === "text") {
        editableDocumentMarkdown = block.text;
        break;
      }
    }
  }
  return {
    node,
    content,
    isConversation,
    showAllTurns,
    showFullTrace,
    timelineItems,
    displayedTimelineItems,
    visibleTimelineItems,
    hiddenTimelineItemCount: displayedTimelineItems.length - visibleTimelineItems.length,
    hasTranscriptActivity,
    rawAnswer,
    conversationCopyText,
    // Widget HTML is not prose; the copy text keeps it verbatim.
    answerWordCount: countResearchDocumentWords(
      stripSessionWidgetBlocks(conversationCopyText ?? rawAnswer),
    ),
    editableDocumentMarkdown,
  };
}
