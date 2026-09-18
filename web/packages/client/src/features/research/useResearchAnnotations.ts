// Everything that measures the rendered document (`09-research-document-view.md`
// §3, §5): where saved passages are, where a follow-up's card sits beside the
// passage it was asked about, how the leader between them is routed, and what
// the pointer is over.
//
// Coordinates sequential layout measurement passes (highlights, anchored cards, collision detection, connector lines) in a single hook to avoid intermediate renders.
//
// Everything runs in layout effects, so a measurement never paints one frame at
// the wrong offset.

import {
  overlappingResearchHighlightRegions,
  researchAnchorConnectorEndpoints,
  resolveResearchHighlightOffset,
} from "@session/shared";
import type {
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResolvedResearchHighlightRange,
} from "@session/shared";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

import type { SegmentElementKind } from "./ThreadSegment.js";
import {
  ANCHORED_CARD_GAP,
  ANCHOR_LAYOUT_DEBOUNCE_MS,
  ASK_COMPOSER_CLEARANCE,
  buildSegmentConnectors,
  resolveAnchoredCardTops,
  sameCardTops,
} from "./layout.js";
import type { ConnectorGeometry, SegmentConnector } from "./layout.js";
import { flatOffsetAtPoint, rangeForTextOffsets, responseRootNodeId } from "./selection/dom.js";
import {
  ResearchHighlightPainter,
  RESEARCH_HIGHLIGHT_LAYER,
  RESEARCH_OVERLAP_LAYER,
  RESEARCH_QUERY_ANCHOR_LAYER,
  RESEARCH_SELECTED_LAYER,
  clearFallbackMarks,
  isFallbackPainting,
  paintFallbackMarks,
} from "./selection/painting.js";

/** A passage a follow-up (or the open ask) was asked about. */
export interface AnchoredEntry {
  segmentId: string;
  /** The follow-up node id, or `ASK_ENTRY_ID` for the ask being composed. */
  id: string;
  anchor: ResearchHighlightAnchor;
}

export const ASK_ENTRY_ID = "__ask__";

/** `CSS.escape` where the engine has it, and a conservative quoting fallback
 * where it does not (jsdom). Node ids are opaque strings from the server, so an
 * attribute selector built from one has to be escaped rather than trusted. */
function cssEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  return css?.escape ? css.escape(value) : value.replace(/["\\]/g, "\\$&");
}

export interface ResearchAnnotationsInput {
  chainNodeIds: readonly string[];
  /** Saved highlights per chain node, straight off the tree detail. */
  highlightsByNode: Record<string, readonly ResearchHighlight[]>;
  /** Snapshot revision per chain node; anchors resolve only against one. */
  revisionByNode: Record<string, string | undefined>;
  anchoredEntries: readonly AnchoredEntry[];
  segmentElement: (nodeId: string, kind: SegmentElementKind) => HTMLElement | null;
  contentContainerRef: RefObject<HTMLElement | null>;
  /** The docked ask composer, for the displacement pass. */
  composerRef: RefObject<HTMLElement | null>;
  /** Changes whenever the rendered projection could have moved: the chain, a
   * "show earlier" expansion, a full-trace toggle. */
  viewKey: string;
  /** The ask's own text, so the displacement pass re-runs when the composer
   * grows. */
  askText: string;
  /** Ids of the highlights the open selection covers, painted in the selection
   * tone above the saved layer. */
  selectedHighlightIds: readonly string[];
  selectedHighlightNodeId: string | null;
}

export interface ResearchAnnotations {
  hiddenHighlightsByNode: Record<string, number>;
  anchoredCardTops: Record<string, number>;
  resolvedCardTops: Record<string, number>;
  askComposerTop: number | null;
  connectorsBySegment: Map<string, SegmentConnector[]>;
  linkedAnchorId: string | null;
  pointerHighlightNodeId: string | null;
  /** Resolved saved ranges per node, for the capture and hit-test paths. */
  resolvedHighlights: (nodeId: string) => ResolvedResearchHighlightRange[];
  /** The annotation under a point, whichever layer it belongs to. */
  annotationAtPoint: (
    root: HTMLElement,
    nodeId: string,
    clientX: number,
    clientY: number,
  ) => { start: number; end: number } | null;
  onPointerMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  setLinkedAnchorId: (id: string | null) => void;
  /** Bumped after each saved-highlight paint, so a consumer waiting for a
   * passage to exist (the `?highlight=` scroll) can observe it. */
  paintVersion: number;
}

function sameConnectors(
  left: readonly SegmentConnector[],
  right: readonly SegmentConnector[],
): boolean {
  return (
    left.length === right.length &&
    left.every((connector, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        connector.id === candidate.id &&
        connector.segmentId === candidate.segmentId &&
        connector.d === candidate.d &&
        connector.x === candidate.x &&
        connector.y === candidate.y
      );
    })
  );
}

