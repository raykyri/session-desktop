// The Home and Bookmarks feed (`10-home-feed-journal-encyclopedia.md` §2, §3,
// ported from `ResearchActivityFeed.tsx`).
//
// The desktop hand-rolled its virtual canvas — cumulative offsets, a binary
// search over them, a `ResizeObserver` per row. TanStack Virtual does the same
// job with dynamic measurement, so what is left here is the feed's own
// behavior: live rows patched into page 0 by the event bridge, a counter for
// arrivals the reader has scrolled past, keyset pagination with a Retry, and an
// undo bar for a removed journal entry.

import {
  buildRecentActivityFromItems,
  normalizeJournalEntry,
  recentActivityItemId,
  toggleResearchStar,
} from "@session/shared";
import type {
  JournalEntry,
  RecentActivityItem,
  RecentResearchQuery,
  ResearchFolderState,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "@session/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  deleteJournalEntry,
  getResearchNodeContent,
  hydrateJournalTweet,
  restoreJournalEntry,
} from "../../api/api.js";
import {
  useActivityFeed,
  useArchiveResearchTree,
  useRemoveResearchTree,
  useRenameResearchTree,
  useSetTreeBookmarked,
  useSetTreeFollowed,
  useTreeSummaries,
  useFolders,
} from "../../api/queries.js";
import { writeClipboardText } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { errorMessage, pushErrorToast, pushToast } from "../../lib/toast.js";
import { ActivityMetadataLine } from "../../ui/ActivityMetadataLine.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { JournalEntryCard } from "../journal/JournalEntryCard.js";
import { journalEntryUrl, type JournalMenuAction } from "../journal/entryMenu.js";
import { RecapDialog } from "../research/RecapDialog.js";
import { DeleteTreeDialog, RenameTreeDialog, ResearchTreeMenuItems } from "../research/treeMenu.js";
import { applyFolderState } from "../sidebar/mutations.js";

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
  if (item.kind === "research-query") {
    const hasTweet = item.query.attachments?.some(
      (attachment) => attachment.status === "resolved" && attachment.tweet,
    );
    if (hasTweet) return item.query.recap?.trim() ? 430 : 384;
    return item.query.recap?.trim() ? 136 : 90;
  }
  const entry = item.entry;
  if (entry.kind === "tweet" && entry.hydration === "ok") return 326;
  return 104;
}

const EMPTY_FOLDER_STATE: ResearchFolderState = {
  folders: [],
  membership: {},
  starred: [],
  collapsed: [],
};

