// Text selection in a thread's answers (`09-research-document-view.md` §5),
// ported from the desktop `useResearchTextSelection`: a selection that ends in
// an answer is expanded once to whole words, clipped to its first paragraph,
// and captured as an `answer-v1` anchor with the saved highlights it overlaps.
// The selection toolbar acts on the capture: Branch to right, Highlight
// (merging with what it overlaps, or removing what it lies inside), Copy.

import type { ResearchHighlightAnchor, ResearchNode } from "@session/shared";
import { documentSource, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { createResearchSelectionExpander } from "@session/shared/lib/researchSelection";
import { researchBranchBlocker } from "@session/shared/lib/researchThreadView";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { writeClipboardText } from "../../lib/clipboard.js";

import { RESEARCH_SELECTED_LAYER, type ResearchHighlightPainter } from "./painting.js";
import { captureSelectionAction, type SelectionAction } from "./selectionCapture.js";
import {
  RESPONSE_ROOT_SELECTOR,
  applyDirectionalSelectionRange,
  flatTextOffsetAt,
  messageFlatBoundaries,
  rangeForTextOffsets,
  researchTextProjection,
  responseRootNodeId,
  selectionTouchesNonTextRow,
  type ResolvedHighlight,
} from "./textRanges.js";

export interface HighlightActions {
  create: (nodeId: string, anchor: ResearchHighlightAnchor) => Promise<void>;
  remove: (nodeId: string, highlightIds: string[]) => Promise<void>;
  expand: (nodeId: string, anchor: ResearchHighlightAnchor, absorbed: string[]) => Promise<void>;
}

export function useTextSelection({
  viewKey,
  revisionOf,
  transcriptOf,
  resolvedHighlightsRef,
  painter,
  segmentRoot,
  domNonce,
  nodeById,
  archived,
  highlights,
  openPendingBranch,
  onToast,
  onError,
}: {
  /** Changes when cached offsets may be invalid. */
  viewKey: string;
  /** The revision an answer on screen renders. */
  revisionOf: (nodeId: string) => string | undefined;
  /** Whether an answer is a conversation transcript. */
  transcriptOf: (nodeId: string) => boolean;
  resolvedHighlightsRef: { readonly current: Map<string, ResolvedHighlight[]> };
  painter: () => ResearchHighlightPainter;
  segmentRoot: (nodeId: string) => HTMLElement | null;
  domNonce: number;
  nodeById: ReadonlyMap<string, ResearchNode>;
  archived: boolean;
  highlights: HighlightActions;
  openPendingBranch: (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => void;
  onToast: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [action, setAction] = useState<SelectionAction | null>(null);
  const [saving, setSaving] = useState(false);

  // A view change can move every offset the capture holds.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAction(null);
    window.getSelection()?.removeAllRanges();
  }, [viewKey]);

  const capture = useCallback(
    (expandToWholeWords: boolean) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAction(null);
        return;
      }
      let range = selection.getRangeAt(0);
      const container =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      // A selection that spans answers produces no anchor.
      const root = container?.closest<HTMLElement>(RESPONSE_ROOT_SELECTOR) ?? null;
      if (!root || selectionTouchesNonTextRow(root, range)) {
        setAction(null);
        return;
      }
      const projection = researchTextProjection(root);
      if (expandToWholeWords && selection.anchorNode && selection.focusNode) {
        const anchorOffset = flatTextOffsetAt(root, selection.anchorNode, selection.anchorOffset);
        const focusOffset = flatTextOffsetAt(root, selection.focusNode, selection.focusOffset);
        const expanded =
          anchorOffset === null || focusOffset === null
            ? null
            : (createResearchSelectionExpander(
                projection,
                document.documentElement.lang || navigator.language,
                messageFlatBoundaries(root),
              )?.(anchorOffset, focusOffset) ?? null);
        const expandedRange = expanded
          ? rangeForTextOffsets(root, expanded.start, expanded.end)
          : null;
        if (expanded && expandedRange) {
          applyDirectionalSelectionRange(expandedRange, expanded.direction);
          range = expandedRange;
        }
      }
      const nodeId = responseRootNodeId(root);
      const node = nodeId ? nodeById.get(nodeId) : undefined;
      setAction(
        nodeId
          ? captureSelectionAction({
              root,
              range,
              nodeId,
              revision: revisionOf(nodeId) ?? "",
              status: node ? nodeStatus(node) : undefined,
              isConversation: transcriptOf(nodeId),
              resolved: (resolvedHighlightsRef.current.get(nodeId) ?? []).map(
                ({ highlight, start, end }) => ({ id: highlight.id, start, end }),
              ),
            })
          : null,
      );
    },
    [nodeById, resolvedHighlightsRef, revisionOf, transcriptOf],
  );

  const captureSelection = useCallback(() => capture(false), [capture]);

  // The browser manages the drag; a primary-button selection that began in
  // an answer is expanded to whole words once, when it ends.
  useEffect(() => {
    let beganInAnswer = false;
    const begin = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      beganInAnswer = event.button === 0 && Boolean(target?.closest(RESPONSE_ROOT_SELECTOR));
    };
    const finish = (event: MouseEvent) => {
      if (event.button === 0 && beganInAnswer) capture(true);
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
  }, [capture]);

  const applyHighlight = useCallback(async () => {
    if (!action || action.live || saving) return;
    setSaving(true);
    try {
      if (action.expandAnchor) {
        await highlights.expand(action.nodeId, action.expandAnchor, action.highlightIds);
      } else if (action.highlightIds.length > 0) {
        await highlights.remove(action.nodeId, action.highlightIds);
      } else {
        await highlights.create(action.nodeId, action.anchor);
        if (action.crossed) {
          onToast(
            "Highlighted to the end of the paragraph. A highlight stays within one paragraph.",
          );
        }
      }
      painter().paint(RESEARCH_SELECTED_LAYER, []);
      window.getSelection()?.removeAllRanges();
      setAction(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [action, highlights, onError, onToast, painter, saving]);

  // A selection can start a branch while its answer can take one.
  const actionNode = action ? (nodeById.get(action.nodeId) ?? null) : null;
  const branchBlocker = !action?.anchor.exact.trim()
    ? "Select some text first"
    : researchBranchBlocker(actionNode, archived);

  const branchFromSelection = useCallback(() => {
    if (!action || branchBlocker) return;
    const { nodeId, anchor } = action;
    setAction(null);
    window.getSelection()?.removeAllRanges();
    openPendingBranch(nodeId, anchor);
  }, [action, branchBlocker, openPendingBranch]);

  const copySelection = useCallback(async () => {
    if (!action) return;
    const text = action.copyText;
    setAction(null);
    window.getSelection()?.removeAllRanges();
    try {
      await writeClipboardText(text);
      onToast("Copied.");
    } catch {
      onToast("Couldn't copy.");
    }
  }, [action, onToast]);

  // Saved highlights a selection covers are repainted in the selection tone.
  const selectedKey = (action?.highlightIds ?? []).join("\n");
  const actionNodeId = action?.nodeId ?? null;
  useLayoutEffect(() => {
    const root = actionNodeId ? segmentRoot(actionNodeId) : null;
    if (!root || !selectedKey || !actionNodeId) {
      painter().paint(RESEARCH_SELECTED_LAYER, []);
      return;
    }
    const ids = selectedKey.split("\n");
    const ranges: Range[] = [];
    for (const { highlight, start, end } of resolvedHighlightsRef.current.get(actionNodeId) ?? []) {
      if (!ids.includes(highlight.id)) continue;
      const range = rangeForTextOffsets(root, start, end);
      if (range) ranges.push(range);
    }
    painter().paint(RESEARCH_SELECTED_LAYER, ranges);
  }, [actionNodeId, domNonce, painter, resolvedHighlightsRef, segmentRoot, selectedKey]);

  const clearAction = useCallback(() => setAction(null), []);

  return {
    action,
    clearAction,
    saving,
    branchBlocker,
    captureSelection,
    applyHighlight,
    branchFromSelection,
    copySelection,
  };
}

/** Whether a node's answer is a conversation transcript. */
export function isTranscript(node: ResearchNode | undefined): boolean {
  return node ? documentSource(node) === "transcript" : false;
}
