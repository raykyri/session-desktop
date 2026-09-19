// A segment's answer (`09-research-document-view.md` §2, §7).
//
// Everything about one node's response lives here: its loading and failure
// states, the recap, the collapsed-fold empty-state cascade, the "show earlier"
// window, the selection root the highlight machinery measures against, the
// sources, the status line with its Cancel link while the run is active, and
// the footer (word count, duration, hidden-highlight notice, copy, and the
// answer menu).
//
// It is memoized apart from its segment's rail: a follow-up card streaming a
// preview in the margin must not rebuild the answer's element tree or re-run
// its Markdown renderers.

import type { ResearchNode, ResearchNodeContent, Turn } from "@session/shared";
import { Copy, LoaderCircle, MoreHorizontal, RefreshCw } from "lucide-react";
import { memo, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { ControlButton, IconButton, LinkButton } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Menu } from "../../ui/Menu.js";
import { QueryState } from "../../ui/QueryState.js";
import { METADATA_LINE } from "../../ui/surfaces.js";

import { SourcesFooter } from "./SourcesFooter.js";
import { TimelineItem } from "./TimelineItem.js";
import { RESPONSE_ROOT_ATTRIBUTE } from "./selection/dom.js";
import { answerEmptyStateText } from "./timeline.js";
import type { SegmentView } from "./timeline.js";

/** The one-line summary under a settled answer. Rendered only for a run that
 * completed and whose recap was generated against the revision on screen, so a
 * stale summary can never describe a re-run answer (09 §2). */
export function Recap({
  content,
  pending,
}: {
  content: ResearchNodeContent | undefined;
  pending: boolean;
}) {
  const node = content?.node;
  if (!content || !node || (node.kind ?? "run") !== "run" || node.status !== "complete")
    return null;
  const recap = node.recap;
  if (
    !recap?.text.trim() ||
    !content.responseRevision ||
    recap.responseRevision !== content.responseRevision
  ) {
    return pending ? (
      <p
        className="research-summary-text mb-7"
        role="status"
        aria-label="Generating summary"
        title="Generating summary"
      >
        <LoaderCircle className="session-spin" size={13} aria-hidden="true" />
      </p>
    ) : null;
  }
  return <p className="research-summary-text mb-8">Summary: {recap.text.trim()}</p>;
}

