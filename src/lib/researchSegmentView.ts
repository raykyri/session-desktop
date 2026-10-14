// The content-derived render state of one answer: which timeline items it
// shows, its copy text, word count and editable Markdown.

import { countResearchDocumentWords } from "@session/shared/lib/researchDocuments";
import { stripSessionWidgetBlocks } from "@session/shared/lib/sessionWidgets";
import { documentHoldsMarkdown, documentSource } from "@session/shared/lib/researchNodeTypes";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  formatPlainTextTranscript,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
  type MessageItem,
} from "@session/shared/lib/turnTimeline";
import type { ResearchNode, ResearchNodeContent } from "../types";

/** Content-derived render state for one turn, cached per node so the whole
 * view identity survives detail replacements — which is what lets the turn's
 * memo and the markdown renderer's cache hold. `node` is the node as of the
 * last content/toggle change and MAY BE STALE on volatile fields (status,
 * error, timestamps); consumers needing fresh metadata take the live node
 * separately. */
export interface SegmentView {
  node: ResearchNode;
  content: ResearchNodeContent | null;
  isConversation: boolean;
  showAllTurns: boolean;
  showFullTrace: boolean;
  timelineItems: MessageItem[];
  displayedTimelineItems: MessageItem[];
  visibleTimelineItems: MessageItem[];
  hiddenTimelineItemCount: number;
  hasTranscriptActivity: boolean;
  rawAnswer: string;
  conversationCopyText: string | null;
  answerWordCount: number;
  editableDocumentMarkdown: string | null;
}

/** How many timeline items an answer renders until the reader asks for the
 * rest. */
export const TIMELINE_ITEM_RENDER_WINDOW = 100;

/** Content-derived render state for one answer. */
export function buildSegmentView(
  node: ResearchNode,
  content: ResearchNodeContent | null,
  showAllTurns: boolean,
  showFullTrace: boolean,
): SegmentView {
  // A transcript document's whole timeline is the document: there is no
  // "answer" fold to collapse to and no fuller trace to reveal. The document
  // source selects the transcript renderer.
  const isConversation =
    documentSource(node) === "transcript" ||
    (content ? documentSource(content.node) === "transcript" : false);
  const timelineItems = buildTimelineItems(content?.turns ?? []);
  const answerTimelineItems = timelineItemsAfterLastToolCall(timelineItems);
  const hasTranscriptActivity = !isConversation && timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems = isConversation || showFullTrace ? timelineItems : answerTimelineItems;
  // Run traces show the newest items because the answer is at the end.
  // Conversations show the first items beginning with the opening question.
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : isConversation
        ? displayedTimelineItems.slice(0, TIMELINE_ITEM_RENDER_WINDOW)
        : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const rawAnswer = assistantTextFromTimelineItems(answerTimelineItems);
  const conversationCopyText =
    isConversation && content ? formatPlainTextTranscript(content.turns, "Assistant") : null;
  // Only imported or authored documents contain editable Markdown.
  let editableDocumentMarkdown: string | null = null;
  if (content && documentHoldsMarkdown(content.node)) {
    for (const turn of content.turns) {
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
