import ResearchReportImport from "./ResearchReportImport";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FocusEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, RotateCw } from "lucide-react";
import {
  buildRecentActivityFromItems,
  type RecentActivityEvent,
} from "../../lib/activity";
import type {
  RecentResearchQuery,
  RecentResearchQueryCursor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "../../types";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import { getResearchNodeContent } from "../../lib/api";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import ResearchFeedPost from "./ResearchFeedPost";
import ResearchRecapDialog from "./ResearchRecapDialog";
import { ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";
import { NoteBody } from "./ResearchNote";
import type { ResearchFolderState } from "../../lib/researchFolders";
import { isActiveResearchStatus } from "../../lib/researchThreads";
import {
  RESEARCH_TREE_MENU_WIDTH,
  ResearchTreeDeleteDialog,
  ResearchTreeMenuItems,
  ResearchTreeRenameDialog,
} from "./ResearchTreeMenu";

/** Scroll anchor tracking the row key under the top edge of the viewport
 * and its pixel offset. */
export interface RecentActivityScrollAnchor {
  key: string;
  offset: number;
}

/** Where an anchored row sits relative to the viewport's top edge. */
export function recentActivityAnchorOffset(
  canvasTop: number,
  rowOffset: number,
  scrollTop: number,
): number {
  return canvasTop + rowOffset - scrollTop;
}

/** Computes the scrollTop required to restore an anchored row to its saved offset. */
export function recentActivityAnchorScrollTop(
  canvasTop: number,
  rowOffset: number,
  anchorOffset: number,
): number {
  return Math.max(0, canvasTop + rowOffset - anchorOffset);
}

export type ResearchActivityFeedView = "home" | "bookmarks";

const EMPTY_RECAP_PENDING_NODE_IDS: ReadonlySet<string> = new Set<string>();

export interface ResearchActivityFeedProps {
  composer: ReactNode;
  onImportReport?: (markdown: string, prompt: string) => Promise<void>;
  /** Home lists every item; Bookmarks lists only queries whose thread is
   * bookmarked, without the composer or setup guide. */
  view?: ResearchActivityFeedView;
  setupGuide?: ReactNode;
  /** Read once, when the feed mounts. */
  initialScrollAnchor?: RecentActivityScrollAnchor | null;
  onScrollAnchorChange?: (anchor: RecentActivityScrollAnchor | null) => void;
  items: RecentResearchQuery[];
  /** Runs whose background summary job is in flight; each card holds a spinner
   * in its summary slot until the summary arrives. */
  recapPendingNodeIds?: ReadonlySet<string>;
  researchTrees: ResearchTreeSummary[];
  nextCursor: RecentResearchQueryCursor | null;
  loadingOlder: boolean;
  olderError: string | null;
  onOpenResearchQuery: (query: RecentResearchQuery) => void;
  onResearchRecapApplied: (node: ResearchNode) => void;
  onError: (message: string) => void;
  folderState: ResearchFolderState;
  onRenameResearch: (treeId: string, title: string) => Promise<void>;
  onArchiveResearch: (treeId: string) => Promise<void>;
  onRestoreResearch: (treeId: string) => Promise<void>;
  onRemoveResearch: (treeId: string) => Promise<void>;
  onToggleResearchStar: (id: string) => void;
  /** Home's per-thread Follow and Bookmark controls; both persist on the tree. */
  onSetResearchFollowed: (treeId: string, followed: boolean) => void;
  onSetResearchBookmarked: (treeId: string, bookmarked: boolean) => void;
  onRequestCreateFolder: (treeIds: string[]) => void;
  onRemoveFromFolder: (treeIds: string[]) => void;
  onLoadOlder: () => void;
  onRefresh?: () => void;
  /** The thread open in the content column beside the feed; the post that
   * opened it (or the thread's newest post) is marked selected. */
  selectedTreeId?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

const MENU_HEIGHT_ESTIMATE = 132;
const MENU_VIEWPORT_MARGIN = 8;

/** Follow-ups under an item, plus replies for a network post. */
export function feedPostReplyCount(query: RecentResearchQuery): { count: number; label: string } {
  const followUps = query.children?.length ?? 0;
  const replies = query.kind === "note" ? (query.replyCount ?? 0) : 0;
  const parts: string[] = [];
  if (replies > 0) parts.push(`${replies} ${replies === 1 ? "reply" : "replies"}`);
  if (followUps > 0) parts.push(`${followUps} ${followUps === 1 ? "follow-up" : "follow-ups"}`);
  return { count: replies + followUps, label: parts.join(", ") };
}

type VirtualActivityRow = {
  kind: "event";
  key: string;
  event: RecentActivityEvent;
  position: number;
};

export function buildRecentActivityVirtualRows(
  feed: RecentActivityEvent[],
): VirtualActivityRow[] {
  return feed.map((event, index) => ({
    kind: "event",
    key: event.id,
    event,
    position: index + 1,
  }));
}

function estimatedActivityRowHeight(row: VirtualActivityRow): number {
  const query = row.event.source.query;
  const hasTweet = query.attachments?.some(
    (attachment) => attachment.status === "resolved" && attachment.tweet,
  );
  return hasTweet ? 400 : 124;
}

export interface VirtualActivityRange {
  start: number;
  end: number;
}

/** Binary-searches cumulative row geometry, keeping scroll work logarithmic
 * even when the feed contains many thousands of loaded records. */
export function virtualActivityRange(
  offsets: number[],
  sizes: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 700,
): VirtualActivityRange {
  if (offsets.length === 0) return { start: 0, end: 0 };
  const minimum = Math.max(0, scrollTop - overscan);
  const maximum = scrollTop + viewportHeight + overscan;
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] + sizes[middle] < minimum) low = middle + 1;
    else high = middle;
  }
  const start = low;
  low = start;
  high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= maximum) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

