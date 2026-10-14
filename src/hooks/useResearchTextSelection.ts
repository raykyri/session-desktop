import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createResearchHighlight, removeResearchHighlights } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import {
  expandedResearchHighlightOffsets,
  RESEARCH_HIGHLIGHT_CONTEXT_LENGTH,
  intersectingResearchHighlightIds,
  researchAnchorContextBounds,
} from "@session/shared/lib/researchHighlights";
import { documentSource, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import {
  clipResearchSelectionToParagraph,
  createResearchSelectionExpander,
  isLiveResearchSelection,
} from "@session/shared/lib/researchSelection";
import { researchBranchBlocker, surrogateSafeSlice } from "@session/shared/lib/researchThreadView";
import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
} from "../types";
import {
  applyDirectionalSelectionRange,
  enclosingMessageFlatBounds,
  flatTextOffsetAt,
  messageFlatBoundaries,
  passageBlockAt,
  rangeForTextOffsets,
  researchHighlightApi,
  researchTextProjection,
  selectionOffsets,
  selectionTouchesNonTextRow,
  type ResearchNativeHighlight,
  type ResearchResolvedHighlight,
} from "../components/research/researchTextRanges";

/** A text selection in an answer that the selection toolbar acts on. */
export interface ResearchSelectionAction {
  /** The turn (node) containing the selection. */
  nodeId: string;
  /** A selection in an answer that is still streaming: it can be copied, but
   * not highlighted or branched from until the answer has a revision. */
  live: boolean;
  /** The selection crossed into a later paragraph; the anchor stops at the
   * end of the first one. */
  crossed: boolean;
  /** The whole selection, for Copy. */
  copyText: string;
  anchor: ResearchHighlightAnchor;
  highlightIds: string[];
  /** The merged annotation Highlight saves when the selection overlaps
   * existing highlights — the union of the selection and every highlight it
   * intersects. Null when there is nothing to merge. */
  expandAnchor: ResearchHighlightAnchor | null;
}

/** Manages answer selection, whole-word expansion, passage anchors,
 * highlight overlap, and the Highlight, Branch, and Copy actions. A `viewKey`
 * change clears captured selection because its offsets may be invalid. */
