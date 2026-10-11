import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { SegmentDomKind } from "../components/research/ResearchTurn";
import {
  flatOffsetAtPoint,
  passageBlockAt,
  rangeForTextOffsets,
  researchHighlightApi,
  researchTextProjection,
  type ResearchNativeHighlight,
  type ResearchResolvedHighlight,
} from "../components/research/researchTextRanges";
import { researchBranchesInReadingOrder } from "../lib/researchBranchView";
import type { ResearchLevel } from "../lib/researchColumns";
import {
  overlappingResearchHighlightRegions,
  resolveResearchHighlightOffset,
} from "../lib/researchHighlights";
import { passageAnchor } from "../lib/researchNodeTypes";
import type { createResearchThreadPersistence } from "../lib/researchThreadPersistence";
import { sameNumberRecord } from "../lib/researchThreadView";
import type { ResearchHighlightAnchor, ResearchNode, ResearchNodeContent } from "../types";
import { useStableValue } from "./useStableValue";

const EMPTY_BRANCHES: ResearchNode[] = [];
const FLASH_MS = 1600;

/** A margin marker: the branches from one paragraph of an answer (`top`, in
 * px from the top of the answer), or from the whole answer (`top` null). */
export interface ResearchBranchMarker {
  key: string;
  top: number | null;
  branchIds: string[];
}

const RESEARCH_HIGHLIGHT_NAME = "session-research-highlights";
const RESEARCH_BRANCH_NAME = "session-research-branch-passages";
const RESEARCH_OPEN_BRANCH_NAME = "session-research-open-branch";
const RESEARCH_PENDING_BRANCH_NAME = "session-research-pending-branch";
const PENDING_BRANCH_ID = "__pending__";
const RESEARCH_OVERLAP_NAME = "session-research-highlight-overlaps";
const RESEARCH_HOVER_HIGHLIGHT_NAME = "session-research-highlight-hover";
const RESEARCH_HOVER_BRANCH_NAME = "session-research-branch-hover";
const RESEARCH_SELECTED_NAME = "session-research-selected-highlights";
const RESEARCH_FLASH_NAME = "session-research-flash";
// Stacking order for the layers that repaint over the shared base tones:
// overlaps above the base paint, hover above overlaps, the underline of an
// open branch's passage above that, and the selection tone above everything.
const RESEARCH_OVERLAP_PRIORITY = 1;
const RESEARCH_HOVER_PRIORITY = 2;
const RESEARCH_OPEN_PRIORITY = 3;
const RESEARCH_FLASH_PRIORITY = 4;
const RESEARCH_SELECTED_PRIORITY = 5;

/** The annotations of the thread page's open answers, painted with the CSS
 * Custom Highlight API without rewriting the Markdown DOM: saved highlights,
 * branch passages (underlined for open branches, dashed for the unsent
 * branch), overlaps, the passage under the pointer, a flash on the passage a
 * user opened, and the branch margin markers. The hook also tracks the
 * registry of each answer's response root, the flat-offset ranges the
 * annotations resolved to (for clicks, hover, ordering and the selection
 * toolbar), and reveals the highlight opened from the Highlights feed. */
