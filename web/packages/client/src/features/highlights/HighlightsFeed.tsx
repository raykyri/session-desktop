// The Highlights page (`10-home-feed-journal.md` §4), ported from the
// desktop `ResearchHighlightsFeed.tsx`: every saved passage, grouped by
// thread under the thread's title, each row the highlighted message's label
// and the passage inside up to 60 characters of its paragraph. Opening one
// selects the thread at that node and scrolls to the passage (`09` §5); ×
// removes it, for a reader who may; Refresh Highlights reads the list again.

import type { ResearchHighlightFeedItem, ResearchTreeSummary } from "@session/shared";
import { RESEARCH_HIGHLIGHT_CONTEXT_LENGTH } from "@session/shared/lib/researchHighlights";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RotateCw, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { removeResearchHighlights } from "../../api/api.js";
import { queryKeys, useHighlightsFeed, useSignedIn } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { pushErrorToast } from "../../lib/toast.js";
import { ControlButton, IconButton } from "../../ui/Button.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

const EXCERPT_CONTEXT_LENGTH = 60;

/** The part of a highlight's stored context shown beside it: within its
 * paragraph, at most 60 characters, cut at a word boundary. `cut` says
 * whether text was left out on that side, which the excerpt marks with "…". */
export function highlightExcerptContext(
  text: string,
  side: "prefix" | "suffix",
): { text: string; cut: boolean } {
  const lines = text.split("\n");
  let context = (side === "prefix" ? lines[lines.length - 1] : lines[0]) ?? "";
  let cut = lines.length === 1 && text.length >= RESEARCH_HIGHLIGHT_CONTEXT_LENGTH;
  context = context.replace(/\s+/g, " ");
  if (context.length > EXCERPT_CONTEXT_LENGTH) {
    cut = true;
    context =
      side === "prefix"
        ? context.slice(-EXCERPT_CONTEXT_LENGTH).replace(/^\S*\s/, "")
        : context.slice(0, EXCERPT_CONTEXT_LENGTH).replace(/\s\S*$/, "");
  } else if (cut) {
    context = side === "prefix" ? context.replace(/^\S*\s/, "") : context.replace(/\s\S*$/, "");
  }
  return { text: context, cut };
}

export interface HighlightThreadGroup {
  treeId: string;
  title: string;
  items: ResearchHighlightFeedItem[];
}

/** Groups highlights by thread. Thread order follows the feed (newest
 * highlight first); each group is sorted by creation time, since feed items
 * carry no position in the thread. */
export function groupHighlightsByThread(
  items: readonly ResearchHighlightFeedItem[],
): HighlightThreadGroup[] {
  const groups = new Map<string, HighlightThreadGroup>();
  for (const item of items) {
    const group = groups.get(item.treeId);
    if (group) group.items.push(item);
    else groups.set(item.treeId, { treeId: item.treeId, title: item.treeTitle, items: [item] });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    items: [...group.items].sort((left, right) => left.createdAt - right.createdAt),
  }));
}

/** Whether the reader may remove a feed highlight (web only). The feed lists
 * the reader's own threads (`highlights.listFeed`), whose owner may remove
 * any highlight; a thread a cached list says the reader does not own is
 * left alone, since the feed row does not say who made the highlight. */
export function mayRemoveFeedHighlight(
  item: Pick<ResearchHighlightFeedItem, "treeId">,
  summaries: readonly ResearchTreeSummary[],
): boolean {
  const role = summaries.find((summary) => summary.id === item.treeId)?.role;
  return role === undefined || role === "owner";
}