export function useResearchTextSelection({
  viewKey,
  detailRef,
  contentByNodeRef,
  resolvedHighlightsRef,
  selectedHighlightPaintRef,
  segmentRoot,
  highlightDomNonce,
  nodeById,
  archived,
  patchNodeHighlights,
  removeHighlights,
  openPendingBranch,
  onToast,
  onError,
}: {
  viewKey: string;
  detailRef: { readonly current: ResearchTreeDetail | null };
  contentByNodeRef: { readonly current: Record<string, ResearchNodeContent> };
  /** Saved highlights resolved against each answer's rendered text. */
  resolvedHighlightsRef: { readonly current: Map<string, ResearchResolvedHighlight[]> };
  /** The paint of the saved highlights a selection overlaps, cleared once
   * the toolbar's Highlight action has saved. */
  selectedHighlightPaintRef: { readonly current: ResearchNativeHighlight | null };
  /** An answer's response root, and the nonce bumped when one moves. */
  segmentRoot: (nodeId: string) => HTMLDivElement | null;
  highlightDomNonce: number;
  nodeById: ReadonlyMap<string, ResearchNode>;
  archived: boolean;
  patchNodeHighlights: (nodeId: string, transform: (highlights: ResearchHighlight[]) => ResearchHighlight[]) => void;
  removeHighlights: (nodeId: string, highlightIds: string[]) => Promise<void>;
  openPendingBranch: (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  onError: (message: string) => void;
}) {
  const [highlightAction, setHighlightAction] = useState<ResearchSelectionAction | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);

  // Clear the action bar and selection when the view changes. Transcript
  // visibility and loaded content can invalidate their cached positions.
  useEffect(() => {
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }, [viewKey]);

  const captureResearchSelection = useCallback((expandToWholeWords: boolean) => {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setHighlightAction(null);
      return;
    }
    let range = selection.getRangeAt(0);
    // Find the turn containing the selection. Selections spanning turns cannot
    // produce an anchor.
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const root = container?.closest<HTMLElement>(".research-response-content-root") ?? null;
    if (!root || root.closest(".is-leaving") || selectionTouchesNonTextRow(root, range)) {
      setHighlightAction(null);
      return;
    }
    const projection = researchTextProjection(root);
    if (expandToWholeWords && selection.anchorNode && selection.focusNode) {
      const anchorOffset = flatTextOffsetAt(root, selection.anchorNode, selection.anchorOffset);
      const focusOffset = flatTextOffsetAt(root, selection.focusNode, selection.focusOffset);
      const expanded =
        anchorOffset === null || focusOffset === null
          ? null
          : createResearchSelectionExpander(
              projection,
              document.documentElement.lang || navigator.language,
              messageFlatBoundaries(root),
            )?.(anchorOffset, focusOffset) ?? null;
      const expandedRange = expanded
        ? rangeForTextOffsets(root, expanded.start, expanded.end)
        : null;
      if (expanded && expandedRange) {
        applyDirectionalSelectionRange(expandedRange, expanded.direction);
        range = expandedRange;
      }
    }
    const nodeId = root.dataset.nodeId ?? null;
    const segmentContent = nodeId ? contentByNodeRef.current[nodeId] : null;
    const revision = segmentContent?.responseRevision ?? "";
    const node = nodeId ? detailRef.current?.nodes.find((candidate) => candidate.id === nodeId) : null;
    // A streaming answer has no revision to anchor to yet; its selection can
    // still be copied.
    const live = isLiveResearchSelection(revision, node ? nodeStatus(node) : undefined);
    if (!researchHighlightApi() || !nodeId || !segmentContent || (!revision && !live)) {
      setHighlightAction(null);
      return;
    }
    const offsets = selectionOffsets(root, range);
    if (!offsets) {
      setHighlightAction(null);
      return;
    }
    const copyText = projection.slice(offsets.start, offsets.end);
    // Limit highlight and branch passages to the first selected paragraph.
    const startBlock = passageBlockAt(root, range.startContainer);
    const { crossed, ...clipped } = clipResearchSelectionToParagraph(
      projection,
      offsets,
      startBlock && !startBlock.contains(range.endContainer)
        ? flatTextOffsetAt(root, startBlock, startBlock.childNodes.length)
        : null,
    );
    offsets.start = clipped.start;
    offsets.end = clipped.end;
    const exact = projection.slice(offsets.start, offsets.end);
    const resolvedRanges = (resolvedHighlightsRef.current.get(nodeId) ?? []).map(
      ({ highlight, start, end }) => ({
        id: highlight.id,
        start,
        end,
      }),
    );
    const highlightIds = intersectingResearchHighlightIds(offsets, resolvedRanges);
    // Whitespace cannot form a useful new highlight, but it can still be a
    // selected subset of an existing annotation that the user wants removed.
    if (!exact.trim() && highlightIds.length === 0) {
      setHighlightAction(null);
      return;
    }
    // Keep the quote's surrounding context inside the message it belongs to
    // so the anchor resolves the same in either transcript view.
    const contextBounds = researchAnchorContextBounds({
      isConversation: segmentContent ? documentSource(segmentContent.node) === "transcript" : false,
      messageBounds: enclosingMessageFlatBounds(root, range),
      projectionLength: projection.length,
    });
    if (!contextBounds) {
      setHighlightAction(null);
      return;
    }
    const contextFloor = contextBounds.start;
    const contextCeil = contextBounds.end;
    const anchorForOffsets = (span: {
      start: number;
      end: number;
    }): ResearchHighlightAnchor => ({
      version: 1,
      projection: "answer-v1",
      responseRevision: revision,
      start: span.start,
      end: span.end,
      exact: projection.slice(span.start, span.end),
      prefix: surrogateSafeSlice(
        projection,
        Math.max(contextFloor, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
        span.start,
      ),
      suffix: surrogateSafeSlice(
        projection,
        span.end,
        Math.min(contextCeil, span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
      ),
    });
    const expandOffsets = live ? null : expandedResearchHighlightOffsets(offsets, resolvedRanges);
    setHighlightAction({
      nodeId,
      live,
      crossed,
      copyText,
      anchor: anchorForOffsets(offsets),
      highlightIds: live ? [] : highlightIds,
      expandAnchor: expandOffsets ? anchorForOffsets(expandOffsets) : null,
    });
  }, []);

  const captureHighlightSelection = useCallback(
    () => captureResearchSelection(false),
    [captureResearchSelection],
  );

  // Let WebKit manage the drag. When a primary-button selection that began in
  // an answer ends, expand its completed range once to full word boundaries.
  useEffect(() => {
    let beganInAnswer = false;
    const begin = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      beganInAnswer =
        event.button === 0 &&
        Boolean(target?.closest(".research-response-content-root"));
    };
    const finish = (event: MouseEvent) => {
      if (event.button === 0 && beganInAnswer) {
        captureResearchSelection(true);
      }
      beganInAnswer = false;
    };
    const cancel = () => {
      beganInAnswer = false;
    };
    document.addEventListener("mousedown", begin);
    document.addEventListener("mouseup", finish);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("mousedown", begin);
      document.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", cancel);
    };
  }, [captureResearchSelection]);

  // Highlight: saves the selection, merging it with every highlight it
  // overlaps (creation first — if removal then fails, the leftover is
  // overlapping highlights, not a lost annotation). A selection inside one
  // highlight, with nothing to merge, removes that highlight instead.
  const applyHighlightAction = useCallback(async () => {
    if (!highlightAction || highlightAction.live || savingHighlight) {
      return;
    }
    const targetNodeId = highlightAction.nodeId;
    if (!contentByNodeRef.current[targetNodeId]) {
      return;
    }
    setSavingHighlight(true);
    try {
      if (highlightAction.expandAnchor) {
        const created = await createResearchHighlight(targetNodeId, highlightAction.expandAnchor);
        const removed =
          highlightAction.highlightIds.length > 0
            ? await removeResearchHighlights(targetNodeId, highlightAction.highlightIds)
            : [];
        const removedIds = new Set(removed.map(({ id }) => id));
        patchNodeHighlights(targetNodeId, (highlights) => [
          ...highlights.filter(({ id }) => !removedIds.has(id)),
          created,
        ]);
      } else if (highlightAction.highlightIds.length > 0) {
        await removeHighlights(targetNodeId, highlightAction.highlightIds);
      } else {
        const created = await createResearchHighlight(targetNodeId, highlightAction.anchor);
        patchNodeHighlights(targetNodeId, (highlights) => [...highlights, created]);
        if (highlightAction.crossed) {
          onToast("Highlighted to the end of the paragraph. A highlight stays within one paragraph.");
        }
      }
      selectedHighlightPaintRef.current?.clear();
      window.getSelection()?.removeAllRanges();
      setHighlightAction(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHighlight(false);
    }
  }, [highlightAction, onError, onToast, patchNodeHighlights, removeHighlights, savingHighlight]);

  // The selection can start a branch only while its turn can take one: that
  // node finished, and the tree accepts branches.
  const highlightActionNode = highlightAction
    ? nodeById.get(highlightAction.nodeId) ?? null
    : null;
  const selectionBranchBlocker = !highlightAction?.anchor.exact.trim()
    ? "Select some text first"
    : researchBranchBlocker(highlightActionNode, archived);

  const branchFromSelection = useCallback(() => {
    if (!highlightAction || selectionBranchBlocker) {
      return;
    }
    const { nodeId, anchor } = highlightAction;
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
    openPendingBranch(nodeId, anchor);
  }, [highlightAction, openPendingBranch, selectionBranchBlocker]);

  const copySelection = useCallback(async () => {
    if (!highlightAction) {
      return;
    }
    const text = highlightAction.copyText;
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
    try {
      await writeClipboardText(text);
      onToast("Copied.");
    } catch {
      onToast("Couldn't copy.", "warning");
    }
  }, [highlightAction, onToast]);

  // A selection overlapping saved highlights repaints those annotations in
  // the standard selection tone, above the amber layer.
  const selectedHighlightKey = (highlightAction?.highlightIds ?? []).join("\n");
  const highlightActionNodeId = highlightAction?.nodeId ?? null;
  useLayoutEffect(() => {
    const painted = selectedHighlightPaintRef.current;
    painted?.clear();
    const root = highlightActionNodeId ? segmentRoot(highlightActionNodeId) : null;
    if (!painted || !root || !selectedHighlightKey || !highlightActionNodeId) {
      return;
    }
    const selectedIds = selectedHighlightKey.split("\n");
    for (const { highlight, start, end } of resolvedHighlightsRef.current.get(
      highlightActionNodeId,
    ) ?? []) {
      if (!selectedIds.includes(highlight.id)) {
        continue;
      }
      const range = rangeForTextOffsets(root, start, end);
      if (!range) {
        continue;
      }
      painted.add(range);
    }
  }, [highlightActionNodeId, highlightDomNonce, segmentRoot, selectedHighlightKey]);

  const clearHighlightAction = useCallback(() => setHighlightAction(null), []);

  return {
    /** The captured selection the toolbar acts on, or null. */
    highlightAction,
    clearHighlightAction,
    savingHighlight,
    /** Why the selection cannot start a branch, or null when it can. */
    selectionBranchBlocker,
    captureHighlightSelection,
    applyHighlightAction,
    branchFromSelection,
    copySelection,
  };
}
