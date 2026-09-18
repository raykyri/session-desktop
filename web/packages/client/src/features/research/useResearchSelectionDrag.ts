// Word-snapped dragging and selection capture
// (`09-research-document-view.md` §5 items 1–3, 9).
//
// A press records the flat offset under the pointer and whether this drag can
// produce an anchor at all. Past a three-pixel threshold every frame re-snaps
// the native selection to whole words with
// `createResearchSelectionSnapper`, re-applying it with the focus kept on the
// pointer's side. The `selectionchange` re-snap pass is WebKit's requirement —
// it updates its character-level range after `mousemove` — and is harmless
// elsewhere, because re-applying an identical range is a no-op.
//
// A release captures. A plain click on a painted passage selects the whole
// annotation instead, which re-enters capture through the same path, so
// removing a highlight goes through the popover the same way saving one did.

import { createResearchSelectionSnapper } from "@session/shared";
import type { ResearchSelectionSnapper, ResolvedResearchHighlightRange } from "@session/shared";
import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { RESEARCH_SELECTION_DRAG_THRESHOLD } from "./layout.js";
import { captureResearchSelection } from "./selection/capture.js";
import type { CapturedResearchSelection } from "./selection/capture.js";
import {
  NON_TEXT_ROW_SELECTOR,
  RESPONSE_ROOT_SELECTOR,
  applyDirectionalSelectionRange,
  flatOffsetAtPoint,
  messageFlatBoundaries,
  rangeForTextOffsets,
  responseRootNodeId,
  selectionTouchesNonTextRow,
} from "./selection/dom.js";
import { supportsHighlightApi } from "./selection/painting.js";

interface SelectionDrag {
  root: HTMLElement;
  anchorOffset: number | null;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  snapEligible: boolean;
  /** Undefined until the drag crosses the threshold, null when word
   * segmentation is unavailable, otherwise cached for every live frame. */
  snapper: ResearchSelectionSnapper | null | undefined;
  frame: number | null;
}

export interface ResearchSelectionDragInput {
  /** The snapshot revision an anchor would be stamped with, per node. */
  revisionByNode: Record<string, string | undefined>;
  resolvedHighlights: (nodeId: string) => ResolvedResearchHighlightRange[];
  annotationAtPoint: (
    root: HTMLElement,
    nodeId: string,
    clientX: number,
    clientY: number,
  ) => { start: number; end: number } | null;
  onCapture: (captured: CapturedResearchSelection | null) => void;
}

export interface ResearchSelectionDragHandlers {
  onRootMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootKeyUp: () => void;
  onRootClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** Re-runs capture against whatever is selected now. */
  capture: () => void;
}