export function HighlightsFeed({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const signedIn = useSignedIn();
  const highlights = useHighlightsFeed(workspaceId);
  const items = useMemo(() => highlights.data ?? [], [highlights.data]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement | null>(null);
  // After removing a focused highlight, focus moves to its successor, the
  // last row, or Refresh when no rows remain.
  const removedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const index = removedIndexRef.current;
    const active = document.activeElement;
    if (index === null || (active && active !== document.body && active.isConnected)) return;
    removedIndexRef.current = null;
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("[data-highlight-open]") ?? []),
    ];
    (rows[Math.min(index, rows.length - 1)] ?? refreshRef.current)?.focus({ preventScroll: true });
  }, [items]);

  const summaries = (): ResearchTreeSummary[] =>
    client
      .getQueriesData<ResearchTreeSummary[]>({ queryKey: ["trees"] })
      .flatMap(([, data]) => data ?? []);

  const open = (item: ResearchHighlightFeedItem) => {
    void navigate({
      to: "/r/$treeId",
      params: { treeId: item.treeId },
      search: {
        node: item.nodeId,
        highlight: item.highlightId,
        ...(workspaceId === "" ? {} : { ws: workspaceId }),
      },
    });
  };

  const remove = (item: ResearchHighlightFeedItem) => {
    void removeResearchHighlights(item.nodeId, [item.highlightId])
      .then(() => {
        // The `research.highlights.removed` event drops the row too; this
        // keeps the list right when the stream is down.
        client.setQueryData<ResearchHighlightFeedItem[]>(
          queryKeys.highlightsFeed(workspaceId),
          (current) => current?.filter((entry) => entry.highlightId !== item.highlightId),
        );
      })
      .catch((failure: unknown) => pushErrorToast("Couldn’t remove the highlight", failure));
  };

  const refresh = () => void highlights.refetch();

  return (
    <div className="bg-surface-feed relative flex h-full min-h-0 flex-col">
      <header className="border-border-divider flex min-h-11 shrink-0 items-center gap-1 border-b py-2 pr-3 pl-4">
        <h1 className="text-fg-heading m-0 min-w-0 flex-1 text-[length:calc(var(--fs-base)+1px)] font-semibold">
          Highlights
        </h1>
        <IconButton ref={refreshRef} label="Refresh Highlights" onClick={refresh}>
          <RotateCw size={14} aria-hidden="true" />
        </IconButton>
      </header>
      <div className="research-reading-surface min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-feed mx-auto flex w-full flex-col pb-6">
          {highlights.isError ? (
            <div className="text-fg-muted flex flex-col items-center gap-3 px-4 py-10 text-center text-sm">
              <p className="m-0" role="alert">
                {highlights.error instanceof Error
                  ? highlights.error.message
                  : "Couldn’t load highlights."}
              </p>
              <ControlButton size="sm" onClick={refresh}>
                Retry
              </ControlButton>
            </div>
          ) : items.length === 0 ? (
            <div className="text-fg-muted px-4 py-10 text-center text-sm">
              {highlights.isLoading
                ? "Loading highlights…"
                : "No highlights. Select text in an answer and choose Highlight."}
            </div>
          ) : (
            <div
              ref={listRef}
              role="feed"
              aria-label="Highlights"
              aria-busy={highlights.isFetching}
            >
              {groupHighlightsByThread(items).map((group) => (
                <section
                  key={group.treeId}
                  aria-label={group.title}
                  className="border-border-divider border-b px-3.5 py-3"
                >
                  <div className="text-fg-muted mb-1.5 truncate text-sm">{group.title}</div>
                  {group.items.map((item) => {
                    const prefix = highlightExcerptContext(item.prefix, "prefix");
                    const suffix = highlightExcerptContext(item.suffix, "suffix");
                    const turn =
                      item.nodeLabel && item.nodeLabel !== item.treeTitle ? item.nodeLabel : null;
                    const removable = signedIn && mayRemoveFeedHighlight(item, summaries());
                    return (
                      <article key={item.highlightId} className="group/highlight relative">
                        <button
                          type="button"
                          data-highlight-open=""
                          className={cn(
                            "text-fg-muted flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-sm border-0 bg-transparent px-0 py-1 text-left",
                            "text-[length:calc(var(--fs-base)+0.5px)] leading-[1.6] [overflow-wrap:anywhere]",
                            removable && "pr-8",
                            FOCUS_RING,
                          )}
                          title={
                            Number.isFinite(item.createdAt)
                              ? `Highlighted ${new Date(item.createdAt).toLocaleString()}`
                              : undefined
                          }
                          onClick={() => open(item)}
                        >
                          {turn ? (
                            <span className="text-fg-subtle truncate text-sm">
                              {turn.split("\n")[0]}
                            </span>
                          ) : null}
                          <span>
                            {prefix.text || prefix.cut ? (
                              <span className="group-hover/highlight:text-fg-secondary">
                                {`${prefix.cut ? "…" : ""}${prefix.text}`}
                              </span>
                            ) : null}
                            <mark className="bg-highlight group-hover/highlight:bg-highlight-hover text-fg-primary rounded-[2px] [box-decoration-break:clone]">
                              {item.exact}
                            </mark>
                            {suffix.text || suffix.cut ? (
                              <span className="group-hover/highlight:text-fg-secondary">
                                {`${suffix.text}${suffix.cut ? "…" : ""}`}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        {removable ? (
                          <IconButton
                            label="Remove highlight"
                            className={cn(
                              "border-border-strong bg-surface-feed-popover shadow-popover absolute top-0.5 right-0 z-[1] size-6 rounded-[7px] border opacity-0",
                              "group-focus-within/highlight:opacity-85 group-hover/highlight:opacity-85",
                            )}
                            onClick={(event) => {
                              const rows = [
                                ...(listRef.current?.querySelectorAll("article") ?? []),
                              ];
                              removedIndexRef.current = rows.indexOf(
                                event.currentTarget.closest("article") as HTMLElement,
                              );
                              remove(item);
                            }}
                          >
                            <X size={14} aria-hidden="true" />
                          </IconButton>
                        ) : null}
                      </article>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
