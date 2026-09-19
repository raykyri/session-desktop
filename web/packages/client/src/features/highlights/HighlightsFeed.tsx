// The Highlights page (`10-home-feed-journal-encyclopedia.md` §4, ported from
// `ResearchHighlightsFeed.tsx`).
//
// Every saved passage across threads, newest first under day headers in local
// time, each shown inside the prefix/suffix context the anchor captured.
// Opening one selects the thread at that node and asks the document view to
// scroll to the passage (`09` §5).

import type { ResearchHighlightFeedItem } from "@session/shared";
import { useNavigate } from "@tanstack/react-router";
import { Fragment } from "react";

import { useHighlightsFeed } from "../../api/queries.js";
import { formatRelativeTime } from "../../lib/relativeTime.js";
import { ControlButton } from "../../ui/Button.js";

/** "Today", "Yesterday", or a calendar date. Local time, because a highlight
 * belongs to the reader's day rather than to UTC's. */
export function formatHighlightDayLabel(createdAt: number, now = Date.now()): string {
  const day = new Date(createdAt);
  const today = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfDay(today).getTime() - startOfDay(day).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

export interface HighlightDayGroup {
  label: string;
  items: ResearchHighlightFeedItem[];
}

/** Groups the feed into day sections, keeping the server's newest-first order.
 * Items with an unreadable timestamp fall into one trailing group rather than
 * being dropped. */
export function groupHighlightsByDay(
  items: readonly ResearchHighlightFeedItem[],
  now = Date.now(),
): HighlightDayGroup[] {
  const groups: HighlightDayGroup[] = [];
  for (const item of items) {
    const label = Number.isFinite(item.createdAt)
      ? formatHighlightDayLabel(item.createdAt, now)
      : "Earlier";
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

const CONTEXT_CHAR_LIMIT = 140;

/** Trim stored anchor context to a readable excerpt: the tail of the prefix and
 * the head of the suffix, cut at word boundaries. */
export function excerptContext(
  text: string,
  side: "prefix" | "suffix",
  limit = CONTEXT_CHAR_LIMIT,
): string {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= limit) return collapsed;
  if (side === "prefix") {
    const tail = collapsed.slice(-limit);
    const cut = tail.indexOf(" ");
    return cut > 0 ? tail.slice(cut + 1) : tail;
  }
  const head = collapsed.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return cut > 0 ? head.slice(0, cut) : head;
}

export function HighlightsFeed({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const highlights = useHighlightsFeed(workspaceId);
  const items = highlights.data ?? [];
  const groups = groupHighlightsByDay(items);

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

  return (
    <div className="research-reading-surface h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[calc(var(--spacing-feed)+2*clamp(20px,4vw,48px))] flex-col px-[clamp(20px,4vw,48px)] pb-12">
        <div className="flex items-center justify-between gap-2 pt-6 pb-4">
          <h1 className="text-input text-fg-heading m-0 font-semibold">Highlights</h1>
        </div>

        {highlights.isError ? (
          <div className="flex flex-col items-start gap-2 py-4">
            <p className="text-status-failed m-0 text-base" role="alert">
              Highlights could not be loaded.
            </p>
            <ControlButton size="sm" onClick={() => void highlights.refetch()}>
              Retry
            </ControlButton>
          </div>
        ) : items.length === 0 ? (
          <p className="text-fg-muted m-0 py-4 text-base">
            {highlights.isLoading
              ? "Loading highlights…"
              : "No highlights yet. Highlight text in research answers to see it here."}
          </p>
        ) : (
          <div role="feed" aria-label="Highlights" aria-busy={highlights.isFetching}>
            {groups.map((group) => (
              <Fragment key={group.label}>
                <h2 className="text-fg-subtle mt-6 mb-2 text-xs font-normal">{group.label}</h2>
                {group.items.map((item) => {
                  const label =
                    item.nodeLabel && item.nodeLabel !== item.treeTitle
                      ? `${item.treeTitle} › ${item.nodeLabel}`
                      : item.treeTitle;
                  const prefix = excerptContext(item.prefix, "prefix");
                  const suffix = excerptContext(item.suffix, "suffix");
                  return (
                    <article key={item.highlightId} className="border-border-divider border-b py-4">
                      <div
                        role="button"
                        tabIndex={0}
                        title="Open in thread"
                        className="research-prose cursor-pointer text-left"
                        onClick={() => open(item)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          open(item);
                        }}
                      >
                        {prefix ? <span className="text-fg-muted">{`…${prefix}`}</span> : null}
                        <mark className="bg-highlight text-fg-primary">{item.exact}</mark>
                        {suffix ? <span className="text-fg-muted">{`${suffix}…`}</span> : null}
                      </div>
                      <div className="text-fg-subtle mt-2 flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          className="min-w-0 truncate border-0 bg-transparent p-0 text-left underline-offset-2 hover:underline"
                          onClick={() => open(item)}
                        >
                          {label}
                        </button>
                        {Number.isFinite(item.createdAt) ? (
                          <time
                            dateTime={new Date(item.createdAt).toISOString()}
                            title={new Date(item.createdAt).toLocaleString()}
                          >
                            {formatRelativeTime(item.createdAt)}
                          </time>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
