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
import type { FocusEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  LoaderCircle,
  MoreHorizontal,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  normalizeJournalEntry,
  recentActivityItemId,
  type JournalEntry,
  type JournalTweetEntry,
  type RecentActivityItem,
} from "../../lib/journal";
import {
  buildRecentActivityFromItems,
  type RecentActivityEvent,
} from "../../lib/activity";
import type {
  RecentActivityCursor,
  RecentResearchQuery,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "../../types";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import { getResearchNodeContent, openExternalUrl } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import ActivityMetadataLine from "../ActivityMetadataLine";
import ResearchThreadActions from "./ResearchThreadActions";
import { ResearchRecapLine } from "./ResearchRecap";
import ResearchRecapDialog from "./ResearchRecapDialog";
import { TweetEmbed } from "./TweetEmbed";
import { ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";
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
  items: RecentActivityItem[];
  researchTrees: ResearchTreeSummary[];
  nextCursor: RecentActivityCursor | null;
  loadingOlder: boolean;
  olderError: string | null;
  /** The most recently removed entry, still restorable. */
  pendingUndo: { entry: JournalEntry } | null;
  onRemoveEntry: (id: string) => void;
  onRetryTweet: (id: string) => void;
  onUndoRemove: () => void;
  onDismissUndo: () => void;
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
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

const JOURNAL_MENU_WIDTH = 180;
const JOURNAL_MENU_HEIGHT_ESTIMATE = 132;
const JOURNAL_VIEWPORT_MARGIN = 8;

export type JournalMenuAction = "open" | "copy" | "retry" | "delete";

export interface JournalMenuItem {
  action: JournalMenuAction;
  label: string;
  /** Single-letter keycap shown in the menu; pressing it fires the item. */
  key: string;
  danger?: boolean;
}

/** The URL an entry stands for: the canonical tweet permalink once hydrated,
 * otherwise what the user entered. */
export function journalEntryUrl(entry: JournalEntry): string | null {
  if (entry.kind === "link") {
    return entry.url;
  }
  return entry.tweet?.url ?? entry.url;
}

/** Context-menu items for an entry. Pure, so tests can pin the layout and
 * keycaps per entry kind without driving the portal menu. */
export function journalEntryMenuItems(entry: JournalEntry): JournalMenuItem[] {
  const items: JournalMenuItem[] = [];
  if (journalEntryUrl(entry)) {
    items.push({
      action: "open",
      label: entry.kind === "tweet" ? "Open on X" : "Open link",
      key: "O",
    });
  }
  items.push({
    action: "copy",
    label: "Copy link",
    key: "C",
  });
  if (entry.kind === "tweet" && entry.hydration !== "pending") {
    items.push({
      action: "retry",
      label: entry.hydration === "failed" ? "Retry tweet" : "Refresh tweet",
      key: "R",
    });
  }
  items.push({ action: "delete", label: "Delete", key: "D", danger: true });
  return items;
}

function menuItemIcon(action: JournalMenuAction) {
  switch (action) {
    case "open":
      return <ExternalLink size={13} aria-hidden="true" />;
    case "copy":
      return <Copy size={13} aria-hidden="true" />;
    case "retry":
      return <RotateCw size={13} aria-hidden="true" />;
    case "delete":
      return <Trash2 size={13} aria-hidden="true" />;
  }
}

function externalLinkClick(url: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };
}

export function JournalTweetCard({ entry }: { entry: JournalTweetEntry }) {
  return entry.tweet ? <TweetEmbed tweet={entry.tweet} /> : null;
}

function JournalEntryCard({
  entry,
  menuOpen,
  onOpenMenu,
  onOpenContextMenu,
  onRetryTweet,
}: {
  entry: JournalEntry;
  menuOpen: boolean;
  onOpenMenu: (entryId: string, trigger: HTMLButtonElement) => void;
  onOpenContextMenu: (entryId: string, clientX: number, clientY: number) => void;
  onRetryTweet: (id: string) => void;
}) {
  let body;
  let variant;
  if (entry.kind === "link") {
    variant = "is-link";
    body = (
      <a
        className="journal-link-url"
        href={entry.url}
        onClick={externalLinkClick(entry.url)}
      >
        {entry.url}
      </a>
    );
  } else if (entry.hydration === "ok" && entry.tweet) {
    variant = "is-tweet";
    body = <JournalTweetCard entry={entry} />;
  } else if (entry.hydration === "failed") {
    variant = "is-tweet-failed";
    body = (
      <div className="journal-tweet-placeholder">
        <a
          className="journal-link-url"
          href={entry.url}
          onClick={externalLinkClick(entry.url)}
        >
          {entry.url}
        </a>
        <p className="journal-tweet-error">
          Couldn’t load this tweet{entry.error ? ` — ${entry.error}` : ""}.
        </p>
        <button
          className="control-button journal-tweet-retry"
          type="button"
          onClick={() => onRetryTweet(entry.id)}
        >
          <RotateCw size={12} aria-hidden="true" />
          <span>Retry</span>
        </button>
      </div>
    );
  } else {
    variant = "is-tweet-pending";
    body = (
      <div className="journal-tweet-placeholder">
        <a
          className="journal-link-url"
          href={entry.url}
          onClick={externalLinkClick(entry.url)}
        >
          {entry.url}
        </a>
        <p className="journal-tweet-loading">
          <LoaderCircle size={12} aria-hidden="true" />
          <span>Loading tweet…</span>
        </p>
      </div>
    );
  }
  return (
    <article
      className={`journal-entry research-content-card ${variant}${
        menuOpen ? " has-open-menu" : ""
      }`}
      title={new Date(entry.createdAt).toLocaleString()}
      onContextMenu={(event) => {
        // Right-clicking a link or the quote card keeps the entry menu too —
        // the browser menu has nothing useful to offer inside the shell.
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(entry.id, event.clientX, event.clientY);
      }}
    >
      {body}
      <button
        className="control-button journal-entry-menu-trigger"
        type="button"
        title="Entry actions"
        aria-label="Entry actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-journal-menu-trigger
        onClick={(event) => onOpenMenu(entry.id, event.currentTarget)}
      >
        <MoreHorizontal size={13} aria-hidden="true" />
      </button>
    </article>
  );
}

function isMarkdownInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button"));
}

