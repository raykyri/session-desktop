import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createResearchHighlight, removeResearchHighlights } from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import {
  expandedResearchHighlightOffsets,
  RESEARCH_HIGHLIGHT_CONTEXT_LENGTH,
  intersectingResearchHighlightIds,
  researchAnchorContextBounds,
} from "../lib/researchHighlights";
import { documentSource, nodeStatus } from "../lib/researchNodeTypes";
import {
  clipResearchSelectionToParagraph,
  createResearchSelectionSnapper,
  isLiveResearchSelection,
  type ResearchSelectionSnapper,
} from "../lib/researchSelection";
import { researchBranchBlocker, surrogateSafeSlice } from "../lib/researchThreadView";
import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
} from "../types";
import {
  NON_TEXT_ROW_SELECTOR,
  applyDirectionalSelectionRange,
  enclosingMessageFlatBounds,
  flatOffsetAtPoint,
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

// Match the platform's small click-versus-drag tolerance: a click should keep
// link, annotation, and native double-click behavior, while a deliberate drag
// switches to live whole-word selection quickly.
const RESEARCH_SELECTION_DRAG_THRESHOLD = 3;

interface ResearchSelectionDrag {
  root: HTMLDivElement;
  anchorOffset: number | null;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  snapEligible: boolean;
  /** Undefined until the drag crosses the click threshold, null when word
   * segmentation is unavailable, otherwise cached for every live frame. */
  snapper: ResearchSelectionSnapper | null | undefined;
  frame: number | null;
}

/** Manages answer selection, whole-word drag snapping, passage anchors,
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
  const selectionDragRef = useRef<ResearchSelectionDrag | null>(null);

  // Clear the action bar and selection when the view changes. Transcript
  // visibility and loaded content can invalidate their cached positions.
  useEffect(() => {
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }, [viewKey]);

  const captureHighlightSelection = useCallback(() => {
    const selection = window.getSelection();
    if (
      !researchHighlightApi() ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setHighlightAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    // Find the turn containing the selection. Selections spanning turns cannot
    // produce an anchor.
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const root = container?.closest<HTMLElement>(".research-response-content-root") ?? null;
    const nodeId = root?.dataset.nodeId ?? null;
    const segmentContent = nodeId ? contentByNodeRef.current[nodeId] : null;
    const revision = segmentContent?.responseRevision ?? "";
    const node = nodeId ? detailRef.current?.nodes.find((candidate) => candidate.id === nodeId) : null;
    // A streaming answer has no revision to anchor to yet; its selection can
    // still be copied.
    const live = isLiveResearchSelection(revision, node ? nodeStatus(node) : undefined);
    if (!root || !nodeId || !segmentContent || (!revision && !live) || root.closest(".is-leaving")) {
      setHighlightAction(null);
      return;
    }
    if (selectionTouchesNonTextRow(root, range)) {
      setHighlightAction(null);
      return;
    }
    const offsets = selectionOffsets(root, range);
    if (!offsets) {
      setHighlightAction(null);
      return;
    }
    const projection = researchTextProjection(root);
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

  /** Replaces the native character-precise drag range with whole-word
   * endpoints. The raw range is checked first so snapping never makes an
   * otherwise ineligible selection (one crossing tool/thinking machinery)
   * eligible for Highlight/Branch. */
  const applySnappedResearchSelection = useCallback(
    (drag: ResearchSelectionDrag, clientX: number, clientY: number) => {
      if (!drag.snapEligible || drag.anchorOffset === null) {
        return;
      }
      const focusOffset = flatOffsetAtPoint(drag.root, clientX, clientY);
      if (focusOffset === null) {
        return;
      }
      if (focusOffset !== drag.anchorOffset) {
        const rawRange = rangeForTextOffsets(
          drag.root,
          Math.min(drag.anchorOffset, focusOffset),
          Math.max(drag.anchorOffset, focusOffset),
        );
        if (!rawRange || selectionTouchesNonTextRow(drag.root, rawRange)) {
          if (rawRange) {
            applyDirectionalSelectionRange(
              rawRange,
              focusOffset < drag.anchorOffset ? "backward" : "forward",
            );
          }
          return;
        }
      }

      if (drag.snapper === undefined) {
        drag.snapper = createResearchSelectionSnapper(
          researchTextProjection(drag.root),
          document.documentElement.lang || navigator.language,
          messageFlatBoundaries(drag.root),
        );
      }
      const snapped = drag.snapper?.(drag.anchorOffset, focusOffset) ?? null;
      if (!snapped) {
        return;
      }
      const range = rangeForTextOffsets(drag.root, snapped.start, snapped.end);
      if (!range) {
        return;
      }
      // Keep the live focus on the pointer side, so a subsequent keyboard
      // extension continues from the endpoint most recently moved.
      applyDirectionalSelectionRange(range, snapped.direction);
    },
    [],
  );

  // A mouse selection can begin in the answer and end over other column
  // chrome, where the response root's mouseup never fires. Remember
  // answer-originated drags and finish them from a document-level fallback.
  const beginHighlightSelectionDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      const root = event.currentTarget;
      const nodeId = root.dataset.nodeId ?? null;
      const content = nodeId ? contentByNodeRef.current[nodeId] : null;
      const target = event.target instanceof Element ? event.target : null;
      const anchorOffset = flatOffsetAtPoint(root, event.clientX, event.clientY);
      selectionDragRef.current = {
        root,
        anchorOffset,
        originX: event.clientX,
        originY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        // Word units do not cross message boundaries, so snapping moves each
        // endpoint by at most a partial word within one turn.
        snapEligible: Boolean(
          researchHighlightApi() &&
            nodeId &&
            content?.responseRevision &&
            anchorOffset !== null &&
            !target?.closest(NON_TEXT_ROW_SELECTOR)
        ),
        snapper: undefined,
        frame: null,
      };
    },
    [],
  );
  const finishHighlightSelectionDrag = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const drag = selectionDragRef.current;
      if (!drag) {
        return;
      }
      selectionDragRef.current = null;
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      if (drag.active) {
        applySnappedResearchSelection(drag, event.clientX, event.clientY);
      }
      captureHighlightSelection();
    },
    [applySnappedResearchSelection, captureHighlightSelection],
  );
  useEffect(() => {
    const cancelDrag = () => {
      const drag = selectionDragRef.current;
      selectionDragRef.current = null;
      if (drag?.frame !== null && drag?.frame !== undefined) {
        window.cancelAnimationFrame(drag.frame);
      }
    };
    const updateDrag = (event: MouseEvent) => {
      const drag = selectionDragRef.current;
      if (!drag) {
        return;
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) >=
          RESEARCH_SELECTION_DRAG_THRESHOLD
      ) {
        drag.active = true;
      }
      if (!drag.active || !drag.snapEligible || drag.frame !== null) {
        return;
      }
      drag.frame = window.requestAnimationFrame(() => {
        drag.frame = null;
        if (selectionDragRef.current === drag) {
          applySnappedResearchSelection(drag, drag.lastX, drag.lastY);
        }
      });
    };
    const resnapNativeSelection = () => {
      const drag = selectionDragRef.current;
      if (!drag?.active || !drag.snapEligible) {
        return;
      }
      // WebKit updates its native character-level range after mousemove. Fix
      // that range in the ensuing selectionchange task, before the next
      // paint, so a slow drag never exposes partial endpoint words.
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      applySnappedResearchSelection(drag, drag.lastX, drag.lastY);
    };
    document.addEventListener("mousemove", updateDrag);
    document.addEventListener("mouseup", finishHighlightSelectionDrag);
    document.addEventListener("selectionchange", resnapNativeSelection);
    window.addEventListener("blur", cancelDrag);
    return () => {
      document.removeEventListener("mousemove", updateDrag);
      document.removeEventListener("mouseup", finishHighlightSelectionDrag);
      document.removeEventListener("selectionchange", resnapNativeSelection);
      window.removeEventListener("blur", cancelDrag);
      cancelDrag();
    };
  }, [applySnappedResearchSelection, finishHighlightSelectionDrag]);

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
    beginHighlightSelectionDrag,
    finishHighlightSelectionDrag,
    applyHighlightAction,
    branchFromSelection,
    copySelection,
  };
}