function MeasuredActivityRow({
  rowKey,
  top,
  onMeasure,
  onFocusCapture,
  onBlurCapture,
  children,
}: {
  rowKey: string;
  top: number;
  onMeasure: (key: string, height: number) => void;
  onFocusCapture?: () => void;
  onBlurCapture?: (event: FocusEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => onMeasure(rowKey, element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, rowKey]);
  return (
    <div
      ref={ref}
      className="recent-activity-virtual-row"
      style={{ transform: `translateY(${top}px)` }}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      {children}
    </div>
  );
}

function ResearchActivityFeed({
  composer,
  onImportReport,
  view = "home",
  setupGuide,
  initialScrollAnchor = null,
  onScrollAnchorChange,
  items: rawItems,
  recapPendingNodeIds = EMPTY_RECAP_PENDING_NODE_IDS,
  researchTrees,
  nextCursor,
  loadingOlder,
  olderError,
  onOpenResearchQuery,
  onResearchRecapApplied,
  onError,
  folderState,
  onRenameResearch,
  onArchiveResearch,
  onRestoreResearch,
  onRemoveResearch,
  onToggleResearchStar,
  onSetResearchFollowed,
  onSetResearchBookmarked,
  onRequestCreateFolder,
  onRemoveFromFolder,
  onLoadOlder,
  onRefresh,
  selectedTreeId = null,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: ResearchActivityFeedProps) {
  const [menu, setMenu] = useState<{
    kind: "tree";
    treeId: string;
    queryNodeId?: string;
    archived: boolean;
    left: number;
    top: number;
  } | null>(null);
  // The post the reader opened. A thread can have several posts (its root and
  // follow-ups); only the one opened is selected. A thread opened from
  // elsewhere selects its newest post.
  const [openedNodeId, setOpenedNodeId] = useState<string | null>(null);
  const openingTreeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedTreeId !== openingTreeIdRef.current) setOpenedNodeId(null);
    openingTreeIdRef.current = null;
  }, [selectedTreeId]);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const [recapDialogContent, setRecapDialogContent] =
    useState<ResearchNodeContent | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialScrollAnchorRef = useRef(initialScrollAnchor);
  const onScrollAnchorChangeRef = useRef(onScrollAnchorChange);
  onScrollAnchorChangeRef.current = onScrollAnchorChange;
  const virtualCanvasRef = useRef<HTMLDivElement | null>(null);
  const loadSentinelRef = useRef<HTMLDivElement | null>(null);
  const onBackRef = useRef(onBack);
  const onForwardRef = useRef(onForward);
  onBackRef.current = onBack;
  onForwardRef.current = onForward;
  useResearchSwipeNavigation(scrollRef, onBack, onForward);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      let handler: (() => void) | undefined;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = onBackRef.current;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = onForwardRef.current;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowLeft"
      ) {
        handler = onBackRef.current;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowRight"
      ) {
        handler = onForwardRef.current;
      }
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    const onMouseUp = (event: globalThis.MouseEvent) => {
      const handler =
        event.button === 3 ? onBackRef.current : event.button === 4 ? onForwardRef.current : undefined;
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    const mouseTarget = scrollRef.current;
    window.addEventListener("keydown", onKeyDown);
    mouseTarget?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      mouseTarget?.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
  const items = rawItems;
  const visibleItems = useMemo(() => {
    if (view !== "bookmarks") return items;
    const bookmarked = new Set(
      researchTrees.filter((tree) => tree.bookmarked).map((tree) => tree.id),
    );
    return items.filter((item) => bookmarked.has(item.treeId));
  }, [items, researchTrees, view]);
  const feed = useMemo(
    () => buildRecentActivityFromItems(visibleItems, researchTrees),
    [visibleItems, researchTrees],
  );
  const viewTitle = view === "bookmarks" ? "Bookmarks" : "Home";
  const selectedNodeId = useMemo(() => {
    if (!selectedTreeId) return null;
    const opened = feed.find(
      (event) =>
        event.source.query.nodeId === openedNodeId &&
        event.source.query.treeId === selectedTreeId,
    );
    const newest = feed.find((event) => event.source.query.treeId === selectedTreeId);
    return (opened ?? newest)?.source.query.nodeId ?? null;
  }, [feed, openedNodeId, selectedTreeId]);
  const treeById = useMemo(() => {
    const map = new Map<string, ResearchTreeSummary>();
    for (const tree of researchTrees) {
      map.set(tree.id, tree);
    }
    return map;
  }, [researchTrees]);
  const [dayBoundaryVersion, setDayBoundaryVersion] = useState(0);
  useEffect(() => {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 25);
    const timer = window.setTimeout(
      () => setDayBoundaryVersion((version) => version + 1),
      nextMidnight.getTime() - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [dayBoundaryVersion]);
  const rows = useMemo(
    () => buildRecentActivityVirtualRows(feed),
    [dayBoundaryVersion, feed],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const measurementFrameRef = useRef(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 800 });
  // Skips the render when nothing moved; the anchor effect runs on every
  // feed render and would otherwise schedule a second one.
  const updateViewport = useCallback((scrollTop: number, height: number) => {
    setViewport((current) =>
      current.scrollTop === scrollTop && current.height === height
        ? current
        : { scrollTop, height },
    );
  }, []);
  const metrics = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    const indexByKey = new Map<string, number>();
    let totalSize = 0;
    for (const [index, row] of rows.entries()) {
      indexByKey.set(row.key, index);
      offsets.push(totalSize);
      const size = measuredHeightsRef.current.get(row.key) ?? estimatedActivityRowHeight(row);
      sizes.push(size);
      totalSize += size;
    }
    return { offsets, sizes, totalSize, indexByKey };
  }, [measurementVersion, rows]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const range = virtualActivityRange(
    metrics.offsets,
    metrics.sizes,
    viewport.scrollTop,
    viewport.height,
  );
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const visibleRowEntries = useMemo(() => {
    const entries = rows
      .slice(range.start, range.end)
      .map((row, localIndex) => ({ row, index: range.start + localIndex }));
    const focusedIndex = focusedRowKey ? metrics.indexByKey.get(focusedRowKey) : undefined;
    if (
      focusedIndex !== undefined &&
      (focusedIndex < range.start || focusedIndex >= range.end)
    ) {
      entries.push({ row: rows[focusedIndex], index: focusedIndex });
      entries.sort((left, right) => left.index - right.index);
    }
    return entries;
  }, [focusedRowKey, metrics.indexByKey, range.end, range.start, rows]);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const anchorRef = useRef<{ key: string; offset: number } | null>(null);
  const knownItemIdsRef = useRef(new Set(items.map((item) => item.nodeId)));
  const previousTopItemIdRef = useRef(items[0]?.nodeId ?? null);

  // The feed column hides (display: none) while a narrow stage shows a thread.
  // A hidden scroller reads as empty, so it saves nothing; when it shows
  // again, it returns to the row it held before hiding.
  const scrollerHiddenRef = useRef(false);
  const captureScrollState = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (scroller.clientHeight === 0) {
      scrollerHiddenRef.current = true;
      return;
    }
    if (scrollerHiddenRef.current) {
      scrollerHiddenRef.current = false;
      const anchor = anchorRef.current;
      const index = anchor ? metricsRef.current.indexByKey.get(anchor.key) : undefined;
      if (anchor && index !== undefined) {
        scroller.scrollTop = recentActivityAnchorScrollTop(
          virtualCanvasRef.current?.offsetTop ?? 0,
          metricsRef.current.offsets[index],
          anchor.offset,
        );
      }
    }
    const geometry = metricsRef.current;
    const currentRows = rowsRef.current;
    const canvasTop = virtualCanvasRef.current?.offsetTop ?? 0;
    const feedScrollTop = Math.max(0, scroller.scrollTop - canvasTop);
    const visible = virtualActivityRange(
      geometry.offsets,
      geometry.sizes,
      feedScrollTop,
      scroller.clientHeight,
      0,
    ).start;
    const row = currentRows[visible];
    anchorRef.current = row
      ? {
          key: row.key,
          offset: recentActivityAnchorOffset(
            canvasTop,
            geometry.offsets[visible],
            scroller.scrollTop,
          ),
        }
      : null;
    updateViewport(feedScrollTop, scroller.clientHeight);
    onScrollAnchorChangeRef.current?.(anchorRef.current);
    if (scroller.scrollTop <= 60) setNewActivityCount(0);
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(captureScrollState);
    };
    captureScrollState();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, [captureScrollState]);

  // Keep the first visible row at the same pixel when a live item is inserted
  // above it or a measured tweet replaces its estimate.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = anchorRef.current;
    const canvasTop = virtualCanvasRef.current?.offsetTop ?? 0;
    if (!scroller || !anchor || scroller.scrollTop <= Math.max(60, canvasTop)) return;
    const index = metrics.indexByKey.get(anchor.key);
    if (index === undefined) return;
    const desired = recentActivityAnchorScrollTop(
      canvasTop,
      metrics.offsets[index],
      anchor.offset,
    );
    if (Math.abs(scroller.scrollTop - desired) > 0.5) {
      scroller.scrollTop = desired;
      updateViewport(Math.max(0, desired - canvasTop), scroller.clientHeight);
    }
    captureScrollState();
  }, [captureScrollState, metrics, rows]);

  // Restore initial scroll position from saved anchor.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = initialScrollAnchorRef.current;
    const index = anchor ? metricsRef.current.indexByKey.get(anchor.key) : undefined;
    if (scroller && anchor && index !== undefined) {
      anchorRef.current = anchor;
      scroller.scrollTop = recentActivityAnchorScrollTop(
        virtualCanvasRef.current?.offsetTop ?? 0,
        metricsRef.current.offsets[index],
        anchor.offset,
      );
    }
  }, []);

  useEffect(() => {
    const previousTopId = previousTopItemIdRef.current;
    const previousTopIndex = previousTopId
      ? items.findIndex((item) => item.nodeId === previousTopId)
      : -1;
    const candidates = previousTopIndex >= 0 ? items.slice(0, previousTopIndex) : [];
    const addedAbove = candidates.filter(
      (item) => !knownItemIdsRef.current.has(item.nodeId),
    ).length;
    if (addedAbove > 0 && (scrollRef.current?.scrollTop ?? 0) > 60) {
      setNewActivityCount((count) => count + addedAbove);
    }
    knownItemIdsRef.current = new Set(items.map((item) => item.nodeId));
    previousTopItemIdRef.current = items[0]?.nodeId ?? null;
  }, [items]);

  const measureRow = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const previous = measuredHeightsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    measuredHeightsRef.current.set(key, height);
    if (measurementFrameRef.current === 0) {
      measurementFrameRef.current = requestAnimationFrame(() => {
        measurementFrameRef.current = 0;
        setMeasurementVersion((version) => version + 1);
      });
    }
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(measurementFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    const liveKeys = new Set(rows.map((row) => row.key));
    for (const key of measuredHeightsRef.current.keys()) {
      if (!liveKeys.has(key)) measuredHeightsRef.current.delete(key);
    }
  }, [rows]);

  useEffect(() => {
    const sentinel = loadSentinelRef.current;
    const scroller = scrollRef.current;
    if (
      !sentinel ||
      !scroller ||
      !nextCursor ||
      loadingOlder ||
      olderError ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
      },
      { root: scroller, rootMargin: "700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadingOlder, nextCursor, olderError, onLoadOlder]);

  const menuTree =
    menu?.kind === "tree" ? (treeById.get(menu.treeId) ?? null) : null;
  const menuQuery =
    menu?.queryNodeId ? items.find((item) => item.nodeId === menu.queryNodeId) ?? null : null;

  function clampedMenuPosition(clientX: number, clientY: number, width: number) {
    return {
      left: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(clientX, window.innerWidth - width - MENU_VIEWPORT_MARGIN),
      ),
      top: Math.max(
        MENU_VIEWPORT_MARGIN,
        Math.min(
          clientY,
          window.innerHeight - MENU_HEIGHT_ESTIMATE - MENU_VIEWPORT_MARGIN,
        ),
      ),
    };
  }

  function openTreeContextMenu(
    tree: ResearchTreeSummary,
    clientX: number,
    clientY: number,
    queryNodeId?: string,
  ) {
    setMenu({
      kind: "tree",
      treeId: tree.id,
      queryNodeId,
      archived: Boolean(tree.archivedAt),
      ...clampedMenuPosition(clientX, clientY, RESEARCH_TREE_MENU_WIDTH),
    });
  }

  function openRecapDialog(nodeId: string) {
    void getResearchNodeContent(nodeId)
      .then((content) => setRecapDialogContent(content))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  }

  // Menu dismissal and its keycap shortcuts, mirroring the research sidebar
  // menus: outside mousedown, Escape, viewport reflow all close; a bare
  // keycap letter fires its item.
  useEffect(() => {
    if (!menu) {
      return;
    }
    const closeMenu = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !(target instanceof Element && target.closest("[data-journal-menu-trigger]"))
      ) {
        setMenu(null);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const tree = treeById.get(menu.treeId);
      if (!tree) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "d" && (key !== "a" || menu.archived)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (tree.runningCount > 0) {
        return;
      }
      if (key === "d") {
        setMenu(null);
        setDeletingTree(tree);
        return;
      }
      setMenu(null);
      void onArchiveResearch(tree.id);
    };
    const closeOnReflow = () => setMenu(null);
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
    // treeById and the handlers are stable enough per menu lifetime; the menu
    // closes on any mutation the actions cause.
  });

  // The height estimate that positioned the menu is a guess (items vary per
  // entry kind); clamp the real menu back inside the viewport once rendered.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) {
      return;
    }
    const height = element.getBoundingClientRect().height;
    const top = Math.max(
      MENU_VIEWPORT_MARGIN,
      Math.min(menu.top, window.innerHeight - MENU_VIEWPORT_MARGIN - height),
    );
    if (top !== menu.top) {
      element.style.top = `${top}px`;
    }
  }, [menu]);

  return (
    <ResearchDocumentFrame
      title={viewTitle}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
      navActions={
        <>
          {onRefresh ? (
            <button
              type="button"
              className="control-button research-history-button research-header-icon"
              onClick={onRefresh}
              aria-label={`Refresh ${viewTitle}`}
            >
              <RotateCw size={14} aria-hidden="true" />
              <span className="research-header-tooltip" aria-hidden="true">
                Refresh {viewTitle}
              </span>
            </button>
          ) : null}
          {view === "home" && onImportReport ? (
            <ResearchReportImport dropTarget={scrollRef} onImport={onImportReport} onError={onError} />
          ) : null}
        </>
      }
    >
      <div ref={scrollRef} className="research-document-scroll journal-scroll">
        <div className="journal-column research-reading-surface">
          {view === "home" ? (
            <div className="journal-composer-container">{composer}</div>
          ) : null}
          {newActivityCount > 0 ? (
            <div className="recent-activity-new-status" role="status" aria-live="polite">
              <button
                className="control-button recent-activity-new"
                type="button"
                onClick={() => {
                  setNewActivityCount(0);
                  const reduceMotion = window.matchMedia?.(
                    "(prefers-reduced-motion: reduce)",
                  ).matches;
                  scrollRef.current?.scrollTo({
                    top: 0,
                    behavior: reduceMotion ? "auto" : "smooth",
                  });
                }}
              >
                {newActivityCount} new {newActivityCount === 1 ? "activity" : "activities"}
              </button>
            </div>
          ) : null}
          <div
            className="journal-feed"
            role="feed"
            aria-label="Recent activity"
            aria-busy={loadingOlder}
          >
            <div
              ref={virtualCanvasRef}
              className="recent-activity-virtual-canvas"
              style={{ height: metrics.totalSize }}
            >
              {visibleRowEntries.map(({ row, index }) => {
                const query = row.event.source.query;
                const researchTree = treeById.get(query.treeId);
                const toggleFollow = () =>
                  onSetResearchFollowed(query.treeId, !researchTree?.followed);
                const toggleBookmark = () =>
                  onSetResearchBookmarked(query.treeId, !researchTree?.bookmarked);
                const openContextMenu = (clientX: number, clientY: number) => {
                  if (researchTree) {
                    openTreeContextMenu(researchTree, clientX, clientY, query.nodeId);
                  }
                };
                const replies = feedPostReplyCount(query);
                return (
                  <MeasuredActivityRow
                    key={row.key}
                    rowKey={row.key}
                    top={metrics.offsets[index]}
                    onMeasure={measureRow}
                    onFocusCapture={() => setFocusedRowKey(row.key)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setFocusedRowKey((current) => (current === row.key ? null : current));
                      }
                    }}
                  >
                    <div
                      className="recent-activity-unit"
                      role="article"
                      aria-posinset={row.position}
                      aria-setsize={nextCursor ? -1 : feed.length}
                    >
                      <ResearchFeedPost
                        isNote={query.kind === "note"}
                        time={
                          Number.isFinite(row.event.occurredAt) ? (
                            <time
                              dateTime={new Date(row.event.occurredAt).toISOString()}
                              title={new Date(row.event.occurredAt).toLocaleString()}
                            >
                              {formatRelativeTime(row.event.occurredAt)}
                            </time>
                          ) : null
                        }
                        title={query.kind === "note" ? null : (researchTree?.title ?? query.title)}
                        renderBody={(clamp) => (
                          <ResearchUserMessage className="research-feed-post-message">
                            {query.kind === "note" ? (
                              <NoteBody
                                prompt={query.prompt}
                                attachments={query.attachments}
                                variant="compact"
                                renderPrompt={clamp}
                              />
                            ) : (
                              <ResearchMessageBody
                                prompt={query.prompt}
                                attachments={query.attachments}
                                variant="compact"
                                renderPrompt={clamp}
                              />
                            )}
                          </ResearchUserMessage>
                        )}
                        recap={query.kind === "note" ? null : query.recap}
                        recapPending={recapPendingNodeIds.has(query.nodeId)}
                        running={query.kind !== "note" && isActiveResearchStatus(query.status)}
                        selected={query.nodeId === selectedNodeId}
                        unread={
                          Boolean(researchTree?.hasUnseenUpdate) && query.treeId !== selectedTreeId
                        }
                        replyCount={replies.count}
                        replyCountLabel={replies.label}
                        followed={Boolean(researchTree?.followed)}
                        bookmarked={Boolean(researchTree?.bookmarked)}
                        onToggleFollow={toggleFollow}
                        onToggleBookmark={toggleBookmark}
                        onOpen={() => {
                          if (query.treeId !== selectedTreeId) {
                            openingTreeIdRef.current = query.treeId;
                          }
                          setOpenedNodeId(query.nodeId);
                          onOpenResearchQuery(query);
                        }}
                        onContextMenu={openContextMenu}
                      />
                    </div>
                  </MeasuredActivityRow>
                );
              })}
            </div>
            {feed.length === 0 ? (
              <div className="journal-empty-container">
                {view === "bookmarks" ? (
                  <p className="journal-empty">Bookmarked research appears here, newest first.</p>
                ) : setupGuide ? (
                  <div className="journal-setup-guide">{setupGuide}</div>
                ) : (
                  <p className="journal-empty">
                    Research, notes, and saved links appear here, newest first.
                  </p>
                )}
              </div>
            ) : null}
            <div
              ref={loadSentinelRef}
              className="recent-activity-load-boundary"
              aria-live="polite"
              aria-atomic="true"
            >
              {nextCursor ? (
                <button
                  className="control-button recent-activity-load-older"
                  type="button"
                  disabled={loadingOlder}
                  onClick={onLoadOlder}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                  <span>
                    {loadingOlder
                      ? "Loading…"
                      : olderError
                        ? "Retry older activity"
                        : "Load older activity"}
                  </span>
                </button>
              ) : null}
              {olderError ? (
                <p className="recent-activity-load-error" role="alert">
                  Couldn’t load older activity. {olderError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {menu?.kind === "tree" && menuTree
        ? createPortal(
            <div
              ref={menuRef}
              className="popover-surface popover-surface--context pane-context-menu research-sidebar-menu"
              role="menu"
              aria-label={`Actions for ${menuTree.title}`}
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <ResearchTreeMenuItems
                tree={menuTree}
                archived={menu.archived}
                folderState={folderState}
                onClose={() => setMenu(null)}
                onToggleStar={onToggleResearchStar}
                onRename={(tree) => {
                  setMenu(null);
                  setRenamingTree(tree);
                }}
                onArchive={(treeId) => void onArchiveResearch(treeId)}
                onRestore={(treeId) => void onRestoreResearch(treeId)}
                onDelete={(tree) => {
                  setMenu(null);
                  setDeletingTree(tree);
                }}
                onRemoveFromFolder={onRemoveFromFolder}
                onRequestCreateFolder={onRequestCreateFolder}
                onRegenerateSummary={
                  menuQuery &&
                  !menu.archived &&
                  menuQuery.status === "complete" &&
                  menuQuery.recap?.trim()
                    ? () => openRecapDialog(menuQuery.nodeId)
                    : undefined
                }
              />
            </div>,
            document.body,
          )
        : null}
      {renamingTree ? (
        <ResearchTreeRenameDialog
          tree={renamingTree}
          onClose={() => setRenamingTree(null)}
          onRename={onRenameResearch}
        />
      ) : null}
      {deletingTree ? (
        <ResearchTreeDeleteDialog
          tree={deletingTree}
          onClose={() => setDeletingTree(null)}
          onRemove={onRemoveResearch}
        />
      ) : null}
      {recapDialogContent
        ? createPortal(
            <ResearchRecapDialog
              content={recapDialogContent}
              onClose={() => setRecapDialogContent(null)}
              onApplied={(node) => {
                onResearchRecapApplied(node);
                setRecapDialogContent((current) =>
                  current?.node.id === node.id ? { ...current, node } : current,
                );
              }}
            />,
            document.body,
          )
        : null}
    </ResearchDocumentFrame>
  );
}

export default memo(ResearchActivityFeed);