function recentQueryTargetExcerpt(target: string, maxWords = 5, maxChars = 40) {
  const normalized = target.split(/\s+/).filter(Boolean).join(" ");
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const wordExcerpt = words.slice(0, maxWords).join(" ");
  const truncated = words.length > maxWords || Array.from(normalized).length > maxChars;
  if (!truncated) return wordExcerpt;

  const characterLimit = Math.max(1, maxChars - 1);
  let excerpt = Array.from(wordExcerpt).slice(0, characterLimit).join("").trimEnd();
  if (Array.from(wordExcerpt).length > characterLimit) {
    excerpt = excerpt.replace(/\s+\S*$/u, "").trimEnd() || excerpt;
  }
  return `${excerpt}…`;
}

export function ResearchQueryCard({
  query,
  metadata,
  followed = false,
  bookmarked = false,
  onToggleFollow,
  onToggleBookmark,
  onOpen,
  onContextMenu,
  onOpenChild,
}: {
  query: RecentResearchQuery;
  /** Event metadata (context phrase and relative time), shown on the card's
   * footer row beside the thread actions. */
  metadata?: ReactNode;
  followed?: boolean;
  bookmarked?: boolean;
  onToggleFollow?: () => void;
  onToggleBookmark?: () => void;
  onOpen: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
  onOpenChild?: (query: RecentResearchQuery) => void;
}) {
  const recap = query.recap?.trim() ?? "";
  const running = isActiveResearchStatus(query.status);
  // A running question shows its spinner and nothing else below the prompt;
  // the thread actions and metadata row appear once the answer settles.
  const actions =
    !running && onToggleFollow && onToggleBookmark ? (
      <ResearchThreadActions
        followed={followed}
        bookmarked={bookmarked}
        onToggleFollow={onToggleFollow}
        onToggleBookmark={onToggleBookmark}
      />
    ) : null;
  return (
    <div
      className="recent-query-block"
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <ResearchUserMessage as="article" className="recent-query-card research-prompt">
        <ResearchMessageBody
          prompt={query.prompt}
          attachments={query.attachments}
          renderPrompt={(content) => (
            <div
              className="recent-query-question-link"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                if (!isMarkdownInteractiveTarget(event.target)) onOpen();
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpen();
              }}
            >
              {content}
            </div>
          )}
        />
      </ResearchUserMessage>
      {running ? (
        <span
          className="recent-query-spinner"
          role="status"
          aria-label="Generating answer"
          title="Generating answer"
        >
          <LoaderCircle size={14} aria-hidden="true" />
        </span>
      ) : null}
      {recap ? <ResearchRecapLine text={recap} className="recent-query-recap" /> : null}
      {query.children?.length && onOpenChild ? (
        <ul
          className="recent-query-children"
          aria-label="Follow-up questions"
          onClick={(event) => event.stopPropagation()}
        >
          {query.children.map((child) => {
            const targetExcerpt = recentQueryTargetExcerpt(child.queryTarget ?? "");
            return (
              <li key={child.nodeId} className="recent-query-child">
                {targetExcerpt ? (
                  <>
                    <span
                      className="recent-query-child-target"
                      title={child.queryTarget ?? undefined}
                    >
                      @{targetExcerpt}
                    </span>{" "}
                  </>
                ) : null}
                <span
                  className="recent-query-child-link"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenChild(child);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenChild(child);
                  }}
                >
                  <span className="recent-query-child-question">{child.prompt}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!running && (actions || metadata) ? (
        <div className="recent-query-footer">
          {actions}
          {metadata ? <div className="recent-query-metadata">{metadata}</div> : null}
        </div>
      ) : null}
    </div>
  );
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
  if (row.event.source.kind === "research-query") {
    if (
      row.event.source.query.attachments?.some(
        (attachment) => attachment.status === "resolved" && attachment.tweet,
      )
    ) {
      return row.event.source.query.recap?.trim() ? 430 : 384;
    }
    return row.event.source.query.recap?.trim() ? 136 : 90;
  }
  const entry = row.event.source.entry;
  if (entry.kind === "tweet" && entry.hydration === "ok") return 326;
  return 104;
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
  researchTrees,
  nextCursor,
  loadingOlder,
  olderError,
  pendingUndo,
  onRemoveEntry,
  onRetryTweet,
  onUndoRemove,
  onDismissUndo,
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
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: ResearchActivityFeedProps) {
  const [menu, setMenu] = useState<
    | { kind: "journal"; entryId: string; left: number; top: number }
    | {
        kind: "tree";
        treeId: string;
        queryNodeId?: string;
        archived: boolean;
        left: number;
        top: number;
      }
    | null
  >(null);
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
      if (event.button === 3) {
        event.preventDefault();
        onBackRef.current?.();
      } else if (event.button === 4) {
        event.preventDefault();
        onForwardRef.current?.();
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
  const items = useMemo(
    () => rawItems.flatMap((item): RecentActivityItem[] => {
      if (item.kind === "research-query") return [item];
      const entry = normalizeJournalEntry(item.entry);
      return entry ? [{ ...item, entry }] : [];
    }),
    [rawItems],
  );
  const visibleItems = useMemo(() => {
    if (view !== "bookmarks") return items;
    const bookmarked = new Set(
      researchTrees.filter((tree) => tree.bookmarked).map((tree) => tree.id),
    );
    return items.filter(
      (item) => item.kind === "research-query" && bookmarked.has(item.query.treeId),
    );
  }, [items, researchTrees, view]);
  const feed = useMemo(
    () => buildRecentActivityFromItems(visibleItems, researchTrees),
    [visibleItems, researchTrees],
  );
  const viewTitle = view === "bookmarks" ? "Bookmarks" : "Home";
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
  const knownItemIdsRef = useRef(new Set(items.map(recentActivityItemId)));
  const previousTopItemIdRef = useRef(items[0] ? recentActivityItemId(items[0]) : null);

  const captureScrollState = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
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
    setViewport({ scrollTop: feedScrollTop, height: scroller.clientHeight });
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
      setViewport({
        scrollTop: Math.max(0, desired - canvasTop),
        height: scroller.clientHeight,
      });
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
      ? items.findIndex((item) => recentActivityItemId(item) === previousTopId)
      : -1;
    const candidates = previousTopIndex >= 0 ? items.slice(0, previousTopIndex) : [];
    const addedAbove = candidates.filter(
      (item) => !knownItemIdsRef.current.has(recentActivityItemId(item)),
    ).length;
    if (addedAbove > 0 && (scrollRef.current?.scrollTop ?? 0) > 60) {
      setNewActivityCount((count) => count + addedAbove);
    }
    knownItemIdsRef.current = new Set(items.map(recentActivityItemId));
    previousTopItemIdRef.current = items[0] ? recentActivityItemId(items[0]) : null;
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

  const menuActivityItem =
    menu?.kind === "journal"
      ? items.find((item) => item.kind === "journal" && item.entry.id === menu.entryId)
      : null;
  const menuEntry = menuActivityItem?.kind === "journal" ? menuActivityItem.entry : null;
  const menuItems = menuEntry ? journalEntryMenuItems(menuEntry) : [];
  const menuTree =
    menu?.kind === "tree" ? (treeById.get(menu.treeId) ?? null) : null;
  const menuQueryItem =
    menu?.kind === "tree" && menu.queryNodeId
      ? items.find(
          (item) =>
            item.kind === "research-query" && item.query.nodeId === menu.queryNodeId,
        ) ?? null
      : null;
  const menuQuery = menuQueryItem?.kind === "research-query" ? menuQueryItem.query : null;

  function runMenuAction(entry: JournalEntry, action: JournalMenuAction) {
    setMenu(null);
    if (action === "open") {
      const url = journalEntryUrl(entry);
      if (url) {
        void openExternalUrl(url);
      }
      return;
    }
    if (action === "copy") {
      void writeClipboardText(
        journalEntryUrl(entry) ?? "",
      );
      return;
    }
    if (action === "retry") {
      onRetryTweet(entry.id);
      return;
    }
    onRemoveEntry(entry.id);
  }

  function clampedMenuPosition(
    clientX: number,
    clientY: number,
    width = JOURNAL_MENU_WIDTH,
  ) {
    return {
      left: Math.max(
        JOURNAL_VIEWPORT_MARGIN,
        Math.min(clientX, window.innerWidth - width - JOURNAL_VIEWPORT_MARGIN),
      ),
      top: Math.max(
        JOURNAL_VIEWPORT_MARGIN,
        Math.min(
          clientY,
          window.innerHeight - JOURNAL_MENU_HEIGHT_ESTIMATE - JOURNAL_VIEWPORT_MARGIN,
        ),
      ),
    };
  }

  function openMenuFromTrigger(entryId: string, trigger: HTMLButtonElement) {
    if (menu?.kind === "journal" && menu.entryId === entryId) {
      setMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenu({
      kind: "journal",
      entryId,
      ...clampedMenuPosition(rect.right - JOURNAL_MENU_WIDTH, rect.bottom + 4),
    });
  }

  function openContextMenu(entryId: string, clientX: number, clientY: number) {
    setMenu({ kind: "journal", entryId, ...clampedMenuPosition(clientX, clientY) });
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
      if (menu.kind === "journal") {
        const activityItem = items.find(
          (candidate) => candidate.kind === "journal" && candidate.entry.id === menu.entryId,
        );
        const entry = activityItem?.kind === "journal" ? activityItem.entry : null;
        if (!entry) {
          return;
        }
        const item = journalEntryMenuItems(entry).find(
          (candidate) => candidate.key.toLowerCase() === event.key.toLowerCase(),
        );
        if (!item) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        runMenuAction(entry, item.action);
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
    // runMenuAction and items are stable enough per menu lifetime; the menu
    // closes on any entry mutation the actions cause.
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
      JOURNAL_VIEWPORT_MARGIN,
      Math.min(menu.top, window.innerHeight - JOURNAL_VIEWPORT_MARGIN - height),
    );
    if (top !== menu.top) {
      element.style.top = `${top}px`;
    }
  }, [menu]);

  // ⌘Z / Ctrl-Z restores the last removed entry while the undo bar shows.
  useEffect(() => {
    if (!pendingUndo) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        onUndoRemove();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onUndoRemove, pendingUndo]);
  return (
    <ResearchDocumentFrame
      title={viewTitle}
      headerActions={view === "home" && onImportReport ? (
        <ResearchReportImport dropTarget={scrollRef} onImport={onImportReport} onError={onError} />
      ) : undefined}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
      navActions={onRefresh ? (
        <button
          type="button"
          className="control-button research-history-button"
          onClick={onRefresh}
          aria-label={`Refresh ${viewTitle}`}
          title={`Refresh ${viewTitle}`}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      ) : undefined}
    >
      <div ref={scrollRef} className="research-document-scroll journal-scroll">
        <div className="journal-column research-reading-surface">
          {view === "home" ? (
            <div className="journal-composer-container">{composer}</div>
          ) : null}
          {pendingUndo ? (
            <div className="journal-undo" role="status">
              <span className="journal-undo-label">
                Entry removed
              </span>
              <button
                className="control-button journal-undo-restore"
                type="button"
                onClick={onUndoRemove}
              >
                <Undo2 size={12} aria-hidden="true" />
                <span>Undo</span>
                <kbd className="context-menu-shortcut is-keycap">⌘Z</kbd>
              </button>
              <button
                className="control-button journal-undo-dismiss"
                type="button"
                title="Dismiss"
                aria-label="Dismiss undo"
                onClick={onDismissUndo}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
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
                const researchTreeId =
                  row.event.source.kind === "research-query"
                    ? row.event.source.query.treeId
                    : null;
                const researchTree = researchTreeId ? treeById.get(researchTreeId) : undefined;
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
                      {row.event.source.kind === "journal" ? (
                        <>
                          <ActivityMetadataLine event={row.event} />
                          <JournalEntryCard
                            entry={row.event.source.entry}
                            menuOpen={
                              menu?.kind === "journal" &&
                              menu.entryId === row.event.source.entry.id
                            }
                            onOpenMenu={openMenuFromTrigger}
                            onOpenContextMenu={openContextMenu}
                            onRetryTweet={onRetryTweet}
                          />
                        </>
                      ) : (
                        <ResearchQueryCard
                          query={row.event.source.query}
                          metadata={<ActivityMetadataLine event={row.event} />}
                          followed={Boolean(researchTree?.followed)}
                          bookmarked={Boolean(researchTree?.bookmarked)}
                          onToggleFollow={() => {
                            if (researchTreeId) {
                              onSetResearchFollowed(researchTreeId, !researchTree?.followed);
                            }
                          }}
                          onToggleBookmark={() => {
                            if (researchTreeId) {
                              onSetResearchBookmarked(researchTreeId, !researchTree?.bookmarked);
                            }
                          }}
                          onOpenChild={onOpenResearchQuery}
                          onOpen={() => {
                            const query = row.event.source;
                            if (query.kind === "research-query") {
                              onOpenResearchQuery(query.query);
                            }
                          }}
                          onContextMenu={(clientX, clientY) => {
                            const source = row.event.source;
                            if (source.kind !== "research-query") {
                              return;
                            }
                            const tree = treeById.get(source.query.treeId);
                            if (!tree) {
                              return;
                            }
                            openTreeContextMenu(tree, clientX, clientY, source.query.nodeId);
                          }}
                        />
                      )}
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
                    Research queries and saved sources appear here, newest first.
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
      {menu?.kind === "journal" && menuEntry
        ? createPortal(
            <div
              ref={menuRef}
              className="popover-surface popover-surface--context pane-context-menu journal-entry-menu"
              role="menu"
              aria-label="Saved entry actions"
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="group-context-actions">
                {menuItems.map((item, index) => (
                  <span key={item.action} style={{ display: "contents" }}>
                    {item.danger && index > 0 ? (
                      <div className="context-menu-divider" role="separator" />
                    ) : null}
                    <button
                      className={`control-button context-menu-has-shortcut${
                        item.danger ? " context-menu-danger" : ""
                      }`}
                      type="button"
                      role="menuitem"
                      onClick={() => runMenuAction(menuEntry, item.action)}
                    >
                      {menuItemIcon(item.action)}
                      <span>{item.label}</span>
                      <kbd className="context-menu-shortcut is-keycap">{item.key}</kbd>
                    </button>
                  </span>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
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
