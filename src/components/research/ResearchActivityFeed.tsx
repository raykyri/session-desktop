import ResearchReportImport from "./ResearchReportImport";
import { nodeType } from "../../lib/researchNodeTypes";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FocusEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { FilePen, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import type {
  RecentResearchQuery,
  ResearchDraft,
  ResearchFolder,
  ResearchFolderState,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "../../types";
import { isEditableTarget } from "../../lib/appHelpers";
import { getResearchNodeContent } from "../../lib/api";
import {
  RESEARCH_ARCHIVE_FOLDER_ID,
  RESEARCH_DRAFTS_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchCardTitle,
  researchFeedChildren,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreePlace,
  stepReorderTarget,
  type ResearchDropPosition,
  type ResearchFeedChild,
} from "../../lib/researchFolders";
import { isActiveResearchStatus } from "../../lib/researchChains";
import {
  feedCycleStep,
  type FeedCycleEntry,
  type FeedCyclePosition,
  type ResearchCycleRequest,
} from "../../lib/researchSiblingCycle";
import { researchFeedPageKey, type ResearchFeedView } from "../../lib/sidebarMode";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchArchivedFeed, { archivedFeedTrees } from "./ResearchArchivedFeed";
import { ResearchColumnsContext } from "./ResearchColumns";
import { ResearchFeedHeader, ResearchFeedScrollThumb } from "./ResearchFeedChrome";
import ResearchFeedCard, {
  researchCardRefocus,
  researchFeedCardControl,
  type ResearchFeedCardStatus,
} from "./ResearchFeedCard";
import ResearchFeedTray, { researchPlaceEmptyText } from "./ResearchFeedTray";
import { ResearchFolderDeleteConfirm } from "./ResearchFolderDialogs";
import { ResearchMenu, ResearchMenuItem } from "./ResearchMenu";
import ResearchFeedRowMenu from "./ResearchMoveMenu";
import type { ResearchUnitMenuPlacement } from "./researchUnitMenu";
import ResearchRecapDialog from "./ResearchRecapDialog";
import {
  ResearchMessageBody,
  ResearchUserMessage,
  visibleResearchPrompt,
} from "./ResearchMessage";
import { PostContent } from "./ResearchPost";
import {
  ResearchTreeDeleteDialog,
  ResearchTreeLifecycleItems,
  ResearchTreeRenameDialog,
} from "./ResearchTreeMenu";

/** Scroll anchor tracking the row key under the top edge of the viewport
 * and its pixel offset. */
interface RecentActivityScrollAnchor {
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

const EMPTY_DRAFTS: ResearchDraft[] = [];
const EMPTY_NODE_IDS: readonly string[] = [];

/** The feed's rows: questions, drafts and starred children. */
const FEED_ROW_SELECTOR = ".research-feed-card-hit, .research-feed-child-open";

/** A roving tab stop over the feed's rows: one row is in the Tab order (the
 * last focused row while it is listed, else the selected one, else the
 * first), and only the selected rows' … buttons are. ↑ and ↓ move between
 * rows. */
function applyFeedRoving(root: HTMLElement | null, last: HTMLElement | null) {
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLElement>(FEED_ROW_SELECTOR)];
  const current =
    (last && rows.includes(last) ? last : null) ??
    rows.find((row) => row.getAttribute("aria-current") === "true") ??
    rows[0];
  for (const row of rows) row.tabIndex = row === current ? 0 : -1;
  for (const menu of root.querySelectorAll<HTMLElement>(".research-feed-card-menu")) {
    menu.tabIndex = menu.closest(".research-feed-card, .research-feed-child")?.classList.contains("is-selected")
      ? 0
      : -1;
  }
}

export interface ResearchActivityFeedProps {
  view?: ResearchFeedView;
  composer: ReactNode;
  onImportReport?: (markdown: string, prompt: string) => Promise<void>;
  setupGuide?: ReactNode;
  /** Read once, when the feed mounts. */
  initialScrollAnchor?: RecentActivityScrollAnchor | null;
  onScrollAnchorChange?: (anchor: RecentActivityScrollAnchor | null) => void;
  /** Loaded feed roots: the newest page, and roots loaded for cards
   * (`onLoadTrees`). Home and Bookmarks list trees in the tree order; a
   * card whose root is not loaded shows its title until it is. */
  items: RecentResearchQuery[];
  /** Active trees in their flat order, then archived trees. */
  researchTrees: ResearchTreeSummary[];
  /** The scoped workspace's user folders and the whole folder state. */
  folders?: ResearchFolder[];
  folderState?: ResearchFolderState;
  drafts?: ResearchDraft[];
  /** Loads the roots of listed cards that `items` lacks. */
  onLoadTrees?: (treeIds: string[]) => Promise<void>;
  onOpenResearchQuery: (query: RecentResearchQuery) => void;
  /** Opens a draft in the content column; the feed keeps its view. */
  onOpenDraft?: (draft: ResearchDraft) => void;
  /** Opens a tree whose root is not in the loaded feed (archived, or paged out). */
  onOpenTree?: (treeId: string) => void;
  onOpenView?: (view: ResearchFeedView) => void;
  onResearchRecapApplied: (node: ResearchNode) => void;
  onError: (message: string) => void;
  onRenameResearch: (treeId: string, title: string) => Promise<void>;
  onRestoreResearch: (treeId: string) => Promise<void>;
  onRemoveResearch: (treeId: string) => Promise<void>;
  onSetResearchBookmarked: (treeId: string, bookmarked: boolean) => void;
  onSetResearchFollowed?: (treeId: string, followed: boolean) => void;
  onMoveTree?: (treeId: string, place: string) => void;
  /** Moves a card within its place (⌥↑ and ⌥↓). */
  onReorderTree?: (treeId: string, place: string, position: ResearchDropPosition) => void;
  onReorderDraft?: (draftId: string, beforeId: string | null) => void;
  /** Remove star on a child row: unstars the follow-up or branch. */
  onUnstarChild?: (child: ResearchFeedChild) => void;
  /** New folder…; with a tree id the tree moves into the new folder. Focus
   * returns to `trigger` when the dialog closes. */
  onNewFolder?: (moveTreeId?: string, trigger?: HTMLElement) => void;
  onRenameFolder?: (folderId: string, trigger?: HTMLElement) => void;
  onRequestDeleteFolder?: (folderId: string) => void;
  /** The folder whose delete confirmation shows under the header. */
  pendingDeleteFolderId?: string | null;
  onConfirmDeleteFolder?: (folderId: string) => void;
  onCancelDeleteFolder?: () => void;
  onToggleTray?: (place: string) => void;
  onDeleteDraft?: (draft: ResearchDraft) => void;
  onDragStart?: ResearchCardDragStart;
  onRefresh?: () => void;
  /** The thread open in the content column beside the feed. */
  selectedTreeId?: string | null;
  /** That thread's open nodes: the message selected in its root pair and
   * the head of each open branch. Their child rows show selected. */
  selectedChildNodeIds?: readonly string[];
  /** The draft open in the content column. */
  selectedDraftId?: string | null;
  onBack?: () => void;
  onForward?: () => void;
}

/** A card of Home's or Bookmarks' virtualized list: a tree, and its root
 * when loaded. `treeId` keys the row. */
interface ResearchFeedRow {
  key: string;
  treeId: string;
  tree?: ResearchTreeSummary;
  query?: RecentResearchQuery;
  /** 1-based, for aria-posinset. */
  position: number;
}

/** The cards of Home (Unfiled trees) or Bookmarks (bookmarked active
 * trees), in the tree order of `trees`. A loaded root whose tree is not in
 * `trees` yet (just created) lists first on Home, newest first. `roots` has
 * one root per tree. */
export function researchFeedRows(
  view: "home" | "bookmarks",
  roots: ReadonlyMap<string, RecentResearchQuery>,
  trees: readonly ResearchTreeSummary[],
  placeOf: (tree: ResearchTreeSummary) => string,
): ResearchFeedRow[] {
  const known = new Set(trees.map((tree) => tree.id));
  const unknown =
    view === "home"
      ? [...roots.values()]
          .filter((query) => !known.has(query.treeId))
          .sort((left, right) => right.createdAt - left.createdAt)
          .map((query) => ({ treeId: query.treeId, query, tree: undefined }))
      : [];
  const listed = trees
    .filter((tree) =>
      tree.archivedAt == null &&
      (view === "bookmarks" ? Boolean(tree.bookmarked) : placeOf(tree) === RESEARCH_UNFILED_FOLDER_ID),
    )
    .map((tree) => ({ treeId: tree.id, tree, query: roots.get(tree.id) }));
  return [...unknown, ...listed].map((row, index) => ({
    key: `tree:${row.treeId}`,
    ...row,
    position: index + 1,
  }));
}

function estimatedActivityRowHeight(row: ResearchFeedRow): number {
  const query = row.query;
  const hasTweet = query?.attachments?.some(
    (attachment) => attachment.status === "resolved" && attachment.tweet,
  );
  return hasTweet ? 400 : 92 + (query?.starred?.length ?? 0) * 48;
}

interface VirtualActivityRange {
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

/** Running status takes precedence over failure status. Show a failure when
 * it is unseen or the question itself failed. */
export function researchFeedStatus(
  tree: ResearchTreeSummary | undefined,
  query: RecentResearchQuery | undefined,
): ResearchFeedCardStatus | null {
  if ((tree?.runningCount ?? 0) > 0 || (query && isActiveResearchStatus(query.status))) {
    return "running";
  }
  if (tree?.hasUnseenFailure || query?.status === "failed") return "failed";
  return null;
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

function feedViewTitle(view: ResearchFeedView, folders: ResearchFolder[]): string {
  switch (view.kind) {
    case "home":
      return "Home";
    case "bookmarks":
      return "Bookmarks";
    case "drafts":
      return "Drafts";
    case "archive":
      return "Archive";
    case "folder":
      return researchPlaceName(view.folderId, folders);
  }
}

/** An open feed menu. `anchor` is the … button that opened a row's menu, or
 * for a context menu (`placement` set) the row's open button; `placement`
 * places a context menu, which returns focus to what had it on its own. A
 * tree's menu is a card's (`queryNodeId` names its loaded root, for
 * Generate recap) or, with `child`, a starred child row's. */
type FeedMenu =
  | {
      kind: "tree";
      treeId: string;
      anchor: HTMLElement;
      placement?: ResearchUnitMenuPlacement;
      child?: ResearchFeedChild;
      queryNodeId?: string;
    }
  | { kind: "draft"; draftId: string; anchor: HTMLElement; placement?: ResearchUnitMenuPlacement };

function ResearchActivityFeed({
  view = { kind: "home" },
  composer,
  onImportReport,
  setupGuide,
  initialScrollAnchor = null,
  onScrollAnchorChange,
  items,
  researchTrees,
  folders = [],
  folderState,
  drafts = EMPTY_DRAFTS,
  onLoadTrees,
  onOpenResearchQuery,
  onOpenDraft,
  onOpenTree,
  onOpenView,
  onResearchRecapApplied,
  onError,
  onRenameResearch,
  onRestoreResearch,
  onRemoveResearch,
  onSetResearchBookmarked,
  onSetResearchFollowed,
  onMoveTree,
  onReorderTree,
  onReorderDraft,
  onUnstarChild,
  onNewFolder,
  onRenameFolder,
  onRequestDeleteFolder,
  pendingDeleteFolderId = null,
  onConfirmDeleteFolder,
  onCancelDeleteFolder,
  onToggleTray,
  onDeleteDraft,
  onDragStart,
  onRefresh,
  selectedTreeId = null,
  selectedChildNodeIds = EMPTY_NODE_IDS,
  selectedDraftId = null,
  onBack,
  onForward,
}: ResearchActivityFeedProps) {
  const [menu, setMenu] = useState<FeedMenu | null>(null);
  // Read by screen readers after a keyboard move.
  const [announcement, setAnnouncement] = useState("");
  const announce = (message: string) =>
    setAnnouncement((current) => (current === message ? `${message}\u00a0` : message));
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const [recapDialogContent, setRecapDialogContent] =
    useState<ResearchNodeContent | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rovingRowRef = useRef<HTMLElement | null>(null);
  // After every render: rows come and go with views, trays and pages.
  useLayoutEffect(() => applyFeedRoving(scrollRef.current, rovingRowRef.current));
  const columns = useContext(ResearchColumnsContext);
  const initialScrollAnchorRef = useRef(initialScrollAnchor);
  const onScrollAnchorChangeRef = useRef(onScrollAnchorChange);
  onScrollAnchorChangeRef.current = onScrollAnchorChange;
  const virtualCanvasRef = useRef<HTMLDivElement | null>(null);
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
      const plainAlt = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      let handler: (() => void) | undefined;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = onBackRef.current;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = onForwardRef.current;
      } else if (plainAlt && event.key === "ArrowLeft") {
        handler = onBackRef.current;
      } else if (plainAlt && event.key === "ArrowRight") {
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

  const treeById = useMemo(
    () => new Map(researchTrees.map((tree) => [tree.id, tree])),
    [researchTrees],
  );
  // One card per thread: its root (feed items are roots; a follow-up item
  // only stands in for a thread whose root has not loaded).
  const queryByTree = useMemo(() => {
    const map = new Map<string, RecentResearchQuery>();
    for (const item of items) {
      const existing = map.get(item.treeId);
      if (!existing || (existing.parentNodeId && !item.parentNodeId)) map.set(item.treeId, item);
    }
    return map;
  }, [items]);
  const placeOf = useCallback(
    (tree: ResearchTreeSummary | undefined) =>
      tree && folderState ? researchTreePlace(tree, folderState) : RESEARCH_UNFILED_FOLDER_ID,
    [folderState],
  );

  // The virtualized list: Unfiled on Home, every bookmarked thread in
  // Bookmarks, both in the tree order.
  const listed = view.kind === "home" || view.kind === "bookmarks";
  const activeTrees = useMemo(
    () => researchTrees.filter((tree) => tree.archivedAt == null),
    [researchTrees],
  );
  const rows = useMemo(
    () =>
      view.kind === "home" || view.kind === "bookmarks"
        ? researchFeedRows(view.kind, queryByTree, activeTrees, placeOf)
        : [],
    [activeTrees, placeOf, queryByTree, view.kind],
  );
  const viewTitle = feedViewTitle(view, folders);
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

  // A different list starts at its top.
  const viewKey = researchFeedPageKey(view);
  const previousViewKeyRef = useRef(viewKey);
  useLayoutEffect(() => {
    if (previousViewKeyRef.current === viewKey) return;
    previousViewKeyRef.current = viewKey;
    anchorRef.current = null;
    setNewActivityCount(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    captureScrollState();
    if (focusTitleOnViewChangeRef.current) {
      focusTitleOnViewChangeRef.current = false;
      titleRef.current?.focus();
    }
  }, [captureScrollState, viewKey]);

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

  // Cards in and near the viewport whose root is not loaded ask for it, in
  // one request per render. An id is asked once while it stays unloaded; a
  // failed request is asked again by Retry.
  const requestedRootsRef = useRef(new Set<string>());
  const [rootLoadError, setRootLoadError] = useState<string | null>(null);
  const [rootLoadAttempt, setRootLoadAttempt] = useState(0);
  const missingRootIds = visibleRowEntries
    .filter(({ row }) => row.tree && !row.query)
    .map(({ row }) => row.treeId);
  const missingRootKey = missingRootIds.join(",");
  useEffect(() => {
    const requested = requestedRootsRef.current;
    for (const id of requested) {
      if (queryByTree.has(id)) requested.delete(id);
    }
    const ids = missingRootKey ? missingRootKey.split(",").filter((id) => !requested.has(id)) : [];
    if (!onLoadTrees || ids.length === 0) return;
    for (const id of ids) requested.add(id);
    onLoadTrees(ids).then(
      () => setRootLoadError(null),
      (err: unknown) => {
        for (const id of ids) requested.delete(id);
        setRootLoadError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [missingRootKey, onLoadTrees, queryByTree, rootLoadAttempt]);

  const menuTree = menu?.kind === "tree" ? (treeById.get(menu.treeId) ?? null) : null;
  const menuQuery =
    menu?.kind === "tree" && menu.queryNodeId
      ? items.find((item) => item.nodeId === menu.queryNodeId) ?? null
      : null;
  const menuDraft =
    menu?.kind === "draft" ? (drafts.find((draft) => draft.id === menu.draftId) ?? null) : null;
  const menuStateRef = useRef(menu);
  menuStateRef.current = menu;
  // Escape returns focus itself; an item that keeps the user on the card
  // (Bookmark, Move to) returns it to the … button.
  const closeMenu = useCallback((restoreFocus = false) => {
    const current = menuStateRef.current;
    setMenu(null);
    if (restoreFocus && current && !current.placement) {
      current.anchor.focus({ preventScroll: true });
    }
  }, []);

  // A card moved by ⌥↑/⌥↓ keeps focus and stays in view while the new order
  // renders (the move applies after the folder store's write settles),
  // unless focus went elsewhere.
  const movedCardRef = useRef<{ cardId: string; until: number; revealed: boolean } | null>(null);
  const keepCardFocus = (cardId: string) => {
    movedCardRef.current = { cardId, until: performance.now() + 2000, revealed: false };
  };
  useLayoutEffect(() => {
    const moved = movedCardRef.current;
    if (!moved) return;
    if (performance.now() > moved.until) {
      movedCardRef.current = null;
      return;
    }
    const hit = researchFeedCardControl(moved.cardId, "open");
    const active = document.activeElement;
    if (!hit || (active !== hit && active !== null && active !== document.body)) return;
    // Scrolls only when the card regains focus or first renders moved, so
    // a later scroll by the reader is not undone.
    if (active === hit && moved.revealed) return;
    moved.revealed = true;
    if (active !== hit) hit.focus({ preventScroll: true });
    hit.closest(".research-feed-card")?.scrollIntoView({ block: "nearest" });
  });

  // A card moved to another place re-mounts there: focus waits on its old …
  // button, then moves to the … button in the new place (see
  // researchCardRefocus).
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refocusCardRef = useRef<{ cardId: string; anchor: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    const pending = refocusCardRef.current;
    if (!pending) return;
    const step = researchCardRefocus(pending.anchor, document.activeElement, document.body);
    if (step === "wait") return;
    refocusCardRef.current = null;
    if (step === "drop") return;
    const target =
      researchFeedCardControl(pending.cardId, "menu") ??
      rootRef.current?.querySelector<HTMLElement>(".research-feed-header-title");
    target?.focus({ preventScroll: true });
  });

  // Esc on the delete confirmation returns to the header's Delete folder
  // button; deleting returns to Home with its title focused.
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const deleteFolderButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusTitleOnViewChangeRef = useRef(false);

  function openRecapDialog(nodeId: string) {
    void getResearchNodeContent(nodeId)
      .then((content) => setRecapDialogContent(content))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  }

  // The row whose … button opened the open menu (aria-expanded).
  const menuTreeId = menu?.kind === "tree" && !menu.child && !menu.placement ? menu.treeId : null;
  const menuChildNodeId =
    menu?.kind === "tree" && !menu.placement ? (menu.child?.nodeId ?? null) : null;
  // A second click on the … button that opened a menu closes it.
  const openTreeMenu = (
    treeId: string,
    anchor: HTMLElement,
    { child, queryNodeId }: { child?: ResearchFeedChild; queryNodeId?: string } = {},
  ) =>
    setMenu((current) =>
      current?.kind === "tree" && current.anchor === anchor && !current.placement
        ? null
        : { kind: "tree", treeId, anchor, child, queryNodeId },
    );
  // The right-click, Shift+F10 and ContextMenu key open the … menu at
  // `placement`; `control` is the row's open button.
  const openTreeContextMenu = (
    treeId: string,
    placement: ResearchUnitMenuPlacement,
    control: HTMLElement,
    { child, queryNodeId }: { child?: ResearchFeedChild; queryNodeId?: string } = {},
  ) => setMenu({ kind: "tree", treeId, anchor: control, placement, child, queryNodeId });
  const openDraftMenu = (draftId: string, anchor: HTMLElement) =>
    setMenu((current) =>
      current?.kind === "draft" && current.draftId === draftId
        ? null
        : { kind: "draft", draftId, anchor },
    );

  /** Opens a thread's card: a question row opens its thread at the question;
   * a row for a later node of the tree opens at that node. */
  function openTreeCard(tree: ResearchTreeSummary | undefined, query: RecentResearchQuery | undefined) {
    if (query && query.nodeId !== tree?.rootNodeId) onOpenResearchQuery(query);
    else onOpenTree?.(tree?.id ?? query?.treeId ?? "");
  }

  /** A thread's card: its root question when loaded, else its title.
   * `virtual`: a card of the virtualized list. */
  function renderTreeCard(
    tree: ResearchTreeSummary | undefined,
    query: RecentResearchQuery | undefined,
    { virtual = false }: { virtual?: boolean } = {},
  ) {
    const treeId = tree?.id ?? query?.treeId ?? "";
    const isPost = query ? nodeType(query) === "post" : false;
    const question = query?.prompt ?? tree?.title ?? "";
    const title = isPost ? null : researchCardTitle(tree?.title ?? query?.title, question);
    const selected = treeId === selectedTreeId;
    const status = researchFeedStatus(tree, query);
    const childRows = query ? researchFeedChildren(query) : [];
    // The card shows the question as plain text; its Markdown renders in the
    // conversation. Link cards and tweet embeds still show.
    const plainPrompt = (asQuestion: (content: ReactNode) => ReactNode) => () =>
      asQuestion(query ? visibleResearchPrompt(query.prompt, query.attachments).trim() : question);
    return (
      <ResearchFeedCard
        cardId={treeId}
        place={placeOf(tree)}
        title={title}
        label={title ? `${title}. ${question}` : question}
        renderBody={(asQuestion) =>
          query ? (
            <ResearchUserMessage className="research-feed-card-message">
              {isPost ? (
                <PostContent
                  prompt={query.prompt}
                  format={query.format ?? "text"}
                  attachments={query.attachments}
                  variant="compact"
                  renderPrompt={plainPrompt(asQuestion)}
                />
              ) : (
                <ResearchMessageBody
                  prompt={query.prompt}
                  attachments={query.attachments}
                  variant="compact"
                  renderPrompt={plainPrompt(asQuestion)}
                />
              )}
            </ResearchUserMessage>
          ) : (
            asQuestion(question)
          )
        }
        status={status}
        statusLabel={
          status === "failed" && tree?.hasUnseenFailure ? "Failed since last viewed" : undefined
        }
        selected={selected}
        // A failure dot already says the thread changed.
        unread={Boolean(tree?.hasUnseenUpdate) && !selected && status !== "failed"}
        childRows={childRows}
        selectedChildNodeIds={selected ? selectedChildNodeIds : EMPTY_NODE_IDS}
        childMenuNodeId={menuChildNodeId}
        menuOpen={menuTreeId === treeId}
        onOpen={() => openTreeCard(tree, query)}
        onOpenChild={(child) => onOpenResearchQuery(child.query)}
        // The … button and the context menu open the same menu.
        onMenu={tree ? (anchor) => openTreeMenu(tree.id, anchor, { queryNodeId: query?.nodeId }) : undefined}
        onChildMenu={tree ? (child, anchor) => openTreeMenu(tree.id, anchor, { child }) : undefined}
        onContextMenu={
          tree
            ? (placement, control) =>
                openTreeContextMenu(tree.id, placement, control, { queryNodeId: query?.nodeId })
            : undefined
        }
        onChildContextMenu={
          tree
            ? (child, placement, control) => openTreeContextMenu(tree.id, placement, control, { child })
            : undefined
        }
        onDragStart={tree ? onDragStart : undefined}
        virtual={virtual}
      />
    );
  }

  /** A draft opens in the content column; its … menu has Open and Delete. */
  function renderDraftCard(draft: ResearchDraft) {
    return (
      <ResearchFeedCard
        key={draft.id}
        cardId={draft.id}
        dragKind="draft"
        place={RESEARCH_DRAFTS_FOLDER_ID}
        label={`Draft: ${draft.prompt.trim()}`}
        renderBody={(asQuestion) => asQuestion(draft.prompt.trim())}
        selected={draft.id === selectedDraftId}
        menuOpen={menu?.kind === "draft" && menu.draftId === draft.id && !menu.placement}
        menuLabel="Draft actions"
        onOpen={() => onOpenDraft?.(draft)}
        onMenu={(anchor) => openDraftMenu(draft.id, anchor)}
        // A draft's context menu is its … menu.
        onContextMenu={(placement, control) =>
          setMenu({ kind: "draft", draftId: draft.id, anchor: control, placement })
        }
        onDragStart={onDragStart}
      />
    );
  }

  /** Trees filed in a place, in the folder order (Archive: newest archived). */
  function treesIn(place: string): ResearchTreeSummary[] {
    return researchTrees.filter(
      (tree) => tree.archivedAt == null && placeOf(tree) === place,
    );
  }

  /** How many questions a place holds, for its tray header. */
  function placeCount(place: string) {
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
      return researchTrees.filter((tree) => tree.archivedAt != null).length;
    }
    return treesIn(place).length + (place === RESEARCH_DRAFTS_FOLDER_ID ? drafts.length : 0);
  }

  function renderPlaceCards(place: string) {
    if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
      return (
        <ResearchArchivedFeed
          trees={researchTrees}
          selectedTreeId={selectedTreeId}
          menuTreeId={menuTreeId}
          onOpen={(treeId) => onOpenTree?.(treeId)}
          onMenu={(treeId, anchor) => openTreeMenu(treeId, anchor)}
          onContextMenu={(treeId, placement, control) => openTreeContextMenu(treeId, placement, control)}
          onDragStart={onDragStart}
        />
      );
    }
    const trees = treesIn(place);
    const placeDrafts = place === RESEARCH_DRAFTS_FOLDER_ID ? drafts : EMPTY_DRAFTS;
    if (trees.length === 0 && placeDrafts.length === 0) {
      return <div className="research-feed-empty">{researchPlaceEmptyText(place)}</div>;
    }
    return (
      <>
        {placeDrafts.map((draft) => renderDraftCard(draft))}
        {trees.map((tree) => (
          <div key={tree.id} className="research-feed-unit">
            {renderTreeCard(tree, queryByTree.get(tree.id))}
          </div>
        ))}
      </>
    );
  }

  const trayPlaces = [
    RESEARCH_DRAFTS_FOLDER_ID,
    ...folders.map((folder) => folder.id),
    RESEARCH_ARCHIVE_FOLDER_ID,
  ];
  const collapsed = new Set(folderState?.collapsed ?? []);
  const soloPlace =
    view.kind === "drafts"
      ? RESEARCH_DRAFTS_FOLDER_ID
      : view.kind === "archive"
        ? RESEARCH_ARCHIVE_FOLDER_ID
        : view.kind === "folder"
          ? view.folderId
          : null;
  const userFolder =
    view.kind === "folder" ? (folders.find((folder) => folder.id === view.folderId) ?? null) : null;
  const archivedBookmarks =
    view.kind === "bookmarks"
      ? researchTrees.filter((tree) => tree.archivedAt != null && tree.bookmarked)
      : [];

  // ⌃Tab / ⌃⇧Tab with the feed as the column last interacted with (see
  // ResearchColumns): opens the next or previous card of the list that holds
  // the current row, as clicking it would, or the next or previous child row
  // of the same card when the current row is a child row. The lists are
  // Home's recent activity (Bookmarks' list) and each open tray, or the
  // view's own cards. The current row is the focused feed row, else the open
  // card, or the child row last opened in it while that row shows selected.
  const openedChildRef = useRef<{ cardId: string; nodeId: string } | null>(null);
  const cycleFeedRef = useRef<(request: ResearchCycleRequest) => boolean>(() => false);
  cycleFeedRef.current = (request) => {
    interface FeedRowEntry extends FeedCycleEntry {
      cardId: string;
      childRows: ResearchFeedChild[];
      /** The card's row in the virtualized list, which may not be rendered. */
      virtualIndex: number | null;
      open: () => void;
    }
    const treeEntry = (
      tree: ResearchTreeSummary | undefined,
      query: RecentResearchQuery | undefined,
      virtualIndex: number | null = null,
    ): FeedRowEntry => {
      const cardId = tree?.id ?? query?.treeId ?? "";
      const childRows = query ? researchFeedChildren(query) : [];
      return {
        key: `tree:${cardId}`,
        cardId,
        children: childRows.map((child) => child.nodeId),
        childRows,
        virtualIndex,
        open: () => openTreeCard(tree, query),
      };
    };
    const placeEntries = (place: string): FeedRowEntry[] => {
      if (place === RESEARCH_ARCHIVE_FOLDER_ID) {
        return archivedFeedTrees(researchTrees).map((tree) => treeEntry(tree, undefined));
      }
      const placeDrafts = place === RESEARCH_DRAFTS_FOLDER_ID ? drafts : EMPTY_DRAFTS;
      return [
        ...placeDrafts.map(
          (draft): FeedRowEntry => ({
            key: `draft:${draft.id}`,
            cardId: draft.id,
            children: [],
            childRows: [],
            virtualIndex: null,
            open: () => onOpenDraft?.(draft),
          }),
        ),
        ...treesIn(place).map((tree) => treeEntry(tree, queryByTree.get(tree.id))),
      ];
    };
    const lists: FeedRowEntry[][] = [];
    if (listed) {
      lists.push([
        ...rows.map((row, index) => treeEntry(row.tree, row.query, index)),
        ...archivedBookmarks.map((tree) => treeEntry(tree, undefined)),
      ]);
    }
    if (view.kind === "home") {
      for (const place of trayPlaces) {
        if (!collapsed.has(place)) lists.push(placeEntries(place));
      }
    }
    if (soloPlace) lists.push(placeEntries(soloPlace));

    const step = feedCycleStep(lists, currentFeedPosition(), request.direction);
    const entry = step ? lists.flat().find((candidate) => candidate.key === step.key) : undefined;
    if (!step || !entry) return true;
    const child = step.child ? entry.childRows.find((candidate) => candidate.nodeId === step.child) : undefined;
    if (child) {
      openedChildRef.current = { cardId: entry.cardId, nodeId: child.nodeId };
      onOpenResearchQuery(child.query);
    } else {
      openedChildRef.current = null;
      entry.open();
    }
    revealFeedRow(entry.cardId, entry.virtualIndex, child?.nodeId ?? null, request.keepFocus);
    return true;
  };
  useEffect(() => columns?.registerCycle("feed", (request) => cycleFeedRef.current(request)), [columns]);

  /** The feed row ⌃Tab steps from (see cycleFeedRef). */
  function currentFeedPosition(): FeedCyclePosition | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && scrollRef.current?.contains(active)) {
      const card = active.matches(".research-feed-card-hit")
        ? active.closest<HTMLElement>(".research-feed-card")
        : null;
      if (card?.dataset.researchCard) {
        return { key: `${card.dataset.researchCardKind ?? "tree"}:${card.dataset.researchCard}`, child: null };
      }
      const childOf = active.matches(".research-feed-child-open")
        ? active.closest<HTMLElement>("[data-research-child-of]")?.dataset.researchChildOf
        : undefined;
      if (childOf) {
        return { key: `tree:${childOf}`, child: active.dataset.nodeId ?? null };
      }
    }
    if (selectedDraftId) return { key: `draft:${selectedDraftId}`, child: null };
    if (!selectedTreeId) return null;
    const opened = openedChildRef.current;
    return {
      key: `tree:${selectedTreeId}`,
      child:
        opened?.cardId === selectedTreeId && selectedChildNodeIds.includes(opened.nodeId) ? opened.nodeId : null,
    };
  }

  /** Scrolls a card (or one of its child rows) into view, rendering it first
   * when it is a virtualized row outside the rendered range, and focuses it
   * unless focus stays in a text field. */
  function revealFeedRow(cardId: string, virtualIndex: number | null, childNodeId: string | null, keepFocus: boolean) {
    const scroller = scrollRef.current;
    if (scroller && virtualIndex !== null) {
      const geometry = metricsRef.current;
      const top = (virtualCanvasRef.current?.offsetTop ?? 0) + (geometry.offsets[virtualIndex] ?? 0);
      const bottom = top + (geometry.sizes[virtualIndex] ?? 0);
      if (top < scroller.scrollTop) {
        scroller.scrollTop = top;
      } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
        scroller.scrollTop = Math.min(top, bottom - scroller.clientHeight);
      }
    }
    const selector = childNodeId
      ? `[data-research-child-of="${CSS.escape(cardId)}"] .research-feed-child-open[data-node-id="${CSS.escape(childNodeId)}"]`
      : `.research-feed-card[data-research-card="${CSS.escape(cardId)}"] .research-feed-card-hit`;
    const started = performance.now();
    const attempt = () => {
      const row = scrollRef.current?.querySelector<HTMLElement>(selector);
      if (!row) {
        if (performance.now() - started < 500) requestAnimationFrame(attempt);
        return;
      }
      row.scrollIntoView({ block: "nearest" });
      if (!keepFocus) row.focus({ preventScroll: true });
    };
    requestAnimationFrame(attempt);
  }

  /** ⌥↑/⌥↓ on a card: moves it one step in the list it is shown in, when
   * that list is its place and the place keeps an order (Bookmarks lists
   * cards from several places, and Archive keeps archive time). The card
   * keeps focus and the new position is announced. */
  function moveFocusedCard(control: HTMLElement, step: -1 | 1) {
    const card = control.closest<HTMLElement>(".research-feed-card");
    const cardId = card?.dataset.researchCard;
    const place = card?.dataset.researchPlace;
    const zonePlace = card?.closest<HTMLElement>("[data-research-drop]")?.dataset.researchDrop;
    if (!card || !cardId || !place || place !== zonePlace || !researchPlaceIsReorderable(place)) {
      return;
    }
    const kind = card.dataset.researchCardKind === "draft" ? "draft" : "tree";
    const ids =
      kind === "draft"
        ? drafts.map((draft) => draft.id)
        : place === RESEARCH_UNFILED_FOLDER_ID
          ? rows.flatMap((row) => (row.tree ? [row.treeId] : []))
          : treesIn(place).map((tree) => tree.id);
    const target = stepReorderTarget(ids, cardId, step);
    if (!target) {
      announce(step < 0 ? "Already first." : "Already last.");
      return;
    }
    if (kind === "draft") onReorderDraft?.(cardId, target.beforeId);
    else onReorderTree?.(cardId, place, target);
    const index = ids.indexOf(cardId) + step;
    announce(`Moved to position ${index + 1} of ${ids.length}.`);
    keepCardFocus(cardId);
  }

  const listEmpty = rows.length === 0;
  // The first-run text (or setup guide) shows only while nothing exists yet:
  // no questions anywhere and no drafts.
  const homeHasNothing =
    view.kind === "home" &&
    items.length === 0 &&
    drafts.length === 0 &&
    researchTrees.length === 0;

  // The feed's ask box starts Home. In Bookmarks and a folder it ends the
  // list, and "+ Ask" in the header brings it into view.
  const composerBlock = composer ? <div className="research-feed-composer">{composer}</div> : null;
  const askButton = composer ? (
    <button
      type="button"
      className="control-button research-head-button"
      aria-label="Go to the ask box"
      onClick={() => {
        const box = rootRef.current?.querySelector<HTMLElement>(".research-feed-composer");
        box?.scrollIntoView({ block: "nearest" });
        box?.querySelector<HTMLElement>("textarea, input")?.focus({ preventScroll: true });
      }}
    >
      <Plus size={13} aria-hidden="true" />
      Ask
    </button>
  ) : null;
  const headerActions =
    userFolder ? (
      <>
        <button
          type="button"
          className="research-feed-icon-button"
          title="Rename folder"
          aria-label="Rename folder"
          onClick={(event) => onRenameFolder?.(userFolder.id, event.currentTarget)}
        >
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button
          ref={deleteFolderButtonRef}
          type="button"
          className="research-feed-icon-button"
          title="Delete folder"
          aria-label="Delete folder"
          onClick={() => onRequestDeleteFolder?.(userFolder.id)}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
        {askButton}
      </>
    ) : view.kind === "home" || view.kind === "bookmarks" ? (
      <>
        {onRefresh ? (
          <button
            type="button"
            className="research-feed-icon-button research-header-icon"
            onClick={onRefresh}
            aria-label={`Refresh ${viewTitle}`}
          >
            <RotateCw size={14} aria-hidden="true" />
            <span className="research-header-tooltip" aria-hidden="true">
              Refresh {viewTitle}
            </span>
          </button>
        ) : null}
        {view.kind === "home" && onImportReport ? (
          <ResearchReportImport dropTarget={scrollRef} onImport={onImportReport} onError={onError} />
        ) : null}
        {view.kind === "home" ? null : askButton}
      </>
    ) : askButton;

  return (
    <div ref={rootRef} className="research-feed">
      <ResearchFeedHeader
        title={viewTitle}
        titleRef={titleRef}
        onBack={soloPlace ? () => onOpenView?.({ kind: "home" }) : undefined}
        actions={headerActions}
        home={view.kind === "home"}
      />
      {userFolder && pendingDeleteFolderId === userFolder.id ? (
        <ResearchFolderDeleteConfirm
          name={userFolder.name}
          count={
            researchTrees.filter((tree) => folderState?.membership[tree.id] === userFolder.id)
              .length
          }
          onConfirm={() => {
            focusTitleOnViewChangeRef.current = true;
            onConfirmDeleteFolder?.(userFolder.id);
          }}
          onCancel={() => {
            onCancelDeleteFolder?.();
            deleteFolderButtonRef.current?.focus();
          }}
        />
      ) : null}
      <div
        ref={scrollRef}
        className="research-feed-scroll"
        data-research-scroll
        onFocus={(event) => {
          const target = event.target as HTMLElement;
          if (!target.matches(FEED_ROW_SELECTOR)) return;
          rovingRowRef.current = target;
          applyFeedRoving(event.currentTarget, target);
        }}
        // The child row a click (or Enter) opened is the row ⌃Tab steps from
        // while its thread is open; WebKit does not focus a clicked button.
        onClickCapture={(event) => {
          const target = event.target as HTMLElement;
          const child = target.closest<HTMLElement>(".research-feed-child-open");
          const cardId = child?.closest<HTMLElement>("[data-research-child-of]")?.dataset.researchChildOf;
          if (child && cardId && child.dataset.nodeId) {
            openedChildRef.current = { cardId, nodeId: child.dataset.nodeId };
          } else if (target.closest(".research-feed-card-hit")) {
            openedChildRef.current = null;
          }
        }}
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          // → and Enter open the focused question (or child row) and move
          // into its messages column.
          if (
            (event.key === "ArrowRight" || event.key === "Enter") &&
            !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
            target.matches(".research-feed-card-hit, .research-feed-child-open")
          ) {
            event.preventDefault();
            target.click();
            columns?.focusOpenedThread(target.matches(".research-feed-child-open"));
            return;
          }
          // ⌥↑ and ⌥↓ move the focused card up or down its list.
          if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey &&
            target.matches(".research-feed-card-hit")
          ) {
            event.preventDefault();
            moveFocusedCard(target, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          // ↑ and ↓ move between the rows, child rows included.
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          if (!target.matches(FEED_ROW_SELECTOR)) return;
          const all = [...event.currentTarget.querySelectorAll<HTMLElement>(FEED_ROW_SELECTOR)];
          const next = all[all.indexOf(target as HTMLElement) + (event.key === "ArrowDown" ? 1 : -1)];
          if (!next) return;
          event.preventDefault();
          next.focus();
          next.scrollIntoView({ block: "nearest" });
        }}
      >
        <div className="research-feed-column-body research-reading-surface">
          {view.kind === "home" ? composerBlock : null}
          {newActivityCount > 0 && listed ? (
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
          {listed ? (
            <section
              className="research-feed-list"
              aria-label={view.kind === "home" ? "Unfiled" : "Bookmarks"}
              data-research-drop={view.kind === "home" ? RESEARCH_UNFILED_FOLDER_ID : undefined}
            >
              <div
                className="research-feed-rows"
                role="feed"
                aria-label={view.kind === "home" ? "Recent activity" : "Bookmarked research"}
              >
                <div
                  ref={virtualCanvasRef}
                  className="recent-activity-virtual-canvas"
                  style={{ height: metrics.totalSize }}
                >
                  {visibleRowEntries.map(({ row, index }) => {
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
                          className="research-feed-unit"
                          role="article"
                          aria-posinset={row.position}
                          aria-setsize={rows.length}
                        >
                          {renderTreeCard(row.tree, row.query, { virtual: true })}
                        </div>
                      </MeasuredActivityRow>
                    );
                  })}
                </div>
                {archivedBookmarks.map((tree) => (
                  <div key={tree.id} className="research-feed-unit">
                    {renderTreeCard(tree, undefined)}
                  </div>
                ))}
                {listEmpty && archivedBookmarks.length === 0 ? (
                  view.kind === "bookmarks" ? (
                    <div className="research-feed-empty">
                      No bookmarks. Choose Bookmark in a question's … menu to keep it here.
                    </div>
                  ) : homeHasNothing && setupGuide ? (
                    <div className="feed-setup-guide">{setupGuide}</div>
                  ) : homeHasNothing ? (
                    <div className="research-feed-empty">
                      Research, posts, and saved links appear here. New ones start at the top.
                    </div>
                  ) : (
                    <div className="research-feed-empty">
                      {researchPlaceEmptyText(RESEARCH_UNFILED_FOLDER_ID)}
                    </div>
                  )
                ) : null}
                {rootLoadError ? (
                  <div className="recent-activity-load-boundary">
                    <p className="recent-activity-load-error" role="alert">
                      Couldn’t load some questions. {rootLoadError}
                    </p>
                    <button
                      className="control-button recent-activity-load-older"
                      type="button"
                      onClick={() => setRootLoadAttempt((attempt) => attempt + 1)}
                    >
                      <RotateCw size={13} aria-hidden="true" />
                      <span>Retry</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          {listed && view.kind !== "home" ? composerBlock : null}
          {view.kind === "home"
            ? trayPlaces.map((place) => (
                <ResearchFeedTray
                  key={place}
                  place={place}
                  name={researchPlaceName(place, folders)}
                  count={placeCount(place)}
                  collapsed={collapsed.has(place)}
                  onToggle={() => onToggleTray?.(place)}
                  onOpen={() =>
                    onOpenView?.(
                      place === RESEARCH_DRAFTS_FOLDER_ID
                        ? { kind: "drafts" }
                        : place === RESEARCH_ARCHIVE_FOLDER_ID
                          ? { kind: "archive" }
                          : { kind: "folder", folderId: place },
                    )
                  }
                >
                  {renderPlaceCards(place)}
                </ResearchFeedTray>
              ))
            : null}
          {soloPlace ? (
            <section
              className="research-feed-solo"
              aria-label={viewTitle}
              data-research-drop={soloPlace}
            >
              {renderPlaceCards(soloPlace)}
            </section>
          ) : null}
          {soloPlace ? composerBlock : null}
        </div>
      </div>
      <ResearchFeedScrollThumb scrollRef={scrollRef} />
      <div className="research-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {menu?.kind === "tree" && menuTree ? (
        <ResearchFeedRowMenu
          anchor={menu.placement?.anchor ?? menu.anchor}
          align={menu.placement?.align}
          label={menu.child ? "Starred item actions" : `Actions for ${menuTree.title}`}
          onRemoveStar={
            menu.child && onUnstarChild
              ? () => {
                  const child = menu.child!;
                  closeMenu();
                  onUnstarChild(child);
                }
              : undefined
          }
          currentPlace={placeOf(menuTree)}
          folders={folders}
          bookmarked={Boolean(menuTree.bookmarked)}
          onToggleBookmark={() => {
            closeMenu(true);
            onSetResearchBookmarked(menuTree.id, !menuTree.bookmarked);
          }}
          followed={Boolean(menuTree.followed)}
          followDisabledReason={menuTree.archivedAt ? "Archived questions don't send notifications" : null}
          onToggleFollow={
            onSetResearchFollowed
              ? () => {
                  closeMenu(true);
                  onSetResearchFollowed(menuTree.id, !menuTree.followed);
                }
              : undefined
          }
          onMove={
            onMoveTree
              ? (place) => {
                  refocusCardRef.current = { cardId: menuTree.id, anchor: menu.anchor };
                  closeMenu(true);
                  onMoveTree(menuTree.id, place);
                }
              : undefined
          }
          onNewFolder={
            onMoveTree
              ? () => {
                  const trigger = menu.anchor;
                  closeMenu();
                  onNewFolder?.(menuTree.id, trigger);
                }
              : undefined
          }
          onClose={() => closeMenu()}
        >
          {menu.child ? null : (
            <ResearchTreeLifecycleItems
              tree={menuTree}
              archived={menuTree.archivedAt != null}
              onClose={() => closeMenu()}
              onRename={(tree) => setRenamingTree(tree)}
              onRestore={(treeId) => void onRestoreResearch(treeId)}
              onDelete={(tree) => setDeletingTree(tree)}
              onRegenerateRecap={
                menuQuery &&
                menuTree.archivedAt == null &&
                menuQuery.status === "complete" &&
                menuQuery.recap?.trim()
                  ? () => openRecapDialog(menuQuery.nodeId)
                  : undefined
              }
            />
          )}
        </ResearchFeedRowMenu>
      ) : null}
      {menu?.kind === "draft" && menuDraft ? (
        <ResearchMenu
          anchor={menu.placement?.anchor ?? menu.anchor}
          align={menu.placement?.align}
          label="Draft actions"
          width={180}
          onClose={() => closeMenu()}
        >
          <ResearchMenuItem
            icon={<FilePen size={15} aria-hidden="true" />}
            label="Open"
            onSelect={() => {
              closeMenu();
              onOpenDraft?.(menuDraft);
            }}
          />
          <ResearchMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            label="Delete"
            onSelect={() => {
              closeMenu();
              onDeleteDraft?.(menuDraft);
            }}
          />
        </ResearchMenu>
      ) : null}
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
    </div>
  );
}

export default memo(ResearchActivityFeed);
