// Turning a live selection into a storable anchor
// (`09-research-document-view.md` §5 items 3–5).
//
// A selection spanning multiple segments, touching tool UI, or containing
// only whitespace cannot be reliably anchored, and is rejected rather than
// captured.

import {
  expandedResearchHighlightOffsets,
  intersectingResearchHighlightIds,
  researchAnchorContextBounds,
} from "@session/shared";
import type { ResearchHighlightAnchor, ResolvedResearchHighlightRange } from "@session/shared";

import { RESEARCH_HIGHLIGHT_CONTEXT_LENGTH } from "../layout.js";

import {
  enclosingMessageFlatBounds,
  selectionOffsets,
  selectionTouchesNonTextRow,
  textContextSlice,
} from "./dom.js";

export interface CapturedResearchSelection {
  /** The segment (node) the selection landed in. */
  nodeId: string;
  anchor: ResearchHighlightAnchor;
  /** Stored highlights the selection overlaps; a non-empty list turns the
   * popover's first action into Remove. */
  highlightIds: string[];
  /** The merged annotation Expand would save — the union of the selection and
   * every highlight it intersects — or null when there is nothing to expand. */
  expandAnchor: ResearchHighlightAnchor | null;
}

/**
 * Builds an `answer-v1` anchor for a flat span, with up to 128 characters of
 * context on each side clamped to the enclosing message.
 */
export function buildResearchAnchor(input: {
  projection: string;
  responseRevision: string;
  span: { start: number; end: number };
  contextBounds: { start: number; end: number };
}): ResearchHighlightAnchor {
  const { projection, responseRevision, span, contextBounds } = input;
  return {
    version: 1,
    projection: "answer-v1",
    responseRevision,
    start: span.start,
    end: span.end,
    exact: projection.slice(span.start, span.end),
    prefix: textContextSlice(
      projection,
      Math.max(contextBounds.start, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
      span.start,
    ),
    suffix: textContextSlice(
      projection,
      span.end,
      Math.min(contextBounds.end, span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
    ),
  };
}

export function captureResearchSelection(input: {
  root: HTMLElement;
  range: Range;
  nodeId: string;
  responseRevision: string;
  /** Saved highlights already located in this segment's projection. */
  resolved: readonly ResolvedResearchHighlightRange[];
}): CapturedResearchSelection | null {
  const { root, range, nodeId, responseRevision, resolved } = input;
  if (selectionTouchesNonTextRow(root, range)) return null;
  const offsets = selectionOffsets(root, range);
  if (!offsets) return null;

  const projection = root.textContent ?? "";
  const exact = projection.slice(offsets.start, offsets.end);
  const highlightIds = intersectingResearchHighlightIds(offsets, [...resolved]);
  // Whitespace cannot form a useful new highlight, but it can be a selected
  // subset of an existing annotation the reader wants removed.
  if (!exact.trim() && highlightIds.length === 0) return null;

  const contextBounds = researchAnchorContextBounds({
    messageBounds: enclosingMessageFlatBounds(root, range),
    projectionLength: projection.length,
  });
  if (!contextBounds) return null;

  const expandOffsets = expandedResearchHighlightOffsets(offsets, [...resolved]);
  return {
    nodeId,
    anchor: buildResearchAnchor({
      projection,
      responseRevision,
      span: offsets,
      contextBounds,
    }),
    highlightIds,
    expandAnchor: expandOffsets
      ? buildResearchAnchor({
          projection,
          responseRevision,
          span: expandOffsets,
          contextBounds,
        })
      : null,
  };
}
