// The capture of a text selection in an answer (`09-research-document-view.md`
// §5): the selection's flat offsets in the answer's text projection, clipped
// to its first paragraph, as an `answer-v1` anchor with the saved highlights
// it overlaps. Kept apart from `useTextSelection` so it can be tested on a
// plain DOM fixture.

import type { ResearchHighlightAnchor, ResearchNodeStatus } from "@session/shared";
import {
  RESEARCH_HIGHLIGHT_CONTEXT_LENGTH,
  expandedResearchHighlightOffsets,
  intersectingResearchHighlightIds,
  researchAnchorContextBounds,
} from "@session/shared/lib/researchHighlights";
import {
  clipResearchSelectionToParagraph,
  isLiveResearchSelection,
} from "@session/shared/lib/researchSelection";
import { surrogateSafeSlice } from "@session/shared/lib/researchThreadView";

import {
  enclosingMessageFlatBounds,
  flatTextOffsetAt,
  passageBlockAt,
  researchTextProjection,
  selectionOffsets,
  selectionTouchesNonTextRow,
} from "./textRanges.js";

/** A text selection in an answer that the selection toolbar acts on. */
export interface SelectionAction {
  nodeId: string;
  /** The answer is still streaming: the selection can be copied, but not
   * highlighted or branched from until the answer has a revision. */
  live: boolean;
  /** The selection crossed into a later paragraph; the anchor stops at the
   * end of the first one. */
  crossed: boolean;
  copyText: string;
  anchor: ResearchHighlightAnchor;
  highlightIds: string[];
  /** The merged annotation Highlight saves when the selection overlaps saved
   * highlights; null when there is nothing to merge. */
  expandAnchor: ResearchHighlightAnchor | null;
}

/** The selection action for `range` in the answer rendered at `root`, or
 * null when the selection forms no anchor (it touches a tool row, or holds
 * only whitespace outside any highlight). A selection in a streaming answer
 * (no revision yet) is live: it can be copied but not saved. */
export function captureSelectionAction({
  root,
  range,
  nodeId,
  revision,
  status,
  isConversation,
  resolved,
}: {
  root: HTMLElement;
  range: Range;
  nodeId: string;
  /** The revision the answer renders; empty while it streams. */
  revision: string;
  status: ResearchNodeStatus | undefined;
  isConversation: boolean;
  /** The saved highlights resolved in this answer, as flat offsets. */
  resolved: { id: string; start: number; end: number }[];
}): SelectionAction | null {
  if (selectionTouchesNonTextRow(root, range)) return null;
  const projection = researchTextProjection(root);
  const live = isLiveResearchSelection(revision, status);
  if (!revision && !live) return null;
  const offsets = selectionOffsets(root, range);
  if (!offsets) return null;
  const copyText = projection.slice(offsets.start, offsets.end);
  // Highlights and branch passages stay within the first paragraph.
  const startBlock = passageBlockAt(root, range.startContainer);
  const { crossed, ...clipped } = clipResearchSelectionToParagraph(
    projection,
    offsets,
    startBlock && !startBlock.contains(range.endContainer)
      ? flatTextOffsetAt(root, startBlock, startBlock.childNodes.length)
      : null,
  );
  const exact = projection.slice(clipped.start, clipped.end);
  const highlightIds = intersectingResearchHighlightIds(clipped, resolved);
  // Whitespace forms no useful highlight, but can be a selected part of
  // one the reader wants removed.
  if (!exact.trim() && highlightIds.length === 0) return null;
  const contextBounds = researchAnchorContextBounds({
    isConversation,
    messageBounds: enclosingMessageFlatBounds(root, range),
    projectionLength: projection.length,
  });
  if (!contextBounds) return null;
  const anchorFor = (span: { start: number; end: number }): ResearchHighlightAnchor => ({
    version: 1,
    projection: "answer-v1",
    responseRevision: revision,
    start: span.start,
    end: span.end,
    exact: projection.slice(span.start, span.end),
    prefix: surrogateSafeSlice(
      projection,
      Math.max(contextBounds.start, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
      span.start,
    ),
    suffix: surrogateSafeSlice(
      projection,
      span.end,
      Math.min(contextBounds.end, span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
    ),
  });
  const expandOffsets = live ? null : expandedResearchHighlightOffsets(clipped, resolved);
  return {
    nodeId,
    live,
    crossed,
    copyText,
    anchor: anchorFor(clipped),
    highlightIds: live ? [] : highlightIds,
    expandAnchor: expandOffsets ? anchorFor(expandOffsets) : null,
  };
}