export function useResearchAnnotations({
  treeId,
  navigationPersistence,
  restoredAnswerScrollRef,
  chainNodeIds,
  chainKey,
  levelPath,
  levels,
  activePending,
  branchesByParent,
  nodeById,
  contentByNode,
  revisionsKey,
  highlightsKey,
  expandedKey,
  fullTraceKey,
}: {
  treeId: string | null;
  navigationPersistence: ReturnType<typeof createResearchThreadPersistence>;
  /** Answers whose scroll offset was restored since their column mounted. */
  restoredAnswerScrollRef: { readonly current: Set<string> };
  /** The answers on screen and their joined key. */
  chainNodeIds: readonly string[];
  chainKey: string;
  /** The selected message of each open level. */
  levelPath: readonly string[];
  levels: readonly ResearchLevel[];
  /** The unsent branch while its column is open. */
  activePending: { parentNodeId: string; anchor: ResearchHighlightAnchor | null } | null;
  branchesByParent: ReadonlyMap<string, ResearchNode[]>;
  nodeById: ReadonlyMap<string, ResearchNode>;
  contentByNode: Record<string, ResearchNodeContent>;
  /** Per answer on screen: its response revision, its highlight ids, and
   * whether it shows all items and the full transcript. Any of them moves
   * the answer's flat-text offsets. */
  revisionsKey: string;
  highlightsKey: string;
  expandedKey: string;
  fullTraceKey: string;
}) {
  // The answer the pointer is over an annotation in, and that annotation.
  const [pointerAnnotationNodeId, setPointerAnnotationNodeId] = useState<string | null>(null);
  const [hoveredAnnotation, setHoveredAnnotation] = useState<{
    nodeId: string;
    start: number;
    end: number;
    kind: "branch" | "highlight";
  } | null>(null);
  const [flashRange, setFlashRange] = useState<{ nodeId: string; start: number; end: number } | null>(null);
  // Count saved highlights whose anchors cannot be located in the rendered
  // answer. The answer's … menu reports these unresolved highlights.
  const [hiddenHighlightsByNode, setHiddenHighlightsByNode] = useState<Record<string, number>>({});
  const [highlightDomNonce, setHighlightDomNonce] = useState(0);
  const [markerLayoutNonce, setMarkerLayoutNonce] = useState(0);
  const [markersByNode, setMarkersByNode] = useState<Record<string, ResearchBranchMarker[]>>({});
  // Resolved highlight ranges per answer, refreshed by the paint effect.
  const resolvedHighlightsRef = useRef(new Map<string, ResearchResolvedHighlight[]>());
  // Bumped after each highlight paint so the focus-highlight effect below
  // observes freshly resolved ranges.
  const [highlightPaintVersion, setHighlightPaintVersion] = useState(0);
  // Flat-offset ranges of resolved branch passages, tagged with their answer.
  // Used by passage clicks, hover, markers, and ordering.
  const branchRangeOffsetsRef = useRef<
    { segmentId: string; id: string; start: number; end: number }[]
  >([]);
  const savedHighlightPaintRef = useRef<ResearchNativeHighlight | null>(null);
  const selectedHighlightPaintRef = useRef<ResearchNativeHighlight | null>(null);
  const annotationHoverFrameRef = useRef<number | null>(null);
  const annotationHoverPointerRef = useRef<{
    root: HTMLDivElement;
    nodeId: string | null;
    clientX: number;
    clientY: number;
  } | null>(null);

  // Answer- and row-scoped DOM lookups. Each message row registers itself
  // ("anchor") and each answer its response root as it mounts; measurement
  // effects read the maps instead of scanning the whole subtree.
  const segmentDomRef = useRef({
    anchor: new Map<string, HTMLElement>(),
    root: new Map<string, HTMLElement>(),
  });
  const registerSegmentElement = useCallback(
    (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => {
      const map = segmentDomRef.current[kind];
      if ((map.get(nodeId) ?? null) === element) {
        return;
      }
      if (element) {
        map.set(nodeId, element);
      } else {
        map.delete(nodeId);
      }
      // An answer's text moved to new DOM: ranges painted into the old DOM
      // are gone.
      if (kind === "root") {
        setHighlightDomNonce((value) => value + 1);
      }
    },
    [],
  );
  const segmentRoot = useCallback(
    (nodeId: string) =>
      (segmentDomRef.current.root.get(nodeId) as HTMLDivElement | undefined) ?? null,
    [],
  );

  // Branch passages per open answer: the anchors of each answer's branches,
  // plus the pending new branch's passage. Immutable per id, so the stable
  // identity only changes when the (answer, id) list does.
  const branchEntries = useStableValue(
    useMemo(() => {
      const next: { segmentId: string; id: string; anchor: ResearchHighlightAnchor }[] = [];
      for (const segmentId of levelPath) {
        for (const child of branchesByParent.get(segmentId) ?? []) {
          const anchor = passageAnchor(child);
          if (anchor) {
            next.push({ segmentId, id: child.id, anchor });
          }
        }
      }
      if (activePending?.anchor) {
        next.push({ segmentId: activePending.parentNodeId, id: PENDING_BRANCH_ID, anchor: activePending.anchor });
      }
      return next;
    }, [activePending, branchesByParent, levelPath]),
    (previous, candidate) =>
      previous.length === candidate.length &&
      previous.every(
        (entry, index) =>
          entry.id === candidate[index].id &&
          entry.segmentId === candidate[index].segmentId &&
          entry.anchor === candidate[index].anchor,
      ),
  );
  // Branch heads open as levels (and the pending branch): their passages are
  // underlined and their markers drawn in the accent colour.
  const openBranchIds = useMemo(() => {
    const open = new Set<string>(levels.slice(1).map((level) => level.headId));
    if (activePending) {
      open.add(PENDING_BRANCH_ID);
    }
    return open;
  }, [activePending, levels]);
  const openBranchKey = [...openBranchIds].sort().join(",");

  // Diagram rendering and other child-owned Markdown controls can replace text
  // nodes without changing the transcript items. Observe those commits so saved
  // ranges are rebuilt against the current rendered projection. Only annotated
  // turns' response roots are observed.
  const annotatedSegmentsKey = chainNodeIds
    .filter((id) => {
      if (!contentByNode[id]?.responseRevision) {
        return false;
      }
      return (
        Boolean(contentByNode[id]?.node.highlights?.length) ||
        branchEntries.some((entry) => entry.segmentId === id)
      );
    })
    .join("\n");
  useEffect(() => {
    if (
      !annotatedSegmentsKey ||
      !researchHighlightApi() ||
      typeof MutationObserver === "undefined"
    ) {
      return;
    }
    const roots = annotatedSegmentsKey
      .split("\n")
      .map((id) => segmentRoot(id))
      .filter((root): root is HTMLDivElement => Boolean(root));
    if (roots.length === 0) {
      return;
    }
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setHighlightDomNonce((value) => value + 1);
      });
    });
    for (const root of roots) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [annotatedSegmentsKey, revisionsKey, expandedKey, fullTraceKey, segmentRoot]);

  // Keep the two saved-highlight paint objects registered for this thread page's
  // lifetime. Mutating their range sets avoids WebKit leaving deleted registry
  // paint on screen until an unrelated selection or pointer event invalidates
  // the text layer.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_HIGHLIGHT_NAME);
    api?.registry.delete(RESEARCH_SELECTED_NAME);
    if (!api) {
      return;
    }
    const saved = new api.Highlight();
    const selected = new api.Highlight();
    selected.priority = RESEARCH_SELECTED_PRIORITY;
    savedHighlightPaintRef.current = saved;
    selectedHighlightPaintRef.current = selected;
    api.registry.set(RESEARCH_HIGHLIGHT_NAME, saved);
    api.registry.set(RESEARCH_SELECTED_NAME, selected);
    return () => {
      savedHighlightPaintRef.current = null;
      selectedHighlightPaintRef.current = null;
      api.registry.delete(RESEARCH_HIGHLIGHT_NAME);
      api.registry.delete(RESEARCH_SELECTED_NAME);
    };
  }, []);

  // Paint saved ranges without rewriting the markdown DOM, across every
  // rendered turn. The CSS Custom Highlight registry is name-global, so all
  // turns' ranges aggregate into one Highlight object per layer. Anchors
  // retain an exact quote and nearby context so they can be relocated when
  // transcript visibility changes shift the flat rendered-text offsets.
  useLayoutEffect(() => {
    const painted = savedHighlightPaintRef.current;
    painted?.clear();
    resolvedHighlightsRef.current = new Map();
    const hidden: Record<string, number> = {};
    if (painted) {
      for (const nodeId of chainNodeIds) {
        const root = segmentRoot(nodeId);
        const segmentContent = contentByNode[nodeId];
        if (!root || !segmentContent?.responseRevision) {
          continue;
        }
        const projection = researchTextProjection(root);
        const resolved: ResearchResolvedHighlight[] = [];
        for (const highlight of segmentContent.node.highlights ?? []) {
          const offsets = resolveResearchHighlightOffset(
            projection,
            segmentContent.responseRevision,
            highlight,
          );
          if (!offsets) {
            continue;
          }
          const range = rangeForTextOffsets(root, offsets.start, offsets.end);
          if (!range) {
            continue;
          }
          painted.add(range);
          resolved.push({ highlight, ...offsets });
        }
        resolvedHighlightsRef.current.set(nodeId, resolved);
        const missing = (segmentContent.node.highlights?.length ?? 0) - resolved.length;
        if (missing > 0) {
          hidden[nodeId] = missing;
        }
      }
    }
    setHiddenHighlightsByNode((current) => (sameNumberRecord(current, hidden) ? current : hidden));
    if (treeId && navigationPersistence.store[treeId]?.focusHighlight) {
      setHighlightPaintVersion((version) => version + 1);
    }
    // Keyed on the revisions and highlight-id lists rather than contentByNode
    // identity: a streaming turn's 1s poll replaces the map every second, and
    // repainting would re-walk every settled turn's text nodes each time for
    // content that cannot have moved.
  }, [
    chainKey,
    chainNodeIds,
    highlightsKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // Reveal the highlight opened from the Highlights feed. After restoring
  // the answer's scroll offset and painting the passage, scroll the passage
  // a third of the way down its column, flash it, and clear the request.
  // Waiting for restoration prevents it from overriding this scroll.
  useLayoutEffect(() => {
    if (!treeId) {
      return;
    }
    const navigation = navigationPersistence.store[treeId];
    const focus = navigation?.focusHighlight;
    if (!navigation || !focus || !restoredAnswerScrollRef.current.has(focus.nodeId)) {
      return;
    }
    const segmentContent = contentByNode[focus.nodeId];
    if (!segmentContent?.responseRevision) {
      return;
    }
    const clear = () => {
      delete navigation.focusHighlight;
      navigationPersistence.flush();
    };
    const resolved = resolvedHighlightsRef.current
      .get(focus.nodeId)
      ?.find(({ highlight }) => highlight.id === focus.highlightId);
    const root = segmentRoot(focus.nodeId);
    if (!resolved || !root) {
      const stillExists = segmentContent.node.highlights?.some(
        (highlight) => highlight.id === focus.highlightId,
      );
      if (!stillExists || resolvedHighlightsRef.current.has(focus.nodeId)) {
        clear();
      }
      return;
    }
    const range = rangeForTextOffsets(root, resolved.start, resolved.end);
    const scroller = root.closest<HTMLElement>(".research-column-scroll");
    clear();
    if (!range || !scroller) {
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    scroller.scrollTop += rect.top - scrollerRect.top - Math.max(72, scrollerRect.height / 3);
    setFlashRange({ nodeId: focus.nodeId, start: resolved.start, end: resolved.end });
  }, [contentByNode, highlightPaintVersion, navigationPersistence, segmentRoot, treeId]);

  // Paint branch passages (blue) and resolve their offsets for clicks, hover,
  // and reveal. The passages of open branches are also underlined; a new
  // branch's passage has only a dashed underline. Anchors that no longer
  // locate a passage are omitted.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_BRANCH_NAME);
    api?.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
    api?.registry.delete(RESEARCH_PENDING_BRANCH_NAME);
    branchRangeOffsetsRef.current = [];
    if (!api) {
      return;
    }
    const painted = new api.Highlight();
    const open = new api.Highlight();
    open.priority = RESEARCH_OPEN_PRIORITY;
    const pending = new api.Highlight();
    pending.priority = RESEARCH_OPEN_PRIORITY;
    let paintedAny = false;
    let openAny = false;
    let pendingAny = false;
    const openIds = new Set(openBranchKey ? openBranchKey.split(",") : []);
    for (const nodeId of chainNodeIds) {
      const root = segmentRoot(nodeId);
      const revision = contentByNode[nodeId]?.responseRevision;
      if (!root || !revision) {
        continue;
      }
      const projection = researchTextProjection(root);
      for (const { id, anchor } of branchEntries.filter((entry) => entry.segmentId === nodeId)) {
        const offsets = resolveResearchHighlightOffset(projection, revision, {
          id,
          anchor,
          createdAt: 0,
        });
        const range = offsets ? rangeForTextOffsets(root, offsets.start, offsets.end) : null;
        if (!range || !offsets) {
          continue;
        }
        branchRangeOffsetsRef.current.push({ segmentId: nodeId, id, ...offsets });
        if (id === PENDING_BRANCH_ID) {
          pending.add(range);
          pendingAny = true;
          continue;
        }
        painted.add(range);
        paintedAny = true;
        if (openIds.has(id)) {
          const underline = rangeForTextOffsets(root, offsets.start, offsets.end);
          if (underline) {
            open.add(underline);
            openAny = true;
          }
        }
      }
    }
    if (paintedAny) {
      api.registry.set(RESEARCH_BRANCH_NAME, painted);
    }
    if (openAny) {
      api.registry.set(RESEARCH_OPEN_BRANCH_NAME, open);
    }
    if (pendingAny) {
      api.registry.set(RESEARCH_PENDING_BRANCH_NAME, pending);
    }
    return () => {
      api.registry.delete(RESEARCH_BRANCH_NAME);
      api.registry.delete(RESEARCH_OPEN_BRANCH_NAME);
      api.registry.delete(RESEARCH_PENDING_BRANCH_NAME);
    };
    // revisionsKey instead of contentByNode identity for the same reason as
    // the saved-highlight paint above.
  }, [
    branchEntries,
    chainKey,
    chainNodeIds,
    openBranchKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // Margin markers: for each open answer, one marker level with each
  // paragraph that has branched passages, and one at the end for branches
  // from the whole answer (and passages that no longer resolve, after a
  // rerun). Positions are measured from the painted ranges, after the branch
  // paint above, and again whenever an answer's layout changes.
  useLayoutEffect(() => {
    const next: Record<string, ResearchBranchMarker[]> = {};
    for (const nodeId of levelPath) {
      const branches = branchesByParent.get(nodeId) ?? EMPTY_BRANCHES;
      if (branches.length === 0) {
        continue;
      }
      const root = segmentRoot(nodeId);
      if (!root) {
        continue;
      }
      const answer = root.closest<HTMLElement>(".research-answer");
      const byBlock = new Map<HTMLElement, string[]>();
      const whole: string[] = [];
      for (const branch of branches) {
        const entry = branchRangeOffsetsRef.current.find(
          (candidate) => candidate.id === branch.id && candidate.segmentId === nodeId,
        );
        const range = entry ? rangeForTextOffsets(root, entry.start, entry.end) : null;
        const block = range ? passageBlockAt(root, range.startContainer) : null;
        if (block) {
          byBlock.set(block, [...(byBlock.get(block) ?? []), branch.id]);
        } else {
          whole.push(branch.id);
        }
      }
      const answerTop = answer?.getBoundingClientRect().top ?? 0;
      const markers: ResearchBranchMarker[] = [...byBlock.entries()]
        .map(([block, ids]) => ({ block, ids, top: block.getBoundingClientRect().top - answerTop }))
        .sort((a, b) => a.top - b.top)
        .map(({ ids, top }, index) => ({
          key: `p${index}`,
          top: Math.round(top),
          branchIds: researchBranchesInReadingOrder(
            ids.map((id) => nodeById.get(id)).filter((node): node is ResearchNode => Boolean(node)),
            (branchId) => branchRangeOffsetsRef.current.find((entry) => entry.id === branchId)?.start ?? null,
          ).map((node) => node.id),
        }));
      if (whole.length > 0) {
        markers.push({ key: "end", top: null, branchIds: whole });
      }
      next[nodeId] = markers;
    }
    setMarkersByNode((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [
    branchEntries,
    branchesByParent,
    levelPath,
    markerLayoutNonce,
    nodeById,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // Paragraphs move when an answer reflows (the window resizes, an image or
  // diagram loads): measure the markers again.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setMarkerLayoutNonce((value) => value + 1);
        });
      }
    });
    for (const nodeId of levelPath) {
      const root = segmentRoot(nodeId);
      if (root) {
        observer.observe(root);
      }
    }
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [highlightDomNonce, levelPath, segmentRoot]);

  // Repaint regions where annotations stack — highlights over each other, or
  // a branch passage over a highlight — in the near-text overlap tone, so
  // stacked coverage stays visible.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_OVERLAP_NAME);
    if (!api) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_OVERLAP_PRIORITY;
    let paintedAny = false;
    for (const nodeId of chainNodeIds) {
      const root = segmentRoot(nodeId);
      if (!root) {
        continue;
      }
      const ranges = [
        ...(resolvedHighlightsRef.current.get(nodeId) ?? []),
        ...branchRangeOffsetsRef.current.filter(
          (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
        ),
      ].map(({ start, end }) => ({ start, end }));
      for (const region of overlappingResearchHighlightRegions(ranges)) {
        const range = rangeForTextOffsets(root, region.start, region.end);
        if (!range) {
          continue;
        }
        painted.add(range);
        paintedAny = true;
      }
    }
    if (paintedAny) {
      api.registry.set(RESEARCH_OVERLAP_NAME, painted);
    }
    return () => {
      api.registry.delete(RESEARCH_OVERLAP_NAME);
    };
  }, [
    branchEntries,
    chainKey,
    chainNodeIds,
    highlightsKey,
    openBranchKey,
    revisionsKey,
    expandedKey,
    fullTraceKey,
    highlightDomNonce,
    segmentRoot,
  ]);

  // The passage under the pointer returns to full strength (tints are dimmed
  // outside the focused column) and darkens one step.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_HOVER_BRANCH_NAME);
    api?.registry.delete(RESEARCH_HOVER_HIGHLIGHT_NAME);
    const root = hoveredAnnotation ? segmentRoot(hoveredAnnotation.nodeId) : null;
    if (!api || !hoveredAnnotation || !root) {
      return;
    }
    const range = rangeForTextOffsets(root, hoveredAnnotation.start, hoveredAnnotation.end);
    if (!range) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_HOVER_PRIORITY;
    painted.add(range);
    const name =
      hoveredAnnotation.kind === "branch" ? RESEARCH_HOVER_BRANCH_NAME : RESEARCH_HOVER_HIGHLIGHT_NAME;
    api.registry.set(name, painted);
    return () => {
      api.registry.delete(name);
    };
  }, [highlightDomNonce, hoveredAnnotation, segmentRoot]);

  // Flashes a branch source or highlight after navigation.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_FLASH_NAME);
    const root = flashRange ? segmentRoot(flashRange.nodeId) : null;
    if (!api || !flashRange || !root) {
      return;
    }
    const range = rangeForTextOffsets(root, flashRange.start, flashRange.end);
    if (!range) {
      return;
    }
    const painted = new api.Highlight();
    painted.priority = RESEARCH_FLASH_PRIORITY;
    painted.add(range);
    api.registry.set(RESEARCH_FLASH_NAME, painted);
    const timer = window.setTimeout(() => setFlashRange(null), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      api.registry.delete(RESEARCH_FLASH_NAME);
    };
  }, [flashRange, segmentRoot]);

  // The branches and the highlight at a point in a turn's content root. CSS
  // highlights have no DOM nodes, so the point is hit-tested against the
  // turn's resolved flat-offset ranges.
  const annotationsAtPoint = useCallback((root: HTMLElement, clientX: number, clientY: number) => {
    const nodeId = root.dataset.nodeId;
    const offset = nodeId ? flatOffsetAtPoint(root, clientX, clientY) : null;
    if (!nodeId || offset === null) {
      return null;
    }
    const branchIds = branchRangeOffsetsRef.current
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
  }, []);

  // Passage-side hover: hit-test the pointer against the turn's resolved
  // highlight and branch ranges (rAF-throttled), for the pointer cursor and
  // the hover tone.
  const trackAnnotationUnderPointer = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    annotationHoverPointerRef.current = {
      root: event.currentTarget,
      nodeId: event.currentTarget.dataset.nodeId ?? null,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (annotationHoverFrameRef.current !== null) {
      return;
    }
    annotationHoverFrameRef.current = window.requestAnimationFrame(() => {
      annotationHoverFrameRef.current = null;
      const sample = annotationHoverPointerRef.current;
      annotationHoverPointerRef.current = null;
      if (!sample) {
        return;
      }
      const { root, nodeId, clientX, clientY } = sample;
      if (!nodeId || !root.isConnected) {
        return;
      }
      const segmentBranches = branchRangeOffsetsRef.current.filter(
        (entry) => entry.segmentId === nodeId && entry.id !== PENDING_BRANCH_ID,
      );
      const segmentHighlights = resolvedHighlightsRef.current.get(nodeId) ?? [];
      const offset =
        segmentBranches.length > 0 || segmentHighlights.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const branch =
        offset === null
          ? undefined
          : segmentBranches.find(({ start, end }) => offset >= start && offset < end);
      const highlight =
        offset === null
          ? undefined
          : segmentHighlights.find(({ start, end }) => offset >= start && offset < end);
      const next = branch
        ? { nodeId, start: branch.start, end: branch.end, kind: "branch" as const }
        : highlight
          ? { nodeId, start: highlight.start, end: highlight.end, kind: "highlight" as const }
          : null;
      setPointerAnnotationNodeId((current) => {
        const value = next ? nodeId : null;
        return current === value ? current : value;
      });
      setHoveredAnnotation((current) =>
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
    if (annotationHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(annotationHoverFrameRef.current);
      annotationHoverFrameRef.current = null;
    }
    annotationHoverPointerRef.current = null;
    setPointerAnnotationNodeId(null);
    setHoveredAnnotation(null);
  }, []);

  /** Runs the Highlights-feed reveal again: a highlight was opened in the
   * thread already on screen. */
  const revealFocusHighlight = useCallback(() => setHighlightPaintVersion((version) => version + 1), []);

  return {
    registerSegmentElement,
    segmentRoot,
    /** Bumped whenever an answer's rendered text moves to new DOM. */
    highlightDomNonce,
    resolvedHighlightsRef,
    branchRangeOffsetsRef,
    selectedHighlightPaintRef,
    markersByNode,
    hiddenHighlightsByNode,
    openBranchIds,
    pointerAnnotationNodeId,
    annotationsAtPoint,
    trackAnnotationUnderPointer,
    clearAnnotationPointer,
    revealFocusHighlight,
  };
}
