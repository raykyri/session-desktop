import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { columnAttributes } from "@session/shared/lib/researchColumns";
import { documentSource, nodeAttachments, nodePrompt, nodeRun, nodeStatus } from "@session/shared/lib/researchNodeTypes";
import { formatRunDuration } from "@session/shared/lib/shortTime";
import { getResearchNodeContent } from "../../lib/api";
import { isEditableTarget } from "../../lib/appHelpers";
import { buildSegmentView, type SegmentView } from "../../lib/researchSegmentView";
import type { ResearchNode } from "../../types";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import { ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";
import { PostContent } from "./ResearchPost";
import { ResearchTimelineItem, runStatusText } from "./ResearchTurn";

// The content of a range selection (src/lib/researchRange.ts): each selected
// message's question and answer, one after another. The view is read-only:
// it renders no `.research-response-content-root` (the text-selection
// toolbar's root, useResearchTextSelection), registers no segment elements
// (highlight painting) and has no margin markers, so a range can be read and
// copied but not highlighted or branched from.

/** The run state of an answer that has no complete response, as one line;
 * null for a complete answer. */
function rangeStateText(node: ResearchNode): string | null {
  const status = nodeStatus(node);
  const run = nodeRun(node);
  if (status === "queued" || status === "starting" || status === "running") return runStatusText(status);
  if (status === "failed") return `Error. ${run?.error ?? "The research run failed."}`;
  if (status === "cancelled") {
    return run?.startedAt
      ? `Stopped after ${formatRunDuration((run.completedAt ?? run.startedAt) - run.startedAt)}. The answer is incomplete.`
      : "Stopped before it started.";
  }
  return null;
}

/** One message of a range: an optional heading (a thread's title, in the
 * feed's range), the question (a note's text; a document shows its heading
 * only), then the answer, its run state, or a spinner while it loads. */
export function ResearchRangeEntry({
  node,
  view,
  heading = null,
  error = null,
}: {
  node: ResearchNode;
  view: SegmentView | null;
  heading?: string | null;
  error?: string | null;
}) {
  const state = rangeStateText(node);
  let question: ReactNode = null;
  if (node.type === "post") {
    question = (
      <ResearchUserMessage className="research-prompt research-range-question">
        <PostContent prompt={nodePrompt(node)} format={node.format ?? "text"} attachments={nodeAttachments(node)} />
      </ResearchUserMessage>
    );
  } else if (node.type !== "document" && nodePrompt(node).trim()) {
    question = (
      <ResearchUserMessage className="research-prompt research-range-question">
        <ResearchMessageBody prompt={nodePrompt(node)} attachments={nodeAttachments(node)} />
      </ResearchUserMessage>
    );
  }
  const items = view?.visibleTimelineItems ?? [];
  return (
    <section className="research-range-entry" aria-label={heading ?? undefined}>
      {heading ? <h3 className="research-range-heading">{heading}</h3> : null}
      {question}
      {node.type === "post" ? null : (
        <div className="research-range-answer">
          {state ? <p className="research-turn-note is-state">{state}</p> : null}
          {error ? (
            <p className="research-response-empty" role="alert">
              {error}
            </p>
          ) : !view ? (
            <div className="research-response-loading">
              <LoaderCircle className="research-spinner" size={18} aria-label="Loading" />
            </div>
          ) : (
            items.map((item) => (
              <ResearchTimelineItem
                key={item.key}
                item={item}
                conversation={view.isConversation}
                imported={documentSource(node) === "imported"}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/** A thread in the feed's range: its id, title and root message. */
interface ResearchFeedRangeTree {
  id: string;
  title: string;
  rootNodeId: string;
}

/** The content column for a range of feed cards: each thread's title, then
 * its root message's question and answer (its follow-ups and branches are
 * not shown). The header names the count and clears the range. */
export function ResearchFeedRangeView({
  trees,
  onClear,
}: {
  trees: readonly ResearchFeedRangeTree[];
  onClear: () => void;
}) {
  // Each root message's content, which carries its node; loaded once per
  // view (the range is short-lived).
  const [loaded, setLoaded] = useState<Record<string, { view: SegmentView } | { error: string }>>({});
  const requestedRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Retry asks for the answers that failed to load again.
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = (nodeId: string) => {
    requestedRef.current.delete(nodeId);
    setLoaded((current) => {
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
    setRetryNonce((nonce) => nonce + 1);
  };
  // Esc clears the range wherever focus is (the thread page that held it
  // has unmounted), unless a field, menu or dialog takes it.
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        isEditableTarget(event.target) ||
        target?.closest("[role='menu'], [role='dialog'], [role='alertdialog'], .popover-surface")
      ) {
        return;
      }
      event.preventDefault();
      onClearRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const rootIds = useMemo(() => trees.map((tree) => tree.rootNodeId), [trees]);
  useEffect(() => {
    for (const nodeId of rootIds) {
      if (requestedRef.current.has(nodeId)) continue;
      requestedRef.current.add(nodeId);
      getResearchNodeContent(nodeId).then(
        (content) => {
          if (!mountedRef.current) return;
          const view = buildSegmentView(content.node, content, true, false);
          setLoaded((current) => ({ ...current, [nodeId]: { view } }));
        },
        (error: unknown) => {
          if (!mountedRef.current) return;
          const message = error instanceof Error ? error.message : String(error);
          setLoaded((current) => ({ ...current, [nodeId]: { error: `Couldn’t load this answer. ${message}` } }));
        },
      );
    }
  }, [retryNonce, rootIds]);
  const title = `${trees.length} threads`;
  return (
    <section
      className="research-placeholder-column research-range-column is-current"
      {...columnAttributes({ id: "placeholder", role: "placeholder" })}
      aria-label={`${trees.length} selected threads`}
    >
      <ResearchPairHeader title={title} clear={{ label: "Clear selection (Esc)", onClear }} />
      <div className="research-column-scroll" tabIndex={-1}>
        <article className="research-answer research-reading-surface research-range">
          {trees.map((tree) => {
            const entry = loaded[tree.rootNodeId];
            const view = entry && "view" in entry ? entry.view : null;
            if (!view) {
              return (
                <section key={tree.id} className="research-range-entry" aria-label={tree.title}>
                  <h3 className="research-range-heading">{tree.title}</h3>
                  {entry && "error" in entry ? (
                    <div className="research-response-loading">
                      <p role="alert">{entry.error}</p>
                      <button className="control-button" type="button" onClick={() => retry(tree.rootNodeId)}>
                        Retry
                      </button>
                    </div>
                  ) : (
                    <div className="research-response-loading">
                      <LoaderCircle className="research-spinner" size={18} aria-label="Loading" />
                    </div>
                  )}
                </section>
              );
            }
            return <ResearchRangeEntry key={tree.id} node={view.node} view={view} heading={tree.title} />;
          })}
        </article>
      </div>
    </section>
  );
}
