import { useRef } from "react";
import { RotateCw, X } from "lucide-react";
import type { ResearchHighlightFeedItem } from "../../types";
import { ResearchFeedHeader, ResearchFeedScrollThumb } from "./ResearchFeedChrome";

export interface ResearchHighlightsFeedProps {
  items: ResearchHighlightFeedItem[];
  loading: boolean;
  error: string | null;
  onOpen: (item: ResearchHighlightFeedItem) => void;
  onRemove?: (item: ResearchHighlightFeedItem) => void;
  onRefresh: () => void;
}

/** Anchors store up to this many characters of context on each side,
 * clamped to the message (ResearchDocument's RESEARCH_HIGHLIGHT_CONTEXT_LENGTH). */
const STORED_CONTEXT_LENGTH = 128;
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
  let cut = lines.length === 1 && text.length >= STORED_CONTEXT_LENGTH;
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

/** Groups highlights by thread, threads in the order their newest highlight
 * appears; within a thread, highlights in the order they were made, which
 * follows the reading order for most threads (the feed items carry no turn
 * position). */
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

/** The Highlights view in the feed column: saved passages grouped by thread,
 * each under the question it answers and shown inside its surrounding
 * sentence. Opening one selects the thread at that node and scrolls to the
 * passage; the remove button deletes the highlight. */
export default function ResearchHighlightsFeed({
  items,
  loading,
  error,
  onOpen,
  onRemove,
  onRefresh,
}: ResearchHighlightsFeedProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
                            onClick={() => onRemove(item)}
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