export function useResearchAnnotations(input: ResearchAnnotationsInput): ResearchAnnotations {
  const {
    chainNodeIds,
    highlightsByNode,
    revisionByNode,
    anchoredEntries,
    segmentElement,
    contentContainerRef,
    composerRef,
    viewKey,
    askText,
    selectedHighlightIds,
    selectedHighlightNodeId,
  } = input;

  // One painter per mounted document, created lazily through the state
  // initializer so the (page-global) highlight registry is not touched during
  // a render that React may discard.
  const [painter] = useState(() => new ResearchHighlightPainter());
  useEffect(() => () => painter.dispose(), [painter]);

  // Resolved saved ranges per node. A ref rather than state: three later passes
  // read it inside the same commit, and publishing it would re-render between
  // them.
  const resolvedRef = useRef(new Map<string, ResolvedResearchHighlightRange[]>());
  const anchoredRangesRef = useRef<{ segmentId: string; id: string; start: number; end: number }[]>(
    [],
  );

  const [hiddenHighlightsByNode, setHiddenHighlightsByNode] = useState<Record<string, number>>({});
  const [anchoredCardTops, setAnchoredCardTops] = useState<Record<string, number>>({});
  const [resolvedCardTops, setResolvedCardTops] = useState<Record<string, number>>({});
  const [askComposerTop, setAskComposerTop] = useState<number | null>(null);
  const [connectors, setConnectors] = useState<SegmentConnector[]>([]);
  const [linkedAnchorId, setLinkedAnchorId] = useState<string | null>(null);
  const [pointerHighlightNodeId, setPointerHighlightNodeId] = useState<string | null>(null);
  const [paintVersion, setPaintVersion] = useState(0);
  // Signature of the last painted resolution. Every pass below re-runs
  // whenever any of its inputs is rebuilt — and the tree detail is rebuilt by
  // every research event — so a writer that published unconditionally would
  // feed its own dependencies and never settle.
  const paintedSignatureRef = useRef("");
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [domNonce, setDomNonce] = useState(0);

  // Reflow can come from the window or from a sidebar resize that changes the
  // content column without firing `resize`. Observe the rendered width as well,
  // then issue one trailing invalidation every measuring pass shares.
  useEffect(() => {
    const target = contentContainerRef.current;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let observedWidth = target?.getBoundingClientRect().width ?? null;
    const schedule = () => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        setLayoutNonce((value) => value + 1);
      }, ANCHOR_LAYOUT_DEBOUNCE_MS);
    };
    const observer =
      target && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width === undefined || observedWidth === null) return;
            // Sub-pixel jitter is not a reflow.
            if (Math.abs(width - observedWidth) < 0.5) return;
            observedWidth = width;
            schedule();
          })
        : null;
    if (target && observer) observer.observe(target);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (debounce !== null) clearTimeout(debounce);
    };
  }, [contentContainerRef, viewKey]);

  // Which segments carry an annotation at all. Only their response roots are
  // observed for DOM changes: a rail's card previews mutate several times a
  // second while a follow-up streams, and observing those would churn every
  // measuring pass for content no anchor can resolve against.
  const annotatedKey = chainNodeIds
    .filter(
      (id) =>
        revisionByNode[id] !== undefined &&
        ((highlightsByNode[id]?.length ?? 0) > 0 ||
          anchoredEntries.some((entry) => entry.segmentId === id)),
    )
    .join("\n");

  useEffect(() => {
    if (!annotatedKey || typeof MutationObserver === "undefined") return;
    const roots = annotatedKey
      .split("\n")
      .map((id) => segmentElement(id, "root"))
      .filter((root): root is HTMLElement => root !== null);
    if (roots.length === 0) return;
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      // The fallback painter appends its own layer to these roots; reacting to
      // its own work would loop.
      if (frame !== null || isFallbackPainting()) return;
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
  }, [annotatedKey, segmentElement, viewKey]);

  const highlightsKey = chainNodeIds
    .map((id) => (highlightsByNode[id] ?? []).map((highlight) => highlight.id).join(","))
    .join("\n");
  const revisionsKey = chainNodeIds.map((id) => revisionByNode[id] ?? "").join("\n");
  const anchoredKey = anchoredEntries.map((entry) => `${entry.segmentId}:${entry.id}`).join("\n");

  // Re-identifies highlight ranges dynamically using quoted text and context; unresolvable ranges increment hidden counters.).
  useLayoutEffect(() => {
    const resolvedByNode = new Map<string, ResolvedResearchHighlightRange[]>();
    const ranges: Range[] = [];
    const hidden: Record<string, number> = {};
    for (const nodeId of chainNodeIds) {
      const root = segmentElement(nodeId, "root");
      const revision = revisionByNode[nodeId];
      const highlights = highlightsByNode[nodeId] ?? [];
      if (!root || !revision) continue;
      const projection = root.textContent ?? "";
      const resolved: ResolvedResearchHighlightRange[] = [];
      const segmentRanges: Range[] = [];
      for (const highlight of highlights) {
        const offsets = resolveResearchHighlightOffset(projection, revision, highlight);
        if (!offsets) continue;
        const range = rangeForTextOffsets(root, offsets.start, offsets.end);
        if (!range) continue;
        segmentRanges.push(range);
        resolved.push({ id: highlight.id, ...offsets });
      }
      resolvedByNode.set(nodeId, resolved);
      ranges.push(...segmentRanges);
      const missing = highlights.length - resolved.length;
      if (missing > 0) hidden[nodeId] = missing;
      if (!painter.supported) {
        if (segmentRanges.length > 0) paintFallbackMarks(root, segmentRanges);
        else clearFallbackMarks(root);
      }
    }
    resolvedRef.current = resolvedByNode;
    if (painter.supported) painter.paint(RESEARCH_HIGHLIGHT_LAYER, ranges);
    const signature = [...resolvedByNode]
      .map(([nodeId, entries]) =>
        entries.map((entry) => `${nodeId}:${entry.id}:${entry.start}:${entry.end}`).join(","),
      )
      .join("\n");
    // Measured state: an effect that reads the rendered geometry has no
    // other way to publish what it found, and every writer below collapses to
    // the previous identity when nothing moved.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHiddenHighlightsByNode((current) => (sameCardTops(current, hidden) ? current : hidden));
    if (paintedSignatureRef.current !== signature) {
      paintedSignatureRef.current = signature;

      setPaintVersion((version) => version + 1);
    }
  }, [
    chainNodeIds,
    highlightsKey,
    revisionsKey,
    viewKey,
    domNonce,
    // A reflow rewraps the text, which moves the boxes the fallback paints from
    // client rects. Re-running is free for the registry path (the resolution is
    // unchanged, so nothing below it re-publishes) and is the only thing that
    // keeps the fallback aligned after a resize.
    layoutNonce,
    painter,
    segmentElement,
    highlightsByNode,
    revisionByNode,
  ]);

  // Pass 2 — query-anchor passages, their cards' desired offsets, and the
  // docked ask composer's offset. An anchor that no longer locates a passage
  // drops out of the map, and its card falls back to the stacked rail.
  useLayoutEffect(() => {
    const tops: Record<string, number> = {};
    const ranges: Range[] = [];
    const anchored: { segmentId: string; id: string; start: number; end: number }[] = [];
    let askTop: number | null = null;

    for (const nodeId of chainNodeIds) {
      const root = segmentElement(nodeId, "root");
      const revision = revisionByNode[nodeId];
      if (!root || !revision) continue;
      const projection = root.textContent ?? "";
      const aside = segmentElement(nodeId, "aside");
      const asideTop = aside?.getBoundingClientRect().top ?? 0;
      for (const entry of anchoredEntries) {
        if (entry.segmentId !== nodeId) continue;
        const offsets = resolveResearchHighlightOffset(projection, revision, {
          id: entry.id,
          anchor: entry.anchor,
          createdAt: 0,
        });
        const range = offsets ? rangeForTextOffsets(root, offsets.start, offsets.end) : null;
        if (!range || !offsets) continue;
        ranges.push(range);
        const top = aside
          ? Math.max(0, Math.round(range.getBoundingClientRect().top - asideTop))
          : null;
        if (entry.id === ASK_ENTRY_ID) {
          askTop = top;
        } else {
          anchored.push({ segmentId: nodeId, id: entry.id, ...offsets });
          if (top !== null) tops[entry.id] = top;
        }
      }
    }

    anchoredRangesRef.current = anchored;
    painter.paint(RESEARCH_QUERY_ANCHOR_LAYER, ranges);
    // Measured state: an effect that reads the rendered geometry has no
    // other way to publish what it found, and every writer below collapses to
    // the previous identity when nothing moved.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnchoredCardTops((current) => (sameCardTops(current, tops) ? current : tops));

    setAskComposerTop((current) => (current === askTop ? current : askTop));
  }, [
    chainNodeIds,
    anchoredEntries,
    anchoredKey,
    revisionsKey,
    viewKey,
    layoutNonce,
    domNonce,
    painter,
    segmentElement,
    revisionByNode,
  ]);

  // Pass 3 — regions where annotations stack. Every base layer shares one wash,
  // so without this pass two highlights over the same words look like one.
  useLayoutEffect(() => {
    const ranges: Range[] = [];
    for (const nodeId of chainNodeIds) {
      const root = segmentElement(nodeId, "root");
      if (!root) continue;
      const spans = [
        ...(resolvedRef.current.get(nodeId) ?? []),
        ...anchoredRangesRef.current.filter((entry) => entry.segmentId === nodeId),
      ].map(({ start, end }) => ({ start, end }));
      for (const region of overlappingResearchHighlightRegions(spans)) {
        const range = rangeForTextOffsets(root, region.start, region.end);
        if (range) ranges.push(range);
      }
    }
    painter.paint(RESEARCH_OVERLAP_LAYER, ranges);
  }, [
    chainNodeIds,
    highlightsKey,
    anchoredKey,
    revisionsKey,
    viewKey,
    domNonce,
    painter,
    segmentElement,
    paintVersion,
  ]);

  // Pass 4 — collision resolution, in the commit that rendered the cards, so
  // their heights are measurable and the corrected offsets land before paint.
  useLayoutEffect(() => {
    const segmentByChild = new Map(anchoredEntries.map((entry) => [entry.id, entry.segmentId]));
    const bySegment = new Map<string, { id: string; desiredTop: number; height: number }[]>();
    for (const [childId, desiredTop] of Object.entries(anchoredCardTops)) {
      const segmentId = segmentByChild.get(childId);
      if (!segmentId) continue;
      const aside = segmentElement(segmentId, "aside");
      const card = aside?.querySelector<HTMLElement>(
        `[data-research-card-node-id="${cssEscape(childId)}"]`,
      );
      const list = bySegment.get(segmentId) ?? [];
      list.push({ id: childId, desiredTop, height: card?.offsetHeight ?? 0 });
      bySegment.set(segmentId, list);
    }
    const next: Record<string, number> = {};
    for (const placements of bySegment.values()) {
      Object.assign(next, resolveAnchoredCardTops(placements, ANCHORED_CARD_GAP));
    }
    // Measured state: an effect that reads the rendered geometry has no
    // other way to publish what it found, and every writer below collapses to
    // the previous identity when nothing moved.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedCardTops((current) => (sameCardTops(current, next) ? current : next));
  }, [anchoredCardTops, anchoredEntries, layoutNonce, segmentElement]);

  // Pass 5 — connectors, routed onto the cards' settled offsets.
  useLayoutEffect(() => {
    const next: SegmentConnector[] = [];
    for (const nodeId of chainNodeIds) {
      const root = segmentElement(nodeId, "root");
      const grid = segmentElement(nodeId, "grid");
      const aside = segmentElement(nodeId, "aside");
      if (!root || !grid || !aside) continue;
      const gridRect = grid.getBoundingClientRect();
      const geometry: ConnectorGeometry[] = [];
      for (const entry of anchoredRangesRef.current) {
        if (entry.segmentId !== nodeId) continue;
        const range = rangeForTextOffsets(root, entry.start, entry.end);
        const card = aside.querySelector<HTMLElement>(
          `[data-research-card-node-id="${cssEscape(entry.id)}"]`,
        );
        const selectionRect = range?.getBoundingClientRect();
        if (!card || !selectionRect || selectionRect.width <= 0 || selectionRect.height <= 0) {
          continue;
        }
        const endpoints = researchAnchorConnectorEndpoints({
          selectionRect,
          cardRect: card.getBoundingClientRect(),
        });
        geometry.push({
          id: entry.id,
          sx: Math.round(endpoints.sx - gridRect.left),
          sy: Math.round(endpoints.sy - gridRect.top),
          ex: Math.round(endpoints.ex - gridRect.left),
          ey: Math.round(endpoints.ey - gridRect.top),
        });
      }
      next.push(...buildSegmentConnectors(nodeId, geometry));
    }
    // Measured state: an effect that reads the rendered geometry has no
    // other way to publish what it found, and every writer below collapses to
    // the previous identity when nothing moved.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConnectors((current) => (sameConnectors(current, next) ? current : next));
  }, [
    chainNodeIds,
    // The routes are read out of `anchoredRangesRef`, which pass 2 fills. A
    // follow-up that arrives at an offset some other card already wanted
    // changes that ref without changing either tops map, so the set of anchored
    // cards is a dependency in its own right.
    anchoredKey,
    resolvedCardTops,
    anchoredCardTops,
    layoutNonce,
    domNonce,
    segmentElement,
  ]);

  // Pass 6 — ask displacement. The composer is absolutely positioned inside the
  // rail; the cards it would cover are nudged with a transform, so the rail's
  // flow layout is untouched and clearing the transforms animates them home.
  useLayoutEffect(() => {
    const clearTransforms = (scope: HTMLElement | null) => {
      if (!scope) return;
      for (const element of scope.querySelectorAll<HTMLElement>("[data-research-card-node-id]")) {
        element.style.transform = "";
      }
    };
    const askEntry = anchoredEntries.find((entry) => entry.id === ASK_ENTRY_ID);
    const composer = composerRef.current;
    const aside = askEntry ? segmentElement(askEntry.segmentId, "aside") : null;
    clearTransforms(contentContainerRef.current);
    if (!askEntry || askComposerTop === null || !composer || !aside) return;

    const clearanceBottom = askComposerTop + composer.offsetHeight + ASK_COMPOSER_CLEARANCE;
    const stack = aside.firstElementChild?.nextElementSibling;
    if (stack instanceof HTMLElement) {
      // The stack keeps its internal spacing: the first card the composer would
      // cover sets one shared shift for itself and everything after it.
      let delta = 0;
      for (const element of Array.from(stack.children)) {
        if (!(element instanceof HTMLElement)) continue;
        if (delta === 0 && element.offsetTop + element.offsetHeight > askComposerTop) {
          delta = Math.max(0, clearanceBottom - element.offsetTop);
        }
        element.style.transform = delta > 0 ? `translateY(${delta}px)` : "";
      }
    }
    for (const element of aside.querySelectorAll<HTMLElement>("[data-research-card-node-id]")) {
      if (element.style.position !== "absolute" && !element.className.includes("absolute"))
        continue;
      const overlaps =
        element.offsetTop < clearanceBottom &&
        element.offsetTop + element.offsetHeight > askComposerTop;
      element.style.transform = overlaps
        ? `translateY(${clearanceBottom - element.offsetTop}px)`
        : "";
    }
    return () => clearTransforms(aside);
  }, [
    anchoredEntries,
    askComposerTop,
    askText,
    composerRef,
    contentContainerRef,
    layoutNonce,
    resolvedCardTops,
    segmentElement,
  ]);

  // Pass 7 — the selection's own tone over the saved wash, painted above it by
  // priority so a selected highlight looks like any other selected text.
  const selectedKey = selectedHighlightIds.join("\n");
  useLayoutEffect(() => {
    const root = selectedHighlightNodeId ? segmentElement(selectedHighlightNodeId, "root") : null;
    if (!root || selectedKey === "") {
      painter.paint(RESEARCH_SELECTED_LAYER, []);
      return;
    }
    const selected = new Set(selectedKey.split("\n"));
    const ranges: Range[] = [];
    for (const entry of resolvedRef.current.get(selectedHighlightNodeId ?? "") ?? []) {
      if (!selected.has(entry.id)) continue;
      const range = rangeForTextOffsets(root, entry.start, entry.end);
      if (range) ranges.push(range);
    }
    painter.paint(RESEARCH_SELECTED_LAYER, ranges);
  }, [selectedKey, selectedHighlightNodeId, domNonce, painter, segmentElement, paintVersion]);

  // Pointer hit-testing. CSS highlights have no DOM, so hovering a passage is
  // answered from the resolved offsets rather than from an element under the
  // cursor. rAF-throttled, with the latest sample replacing a queued one so the
  // test never lags a frame behind at a boundary.
  const hoverFrameRef = useRef<number | null>(null);
  const hoverSampleRef = useRef<{
    root: HTMLElement;
    nodeId: string | null;
    clientX: number;
    clientY: number;
  } | null>(null);

  const onPointerMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    hoverSampleRef.current = {
      root: event.currentTarget,
      nodeId: responseRootNodeId(event.currentTarget),
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
      const anchors = anchoredRangesRef.current.filter((entry) => entry.segmentId === nodeId);
      const highlights = resolvedRef.current.get(nodeId) ?? [];
      const offset =
        anchors.length > 0 || highlights.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const overHighlight =
        offset !== null && highlights.some(({ start, end }) => offset >= start && offset < end);
      const linked =
        offset === null
          ? null
          : (anchors.find(({ start, end }) => offset >= start && offset < end)?.id ?? null);
      setPointerHighlightNodeId((current) => {
        const next = overHighlight ? nodeId : null;
        return current === next ? current : next;
      });
      setLinkedAnchorId((current) => (current === linked ? current : linked));
    });
  }, []);

  const onPointerLeave = useCallback(() => {
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = null;
    hoverSampleRef.current = null;
    setPointerHighlightNodeId(null);
    setLinkedAnchorId(null);
  }, []);

  const annotationAtPoint = useCallback(
    (root: HTMLElement, nodeId: string, clientX: number, clientY: number) => {
      const offset = flatOffsetAtPoint(root, clientX, clientY);
      if (offset === null) return null;
      const candidates = [
        ...anchoredRangesRef.current.filter((entry) => entry.segmentId === nodeId),
        ...(resolvedRef.current.get(nodeId) ?? []),
      ];
      const hit = candidates.find(({ start, end }) => offset >= start && offset < end);
      return hit ? { start: hit.start, end: hit.end } : null;
    },
    [],
  );

  const resolvedHighlights = useCallback(
    (nodeId: string) => resolvedRef.current.get(nodeId) ?? [],
    [],
  );

  const connectorsBySegment = useMemo(() => {
    const map = new Map<string, SegmentConnector[]>();
    for (const connector of connectors) {
      const list = map.get(connector.segmentId);
      if (list) list.push(connector);
      else map.set(connector.segmentId, [connector]);
    }
    return map;
  }, [connectors]);

  return {
    hiddenHighlightsByNode,
    anchoredCardTops,
    resolvedCardTops,
    askComposerTop,
    connectorsBySegment,
    linkedAnchorId,
    pointerHighlightNodeId,
    resolvedHighlights,
    annotationAtPoint,
    onPointerMove,
    onPointerLeave,
    setLinkedAnchorId,
    paintVersion,
  };
}
