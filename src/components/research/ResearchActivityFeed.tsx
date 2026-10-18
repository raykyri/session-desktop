import { collapseBlankLines, feedTextRuns, splitNoteHeading } from "@session/shared/lib/feedLinkText";
import ResearchReportImport from "./ResearchReportImport";
import { nodeType } from "@session/shared/lib/researchNodeTypes";
import { researchNoteEditable } from "@session/shared/lib/researchNoteEdit";
import {
  Fragment,
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
import {
  ChevronDown,
  ChevronRight,
  FilePen,
  IndentDecrease,
  IndentIncrease,
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-react";
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
  RESEARCH_TRASH_FOLDER_ID,
  RESEARCH_UNFILED_FOLDER_ID,
  researchCardTitle,
  researchPlaceIsReorderable,
  researchPlaceName,
  researchTreePlace,
  stepReorderTarget,
  type ResearchDropPosition,
} from "@session/shared/lib/researchFolders";
import { researchThreadKind, researchThreadState } from "@session/shared/lib/researchRowGlyph";
import {
  researchChildCount,
  researchGroupSummary,
  researchItemCount,
  researchNestCandidates,
  researchTreeGroups,
  researchTreeHoldsChildren,
} from "@session/shared/lib/researchGroups";
import ResearchRowGlyph from "./ResearchRowGlyph";
import {
  feedCycleStep,
  type ResearchCycleRequest,
} from "@session/shared/lib/researchSiblingCycle";
import { researchFeedPageKey, type ResearchFeedView } from "@session/shared/lib/sidebarMode";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import ResearchArchivedFeed, { archivedFeedTrees } from "./ResearchArchivedFeed";
import { ResearchColumnsContext } from "./ResearchColumns";
import { ResearchFeedHeader, ResearchFeedScrollThumb } from "./ResearchFeedChrome";
import ResearchFeedCard, {
  ResearchGroupCount,
  researchCardRefocus,
  researchFeedCardControl,
} from "./ResearchFeedCard";
import ResearchFeedTray, { researchPlaceEmptyText } from "./ResearchFeedTray";
import { ResearchDeleteDialog } from "./ResearchDeleteDialog";
import { ResearchFolderDeleteDialog } from "./ResearchFolderDialogs";
import ResearchTrashList from "./ResearchTrashList";
import { researchTrashCount, type ResearchTrashEntry } from "@session/shared/lib/researchTrash";
import { ResearchMenu, ResearchMenuItem, ResearchMenuTitle } from "./ResearchMenu";
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
const EMPTY_PARENTS: Readonly<Record<string, string>> = {};
const EMPTY_GROUP_IDS: ReadonlySet<string> = new Set();
const EMPTY_TRASH: ResearchTrashEntry[] = [];
/** The feed's rows: the open buttons of its cards. */
const FEED_ROW_SELECTOR = ".research-feed-card-hit";

/** What a key does on a focused feed row.
 * "select": Enter selects the row's node, as a click does, and focus stays
 * on the row. "enter-thread": → selects it and moves focus into the opened
 * thread's messages column. Null for other keys and for modified keys. */
export function feedRowOpenKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "select" | "enter-thread" | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === "Enter") return "select";
  if (event.key === "ArrowRight") return "enter-thread";
  return null;
}

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
  for (const menu of root.querySelectorAll<HTMLElement>(
    ".research-feed-card-menu, .research-feed-group-toggle",
  )) {
    menu.tabIndex = menu.closest(".research-feed-card")?.classList.contains("is-selected")
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
   * (`onLoadTrees`). Home lists trees in the tree order; a card whose root
   * is not loaded shows its title until it is. */
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
  /** Edits a note card's note, on a double-click of its card. */
  onEditNote?: (treeId: string, nodeId: string) => void;
  onOpenView?: (view: ResearchFeedView) => void;
  onResearchRecapApplied: (node: ResearchNode) => void;
  onError: (message: string) => void;
  onRenameResearch: (treeId: string, title: string) => Promise<void>;
  onRestoreResearch: (treeId: string) => Promise<void>;
  /** Moves a thread to the Trash (Delete's default). */
  onTrashResearch: (treeId: string) => Promise<void>;
  /** Deletes a thread permanently (Delete now). */
  onRemoveResearch: (treeId: string) => Promise<void>;
  /** The scoped workspace's Trash, most recently trashed first. */
  trashEntries?: ResearchTrashEntry[];
  onRestoreTrashEntry?: (entry: ResearchTrashEntry) => void;
  /** Deletes a Trash entry permanently; rejects to keep its dialog open. */
  onDeleteTrashEntry?: (entry: ResearchTrashEntry) => Promise<void>;
  onEmptyTrash?: () => Promise<void>;
  onMoveTree?: (treeId: string, place: string) => void;
  /** Moves a card within its place (⌥↑ and ⌥↓). */
  onReorderTree?: (treeId: string, place: string, position: ResearchDropPosition) => void;
  onReorderDraft?: (draftId: string, beforeId: string | null) => void;
  /** The children archived, moved to the Trash or deleted with a tree, for
   * its confirmations. */
  groupChildren?: (treeId: string) => ResearchTreeSummary[];
  /** Lists a tree under a question, document or post (Make child of…, ⌥→, and
   * ⌥↑/⌥↓ within a group), before `beforeId` or at the end for null. */
  onNestTree?: (treeId: string, parentId: string, beforeId: string | null) => void;
  /** Move out (⌥←): lists a child on its own after its former group. */
  onMoveOutOfGroup?: (treeId: string) => Promise<boolean>;
  onSetGroupsCollapsed?: (parentIds: readonly string[], collapsed: boolean) => void;
  /** New folder…; with a tree id the tree moves into the new folder. Focus
   * returns to `trigger` when the dialog closes. */
  onNewFolder?: (moveTreeId?: string, trigger?: HTMLElement) => void;
  onRenameFolder?: (folderId: string, trigger?: HTMLElement) => void;
  onRequestDeleteFolder?: (folderId: string) => void;
  /** The folder whose delete confirmation is open, over its folder view. */
  pendingDeleteFolderId?: string | null;
  /** Moves the folder to the Trash. */
  onConfirmDeleteFolder?: (folderId: string) => void;
  /** Deletes the folder now; its questions move to Unfiled. */
  onDeleteFolderNow?: (folderId: string) => void;
  onCancelDeleteFolder?: () => void;
  onToggleTray?: (place: string) => void;
  onDeleteDraft?: (draft: ResearchDraft) => void;
  onDragStart?: ResearchCardDragStart;
  onRefresh?: () => void;
  /** The thread open in the content column beside the feed. */
  selectedTreeId?: string | null;
  /** The draft open in the content column. */
  selectedDraftId?: string | null;
  onBack?: () => void;
  onForward?: () => void;
}

