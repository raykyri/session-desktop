// The Home feed (`10-home-feed-journal.md` §2,
// ported from `ResearchActivityFeed.tsx`).
//
// The desktop hand-rolled its virtual canvas — cumulative offsets, a binary
// search over them, a `ResizeObserver` per row. TanStack Virtual does the same
// job with dynamic measurement, so what is left here is the feed's own
// behavior: live rows patched into page 0 by the event bridge, a counter for
// arrivals the reader has scrolled past, and keyset pagination with a Retry.

import { buildRecentActivityFromItems, recentActivityItemId } from "@session/shared";
import type {
  RecentActivityItem,
  RecentActivityScope,
  RecentResearchQuery,
  ResearchFolderState,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { getResearchNodeContent } from "../../api/api.js";
import {
  useActivityFeed,
  useSignedIn,
  useArchiveResearchTree,
  useRemoveResearchTree,
  useRenameResearchTree,
  useTreeSummaries,
  useFolders,
} from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { errorMessage, pushErrorToast } from "../../lib/toast.js";
import {
  useNavigationStore,
  type FeedMode,
  type FeedScrollAnchor,
} from "../../stores/navigation.js";
import { ActivityMetadataLine } from "../../ui/ActivityMetadataLine.js";
import { ControlButton } from "../../ui/Button.js";
import { Menu, MenuItem } from "../../ui/Menu.js";
import { QueryState } from "../../ui/QueryState.js";
import { RecapDialog } from "../research/RecapDialog.js";
import { DeleteTreeDialog, RenameTreeDialog, ResearchTreeMenuItems } from "../research/treeMenu.js";

import { ResearchQueryCard } from "./ResearchQueryCard.js";
import {
  countNewAbove,
  feedScrollBehavior,
  FEED_TOP_THRESHOLD,
  useFeedScrollAnchor,
} from "./useActivityFeedState.js";

/** First guess at a row's height, refined by measurement on mount. The two
 * shapes differ by an order of magnitude, so one average would make every
 * scrollbar wrong (`ResearchActivityFeed.tsx:494`). */
export function estimateRowHeight(item: RecentActivityItem): number {
  const hasTweet = item.query.attachments?.some(
    (attachment) => attachment.status === "resolved" && attachment.tweet,
  );
  if (hasTweet) return item.query.recap?.trim() ? 430 : 384;
  return item.query.recap?.trim() ? 136 : 90;
}

const EMPTY_FOLDER_STATE: ResearchFolderState = {
  folders: [],
  membership: {},
  collapsed: [],
};

export interface ActivityFeedProps {
  workspaceId: string;
  scope?: RecentActivityScope;
  scopeSwitcher?: {
    mode: FeedMode;
    workspaceTitle: string;
    onChange: (mode: FeedMode) => void;
  };
  title: string;
  /** Home's composer and import row, rendered above the feed. */
  header?: React.ReactNode;
  /** The scroll container is exposed so Home can hang its report drop target
   * off the whole column. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

function captureFeedAnchor(
  scroller: HTMLElement,
  virtualItems: { key: string | number | bigint; start: number; end: number }[],
): FeedScrollAnchor {
  const top = scroller.scrollTop;
  const visible =
    virtualItems.find((item) => item.start <= top && item.end > top) ??
    virtualItems.find((item) => item.end > top) ??
    virtualItems[0];
  return {
    key: visible ? String(visible.key) : "",
    offset: visible ? visible.start - top : 0,
    top,
  };
}

/** Pixel offset of `node` from the start of `scroller`'s content. The composer
 * and title sit above the virtual list, so TanStack Virtual needs this as
 * `scrollMargin` and restore must not treat list offset 0 as scrollTop 0. */
function offsetWithinScroller(scroller: HTMLElement, node: HTMLElement): number {
  return (
    node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

export function ActivityFeed({
  workspaceId,
  scope = "workspace",
  scopeSwitcher,
  title,
  header,
  scrollRef: externalScrollRef,
}: ActivityFeedProps) {
  // Opted out of the React Compiler: `useVirtualizer` returns functions that
  // cannot be memoized without going stale, so the compiler would skip this
  // component anyway and warn about it.
  "use no memo";

  const navigate = useNavigate();
  const feed = useActivityFeed({ scope, workspaceId });
  const summaries = useTreeSummaries({ workspaceId });
  const folders = useFolders(workspaceId);
  const rename = useRenameResearchTree();
  const archive = useArchiveResearchTree();
  const remove = useRemoveResearchTree();

  const signedIn = useSignedIn();
  const canManage = signedIn && scope !== "all";
  const view =
    scope === "all"
      ? "all-users"
      : scope === "mine"
        ? "my-workspaces"
        : workspaceId === ""
          ? ""
          : `ws:${workspaceId}`;
  const anchor = useFeedScrollAnchor(view);

  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // Read once the workspace is known so a remount starts at the saved offset
  // instead of 0. Do not snapshot `home:` before `workspaceId` resolves — that
  // locked initialOffset at 0 and the virtualizer later wrote it over restore.
  const initialScrollOffset = useRef<number | undefined>(undefined);
  if (initialScrollOffset.current === undefined && view !== "") {
    initialScrollOffset.current = useNavigationStore.getState().feedAnchorFor(view)?.top ?? 0;
  }

  const [newCount, setNewCount] = useState(0);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  // The recap dialog needs the node's content, which the feed row does not
  // carry; it is fetched when the menu item is chosen rather than for every
  // card on screen.
  const [recapContent, setRecapContent] = useState<ResearchNodeContent | null>(null);

  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((page) => page.items), [feed.data]);

  const trees = useMemo(() => summaries.data ?? [], [summaries.data]);
  const treeById = useMemo(() => new Map(trees.map((tree) => [tree.id, tree])), [trees]);
  const events = useMemo(() => buildRecentActivityFromItems(items, trees), [items, trees]);
  const itemBySourceId = useMemo(
    () => new Map(items.map((item) => [recentActivityItemId(item), item])),
    [items],
  );

  // useVirtualizer's API triggers this lint rule unconditionally; the disable
  // below is the only way to suppress the warning.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const event = events[index];
      if (!event) return 120;
      const item = itemBySourceId.get(`research:${event.source.query.nodeId}`);
      return item ? estimateRowHeight(item) : 120;
    },
    getItemKey: (index) => events[index]?.id ?? index,
    overscan: 6,
    scrollMargin,
    initialOffset: initialScrollOffset.current,
    // The viewport's size before the resize observer reports one. A zero
    // height would put the first render's range at nothing and leave the feed
    // blank until a scroll or a resize; one screen's worth is the guess the
    // first paint is measured against.
    initialRect: { width: 0, height: 800 },
  });

  /* ---------------------------------------------------------------------
   * Scroll anchor, new-activity counter
   * ------------------------------------------------------------------ */

  const virtualItems = virtualizer.getVirtualItems();
  const listSize = virtualizer.getTotalSize();

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const next = offsetWithinScroller(scroller, list);
    setScrollMargin((current) => (current === next ? current : next));
  }, [header, events.length, listSize, scrollRef]);

  // Restore by writing `scrollTop` directly. `virtualizer.scrollToOffset` goes
  // through alignment/clamping and a reconcile loop: before the list is tall
  // enough that loop snaps to ~the first row and hides the composer. Keep the
  // target until measurements settle or the reader scrolls away.
  const pendingRestoreTop = useRef<number | null>(null);
  const restorePrepared = useRef(false);
  useLayoutEffect(() => {
    if (view === "") return;
    if (!restorePrepared.current) {
      const saved = useNavigationStore.getState().feedAnchorFor(view) ?? anchor.initial;
      if (typeof saved?.top === "number") {
        pendingRestoreTop.current = saved.top;
        restorePrepared.current = true;
      } else if (saved) {
        if (events.length === 0) return;
        const index = events.findIndex((event) => event.id === saved.key);
        if (index < 0) {
          restorePrepared.current = true;
        } else {
          const offsetForIndex = virtualizer.getOffsetForIndex(index, "start");
          pendingRestoreTop.current = offsetForIndex
            ? Math.max(0, offsetForIndex[0] - saved.offset)
            : 0;
          restorePrepared.current = true;
        }
      } else {
        restorePrepared.current = true;
      }
    }
    const target = pendingRestoreTop.current;
    const scroller = scrollRef.current;
    if (target === null || !scroller || events.length === 0) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (target > max && Math.abs(scroller.scrollTop - max) <= 1) {
      pendingRestoreTop.current = null;
      return;
    }
    if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target;
  }, [anchor.initial, events, listSize, scrollMargin, scrollRef, view, virtualizer, workspaceId]);

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const atTop = scroller.scrollTop <= FEED_TOP_THRESHOLD;
    if (atTop) setNewCount(0);
    const pending = pendingRestoreTop.current;
    if (pending !== null) {
      if (Math.abs(scroller.scrollTop - pending) <= 1) pendingRestoreTop.current = null;
      else return;
    }
    // An empty range is a measurement gap, not "the reader is at the top".
    // Writing null here used to wipe a saved position on remount.
    if (virtualizer.getVirtualItems().length === 0) return;
    anchor.record(captureFeedAnchor(scroller, virtualizer.getVirtualItems()));
  }, [anchor, scrollRef, virtualizer]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      // Flush the last real scroll. Do not recapture here: this effect cleans
      // up after the node is gone, and a detached scroller often reads
      // scrollTop 0, which would replace the position openQuery just saved
      // with "top of the first feed item".
      anchor.flush();
    };
  }, [anchor, onScroll, scrollRef]);

  const knownIdsRef = useRef<Set<string>>(new Set());
  const previousTopRef = useRef<string | null>(null);
  useEffect(() => {
    const ids = items.map(recentActivityItemId);
    const added = countNewAbove(previousTopRef.current, ids, knownIdsRef.current);
    if (added > 0 && (scrollRef.current?.scrollTop ?? 0) > FEED_TOP_THRESHOLD) {
      setNewCount((count) => count + added);
    }
    knownIdsRef.current = new Set(ids);
    previousTopRef.current = ids[0] ?? null;
  }, [items, scrollRef]);

  /* ---------------------------------------------------------------------
   * Actions
   * ------------------------------------------------------------------ */

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: feedScrollBehavior() });
  };

  const openQuery = (query: RecentResearchQuery) => {
    const scroller = scrollRef.current;
    if (scroller) {
      anchor.record(captureFeedAnchor(scroller, virtualizer.getVirtualItems()));
      anchor.flush();
    }
    void navigate({
      to: "/r/$treeId",
      params: { treeId: query.treeId },
      search: {
        node: query.nodeId,
        ...((query.workspaceId ?? workspaceId) ? { ws: query.workspaceId ?? workspaceId } : {}),
      },
    });
  };

  const openRecapDialog = (nodeId: string) => {
    void getResearchNodeContent(nodeId)
      .then(setRecapContent)
      .catch((error: unknown) => pushErrorToast("Could not read answer", error));
  };

  const folderState = folders.data ?? EMPTY_FOLDER_STATE;

  const treeMenu = (tree: ResearchTreeSummary | undefined, query: RecentResearchQuery | null) =>
    tree ? (
      <ResearchTreeMenuItems
        tree={tree}
        archived={tree.archivedAt != null}
        folderState={folderState}
        // Folder actions are omitted because this surface has no folder dialog
        // to support them (`10` §2).
        onRename={setRenamingTree}
        onArchive={(treeId) => archive.mutate({ treeId, archived: true })}
        onRestore={(treeId) => archive.mutate({ treeId, archived: false })}
        onDelete={setDeletingTree}
        // Any settled answer can be summarized; the dialog says whether it is
        // writing a first summary or replacing one.
        onRegenerateSummary={
          query && tree.archivedAt == null && query.status === "complete"
            ? () => openRecapDialog(query.nodeId)
            : undefined
        }
      />
    ) : null;

  const nothingYet = feed.isSuccess && events.length === 0;

  return (
    <div
      ref={scrollRef}
      className="research-reading-surface h-full overflow-y-auto pr-8 pl-[42px] max-[900px]:pr-7 max-[900px]:pl-[38px]"
    >
      <div className="research-document-frame flex min-w-0 flex-col pb-12">
        <div className="max-w-feed flex w-full flex-col">
          <div className="flex items-center justify-between gap-2 pt-6 pb-4">
            <h1 className="text-title text-fg-heading m-0 font-semibold">{title}</h1>
            {scopeSwitcher ? (
              <Menu
                align="end"
                size="sm"
                label="Feed scope"
                trigger={
                  <ControlButton
                    size="sm"
                    className="max-w-52 gap-1.5"
                    aria-label={`Feed scope: ${title}`}
                  >
                    <span className="truncate">{title}</span>
                    <ChevronDown size={13} aria-hidden="true" />
                  </ControlButton>
                }
              >
                <MenuItem
                  selected={scopeSwitcher.mode === "all"}
                  onClick={() => scopeSwitcher.onChange("all")}
                >
                  All Users
                </MenuItem>
                <MenuItem
                  selected={scopeSwitcher.mode === "workspaces"}
                  onClick={() => scopeSwitcher.onChange("workspaces")}
                >
                  My Workspaces
                </MenuItem>
                <MenuItem
                  selected={scopeSwitcher.mode === "workspace"}
                  onClick={() => scopeSwitcher.onChange("workspace")}
                >
                  {scopeSwitcher.workspaceTitle || "Workspace"}
                </MenuItem>
              </Menu>
            ) : null}
          </div>

          {header}

          {newCount > 0 ? (
            <div className="sticky top-2 z-1 flex justify-center" role="status" aria-live="polite">
              <ControlButton
                size="sm"
                className="rounded-full"
                onClick={() => {
                  setNewCount(0);
                  scrollToTop();
                }}
              >
                {newCount} new {newCount === 1 ? "update" : "updates"}
              </ControlButton>
            </div>
          ) : null}

          <div ref={listRef} role="feed" aria-label={title} aria-busy={feed.isFetching}>
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualItems.map((virtualRow) => {
                const event = events[virtualRow.index];
                if (!event) return null;
                const source = event.source;
                return (
                  <div
                    key={virtualRow.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      // `start` is in scroller coordinates (it includes
                      // `scrollMargin`); this node is already below the title
                      // and composer, so the margin has to come off again.
                      transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                    }}
                  >
                    <div
                      className="flex flex-col gap-[9px] pt-[21px] pb-5"
                      role="article"
                      aria-posinset={virtualRow.index + 1}
                      aria-setsize={feed.hasNextPage ? -1 : events.length}
                    >
                      <ActivityMetadataLine event={event} showTime={false} />
                      <ResearchQueryCard
                        query={source.query}
                        tree={treeById.get(source.query.treeId)}
                        menuItems={
                          canManage
                            ? treeMenu(treeById.get(source.query.treeId), source.query)
                            : null
                        }
                        onOpen={() => openQuery(source.query)}
                        onOpenChild={openQuery}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {nothingYet ? (
              <QueryState empty="No recent activity yet. Run a query to see it here." />
            ) : null}

            <div aria-live="polite" className="flex flex-col items-start gap-2 py-4">
              {feed.hasNextPage ? (
                <ControlButton
                  size="sm"
                  className="gap-1.5"
                  disabled={feed.isFetchingNextPage}
                  onClick={() => void feed.fetchNextPage()}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                  <span>
                    {feed.isFetchingNextPage
                      ? "Loading…"
                      : feed.isFetchNextPageError
                        ? "Retry older activity"
                        : "Load older activity"}
                  </span>
                </ControlButton>
              ) : null}
              {feed.isFetchNextPageError ? (
                <p className={cn("text-status-failed m-0 text-sm")} role="alert">
                  Couldn’t load older activity.
                </p>
              ) : null}
              {feed.isError ? (
                <QueryState error="Couldn’t load activity." onRetry={() => void feed.refetch()} />
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {recapContent ? (
        <RecapDialog
          content={recapContent}
          open
          onClose={() => setRecapContent(null)}
          onApplied={(updated) =>
            setRecapContent((current: ResearchNodeContent | null) =>
              current && current.node.id === updated.id ? { ...current, node: updated } : current,
            )
          }
        />
      ) : null}
      {renamingTree ? (
        <RenameTreeDialog
          tree={renamingTree}
          open
          onClose={() => setRenamingTree(null)}
          onRename={(treeId, title) => rename.mutateAsync({ treeId, title })}
        />
      ) : null}
      {deletingTree ? (
        <DeleteTreeDialog
          tree={deletingTree}
          open
          busy={remove.isPending}
          error={remove.error ? errorMessage(remove.error) : null}
          onClose={() => setDeletingTree(null)}
          onRemove={(treeId) => remove.mutate(treeId, { onSuccess: () => setDeletingTree(null) })}
        />
      ) : null}
    </div>
  );
}