export function useResearchSelectionDrag(
  input: ResearchSelectionDragInput,
): ResearchSelectionDragHandlers {
  // The latest-props ref: the document listeners below are installed once and
  // must see the current callbacks without re-subscribing on every render.
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });
  const dragRef = useRef<SelectionDrag | null>(null);

  const capture = useCallback(() => {
    const { revisionByNode, resolvedHighlights, onCapture } = inputRef.current;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      onCapture(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    // Reject selections spanning multiple segments or extending into the rail.
    const root = container?.closest<HTMLElement>(RESPONSE_ROOT_SELECTOR) ?? null;
    const nodeId = responseRootNodeId(root);
    const revision = nodeId ? revisionByNode[nodeId] : undefined;
    if (!root || !nodeId || !revision) {
      onCapture(null);
      return;
    }
    onCapture(
      captureResearchSelection({
        root,
        range,
        nodeId,
        responseRevision: revision,
        resolved: resolvedHighlights(nodeId),
      }),
    );
  }, []);

  /** Replaces the native character-precise range with whole-word endpoints. The
   * raw range is checked first, so snapping can never make an otherwise
   * ineligible selection (one crossing transcript machinery) eligible. */
  const applySnapped = useCallback((drag: SelectionDrag, clientX: number, clientY: number) => {
    if (!drag.snapEligible || drag.anchorOffset === null) return;
    const focusOffset = flatOffsetAtPoint(drag.root, clientX, clientY);
    if (focusOffset === null) return;
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
        drag.root.textContent ?? "",
        document.documentElement.lang || navigator.language,
        messageFlatBoundaries(drag.root),
      );
    }
    const snapped = drag.snapper?.(drag.anchorOffset, focusOffset) ?? null;
    if (!snapped) return;
    const range = rangeForTextOffsets(drag.root, snapped.start, snapped.end);
    if (range) applyDirectionalSelectionRange(range, snapped.direction);
  }, []);

  const onRootMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = event.currentTarget;
    const nodeId = responseRootNodeId(root);
    const revision = nodeId ? inputRef.current.revisionByNode[nodeId] : undefined;
    const target = event.target instanceof Element ? event.target : null;
    const anchorOffset = flatOffsetAtPoint(root, event.clientX, event.clientY);
    dragRef.current = {
      root,
      anchorOffset,
      originX: event.clientX,
      originY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      // Turn membership is deliberately not part of this test: the snapper
      // splits its units at every message seam, so it moves each endpoint by at
      // most a partial word inside one message and can neither carry a
      // selection across a seam nor pull a crossing one back inside.
      snapEligible: Boolean(
        supportsHighlightApi() &&
        nodeId &&
        revision &&
        anchorOffset !== null &&
        !target?.closest(NON_TEXT_ROW_SELECTOR),
      ),
      snapper: undefined,
      frame: null,
    };
  }, []);

  // A drag can begin in the answer and end over the rail, where the root's own
  // `mouseup` never fires, so the release is finished from a document listener.
  const finishDrag = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (drag.frame !== null) {
        cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      if (drag.active) applySnapped(drag, event.clientX, event.clientY);
      capture();
    },
    [applySnapped, capture],
  );

  useEffect(() => {
    const cancelDrag = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.frame != null) cancelAnimationFrame(drag.frame);
    };
    const updateDrag = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (
        !drag.active &&
        Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) >=
          RESEARCH_SELECTION_DRAG_THRESHOLD
      ) {
        drag.active = true;
      }
      if (!drag.active || !drag.snapEligible || drag.frame !== null) return;
      // A frame fallback for engines that coalesce `selectionchange` during a
      // drag; where the event fires promptly the listener below has already
      // corrected the range and this pass is a no-op.
      drag.frame = requestAnimationFrame(() => {
        drag.frame = null;
        if (dragRef.current === drag) applySnapped(drag, drag.lastX, drag.lastY);
      });
    };
    const resnap = () => {
      const drag = dragRef.current;
      if (!drag?.active || !drag.snapEligible) return;
      if (drag.frame !== null) {
        cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      applySnapped(drag, drag.lastX, drag.lastY);
    };
    document.addEventListener("mousemove", updateDrag);
    document.addEventListener("mouseup", finishDrag);
    document.addEventListener("selectionchange", resnap);
    window.addEventListener("blur", cancelDrag);
    return () => {
      document.removeEventListener("mousemove", updateDrag);
      document.removeEventListener("mouseup", finishDrag);
      document.removeEventListener("selectionchange", resnap);
      window.removeEventListener("blur", cancelDrag);
      cancelDrag();
    };
  }, [applySnapped, finishDrag]);

  const onRootMouseUp = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => finishDrag(event),
    [finishDrag],
  );

  const onRootClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const root = event.currentTarget;
      const nodeId = responseRootNodeId(root);
      const selection = window.getSelection();
      if (!nodeId || !selection || !selection.isCollapsed) return;
      // Preserve standard link navigation and avoid showing the selection popover when clicking hyperlinks.
      if (event.target instanceof Element && event.target.closest("a")) return;
      const hit = inputRef.current.annotationAtPoint(root, nodeId, event.clientX, event.clientY);
      if (!hit) return;
      const range = rangeForTextOffsets(root, hit.start, hit.end);
      if (!range) return;
      selection.removeAllRanges();
      selection.addRange(range);
      capture();
    },
    [capture],
  );

  return { onRootMouseDown, onRootMouseUp, onRootKeyUp: capture, onRootClick, capture };
}