/** A child card under a top-level card. */
interface ResearchFeedRowChild {
  tree: ResearchTreeSummary;
  query?: RecentResearchQuery;
}

/** A card of Home's virtualized list: a top-level tree, and its root when
 * loaded, with the children listed under it. `treeId` keys the row. */
interface ResearchFeedRow {
  key: string;
  treeId: string;
  tree?: ResearchTreeSummary;
  query?: RecentResearchQuery;
  children: ResearchFeedRowChild[];
  /** Its children are hidden. */
  collapsed: boolean;
  /** 1-based, for aria-posinset. */
  position: number;
}

/** Build Home's rows: Unfiled trees in tree order, after newly loaded roots
 * without a corresponding tree in newest-first order. A child (`parents`)
 * is listed under its parent's row when the parent is listed. */
export function researchFeedRows(
  roots: ReadonlyMap<string, RecentResearchQuery>,
  trees: readonly ResearchTreeSummary[],
  placeOf: (tree: ResearchTreeSummary) => string,
  parents: Readonly<Record<string, string>> = EMPTY_PARENTS,
  collapsedGroups: ReadonlySet<string> = EMPTY_GROUP_IDS,
): ResearchFeedRow[] {
  const known = new Set(trees.map((tree) => tree.id));
  const unknown = [...roots.values()]
    .filter((query) => !known.has(query.treeId))
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((query) => ({ treeId: query.treeId, query, tree: undefined, children: [] }));
  const listed = researchTreeGroups(
    trees.filter((tree) => tree.archivedAt == null && placeOf(tree) === RESEARCH_UNFILED_FOLDER_ID),
    parents,
  ).map((group) => ({
    treeId: group.tree.id,
    tree: group.tree,
    query: roots.get(group.tree.id),
    children: group.children.map((child) => ({ tree: child, query: roots.get(child.id) })),
  }));
  return [...unknown, ...listed].map((row, index) => ({
    key: `tree:${row.treeId}`,
    ...row,
    collapsed: collapsedGroups.has(row.treeId),
    position: index + 1,
  }));
}

function estimatedActivityRowHeight(row: ResearchFeedRow): number {
  if (row.children.length === 0) return 92;
  return 116 + (row.collapsed ? 0 : row.children.length * 80);
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
    case "drafts":
      return "Drafts";
    case "archive":
      return "Archive";
    case "trash":
      return "Trash";
    case "folder":
      return researchPlaceName(view.folderId, folders);
  }
}

/** An open feed menu. `anchor` is the … button that opened a row's menu, or
 * for a context menu (`placement` set) the row's open button; `placement`
 * places a context menu, which returns focus to what had it on its own. A
 * tree's menu is a card's (`queryNodeId` names its loaded root, for
 * Generate recap). */