export interface ActivityFeedProps {
  workspaceId: string;
  /** Bookmarks is the same feed with the server filtering roots by
   * `trees.bookmarked`; it has no composer and no import target. */
  bookmarkedOnly?: boolean;
  title: string;
  /** Home's composer and import row, rendered above the feed. */
  header?: React.ReactNode;
  /** The scroll container is exposed so Home can hang its report drop target
   * off the whole column. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export function ActivityFeed({
  workspaceId,
  bookmarkedOnly = false,
  title,
  header,
  scrollRef: externalScrollRef,
}: ActivityFeedProps) {
  // Opted out of the React Compiler: `useVirtualizer` returns functions that
  // cannot be memoized without going stale, so the compiler would skip this
  // component anyway and warn about it.
  "use no memo";

  const navigate = useNavigate();
  const client = useQueryClient();
  const feed = useActivityFeed({ workspaceId, bookmarkedOnly });
  const summaries = useTreeSummaries({ workspaceId });
  const folders = useFolders(workspaceId);
  const rename = useRenameResearchTree();
  const archive = useArchiveResearchTree();
  const remove = useRemoveResearchTree();
  const setFollowed = useSetTreeFollowed();
  const setBookmarked = useSetTreeBookmarked();

  const view = `${bookmarkedOnly ? "bookmarks" : "home"}:${workspaceId}`;
  const anchor = useFeedScrollAnchor(view);

  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;

  const [undoEntry, setUndoEntry] = useState<JournalEntry | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  // The recap dialog needs the node's content, which the feed row does not
  // carry; it is fetched when the menu item is chosen rather than for every
  // card on screen.
  const [recapContent, setRecapContent] = useState<ResearchNodeContent | null>(null);

  const items = useMemo(() => {
    const pages = feed.data?.pages ?? [];
    return pages.flatMap((page) =>
      page.items.flatMap((item): RecentActivityItem[] => {
        if (item.kind === "research-query") return [item];
        const entry = normalizeJournalEntry(item.entry);
        return entry ? [{ ...item, entry }] : [];
      }),
    );
  }, [feed.data]);

  const trees = useMemo(() => summaries.data ?? [], [summaries.data]);
  const treeById = useMemo(() => new Map(trees.map((tree) => [tree.id, tree])), [trees]);
  const events = useMemo(() => buildRecentActivityFromItems(items, trees), [items, trees]);
  const itemBySourceId = useMemo(
    () => new Map(items.map((item) => [recentActivityItemId(item), item])),
    [items],
  );

  // The lint reports the skip regardless of the directive above; the opt-out
  // is the directive, this only quiets the notice.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const event = events[index];
      if (!event) return 120;
      const item = itemBySourceId.get(
        event.source.kind === "journal"
          ? `journal:${event.source.entry.id}`
          : `research:${event.source.query.nodeId}`,
      );
      return item ? estimateRowHeight(item) : 120;
    },
    getItemKey: (index) => events[index]?.id ?? index,
    overscan: 6,
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
  const restoredRef = useRef(false);
  useLayoutEffect(() => {
    if (restoredRef.current || events.length === 0) return;
    const saved = anchor.initial;
    if (!saved) {
      restoredRef.current = true;
      return;
    }
    const index = events.findIndex((event) => event.id === saved.key);
    if (index < 0) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    virtualizer.scrollToIndex(index, { align: "start" });
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop - saved.offset);
  }, [anchor.initial, events, scrollRef, virtualizer]);

  const onScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const atTop = scroller.scrollTop <= FEED_TOP_THRESHOLD;
    if (atTop) setNewCount(0);
    const top = virtualizer.getVirtualItems()[0];
    anchor.record(top ? { key: String(top.key), offset: top.start - scroller.scrollTop } : null);
  }, [anchor, scrollRef, virtualizer]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [onScroll, scrollRef]);

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
    void navigate({
      to: "/r/$treeId",
      params: { treeId: query.treeId },
      search: { node: query.nodeId, ...(workspaceId === "" ? {} : { ws: workspaceId }) },
    });
  };

  const runEntryAction = (entry: JournalEntry, action: JournalMenuAction) => {
    const url = journalEntryUrl(entry);
    switch (action) {
      case "open":
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        return;
      case "copy":
        void writeClipboardText(url ?? "")
          .then(() => pushToast({ title: "Link copied", tone: "success" }))
          .catch((error: unknown) => pushErrorToast("The link could not be copied", error));
        return;
      case "retry":
        void hydrateJournalTweet(entry.id).catch((error: unknown) =>
          pushErrorToast("The post could not be loaded", error),
        );
        return;
      case "delete":
        // Retain the deleted entry locally so undo can restore it without
        // refetching.
        setUndoEntry(entry);
        void deleteJournalEntry(entry.id)
          .then(() => client.invalidateQueries({ queryKey: ["activity"] }))
          .catch((error: unknown) => {
            setUndoEntry(null);
            pushErrorToast("The entry could not be removed", error);
          });
        return;
    }
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
        // Star status is folder state, which can be updated from either the feed
        // or sidebar. Folder actions are omitted because this surface has no
        // folder dialog to support them (`10` §2).
        onToggleStar={(treeId) =>
          void applyFolderState(client, workspaceId, toggleResearchStar(folderState, treeId))
        }
        onRename={setRenamingTree}
        onArchive={(treeId) => archive.mutate({ treeId, archived: true })}
        onRestore={(treeId) => archive.mutate({ treeId, archived: false })}
        onDelete={setDeletingTree}
        // Only a settled answer that already has a summary can be summarized
        // again (`ResearchActivityFeed.tsx:1437`).
        onRegenerateSummary={
          query && tree.archivedAt == null && query.status === "complete" && query.recap?.trim()
            ? () => openRecapDialog(query.nodeId)
            : undefined
        }
      />
    ) : null;

  const nothingYet = feed.isSuccess && events.length === 0;

  return (
    <div ref={scrollRef} className="research-reading-surface h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[calc(var(--spacing-feed)+2*clamp(20px,4vw,48px))] flex-col px-[clamp(20px,4vw,48px)] pb-12">
        <div className="flex items-center justify-between gap-2 pt-6 pb-4">
          <h1 className="text-input text-fg-heading m-0 font-semibold">{title}</h1>
        </div>

        {header}

        {undoEntry ? (
          <div
            role="status"
            className="border-border-divider bg-surface-panel my-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="flex-1">Entry removed</span>
            <ControlButton
              size="sm"
              className="gap-1.5"
              onClick={() => {
                const entry = undoEntry;
                setUndoEntry(null);
                void restoreJournalEntry(entry)
                  .then(() => client.invalidateQueries({ queryKey: ["activity"] }))
                  .catch((error: unknown) =>
                    pushErrorToast("The entry could not be restored", error),
                  );
              }}
            >
              <Undo2 size={12} aria-hidden="true" />
              <span>Undo</span>
            </ControlButton>
            <IconButton label="Dismiss undo" onClick={() => setUndoEntry(null)}>
              <X size={12} aria-hidden="true" />
            </IconButton>
          </div>
        ) : null}

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

        <div role="feed" aria-label={title} aria-busy={feed.isFetching}>
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
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    className="flex flex-col gap-1.5 py-5"
                    role="article"
                    aria-posinset={virtualRow.index + 1}
                    aria-setsize={feed.hasNextPage ? -1 : events.length}
                  >
                    {source.kind === "journal" ? (
                      <>
                        <ActivityMetadataLine event={event} className="text-xs" />
                        <JournalEntryCard
                          entry={source.entry}
                          onAction={(action) => runEntryAction(source.entry, action)}
                        />
                      </>
                    ) : (
                      <ResearchQueryCard
                        query={source.query}
                        tree={treeById.get(source.query.treeId)}
                        metadata={<ActivityMetadataLine event={event} />}
                        menuItems={treeMenu(treeById.get(source.query.treeId), source.query)}
                        onOpen={() => openQuery(source.query)}
                        onOpenChild={openQuery}
                        onToggleFollow={() =>
                          setFollowed.mutate({
                            treeId: source.query.treeId,
                            value: !treeById.get(source.query.treeId)?.followed,
                          })
                        }
                        onToggleBookmark={() =>
                          setBookmarked.mutate({
                            treeId: source.query.treeId,
                            value: !treeById.get(source.query.treeId)?.bookmarked,
                          })
                        }
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {nothingYet ? (
            <p className="text-fg-muted m-0 py-4 text-base">
              {bookmarkedOnly
                ? "No bookmarked research yet. Bookmark a research thread to see it here."
                : "No recent activity yet. Run a query or save a source to see it here."}
            </p>
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
              <ControlButton size="sm" onClick={() => void feed.refetch()}>
                Retry
              </ControlButton>
            ) : null}
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
          onRename={(treeId, title) => rename.mutate({ treeId, title })}
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
