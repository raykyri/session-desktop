// The annotations of a thread's open answers (`09-research-document-view.md`
// §5), ported from the desktop `useResearchAnnotations`: saved highlights,
// branch passages (underlined for open branches, dashed for the unsent
// branch), overlaps, the passage under the pointer, a flash on a passage just
// jumped to, and the branch margin markers. Painting goes through
// `ResearchHighlightPainter` (the CSS Custom Highlight API), without rewriting
// the Markdown DOM.
//
// The hook also keeps the registry of each answer's response root and each
// message row, and the flat-offset ranges the annotations resolved to, which
// clicks, hover, the markers and the selection toolbar read.

import type { ResearchHighlight, ResearchHighlightAnchor, ResearchNode } from "@session/shared";
import { researchBranchesInReadingOrder } from "@session/shared/lib/researchBranchView";
import type { ResearchLevel } from "@session/shared/lib/researchColumns";
import {
  overlappingResearchHighlightRegions,
  resolveResearchHighlightOffset,
} from "@session/shared/lib/researchHighlights";
import { passageAnchor } from "@session/shared/lib/researchNodeTypes";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import {
  RESEARCH_BRANCH_LAYER,
  RESEARCH_FLASH_LAYER,
  RESEARCH_HIGHLIGHT_LAYER,
  RESEARCH_HOVER_BRANCH_LAYER,
  RESEARCH_HOVER_HIGHLIGHT_LAYER,
  RESEARCH_OPEN_BRANCH_LAYER,
  RESEARCH_OVERLAP_LAYER,
  RESEARCH_PENDING_BRANCH_LAYER,
  ResearchHighlightPainter,
  clearFallbackMarks,
  isFallbackPainting,
  paintFallbackMarks,
} from "./painting.js";
import { clearHighlightFocus, focusHighlightOf } from "./persistence.js";
import {
  flatOffsetAtPoint,
  passageBlockAt,
  rangeForTextOffsets,
  researchTextProjection,
  type ResolvedHighlight,
} from "./textRanges.js";

const NO_BRANCHES: ResearchNode[] = [];
const FLASH_MS = 1600;
const PENDING_BRANCH_ID = "__pending__";

/** A margin marker: the branches from one paragraph of an answer (`top`, in
 * px from the top of the answer), or from the whole answer (`top` null). */
export interface BranchMarker {
  key: string;
  top: number | null;
  branchIds: string[];
}

export type SegmentDomKind = "anchor" | "root";

interface BranchRange {
  segmentId: string;
  id: string;
  start: number;
  end: number;
}

export interface AnnotationHit {
  nodeId: string;
  branchIds: string[];
  highlight: ResolvedHighlight | undefined;
}

const sameNumberRecord = (left: Record<string, number>, right: Record<string, number>) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

