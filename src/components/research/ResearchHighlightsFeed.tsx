import { useEffect, useRef } from "react";
import { RotateCw, X } from "lucide-react";
import type { ResearchHighlightFeedItem } from "../../types";
import { RESEARCH_HIGHLIGHT_CONTEXT_LENGTH } from "@session/shared/lib/researchHighlights";
import { ResearchFeedHeader, ResearchFeedScrollThumb } from "./ResearchFeedChrome";

export interface ResearchHighlightsFeedProps {
  items: ResearchHighlightFeedItem[];
  loading: boolean;
  error: string | null;
  onOpen: (item: ResearchHighlightFeedItem) => void;
  onRemove?: (item: ResearchHighlightFeedItem) => void;
  onRefresh: () => void;
}

const EXCERPT_CONTEXT_LENGTH = 60;

/** The part of a highlight's stored context shown beside it: within its
 * paragraph, at most 60 characters, cut at a word boundary. `cut` says
 * whether text was left out on that side, which the excerpt marks with "…". */
export function highlightExcerptContext(
  text: string,
  side: "prefix" | "suffix",
): { text: string; cut: boolean } {
  const lines = text.split("\n");
  let context = side === "prefix" ? lines[lines.length - 1] : lines[0];
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

/** Group highlights by thread. Preserve thread order from the feed and sort
 * each group by creation time because feed items contain no turn position. */
export function groupHighlightsByThread(items: ResearchHighlightFeedItem[]) {
  const groups = new Map<string, { treeId: string; title: string; items: ResearchHighlightFeedItem[] }>();
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

/** Highlights grouped by thread with surrounding text. Opening a highlight
 * selects its node and scrolls to the passage. */
export default function ResearchHighlightsFeed({
  items,
  loading,
  error,
  onOpen,
  onRemove,
  onRefresh,
}: ResearchHighlightsFeedProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // After removing a focused highlight, focus its successor, the final row,
  // or Refresh when no rows remain.
  const removedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const index = removedIndexRef.current;
    const active = document.activeElement;
    if (index === null || (active && active !== document.body && active.isConnected)) return;
    removedIndexRef.current = null;
    const root = scrollRef.current?.parentElement;
    const rows = [...(root?.querySelectorAll<HTMLElement>(".research-highlight-open") ?? [])];
    (rows[Math.min(index, rows.length - 1)] ??
      root?.querySelector<HTMLElement>('[aria-label="Refresh Highlights"]'))?.focus({
      preventScroll: true,
    });
  }, [items]);
  return (
    <div className="research-feed">
      <ResearchFeedHeader
        title="Highlights"
        actions={
          <button
            type="button"
            className="research-feed-icon-button"
            onClick={onRefresh}
            aria-label="Refresh Highlights"
            title="Refresh Highlights"
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
        }
      />
      <div ref={scrollRef} className="research-feed-scroll" data-research-scroll>
        <div className="research-feed-column-body research-reading-surface">
          {error ? (
            <div className="research-feed-empty is-padded">
              <p role="alert">{error}</p>
              <button
                type="button"
                className="control-button recent-activity-load-older"
                onClick={onRefresh}
              >
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="research-feed-empty is-padded">
              {loading
                ? "Loading highlights…"
                : "No highlights. Select text in an answer and choose Highlight."}
            </div>
          ) : (
            <div role="feed" aria-label="Highlights" aria-busy={loading}>
              {groupHighlightsByThread(items).map((group) => (
                <section key={group.treeId} className="research-highlight-group">
                  <div className="research-highlight-source">{group.title}</div>
                  {group.items.map((item) => {
                    const prefix = highlightExcerptContext(item.prefix, "prefix");
                    const suffix = highlightExcerptContext(item.suffix, "suffix");
                    const turn = item.nodeLabel && item.nodeLabel !== item.treeTitle ? item.nodeLabel : null;
                    return (
                      <article key={item.highlightId} className="research-highlight-item">
                        <button
                          type="button"
                          className="research-highlight-open"
                          title={
                            Number.isFinite(item.createdAt)
                              ? `Highlighted ${new Date(item.createdAt).toLocaleString()}`
                              : undefined
                          }
                          onClick={() => onOpen(item)}
                        >
                          {turn ? (
                            <span className="research-highlight-turn">{turn.split("\n")[0]}</span>
                          ) : null}
                          <span className="research-highlight-excerpt">
                            {prefix.text || prefix.cut ? (
                              <span className="research-highlight-context">
                                {`${prefix.cut ? "…" : ""}${prefix.text}`}
                              </span>
                            ) : null}
                            <mark className="research-highlight-mark">{item.exact}</mark>
                            {suffix.text || suffix.cut ? (
                              <span className="research-highlight-context">
                                {`${suffix.text}${suffix.cut ? "…" : ""}`}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        {onRemove ? (
                          <button
                            type="button"
                            className="research-feed-icon-button research-highlight-remove"
                            title="Remove highlight"
                            aria-label="Remove highlight"
                            onClick={(event) => {
                              const rows = [
                                ...(scrollRef.current?.querySelectorAll(".research-highlight-item") ?? []),
                              ];
                              removedIndexRef.current = rows.indexOf(
                                event.currentTarget.closest(".research-highlight-item") as Element,
                              );
                              onRemove(item);
                            }}
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
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
      <ResearchFeedScrollThumb scrollRef={scrollRef} />
    </div>
  );
}