export interface AnswerPaneProps {
  view: SegmentView;
  node: ResearchNode;
  turns: readonly Turn[];
  /** Null until the snapshot lands; a string when the read failed. */
  contentError: string | null;
  contentLoading: boolean;
  /** `queued` or `running`. */
  segmentActive: boolean;
  /** Position in the admission queue while `queued`; 0 means claimed. */
  queuePosition: number | undefined;
  /** The model is reasoning rather than writing (`research.run.thinking`). */
  thinking: boolean;
  durationText: string | null;
  hiddenHighlightCount: number;
  recapPending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canRetryNode: boolean;
  retryingNode: boolean;
  pointerOverHighlight: boolean;
  /** Rows for the answer's `⋯` menu, supplied by the page. */
  menuItems: ReactNode;
  registerRoot: (element: HTMLElement | null) => void;
  onExpandTurns: (nodeId: string) => void;
  onShowFullTrace: (nodeId: string) => void;
  onRetryContentLoad: () => void;
  onCopyAnswer: () => void;
  onCancelNode: (nodeId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onRootMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootKeyUp: () => void;
  onRootClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseLeave: () => void;
}

export const AnswerPane = memo(function AnswerPane({
  view,
  node,
  turns,
  contentError,
  contentLoading,
  segmentActive,
  queuePosition,
  thinking,
  durationText,
  hiddenHighlightCount,
  recapPending,
  cancelling,
  canCancel,
  canRetryNode,
  retryingNode,
  pointerOverHighlight,
  menuItems,
  registerRoot,
  onExpandTurns,
  onShowFullTrace,
  onRetryContentLoad,
  onCopyAnswer,
  onCancelNode,
  onRetryNode,
  onRootMouseDown,
  onRootMouseUp,
  onRootKeyUp,
  onRootClick,
  onRootMouseMove,
  onRootMouseLeave,
}: AnswerPaneProps) {
  const retryButton = canRetryNode ? (
    <ControlButton size="sm" disabled={retryingNode} onClick={() => onRetryNode(node.id)}>
      {retryingNode ? (
        <>
          <LoaderCircle className="session-spin" size={12} aria-hidden="true" />
          <span>Retrying…</span>
        </>
      ) : (
        <>
          <RefreshCw size={12} aria-hidden="true" />
          <span>Retry</span>
        </>
      )}
    </ControlButton>
  ) : null;

  const noContent = (contentLoading || Boolean(contentError)) && view.timelineItems.length === 0;
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const emptyStateText = answerEmptyStateText({
    node,
    sourceError: view.content?.sourceError,
    hasAnyTimelineItem: view.timelineItems.length > 0,
  });

  return (
    <section className="min-w-0" aria-label="Answer">
      {noContent ? (
        <QueryState
          loading={!contentError}
          loadingLabel="Loading answer…"
          error={contentError ? `Couldn’t load the answer: ${contentError}` : undefined}
          onRetry={onRetryContentLoad}
        />
      ) : (
        <>
          {contentError ? (
            <QueryState
              className="py-0 pb-3"
              error={`Couldn’t refresh the answer: ${contentError}`}
              onRetry={onRetryContentLoad}
            />
          ) : null}
          {node.status === "failed" && view.timelineItems.length > 0 ? (
            <div className="mb-3 flex flex-col items-start gap-2" role="alert">
              <p className="text-status-failed m-0 text-sm">{node.error ?? "The run failed."}</p>
              {retryButton}
            </div>
          ) : null}
          <Recap content={view.content} pending={recapPending} />
          {view.displayedTimelineItems.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              {emptyStateText === null ? null : (
                <p className="text-fg-muted m-0 text-sm">{emptyStateText}</p>
              )}
              {node.status === "failed" ||
              node.status === "cancelled" ||
              node.status === "interrupted"
                ? retryButton
                : null}
            </div>
          ) : (
            <>
              {view.hiddenTimelineItemCount > 0 ? (
                <ControlButton size="sm" className="mb-3" onClick={() => onExpandTurns(node.id)}>
                  Show {view.hiddenTimelineItemCount} earlier message
                  {view.hiddenTimelineItemCount === 1 ? "" : "s"}
                </ControlButton>
              ) : null}
              {/* The selection root: the `answer-v1` projection is exactly this
                  element's `textContent` (09 §5 item 4). */}
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div
                ref={registerRoot}
                {...{ [RESPONSE_ROOT_ATTRIBUTE]: node.id }}
                className={cn(
                  // `relative` is the fallback highlight layer's positioning
                  // context (`selection/painting.ts`).
                  "relative flex min-w-0 flex-col gap-2",
                  pointerOverHighlight && "cursor-pointer",
                )}
                onMouseDown={onRootMouseDown}
                onMouseUp={onRootMouseUp}
                onKeyUp={onRootKeyUp}
                onClick={onRootClick}
                onMouseMove={onRootMouseMove}
                onMouseLeave={onRootMouseLeave}
              >
                {view.visibleTimelineItems.map((item) => (
                  <TimelineItem key={item.key} item={item} />
                ))}
              </div>
            </>
          )}
          {segmentActive ? (
            <p className="text-fg-muted mt-2 flex items-center gap-1.5 text-sm" role="status">
              <span
                className="bg-status-active session-thinking-dot size-1.5 rounded-full"
                aria-hidden="true"
              />
              {/* One line for the whole active state: the queue position while
                  the run waits behind others, then what it is doing. A separate
                  "Queued" line above this one only restated it. */}
              <span>
                {queuePosition !== undefined && queuePosition > 0
                  ? `Queued · ${queuePosition} ahead`
                  : thinking
                    ? "Thinking…"
                    : "Working…"}
              </span>
              {durationText ? <span>· {durationText}</span> : null}
              {canCancel ? (
                <LinkButton
                  className="ml-1.5"
                  disabled={cancelling}
                  onClick={() => setConfirmingCancel(true)}
                >
                  {cancelling ? "Cancelling…" : "Cancel"}
                </LinkButton>
              ) : null}
            </p>
          ) : null}
          <ConfirmDialog
            open={confirmingCancel}
            onOpenChange={(next) => {
              if (!next) setConfirmingCancel(false);
            }}
            title="Cancel this run?"
            description="The run stops within a second. Any partial answer stays readable."
            confirmLabel="Cancel run"
            cancelLabel="Keep running"
            tone="danger"
            onConfirm={() => {
              setConfirmingCancel(false);
              onCancelNode(node.id);
            }}
          />
          {node.status === "complete" ? <SourcesFooter turns={turns} /> : null}
          {/* An in-flight run has nothing to meter: the word count is 0 or
              mid-stream, and copy/retry apply to a settled answer. The status
              line above already reports the run, so the footer waits for it to
              settle; the segment's context menu still carries the ⋯ rows. */}
          {segmentActive ? null : (
            <footer
              className={cn(
                "text-fg-subtle min-h-control-sm mt-5 flex flex-wrap items-center gap-x-3 gap-y-1.5",
                METADATA_LINE,
              )}
            >
              <span>
                {view.answerWordCount.toLocaleString()}{" "}
                {view.answerWordCount === 1 ? "word" : "words"}
              </span>
              {durationText ? <span>{durationText}</span> : null}
              {hiddenHighlightCount > 0 ? (
                <span title="These highlights are in collapsed or hidden sections.">
                  {hiddenHighlightCount} hidden{" "}
                  {hiddenHighlightCount === 1 ? "highlight" : "highlights"}
                  {view.hasTranscriptActivity && !view.showFullTrace ? (
                    <>
                      {" · "}
                      <LinkButton onClick={() => onShowFullTrace(node.id)}>
                        Show full transcript
                      </LinkButton>
                    </>
                  ) : null}
                </span>
              ) : null}
              <span className="flex items-center gap-0.5">
                {node.status === "complete" && view.rawAnswer ? (
                  <IconButton label="Copy answer as Markdown" onClick={onCopyAnswer}>
                    <Copy size={14} aria-hidden="true" />
                  </IconButton>
                ) : null}
                {menuItems ? (
                  <Menu
                    label="Answer actions"
                    align="end"
                    trigger={
                      <IconButton label="Answer actions">
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </IconButton>
                    }
                  >
                    {menuItems}
                  </Menu>
                ) : null}
              </span>
            </footer>
          )}
        </>
      )}
    </section>
  );
});