type FeedMenu =
  | {
      kind: "tree";
      treeId: string;
      anchor: HTMLElement;
      placement?: ResearchUnitMenuPlacement;
      queryNodeId?: string;
      /** Make child of…: the menu lists the parents to choose from. */
      mode?: "nest";
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
  onEditNote,
  onOpenView,
  onResearchRecapApplied,
  onError,
  onRenameResearch,
  onRestoreResearch,
  onTrashResearch,
  onRemoveResearch,
  trashEntries = EMPTY_TRASH,
  onRestoreTrashEntry,
  onDeleteTrashEntry,
  onEmptyTrash,
  onMoveTree,
  onReorderTree,
  onReorderDraft,
  groupChildren,
  onNestTree,
  onMoveOutOfGroup,
  onSetGroupsCollapsed,
  onNewFolder,
  onRenameFolder,
  onRequestDeleteFolder,
  pendingDeleteFolderId = null,
  onConfirmDeleteFolder,
  onDeleteFolderNow,
  onCancelDeleteFolder,
  onToggleTray,
  onDeleteDraft,
  onDragStart,
  onRefresh,
  selectedTreeId = null,
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
  // Home's Trash tray starts collapsed; opening it is not saved.
  const [trashTrayOpen, setTrashTrayOpen] = useState(false);
  const [deletingTrashEntry, setDeletingTrashEntry] = useState<ResearchTrashEntry | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const trashTriggerRef = useRef<HTMLElement | null>(null);
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
  /** Whether a tree can be a parent: a question, a document or a post. */
  const treeHoldsChildren = (treeId: string) => researchTreeHoldsChildren(treeById.get(treeId)?.type);
  const placeOf = useCallback(
    (tree: ResearchTreeSummary | undefined) =>
      tree && folderState ? researchTreePlace(tree, folderState) : RESEARCH_UNFILED_FOLDER_ID,
    [folderState],
  );
  const parents = folderState?.parents ?? EMPTY_PARENTS;
  const collapsedGroupList = folderState?.collapsedGroups;
  const collapsedGroups = useMemo(
    () => (collapsedGroupList ? new Set(collapsedGroupList) : EMPTY_GROUP_IDS),
    [collapsedGroupList],
  );

  // The virtualized list: Unfiled on Home, in the tree order.
  const listed = view.kind === "home";
  const activeTrees = useMemo(
    () => researchTrees.filter((tree) => tree.archivedAt == null),
    [researchTrees],
  );
  const rows = useMemo(
    () =>
      view.kind === "home"
        ? researchFeedRows(queryByTree, activeTrees, placeOf, parents, collapsedGroups)
        : [],
    [activeTrees, collapsedGroups, parents, placeOf, queryByTree, view.kind],
  );
  const viewTitle = feedViewTitle(view, folders);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const measurementFrameRef = useRef(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 800 });
  // Avoid a second render when the anchor effect reports unchanged geometry.
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

  // A narrow thread view hides the feed with display: none. Preserve its
  // previous row because hidden scrollers report zero dimensions.
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
  // above it or a measured row replaces its estimate.
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

  // Load missing roots for cards in or near the viewport once per render.
  // Keep ids pending until they load; Retry clears failed ids for another request.
  const requestedRootsRef = useRef(new Set<string>());
  const [rootLoadError, setRootLoadError] = useState<string | null>(null);
  const [rootLoadAttempt, setRootLoadAttempt] = useState(0);
  const missingRootIds = visibleRowEntries.flatMap(({ row }) => [
    ...(row.tree && !row.query ? [row.treeId] : []),
    ...(row.collapsed
      ? []
      : row.children.filter((child) => !child.query).map((child) => child.tree.id)),
  ]);
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
  // Escape returns focus itself; an action that leaves the card open
  // (Move to) returns focus to the … button.
  const closeMenu = useCallback((restoreFocus = false) => {
    const current = menuStateRef.current;
    setMenu(null);
    if (restoreFocus && current && !current.placement) {
      current.anchor.focus({ preventScroll: true });
    }
  }, []);

  // Preserve focus and visibility after an ⌥↑/⌥↓ reorder unless focus moved
  // elsewhere while the folder update completed.
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
    // subsequent manual scrolling is not undone.
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

  // Cancelling the delete confirmation returns focus to the control that
  // opened it, else the header's Delete folder button; deleting returns to
  // Home with its title focused.
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const deleteFolderButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusTitleOnViewChangeRef = useRef(false);

  function openRecapDialog(nodeId: string) {
    void getResearchNodeContent(nodeId)
      .then((content) => setRecapDialogContent(content))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  }

  // The row whose … button opened the open menu (aria-expanded).
  const menuTreeId = menu?.kind === "tree" && !menu.placement ? menu.treeId : null;
  // A second click on the … button that opened a menu closes it.
  const openTreeMenu = (
    treeId: string,
    anchor: HTMLElement,
    { queryNodeId }: { queryNodeId?: string } = {},
  ) =>
    setMenu((current) =>
      current?.kind === "tree" && current.anchor === anchor && !current.placement
        ? null
        : { kind: "tree", treeId, anchor, queryNodeId },
    );
  // The right-click, Shift+F10 and ContextMenu key open the … menu at
  // `placement`; `control` is the row's open button.
  const openTreeContextMenu = (
    treeId: string,
    placement: ResearchUnitMenuPlacement,
    control: HTMLElement,
    { queryNodeId }: { queryNodeId?: string } = {},
  ) => setMenu({ kind: "tree", treeId, anchor: control, placement, queryNodeId });
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
   * `virtual`: a card of the virtualized list. A parent card lists
   * `children` after it unless its group is collapsed; a child card names
   * its parent (`parentName`). */
  function renderTreeCard(
    tree: ResearchTreeSummary | undefined,
    query: RecentResearchQuery | undefined,
    {
      virtual = false,
      parentId,
      parentName,
      children = [],
    }: {
      virtual?: boolean;
      parentId?: string;
      parentName?: string;
      children?: readonly ResearchFeedRowChild[];
    } = {},
  ) {
    const treeId = tree?.id ?? query?.treeId ?? "";
    const isPost = query ? nodeType(query) === "post" : false;
    const question = query?.prompt ?? tree?.title ?? "";
    const title = isPost ? null : researchCardTitle(tree?.title ?? query?.title, question);
    const awaitingTitle = !isPost && !(tree?.title ?? query?.title)?.trim();
    const selected = treeId === selectedTreeId;
    const state = researchThreadState(tree, query);
    // A group names its children after the title. A separate title carries
    // the count; otherwise it follows the note heading, preview, or question.
    const childCount = children.length;
    const count = title == null && childCount > 0 ? <ResearchGroupCount count={childCount} /> : null;
    // The card shows the question as plain text, URLs in the link color; its
    // Markdown renders in the conversation. Link cards still show; a tweet
    // shows as a "[Tweet: @handle]" label, its embed only in the conversation.
    // A note, and a question still waiting for its title, show at most four
    // lines in the muted color, with blank lines removed. A note whose first
    // line is a Markdown heading shows that line in the card title's style.
    const plainPrompt = (asQuestion: (content: ReactNode) => ReactNode) => () => {
      const text = query ? visibleResearchPrompt(query.prompt, query.attachments).trim() : question;
      if (!isPost && !awaitingTitle) {
        return asQuestion(
          <>
            {feedText(text)}
            {count}
          </>,
        );
      }
      const { heading, rest } = isPost ? splitNoteHeading(text) : { heading: null, rest: text };
      const preview = collapseBlankLines(rest).trim();
      return asQuestion(
        <>
          {heading ? (
            <span className="research-feed-card-title research-feed-note-heading">
              {heading}
              {count}
            </span>
          ) : null}
          {preview ? (
            <span className={`research-feed-preview-text${heading ? " is-after-heading" : ""}`}>
              {feedText(preview)}
              {heading ? null : count}
            </span>
          ) : heading ? null : count}
        </>,
      );
    };
    const name = title ?? question;
    const groupCollapsed = collapsedGroups.has(treeId);
    const group =
      children.length > 0
        ? {
            count: children.length,
            collapsed: groupCollapsed,
            summary: researchGroupSummary(
              children.map((child) => ({
                state: researchThreadState(child.tree, child.query),
                unread: child.tree.hasUnseenUpdate,
              })),
            ),
            label: `${groupCollapsed ? "Show" : "Hide"} ${researchItemCount(children.length)} under “${shortName(name)}”`,
            onToggle: (all: boolean) => toggleGroup(treeId, name, all),
          }
        : undefined;
    const nested =
      children.length > 0 && !groupCollapsed
        ? children.map((child) => (
            <Fragment key={child.tree.id}>
              {renderTreeCard(child.tree, child.query, {
                virtual,
                parentId: treeId,
                parentName: name,
              })}
            </Fragment>
          ))
        : undefined;
    const cardLabel = title ? `${title}. ${question}` : question;
    return (
      <ResearchFeedCard
        cardId={treeId}
        place={placeOf(tree)}
        title={title}
        label={parentName ? `${cardLabel}, in “${shortName(parentName)}”` : cardLabel}
        holdsChildren={
          !parentId && tree !== undefined && tree.archivedAt == null && treeHoldsChildren(tree.id)
        }
        parentId={parentId}
        group={group}
        nested={nested}
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
                  tweetLabels
                  suffix={count}
                />
              ) : (
                <ResearchMessageBody
                  prompt={query.prompt}
                  attachments={query.attachments}
                  variant="compact"
                  renderPrompt={plainPrompt(asQuestion)}
                  tweetLabels
                />
              )}
            </ResearchUserMessage>
          ) : (
            asQuestion(
              <>
                {feedText(question)}
                {count}
              </>,
            )
          )
        }
        kind={researchThreadKind(tree, query)}
        state={state}
        statusLabel={
          state === "failed" && tree?.hasUnseenFailure ? "Failed since last viewed" : undefined
        }
        selected={selected}
        // Unread shows on an answered card only (researchRowGlyph).
        unread={Boolean(tree?.hasUnseenUpdate) && !selected}
        menuOpen={menuTreeId === treeId}
        onOpen={() => openTreeCard(tree, query)}
        // A double-click on a note's card edits the note, unless the thread is
        // archived (researchNoteEditable).
        onEdit={
          onEditNote && tree && query && researchNoteEditable(query, tree.archivedAt != null)
            ? () => onEditNote(tree.id, query.nodeId)
            : undefined
        }
        // The … button and the context menu open the same menu.
        onMenu={tree ? (anchor) => openTreeMenu(tree.id, anchor, { queryNodeId: query?.nodeId }) : undefined}
        onContextMenu={
          tree
            ? (placement, control) =>
                openTreeContextMenu(tree.id, placement, control, { queryNodeId: query?.nodeId })
            : undefined
        }
        onDragStart={tree ? onDragStart : undefined}
        virtual={virtual}
      />
    );
  }

  /** Collapses or expands a group; with `all` (Alt+click), every group. */
  function toggleGroup(parentId: string, name: string, all: boolean) {
    const collapse = !collapsedGroups.has(parentId);
    const ids = all ? [...new Set(Object.values(parents))] : [parentId];
    onSetGroupsCollapsed?.(ids, collapse);
    announce(
      all
        ? collapse
          ? "Collapsed every group."
          : "Expanded every group."
        : `${collapse ? "Collapsed" : "Expanded"} “${shortName(name)}”.`,
    );
  }

  /** A place's trees as top-level items with their children (Archive: one
   * flat list). */
  function groupsIn(place: string) {
    return researchTreeGroups(treesIn(place), parents);
  }

  /** The top-level tree ids of the list a card is in. */
  function topLevelIdsIn(place: string): string[] {
    return place === RESEARCH_UNFILED_FOLDER_ID
      ? rows.flatMap((row) => (row.tree ? [row.treeId] : []))
      : groupsIn(place).map((group) => group.tree.id);
  }

  /** The parent a tree is listed under, or null when it is listed on its
   * own. */
  function listedParentOf(tree: ResearchTreeSummary): ResearchTreeSummary | null {
    const parent = treeById.get(parents[tree.id] ?? "");
    return parent &&
      parent.archivedAt == null &&
      parents[parent.id] === undefined &&
      placeOf(parent) === placeOf(tree)
      ? parent
      : null;
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
        kind="draft"
        renderBody={(asQuestion) => asQuestion(feedText(draft.prompt.trim()))}
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
    if (place === RESEARCH_TRASH_FOLDER_ID) return trashEntries.length;
    return treesIn(place).length + (place === RESEARCH_DRAFTS_FOLDER_ID ? drafts.length : 0);
  }

  function renderPlaceCards(place: string) {
    if (place === RESEARCH_TRASH_FOLDER_ID) {
      return (
        <ResearchTrashList
          entries={trashEntries}
          onRestore={(entry) => onRestoreTrashEntry?.(entry)}
          onDeleteNow={(entry, trigger) => {
            trashTriggerRef.current = trigger;
            setDeletingTrashEntry(entry);
          }}
        />
      );
    }
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
        {researchTreeGroups(trees, parents).map(({ tree, children }) => (
          <div key={tree.id} className="research-feed-unit">
            {renderTreeCard(tree, queryByTree.get(tree.id), {
              children: children.map((child) => ({ tree: child, query: queryByTree.get(child.id) })),
            })}
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
        : view.kind === "trash"
          ? RESEARCH_TRASH_FOLDER_ID
          : view.kind === "folder"
            ? view.folderId
            : null;
  const userFolder =
    view.kind === "folder" ? (folders.find((folder) => folder.id === view.folderId) ?? null) : null;

  // ⌃Tab / ⌃⇧Tab with the feed as the column last interacted with (see
  // ResearchColumns): opens the next or previous card of the list that holds
  // the current card, as clicking it would. The lists are Home's recent
  // activity and each open tray, or the view's own cards; an expanded
  // group's children follow their parent. The current card is the focused
  // one, else the open one.
  const cycleFeedRef = useRef<(request: ResearchCycleRequest) => boolean>(() => false);
  cycleFeedRef.current = (request) => {
    interface FeedRowEntry {
      key: string;
      cardId: string;
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
      return {
        key: `tree:${cardId}`,
        cardId,
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
            virtualIndex: null,
            open: () => onOpenDraft?.(draft),
          }),
        ),
        ...groupsIn(place).flatMap(({ tree, children }) => [
          treeEntry(tree, queryByTree.get(tree.id)),
          ...(collapsedGroups.has(tree.id)
            ? []
            : children.map((child) => treeEntry(child, queryByTree.get(child.id)))),
        ]),
      ];
    };
    const lists: FeedRowEntry[][] = [];
    if (listed) {
      lists.push(
        rows.flatMap((row, index) => [
          treeEntry(row.tree, row.query, index),
          ...(row.collapsed
            ? []
            : row.children.map((child) => treeEntry(child.tree, child.query, index))),
        ]),
      );
    }
    if (view.kind === "home") {
      for (const place of trayPlaces) {
        if (!collapsed.has(place)) lists.push(placeEntries(place));
      }
    }
    if (soloPlace) lists.push(placeEntries(soloPlace));

    const step = feedCycleStep(
      lists.map((entries) => entries.map((entry) => entry.key)),
      currentFeedCard(),
      request.direction,
    );
    const entry = step ? lists.flat().find((candidate) => candidate.key === step) : undefined;
    if (!entry) return true;
    entry.open();
    revealFeedRow(entry.cardId, entry.virtualIndex, request.keepFocus);
    return true;
  };
  useEffect(() => columns?.registerCycle("feed", (request) => cycleFeedRef.current(request)), [columns]);

  /** The key of the feed card ⌃Tab steps from (see cycleFeedRef). */
  function currentFeedCard(): string | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && scrollRef.current?.contains(active)) {
      const card = active.matches(".research-feed-card-hit")
        ? active.closest<HTMLElement>(".research-feed-card")
        : null;
      if (card?.dataset.researchCard) {
        return `${card.dataset.researchCardKind ?? "tree"}:${card.dataset.researchCard}`;
      }
    }
    if (selectedDraftId) return `draft:${selectedDraftId}`;
    return selectedTreeId ? `tree:${selectedTreeId}` : null;
  }

  /** Scrolls a card into view, rendering it first when it is in a
   * virtualized row outside the rendered range, and focuses it unless focus
   * stays in a text field. */
  function revealFeedRow(cardId: string, virtualIndex: number | null, keepFocus: boolean) {
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
    const selector = `.research-feed-card[data-research-card="${CSS.escape(cardId)}"] .research-feed-card-hit`;
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
   * that list is its place and the place keeps an order (Archive keeps
   * archive time). The card
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
    const parentId = card.dataset.researchParent;
    const ids =
      kind === "draft"
        ? drafts.map((draft) => draft.id)
        : parentId
          ? [
              ...(card.parentElement?.querySelectorAll<HTMLElement>(
                ":scope > .research-feed-card[data-research-parent]",
              ) ?? []),
            ].flatMap((sibling) => sibling.dataset.researchCard ?? [])
          : topLevelIdsIn(place);
    const target = stepReorderTarget(ids, cardId, step);
    if (!target) {
      announce(step < 0 ? "Already first." : "Already last.");
      return;
    }
    if (kind === "draft") onReorderDraft?.(cardId, target.beforeId);
    else if (parentId) onNestTree?.(cardId, parentId, target.beforeId);
    else onReorderTree?.(cardId, place, target);
    const index = ids.indexOf(cardId) + step;
    announce(`Moved to position ${index + 1} of ${ids.length}.`);
    keepCardFocus(cardId);
  }

  /** The card a control is in, when it is listed in its own place and the
   * place keeps an order (not Archive). */
  function focusedTreeCard(control: HTMLElement) {
    const card = control.closest<HTMLElement>(".research-feed-card");
    const tree = treeById.get(card?.dataset.researchCard ?? "");
    const place = card?.dataset.researchPlace;
    const zonePlace = card?.closest<HTMLElement>("[data-research-drop]")?.dataset.researchDrop;
    if (!card || !tree || card.dataset.researchCardKind !== "tree" || !place) return null;
    if (place !== zonePlace || !researchPlaceIsReorderable(place)) return null;
    return { card, tree, place };
  }

  /** ⌥→: lists the focused card under the question, document or post above
   * it. */
  function nestFocusedCard(control: HTMLElement) {
    const focused = focusedTreeCard(control);
    if (!focused || !onNestTree) return;
    const { card, tree, place } = focused;
    if (card.dataset.researchParent) {
      announce("Already in a group. Nesting is one level deep.");
      return;
    }
    const ids = topLevelIdsIn(place);
    const above = treeById.get(ids[ids.indexOf(tree.id) - 1] ?? "");
    if (!above) {
      announce("No question, document or post above to nest under.");
      return;
    }
    if (!treeHoldsChildren(above.id)) {
      announce(`“${shortName(above.title)}” can’t hold children.`);
      return;
    }
    onNestTree(tree.id, above.id, null);
    // Nesting a card that has children opens a confirmation first; screen
    // readers announce the dialog, so nothing is announced here.
    if (!card.dataset.researchChildren) {
      announce(`Moved under “${shortName(above.title)}”.`);
      keepCardFocus(tree.id);
    }
  }

  /** ⌥←: lists the focused child on its own, after its former group. */
  function moveFocusedCardOut(control: HTMLElement) {
    const focused = focusedTreeCard(control);
    if (!focused || !onMoveOutOfGroup) return;
    const parent = listedParentOf(focused.tree);
    if (!parent) {
      announce("Not in a group.");
      return;
    }
    keepCardFocus(focused.tree.id);
    void onMoveOutOfGroup(focused.tree.id).then((moved) => {
      if (moved) announce(`Moved out of “${shortName(parent.title)}”.`);
    });
  }

  // A card menu's group actions: Make child of…, Move out, and Collapse
  // or Expand. An archived card's menu has none.
  const menuGroupTree =
    menu?.kind === "tree" && menuTree && menuTree.archivedAt == null && onNestTree
      ? menuTree
      : null;
  const menuGroupParent = menuGroupTree ? listedParentOf(menuGroupTree) : null;
  const menuGroupPlace = menuGroupTree ? placeOf(menuGroupTree) : null;
  const menuGroupChildCount =
    menuGroupTree && !menuGroupParent
      ? activeTrees.filter(
          (tree) => parents[tree.id] === menuGroupTree.id && placeOf(tree) === menuGroupPlace,
        ).length
      : 0;
  const nestCandidates =
    menuGroupTree && menuGroupPlace && researchPlaceIsReorderable(menuGroupPlace)
      ? researchNestCandidates(
          topLevelIdsIn(menuGroupPlace),
          menuGroupParent?.id ?? menuGroupTree.id,
          (id) =>
            id !== menuGroupTree.id &&
            id !== menuGroupParent?.id &&
            treeHoldsChildren(id),
        ).flatMap((id) => treeById.get(id) ?? [])
      : [];
  const menuGroupCollapsed = menuGroupTree ? collapsedGroups.has(menuGroupTree.id) : false;
  const groupMenuItems =
    menu?.kind === "tree" && menuGroupTree ? (
      <>
        <ResearchMenuItem
          icon={<IndentIncrease size={15} aria-hidden="true" />}
          label="Make child of…"
          disabled={nestCandidates.length === 0}
          title={nestCandidates.length === 0 ? "No question, document or post to nest under" : undefined}
          onSelect={() => setMenu({ ...menu, mode: "nest" })}
        />
        {menuGroupParent && onMoveOutOfGroup ? (
          <ResearchMenuItem
            icon={<IndentDecrease size={15} aria-hidden="true" />}
            label="Move out of group"
            onSelect={() => {
              const parent = menuGroupParent;
              closeMenu(true);
              keepCardFocus(menuGroupTree.id);
              void onMoveOutOfGroup(menuGroupTree.id).then((moved) => {
                if (moved) announce(`Moved out of “${shortName(parent.title)}”.`);
              });
            }}
          />
        ) : null}
        {menuGroupChildCount > 0 ? (
          <ResearchMenuItem
            icon={
              menuGroupCollapsed ? (
                <ChevronRight size={15} aria-hidden="true" />
              ) : (
                <ChevronDown size={15} aria-hidden="true" />
              )
            }
            label={menuGroupCollapsed ? "Expand" : "Collapse"}
            onSelect={() => {
              closeMenu(true);
              toggleGroup(menuGroupTree.id, menuGroupTree.title, false);
            }}
          />
        ) : null}
      </>
    ) : null;

  // A parent in the Trash is deleted with its children there.
  const deletingTrashChildCount =
    deletingTrashEntry?.kind === "tree" ? (groupChildren?.(deletingTrashEntry.id).length ?? 0) : 0;

  const listEmpty = rows.length === 0;
  // The first-run text (or setup guide) shows only while nothing exists yet:
  // no questions anywhere and no drafts.
  const homeHasNothing =
    view.kind === "home" &&
    items.length === 0 &&
    drafts.length === 0 &&
    researchTrees.length === 0;

  // The feed's ask box starts Home. In a folder it ends the list.
  const composerBlock = composer ? <div className="research-feed-composer">{composer}</div> : null;
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
      </>
    ) : view.kind === "trash" ? (
      <button
        type="button"
        className="research-feed-button"
        disabled={trashEntries.length === 0 || !onEmptyTrash}
        onClick={() => setEmptyingTrash(true)}
      >
        Empty Trash
      </button>
    ) : view.kind === "home" ? (
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
        {onImportReport ? (
          <ResearchReportImport dropTarget={scrollRef} onImport={onImportReport} onError={onError} />
        ) : null}
      </>
    ) : null;

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
        <ResearchFolderDeleteDialog
          name={userFolder.name}
          count={
            researchTrees.filter((tree) => folderState?.membership[tree.id] === userFolder.id)
              .length
          }
          fallbackFocus={() => deleteFolderButtonRef.current}
          onTrash={() => {
            focusTitleOnViewChangeRef.current = true;
            onConfirmDeleteFolder?.(userFolder.id);
          }}
          onDelete={() => {
            focusTitleOnViewChangeRef.current = true;
            onDeleteFolderNow?.(userFolder.id);
          }}
          onCancel={() => onCancelDeleteFolder?.()}
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
        onKeyDown={(event) => {
          const target = event.target as HTMLElement;
          // Enter and → open the focused card as a click does; → also moves
          // focus into its messages column.
          const openKey = feedRowOpenKey(event);
          if (openKey && target.matches(FEED_ROW_SELECTOR)) {
            event.preventDefault();
            target.click();
            if (openKey === "enter-thread") columns?.focusOpenedThread();
            return;
          }
          // ⌥→ nests the focused card under the card above; ⌥← moves a
          // child out of its group.
          if (
            (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
            event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey &&
            target.matches(".research-feed-card-hit")
          ) {
            event.preventDefault();
            if (event.key === "ArrowRight") nestFocusedCard(target);
            else moveFocusedCardOut(target);
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
          // ↑ and ↓ move between the cards, a group's children included.
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
              aria-label="Unfiled"
              data-research-drop={RESEARCH_UNFILED_FOLDER_ID}
            >
              <div
                className="research-feed-rows"
                role="feed"
                aria-label="Recent activity"
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
                          {renderTreeCard(row.tree, row.query, { virtual: true, children: row.children })}
                        </div>
                      </MeasuredActivityRow>
                    );
                  })}
                </div>
                {listEmpty ? (
                  homeHasNothing && setupGuide ? (
                    <div className="feed-setup-guide">{setupGuide}</div>
                  ) : homeHasNothing ? (
                    <div className="research-feed-empty">
                      Research, notes, and saved links appear here. New ones start at the top.
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
          {view.kind === "home" ? (
            // Trash ends Home, collapsed until opened; it takes no drops.
            <ResearchFeedTray
              place={RESEARCH_TRASH_FOLDER_ID}
              name="Trash"
              count={trashEntries.length}
              countNoun={["item", "items"]}
              drop={false}
              collapsed={!trashTrayOpen}
              onToggle={() => setTrashTrayOpen((open) => !open)}
              onOpen={() => onOpenView?.({ kind: "trash" })}
            >
              {renderPlaceCards(RESEARCH_TRASH_FOLDER_ID)}
            </ResearchFeedTray>
          ) : null}
          {view.kind === "home" && onNewFolder ? (
            // The same New folder action as the sidebar's, below the trays;
            // focus returns to this button when the dialog closes.
            <button
              type="button"
              className="research-feed-new-folder"
              onClick={(event) => onNewFolder(undefined, event.currentTarget)}
            >
              + New folder
            </button>
          ) : null}
          {soloPlace ? (
            <section
              className="research-feed-solo"
              aria-label={viewTitle}
              data-research-drop={soloPlace === RESEARCH_TRASH_FOLDER_ID ? undefined : soloPlace}
            >
              {renderPlaceCards(soloPlace)}
            </section>
          ) : null}
          {soloPlace && view.kind !== "archive" && view.kind !== "trash" ? composerBlock : null}
        </div>
      </div>
      <ResearchFeedScrollThumb scrollRef={scrollRef} />
      <div className="research-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
      {menu?.kind === "tree" && menu.mode === "nest" && menuGroupTree ? (
        <ResearchMenu
          anchor={menu.placement?.anchor ?? menu.anchor}
          align={menu.placement?.align}
          label={`Make “${shortName(menuGroupTree.title)}” a child of`}
          width={260}
          onClose={() => closeMenu()}
        >
          <ResearchMenuTitle>Make child of</ResearchMenuTitle>
          {nestCandidates.map((parent) => (
            <ResearchMenuItem
              key={parent.id}
              icon={<ResearchRowGlyph kind={researchThreadKind(parent, undefined)} />}
              label={parent.title}
              onSelect={() => {
                closeMenu(true);
                onNestTree?.(menuGroupTree.id, parent.id, null);
                if (menuGroupChildCount === 0) {
                  announce(`Moved under “${shortName(parent.title)}”.`);
                  keepCardFocus(menuGroupTree.id);
                }
              }}
            />
          ))}
        </ResearchMenu>
      ) : null}
      {menu?.kind === "tree" && menuTree && menu.mode !== "nest" ? (
        <ResearchFeedRowMenu
          anchor={menu.placement?.anchor ?? menu.anchor}
          align={menu.placement?.align}
          label={`Actions for ${menuTree.title}`}
          groupItems={groupMenuItems}
          currentPlace={placeOf(menuTree)}
          folders={folders}
          archiveShortcut={view.kind === "home"}
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
          groupChildren={groupChildren?.(deletingTree.id)}
          onClose={() => setDeletingTree(null)}
          onTrash={onTrashResearch}
          onRemove={onRemoveResearch}
        />
      ) : null}
      {deletingTrashEntry && onDeleteTrashEntry ? (
        <ResearchDeleteDialog
          fallbackFocus={() =>
            trashTriggerRef.current?.isConnected ? trashTriggerRef.current : titleRef.current
          }
          remove={{
            body: (
              <p>
                “{deletingTrashEntry.title}”
                {deletingTrashChildCount > 0
                  ? ` and its ${researchChildCount(deletingTrashChildCount)}`
                  : ""}{" "}
                will be deleted. This can’t be undone.
              </p>
            ),
            onConfirm: () => onDeleteTrashEntry(deletingTrashEntry),
          }}
          onClose={() => setDeletingTrashEntry(null)}
        />
      ) : null}
      {emptyingTrash && onEmptyTrash ? (
        <ResearchDeleteDialog
          fallbackFocus={() => titleRef.current}
          remove={{
            title: "Empty the Trash?",
            body: (
              <p>
                {researchTrashCount(trashEntries.length)} will be deleted. This can’t be undone.
              </p>
            ),
            label: "Empty Trash",
            pendingLabel: "Emptying…",
            onConfirm: onEmptyTrash,
          }}
          onClose={() => setEmptyingTrash(false)}
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

/** Feed card text with each URL in a span drawn in the link color. The card
 * is one open button, so the URLs are not links. */
function feedText(text: string): ReactNode {
  const runs = feedTextRuns(text);
  if (!runs.some((run) => run.kind === "url")) return text;
  return runs.map((run, index) =>
    run.kind === "url" ? (
      <span key={index} className="research-feed-url">
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/** A card's name in labels and announcements, at most 60 characters. */
function shortName(name: string): string {
  const text = name.replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 59).trimEnd()}…` : text;
}