export function useThreadAnnotations({
  treeId,
  levelPath,
  levels,
  activePending,
  branchesByParent,
  nodeById,
  revisionByNode,
  viewKey,
  restoredAnswers,
}: {
  treeId: string;
  /** The answers on screen: each open level's selected message. */
  levelPath: readonly string[];
  levels: readonly ResearchLevel[];
  /** The unsent branch while its column is open. */
  activePending: { parentNodeId: string; anchor: ResearchHighlightAnchor | null } | null;
  branchesByParent: ReadonlyMap<string, ResearchNode[]>;
  nodeById: ReadonlyMap<string, ResearchNode>;
  /** The snapshot revision each answer on screen renders. */
  revisionByNode: Readonly<Record<string, string | undefined>>;
  /** Changes whenever an answer's rendered text can have moved: an expanded
   * window or a full-transcript toggle. */
  viewKey: string;
  /** Answers whose scroll offset was restored since their column mounted;
   * the Highlights-feed reveal waits for it. */
  restoredAnswers: { readonly current: ReadonlySet<string> };
}) {
  const [pointerAnnotationNodeId, setPointerAnnotationNodeId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    nodeId: string;
    start: number;
    end: number;
    kind: "branch" | "highlight";
  } | null>(null);
  const [flash, setFlash] = useState<{ nodeId: string; start: number; end: number } | null>(null);
  const [hiddenHighlightsByNode, setHiddenHighlightsByNode] = useState<Record<string, number>>({});
  const [domNonce, setDomNonce] = useState(0);
  const [markerNonce, setMarkerNonce] = useState(0);
  const [markersByNode, setMarkersByNode] = useState<Record<string, BranchMarker[]>>({});
  const [paintVersion, setPaintVersion] = useState(0);
  // The branches whose passage resolved in an answer on screen, as a key
  // and a set (the ranges themselves are in `branchRangesRef`).
  const [resolvedBranchKey, setResolvedBranchKey] = useState("");
  const resolvedBranchIds = useMemo(
    () => new Set(resolvedBranchKey ? resolvedBranchKey.split("\n") : []),
    [resolvedBranchKey],
  );
  const resolvedHighlightsRef = useRef(new Map<string, ResolvedHighlight[]>());
  const branchRangesRef = useRef<BranchRange[]>([]);
  const hoverFrameRef = useRef<number | null>(null);
  const hoverSampleRef = useRef<{
    root: HTMLElement;
    nodeId: string | null;
    clientX: number;
    clientY: number;
  } | null>(null);

  const painterRef = useRef<ResearchHighlightPainter | null>(null);
  painterRef.current ??= new ResearchHighlightPainter();
  useEffect(() => {
    const painter = painterRef.current ?? new ResearchHighlightPainter();
    painterRef.current = painter;
    return () => {
      painter.dispose();
      painterRef.current = null;
    };
  }, []);
  const painter = useCallback(() => {
    painterRef.current ??= new ResearchHighlightPainter();
    return painterRef.current;
  }, []);

  // Each message row ("anchor") and each answer's response root ("root")
  // registers itself as it mounts.
  const domRef = useRef({
    anchor: new Map<string, HTMLElement>(),
    root: new Map<string, HTMLElement>(),
  });
  const registerSegmentElement = useCallback(
    (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => {
      const map = domRef.current[kind];
      if ((map.get(nodeId) ?? null) === element) return;
      if (element) map.set(nodeId, element);
      else map.delete(nodeId);
      // The answer's text moved to new DOM: ranges painted into the old DOM
      // are gone.
      if (kind === "root") setDomNonce((value) => value + 1);
    },
    [],
  );
  const segmentRoot = useCallback((nodeId: string) => domRef.current.root.get(nodeId) ?? null, []);

  const highlightsByNode = useMemo(() => {
    const map: Record<string, readonly ResearchHighlight[]> = {};
    for (const id of levelPath) map[id] = nodeById.get(id)?.highlights ?? [];
    return map;
  }, [levelPath, nodeById]);
  const highlightsKey = levelPath
    .map((id) => (highlightsByNode[id] ?? []).map((highlight) => highlight.id).join(","))
    .join("\n");
  const revisionsKey = levelPath.map((id) => revisionByNode[id] ?? "").join("\n");
  const pathKey = levelPath.join("\n");

  // Branch passages of each answer on screen, plus the unsent branch's.
  const branchEntries = useMemo(() => {
    const next: { segmentId: string; id: string; anchor: ResearchHighlightAnchor }[] = [];
    for (const segmentId of levelPath) {
      for (const child of branchesByParent.get(segmentId) ?? NO_BRANCHES) {
        const anchor = passageAnchor(child);
        if (anchor) next.push({ segmentId, id: child.id, anchor });
      }
    }
    if (activePending?.anchor) {
      next.push({
        segmentId: activePending.parentNodeId,
        id: PENDING_BRANCH_ID,
        anchor: activePending.anchor,
      });
    }
    return next;
  }, [activePending, branchesByParent, levelPath]);
  const branchKey = branchEntries
    .map((entry) => `${entry.segmentId}:${entry.id}:${entry.anchor.start}:${entry.anchor.end}`)
    .join("\n");

  // Branch heads open as levels (and the unsent branch): their passages are
  // underlined and their markers drawn in the accent.
  const openBranchIds = useMemo(() => {
    const open = new Set<string>(levels.slice(1).map((level) => level.headId));
    if (activePending) open.add(PENDING_BRANCH_ID);
    return open;
  }, [activePending, levels]);
  const openKey = [...openBranchIds].sort().join(",");

  // Diagrams and other child-owned controls replace text nodes without
  // changing the timeline: observe annotated answers' roots so ranges are
  // rebuilt against what is rendered.
  const annotatedKey = levelPath
    .filter(
      (id) =>
        revisionByNode[id] &&
        ((highlightsByNode[id]?.length ?? 0) > 0 ||
          branchEntries.some((entry) => entry.segmentId === id)),
    )
    .join("\n");
  useEffect(() => {
    if (!annotatedKey || typeof MutationObserver === "undefined") return;
    const roots = annotatedKey
      .split("\n")
      .map((id) => segmentRoot(id))
      .filter((root): root is HTMLElement => root !== null);
    if (roots.length === 0) return;
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (isFallbackPainting() || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setDomNonce((value) => value + 1);
      });
    });
    for (const root of roots) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [annotatedKey, revisionsKey, viewKey, segmentRoot]);

  // Saved highlights.
  useLayoutEffect(() => {
    const ranges: Range[] = [];
    const resolvedMap = new Map<string, ResolvedHighlight[]>();
    const hidden: Record<string, number> = {};
    const supported = painter().supported;
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      const revision = revisionByNode[nodeId];
      const highlights = highlightsByNode[nodeId] ?? [];
      if (!root || !revision) continue;
      const projection = researchTextProjection(root);
      const resolved: ResolvedHighlight[] = [];
      const own: Range[] = [];
      for (const highlight of highlights) {
        const offsets = resolveResearchHighlightOffset(projection, revision, highlight);
        if (!offsets) continue;
        const range = rangeForTextOffsets(root, offsets.start, offsets.end);
        if (!range) continue;
        own.push(range);
        resolved.push({ highlight, ...offsets });
      }
      ranges.push(...own);
      resolvedMap.set(nodeId, resolved);
      if (!supported) {
        if (own.length > 0) paintFallbackMarks(root, own);
        else clearFallbackMarks(root);
      }
      const missing = highlights.length - resolved.length;
      if (missing > 0) hidden[nodeId] = missing;
    }
    resolvedHighlightsRef.current = resolvedMap;
    painter().paint(RESEARCH_HIGHLIGHT_LAYER, ranges);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHiddenHighlightsByNode((current) => (sameNumberRecord(current, hidden) ? current : hidden));
    if (focusHighlightOf(treeId)) setPaintVersion((value) => value + 1);
    // Keyed on revisions and highlight ids: a streaming answer replaces its
    // content often, and repainting would re-walk every settled answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, highlightsKey, revisionsKey, viewKey, domNonce, segmentRoot, painter]);

  // Branch passages, the open branches' underline and the unsent branch's
  // dashed underline; offsets are kept for clicks, hover and markers.
  useLayoutEffect(() => {
    const painted: Range[] = [];
    const open: Range[] = [];
    const pending: Range[] = [];
    const offsets: BranchRange[] = [];
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      const revision = revisionByNode[nodeId];
      if (!root || !revision) continue;
      const projection = researchTextProjection(root);
      for (const { id, anchor } of branchEntries.filter((entry) => entry.segmentId === nodeId)) {
        const resolved = resolveResearchHighlightOffset(projection, revision, {
          id,
          anchor,
          createdAt: 0,
        });
        const range = resolved ? rangeForTextOffsets(root, resolved.start, resolved.end) : null;
        if (!range || !resolved) continue;
        offsets.push({ segmentId: nodeId, id, ...resolved });
        if (id === PENDING_BRANCH_ID) {
          pending.push(range);
          continue;
        }
        painted.push(range);
        if (openBranchIds.has(id)) {
          const underline = rangeForTextOffsets(root, resolved.start, resolved.end);
          if (underline) open.push(underline);
        }
      }
    }
    branchRangesRef.current = offsets;
    const key = offsets
      .filter((entry) => entry.id !== PENDING_BRANCH_ID)
      .map((entry) => entry.id)
      .join("\n");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedBranchKey((current) => (current === key ? current : key));
    const layers = painter();
    layers.paint(RESEARCH_BRANCH_LAYER, painted);
    layers.paint(RESEARCH_OPEN_BRANCH_LAYER, open);
    layers.paint(RESEARCH_PENDING_BRANCH_LAYER, pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey, pathKey, openKey, revisionsKey, viewKey, domNonce, segmentRoot, painter]);

  // Margin markers: per answer, one at each paragraph with branched
  // passages, and one at the end for whole-answer branches (and passages
  // that no longer resolve, after a rerun). Measured after the paint above.
  useLayoutEffect(() => {
    const next: Record<string, BranchMarker[]> = {};
    for (const nodeId of levelPath) {
      const branches = branchesByParent.get(nodeId) ?? NO_BRANCHES;
      if (branches.length === 0) continue;
      const root = segmentRoot(nodeId);
      if (!root) continue;
      const answer = root.closest<HTMLElement>("[data-research-answer]");
      const byBlock = new Map<HTMLElement, string[]>();
      const whole: string[] = [];
      for (const branch of branches) {
        const entry = branchRangesRef.current.find(
          (candidate) => candidate.id === branch.id && candidate.segmentId === nodeId,
        );
        const range = entry ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const block = range ? passageBlockAt(root, range.startContainer) : null;
        if (block) byBlock.set(block, [...(byBlock.get(block) ?? []), branch.id]);
        else whole.push(branch.id);
      }
      const answerTop = answer?.getBoundingClientRect().top ?? 0;
      const markers: BranchMarker[] = [...byBlock.entries()]
        .map(([block, ids]) => ({ ids, top: block.getBoundingClientRect().top - answerTop }))
        .sort((left, right) => left.top - right.top)
        .map(({ ids, top }, index) => ({
          key: `p${index}`,
          top: Math.round(top),
          branchIds: researchBranchesInReadingOrder(
            ids.map((id) => nodeById.get(id)).filter((node): node is ResearchNode => Boolean(node)),
            (branchId) =>
              branchRangesRef.current.find((entry) => entry.id === branchId)?.start ?? null,
          ).map((node) => node.id),
        }));
      if (whole.length > 0) markers.push({ key: "end", top: null, branchIds: whole });
      next[nodeId] = markers;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMarkersByNode((current) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    branchKey,
    branchesByParent,
    pathKey,
    markerNonce,
    nodeById,
    revisionsKey,
    viewKey,
    domNonce,
  ]);

  // Paragraphs move when an answer reflows: measure the markers again.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setMarkerNonce((value) => value + 1);
        });
      }
    });
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      if (root) observer.observe(root);
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domNonce, pathKey, segmentRoot]);

  // Where annotations stack, a tone nearer the text keeps the depth visible.
  useLayoutEffect(() => {
    const ranges: Range[] = [];
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      if (!root) continue;
      const spans = [
        ...(resolvedHighlightsRef.current.get(nodeId) ?? []),
        ...branchRangesRef.current.filter(
          (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
        ),
      ].map(({ start, end }) => ({ start, end }));
      for (const region of overlappingResearchHighlightRegions(spans)) {
        const range = rangeForTextOffsets(root, region.start, region.end);
        if (range) ranges.push(range);
      }
    }
    painter().paint(RESEARCH_OVERLAP_LAYER, ranges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey, pathKey, highlightsKey, openKey, revisionsKey, viewKey, domNonce, painter]);

  // The passage under the pointer darkens one step.
  useLayoutEffect(() => {
    const layers = painter();
    const root = hovered ? segmentRoot(hovered.nodeId) : null;
    const range = hovered && root ? rangeForTextOffsets(root, hovered.start, hovered.end) : null;
    layers.paint(RESEARCH_HOVER_BRANCH_LAYER, range && hovered?.kind === "branch" ? [range] : []);
    layers.paint(
      RESEARCH_HOVER_HIGHLIGHT_LAYER,
      range && hovered?.kind === "highlight" ? [range] : [],
    );
  }, [domNonce, hovered, painter, segmentRoot]);

  // A passage flashed after a jump.
  useLayoutEffect(() => {
    const root = flash ? segmentRoot(flash.nodeId) : null;
    const range = flash && root ? rangeForTextOffsets(root, flash.start, flash.end) : null;
    painter().paint(RESEARCH_FLASH_LAYER, range ? [range] : []);
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash, painter, segmentRoot]);

  // The highlight opened from the Highlights feed: once its answer's scroll
  // offset is restored and the passage is painted, it is scrolled a third of
  // the way down its column and flashed.
  useLayoutEffect(() => {
    const focus = focusHighlightOf(treeId);
    if (!focus || !restoredAnswers.current.has(focus.nodeId)) return;
    if (!revisionByNode[focus.nodeId]) return;
    const resolved = resolvedHighlightsRef.current
      .get(focus.nodeId)
      ?.find(({ highlight }) => highlight.id === focus.highlightId);
    const root = segmentRoot(focus.nodeId);
    if (!resolved || !root) {
      const exists = (highlightsByNode[focus.nodeId] ?? []).some(
        (highlight) => highlight.id === focus.highlightId,
      );
      if (!exists || resolvedHighlightsRef.current.has(focus.nodeId)) clearHighlightFocus(treeId);
      return;
    }
    clearHighlightFocus(treeId);
    const range = rangeForTextOffsets(root, resolved.start, resolved.end);
    const scroller = root.closest<HTMLElement>("[data-research-scroll]");
    if (!range || !scroller) return;
    const rect = range.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    scroller.scrollTop += rect.top - bounds.top - Math.max(72, bounds.height / 3);
    setFlash({ nodeId: focus.nodeId, start: resolved.start, end: resolved.end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintVersion, revisionsKey, segmentRoot, treeId]);

  /** The branches and the highlight at a point in an answer's root. CSS
   * highlights have no DOM nodes, so the point is hit-tested against the
   * resolved offsets. */
  const annotationsAtPoint = useCallback(
    (root: HTMLElement, clientX: number, clientY: number): AnnotationHit | null => {
      const nodeId = root.getAttribute("data-research-response-root");
      const offset = nodeId ? flatOffsetAtPoint(root, clientX, clientY) : null;
      if (!nodeId || offset === null) return null;
      const branchIds = branchRangesRef.current
        .filter(
          (entry) =>
            entry.segmentId === nodeId &&
            entry.id !== PENDING_BRANCH_ID &&
            offset >= entry.start &&
            offset < entry.end,
        )
        .map((entry) => entry.id);
      const highlight = (resolvedHighlightsRef.current.get(nodeId) ?? []).find(
        ({ start, end }) => offset >= start && offset < end,
      );
      return { nodeId, branchIds, highlight };
    },
    [],
  );

  const trackAnnotationUnderPointer = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    hoverSampleRef.current = {
      root: event.currentTarget,
      nodeId: event.currentTarget.getAttribute("data-research-response-root"),
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (hoverFrameRef.current !== null) return;
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null;
      const sample = hoverSampleRef.current;
      hoverSampleRef.current = null;
      if (!sample?.nodeId || !sample.root.isConnected) return;
      const { root, nodeId, clientX, clientY } = sample;
      const branches = branchRangesRef.current.filter(
        (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
      );
      const highlights = resolvedHighlightsRef.current.get(nodeId) ?? [];
      const offset =
        branches.length > 0 || highlights.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const branch =
        offset === null
          ? undefined
          : branches.find(({ start, end }) => offset >= start && offset < end);
      const highlight =
        offset === null
          ? undefined
          : highlights.find(({ start, end }) => offset >= start && offset < end);
      const next = branch
        ? { nodeId, start: branch.start, end: branch.end, kind: "branch" as const }
        : highlight
          ? { nodeId, start: highlight.start, end: highlight.end, kind: "highlight" as const }
          : null;
      setPointerAnnotationNodeId((current) => {
        const value = next ? nodeId : null;
        return current === value ? current : value;
      });
      setHovered((current) =>
        current?.nodeId === next?.nodeId &&
        current?.start === next?.start &&
        current?.end === next?.end &&
        current?.kind === next?.kind
          ? current
          : next,
      );
    });
  }, []);

  const clearAnnotationPointer = useCallback(() => {
    if (hoverFrameRef.current !== null) {
      cancelAnimationFrame(hoverFrameRef.current);
      hoverFrameRef.current = null;
    }
    hoverSampleRef.current = null;
    setPointerAnnotationNodeId(null);
    setHovered(null);
  }, []);

  /** Runs the Highlights-feed reveal again (the thread was already open). */
  const revealFocusHighlight = useCallback(() => setPaintVersion((value) => value + 1), []);

  return {
    registerSegmentElement,
    segmentRoot,
    domNonce,
    painter,
    resolvedHighlightsRef,
    branchRangesRef,
    resolvedBranchIds,
    markersByNode,
    hiddenHighlightsByNode,
    openBranchIds,
    pointerAnnotationNodeId,
    annotationsAtPoint,
    trackAnnotationUnderPointer,
    clearAnnotationPointer,
    revealFocusHighlight,
    flashRange: setFlash,
  };
}
