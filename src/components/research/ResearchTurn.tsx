import { memo, useCallback, useLayoutEffect, useState } from "react";
import {
  LoaderCircle,
  MoreHorizontal,
  RotateCcw,
  Square,
  Star,
  Wrench,
} from "lucide-react";
import { ResearchBranchIcon } from "./ResearchIcons";
import {
  conversationActivityToolCalls,
  conversationToolCallLabel,
} from "../../lib/researchConversations";
import { stripImportedReportCitations } from "../../lib/researchDocuments";
import { formatRunDuration, shortWhen } from "../../lib/shortTime";
import { latestToolActivityLabel, type MessageBlock, type MessageItem } from "../../lib/turnTimeline";
import type { ResearchNode, ResearchNodeContent } from "../../types";
import {
  RawTranscriptDisclosure,
  TranscriptActivityItem,
  timelineContextStatusClass,
  timelineStatusClass,
} from "../TranscriptActivity";
import ResearchRecap from "./ResearchRecap";
import { ResearchMarkdown, ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";

// The backend caps snapshots at 64MB, which is still far beyond what markdown
// parsing and eager React element creation can absorb without freezing the
// interface. Blocks past this size render as plain preformatted text — itself
// display-capped, since laying out a multi-megabyte text node freezes the interface
// too — and long transcripts render only their tail until expanded.
const MARKDOWN_CHAR_LIMIT = 100_000;
const PLAINTEXT_DISPLAY_CHAR_LIMIT = 1_000_000;
const ACTIVITY_PAYLOAD_CHAR_LIMIT = 200_000;
// Hoisted so the memoized markdown renderer sees a stable prop identity — an
// inline object literal would defeat its render cache on every poll.
const OVERSIZED_MARKDOWN_POLICY = {
  maxCharacters: MARKDOWN_CHAR_LIMIT,
  maxDisplayCharacters: PLAINTEXT_DISPLAY_CHAR_LIMIT,
  fallbackClassName: "research-plaintext",
} as const;
/** A clamped answer shows nine lines of body text, as
 * `.research-answer-clamp.is-clamped` in research.css does. */
const ANSWER_CLAMP_LINES = 9;
const ANSWER_MAX_LENGTH_DOTS = 12;

/** Content-derived render state for one turn, cached per node so the whole
 * view identity survives detail replacements — which is what lets the turn's
 * memo and the markdown renderer's cache hold. `node` is the node as of the
 * last content/toggle change and MAY BE STALE on volatile fields (status,
 * error, timestamps); consumers needing fresh metadata take the live node
 * separately. */
export interface SegmentView {
  node: ResearchNode;
  content: ResearchNodeContent | null;
  isDocument: boolean;
  isConversation: boolean;
  showAllTurns: boolean;
  showFullTrace: boolean;
  timelineItems: MessageItem[];
  displayedTimelineItems: MessageItem[];
  visibleTimelineItems: MessageItem[];
  hiddenTimelineItemCount: number;
  hasTranscriptActivity: boolean;
  rawAnswer: string;
  conversationCopyText: string | null;
  answerWordCount: number;
  editableDocumentMarkdown: string | null;
}

export type SegmentDomKind = "anchor" | "root";

function unexpectedRoleLabel(role: string) {
  if (role === "system") {
    return "System content";
  }
  if (role === "user") {
    return "Additional user content";
  }
  return `${role || "Unknown"} content`;
}

function ResearchMessageBlock({
  block,
  role,
  conversation = false,
  imported = false,
}: {
  block: MessageBlock;
  role: string;
  conversation?: boolean;
  imported?: boolean;
}) {
  if (block.type === "text") {
    // In a conversation node every turn is first-class content: user
    // messages render as markdown prompts, not as unexpected-content
    // callouts (that framing exists for run responses, where a mid-response
    // user turn signals leakage).
    if (role === "assistant" || conversation) {
      return (
        <ResearchMarkdown
          text={imported ? stripImportedReportCitations(block.text) : block.text}
          oversizedContent={imported ? undefined : OVERSIZED_MARKDOWN_POLICY}
        />
      );
    }
    return <p className="research-unexpected-text">{block.text}</p>;
  }
  return (
    <RawTranscriptDisclosure
      value={block.value}
      maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
      deferPayload
      className="research-activity"
    />
  );
}

// Memoized on item identity: the tree detail is replaced by every research
// event (4×/s while any run in the tree streams), and without the memo each
// replacement re-rendered — and re-parsed the markdown of — every visible
// item. Item identities are stable across detail replacements because they
// derive from `content`, which only changes when this node's fetch completes.
export const ResearchTimelineItem = memo(function ResearchTimelineItem({
  item,
  conversation = false,
  imported = false,
}: {
  item: MessageItem;
  conversation?: boolean;
  imported?: boolean;
}) {
  if (conversation) {
    return (
      <section
        className={`research-response-item role-${item.role} is-conversation${timelineContextStatusClass(
          item.contextStatus,
        )}`}
        data-timeline-key={item.key}
      >
        {item.contextStatus === "rolledBack" ? (
          <div className="turn-context-status">Excluded from active context</div>
        ) : null}
        {item.blocks.length > 0 && item.role === "user" ? (
          <ResearchUserMessage
            className={`research-response-message research-conversation-prompt research-prompt${timelineStatusClass(item.status)}`}
          >
            {item.blocks.map((block, index) => (
              <ResearchMessageBlock
                key={`${item.key}-${index}`}
                block={block}
                role={item.role}
                conversation
              />
            ))}
          </ResearchUserMessage>
        ) : item.blocks.length > 0 ? (
          <div className={`research-response-message${timelineStatusClass(item.status)}`}>
            {item.blocks.map((block, index) => (
              <ResearchMessageBlock
                key={`${item.key}-${index}`}
                block={block}
                role={item.role}
                conversation
              />
            ))}
          </div>
        ) : null}
        {item.activities.map((activity) => {
          // Render export activity markers (collapsed tool calls) as chips.
          // Archives are only shape-validated, so unexpected activity types
          // use the standard activity disclosure.
          const toolCalls = conversationActivityToolCalls(activity);
          if (toolCalls === null) {
            return (
              <TranscriptActivityItem
                key={activity.key}
                item={activity}
                className="research-activity"
                isRootActivity
                maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
                deferPayloads
                showResultTokenCount={false}
              />
            );
          }
          // If the marker count is malformed, omit the number from the chip
          // but still show that tool activity occurred.
          return (
            <div key={activity.key} className="research-conversation-activity">
              <Wrench size={12} aria-hidden="true" />
              <span>{conversationToolCallLabel(toolCalls)}</span>
            </div>
          );
        })}
      </section>
    );
  }
  const hasUnexpectedContent = item.role !== "assistant" && item.blocks.length > 0;
  return (
    <section
      className={`research-response-item role-${item.role}${timelineContextStatusClass(
        item.contextStatus,
      )}`}
      data-timeline-key={item.key}
    >
      {item.contextStatus === "rolledBack" ? (
        <div className="turn-context-status">Excluded from active context</div>
      ) : null}
      {item.blocks.length > 0 ? (
        <div
          className={`research-response-message${
            hasUnexpectedContent ? " research-unexpected-content" : ""
          }${timelineStatusClass(item.status)}`}
        >
          {hasUnexpectedContent ? <span>{unexpectedRoleLabel(item.role)}</span> : null}
          {item.blocks.map((block, index) => (
            <ResearchMessageBlock
              key={`${item.key}-${index}`}
              block={block}
              role={item.role}
              imported={imported}
            />
          ))}
        </div>
      ) : null}
      {item.activities.map((activity) => (
        <TranscriptActivityItem
          key={activity.key}
          item={activity}
          className="research-activity"
          isRootActivity
          maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
          deferPayloads
          showResultTokenCount={false}
        />
      ))}
    </section>
  );
});

/** Measures a clamped answer: whether it overflows the nine-line clamp and how
 * many clamp heights its content takes (the length dots). */
function useAnswerLength(enabled: boolean) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [length, setLength] = useState({ overflows: false, pages: 1, shown: 1 });
  useLayoutEffect(() => {
    if (!enabled || !element) {
      return;
    }
    const measure = () => {
      const prose = element.querySelector<HTMLElement>(".research-prose") ?? element;
      const lineHeight = Number.parseFloat(getComputedStyle(prose).lineHeight);
      const clampHeight = ANSWER_CLAMP_LINES * (Number.isFinite(lineHeight) ? lineHeight : 22);
      const total = element.scrollHeight;
      const overflows = total > clampHeight + 4;
      const pages = Math.min(ANSWER_MAX_LENGTH_DOTS, Math.max(1, Math.ceil(total / clampHeight)));
      const shown = total > 0 ? Math.min(1, clampHeight / total) : 1;
      setLength((current) =>
        current.overflows === overflows && current.pages === pages && current.shown === shown
          ? current
          : { overflows, pages, shown },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled]);
  return { setContentElement: setElement, ...length };
}

function sameTurnNode(a: ResearchNode, b: ResearchNode) {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.error === b.error &&
    a.paneId === b.paneId &&
    a.parentNodeId === b.parentNodeId &&
    a.prompt === b.prompt &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.createdAt === b.createdAt &&
    a.promotedAt === b.promotedAt &&
    a.adapter === b.adapter &&
    a.model === b.model &&
    a.origin === b.origin
  );
}

/** Compare node metadata by field and all other props by identity to skip
 * renders when the displayed data is unchanged. New props automatically
 * use identity comparison. */
function propsEqualExceptNode<T extends { node: ResearchNode }>(prev: T, next: T) {
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (key === "node") {
      continue;
    }
    if (!Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return sameTurnNode(prev.node, next.node);
}

interface ResearchAnswerPaneProps {
  view: SegmentView;
  node: ResearchNode;
  contentError: string | null;
  cancelling: boolean;
  /** Elapsed clock for an active run ("1:08"), ticking once a second. */
  elapsedText: string | null;
  /** A queued run whose parent's answer is still running. */
  waitsForParent: boolean;
  recapPending: boolean;
  pointerOverAnnotation: boolean;
  expanded: boolean;
  canRetry: boolean;
  retrying: boolean;
  canEditQuestion: boolean;
  registerSegmentElement: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
  onExpandTurns: (nodeId: string) => void;
  onRetryContentLoad: () => void;
  onToggleFullTrace: (nodeId: string) => void;
  onCancelNode: (nodeId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onEditQuestion: (nodeId: string) => void;
  onToggleAnswer: (nodeId: string) => void;
  onRootMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootKeyUp: () => void;
  onRootClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootMouseLeave: () => void;
}

/** The status line of an active run: "Working", with the run's latest tool
 * activity when it has one ("Working · reading lesswrong.com"). */
export function runStatusText(
  node: Pick<ResearchNode, "status">,
  waitsForParent: boolean,
  activity: string | null = null,
) {
  if (node.status === "running") {
    return activity ? `Working · ${activity}` : "Working";
  }
  if (node.status === "starting") {
    return "Starting…";
  }
  return waitsForParent ? "Queued. Starts when the running answer finishes." : "Queued";
}

/** The answer side of a turn. Finished answers are clamped to nine lines with
 * a fade (the pointer expand target) and length dots (the keyboard control,
 * which also collapses); running answers stream unclamped under a status line
 * with the elapsed time and Stop. Isolated behind its own memo so the
 * question's meta row (branch counts, star) can change without rebuilding the
 * answer's timeline element tree. */
const ResearchAnswerPane = memo(function ResearchAnswerPane({
  view,
  node,
  contentError,
  cancelling,
  elapsedText,
  waitsForParent,
  recapPending,
  pointerOverAnnotation,
  expanded,
  canRetry,
  retrying,
  canEditQuestion,
  registerSegmentElement,
  onExpandTurns,
  onRetryContentLoad,
  onToggleFullTrace,
  onCancelNode,
  onRetryNode,
  onEditQuestion,
  onToggleAnswer,
  onRootMouseDown,
  onRootMouseUp,
  onRootKeyUp,
  onRootClick,
  onRootMouseMove,
  onRootMouseLeave,
}: ResearchAnswerPaneProps) {
  const active = node.status === "queued" || node.status === "starting" || node.status === "running";
  const lingeringPane = node.status === "cancelled" && Boolean(node.paneId);
  // Documents and conversations are the content itself, not an answer to a
  // question, so they are never clamped.
  const clampable =
    node.status === "complete" && !view.isDocument && !view.isConversation && !view.showFullTrace;
  const clamped = clampable && !expanded;
  const { setContentElement, overflows, pages, shown } = useAnswerLength(clampable);
  // Stable, so React does not detach and reattach the root on every render.
  const nodeId = node.id;
  const contentRootRef = useCallback(
    (element: HTMLDivElement | null) => {
      setContentElement(element);
      registerSegmentElement(nodeId, "root", element);
    },
    [nodeId, registerSegmentElement, setContentElement],
  );
  const retryButton = (label: string) =>
    canRetry ? (
      <button
        className="control-button research-turn-button"
        type="button"
        // Not disabled: a failed retry would otherwise drop focus.
        aria-disabled={retrying || undefined}
        onClick={() => {
          if (!retrying) onRetryNode(node.id);
        }}
      >
        {retrying ? (
          <LoaderCircle className="research-spinner" size={13} aria-hidden="true" />
        ) : (
          <RotateCcw size={13} aria-hidden="true" />
        )}
        <span>{retrying ? "Retrying…" : label}</span>
      </button>
    ) : null;
  const stopButton = (label: string) => (
    <button
      className="control-button research-turn-button is-ghost"
      type="button"
      disabled={cancelling}
      onClick={() => onCancelNode(node.id)}
    >
      <Square size={12} aria-hidden="true" />
      <span>{cancelling ? "Stopping…" : label}</span>
    </button>
  );

  // A queued run (waiting for its turn on the backend) reads like a question
  // in the client-side queue: the state as a plain line, its action (Stop,
  // which cancels it) below, where the queue's Remove sits.
  if (node.status === "queued") {
    return (
      <section className="research-response" aria-label="Research response">
        <div className="research-turn-note is-state" role="status">
          {runStatusText(node, waitsForParent)}
        </div>
        <div className="research-turn-actions">
          <button
            className="control-button research-turn-button is-ghost"
            type="button"
            disabled={cancelling}
            onClick={() => onCancelNode(node.id)}
          >
            {cancelling ? "Stopping…" : "Stop"}
          </button>
        </div>
      </section>
    );
  }

  if (!view.content) {
    return (
      <section className="research-response" aria-label="Research response">
        {active ? (
          <div className="research-turn-run" role="status">
            <span className="research-pulse" aria-hidden="true" />
            <span>{runStatusText(node, waitsForParent)}</span>
            {elapsedText ? <span className="research-tnum">{elapsedText}</span> : null}
            {stopButton("Stop")}
          </div>
        ) : null}
        <div className="research-response-loading">
          {contentError ? (
            <>
              <p role="alert">{contentError}</p>
              <button className="control-button" type="button" onClick={onRetryContentLoad}>
                Retry
              </button>
            </>
          ) : (
            <LoaderCircle className="research-spinner" size={18} aria-hidden="true" />
          )}
        </div>
      </section>
    );
  }

  const failure =
    node.status === "failed" ? (
      <>
        <div className="research-turn-alert is-error" role="alert">
          <div>
            <b>Stopped with an error.</b> {node.error ?? "The research run failed."}
          </div>
        </div>
        <div className="research-turn-actions">
          {retryButton("Retry")}
          {canEditQuestion ? (
            <button
              className="control-button research-turn-button is-ghost"
              type="button"
              onClick={() => onEditQuestion(node.id)}
            >
              Edit question
            </button>
          ) : null}
        </div>
      </>
    ) : null;
  const cancellation =
    node.status === "cancelled" ? (
      <>
        <div className="research-turn-note">
          {node.startedAt
            ? `Stopped after ${formatRunDuration((node.completedAt ?? node.startedAt) - node.startedAt)}.`
            : "Stopped before it started."}
        </div>
        <div className="research-turn-actions">
          {retryButton("Run again")}
          {lingeringPane ? stopButton("Retry stop") : null}
        </div>
      </>
    ) : null;
  const emptyText =
    node.status === "failed" || node.status === "cancelled"
      ? null
      : view.content.sourceError
        ? `The response is no longer available: ${view.content.sourceError}`
        : node.status === "complete"
          ? "Research completed, but its response is unavailable. Open the original session transcript if it still exists."
          : active
            ? view.timelineItems.length > 0
              ? "Waiting for the final response…"
              : null
            : "No response is available.";

  return (
    <section className="research-response" aria-label="Research response">
      {contentError ? (
        <div className="research-response-stale" role="alert">
          <p>Refreshing this response failed: {contentError}</p>
          <button className="control-button" type="button" onClick={onRetryContentLoad}>
            Retry
          </button>
        </div>
      ) : null}
      {active ? (
        <div className="research-turn-run">
          <span className="research-pulse" aria-hidden="true" />
          <span role="status">
            {runStatusText(
              node,
              waitsForParent,
              node.status === "running" ? latestToolActivityLabel(view.timelineItems) : null,
            )}
          </span>
          {elapsedText ? <span className="research-tnum">{elapsedText}</span> : null}
          {view.hasTranscriptActivity ? (
            <button
              type="button"
              className="research-link-button research-turn-trace"
              aria-pressed={view.showFullTrace}
              onClick={() => onToggleFullTrace(node.id)}
            >
              {view.showFullTrace ? "Hide trace" : "Show trace"}
            </button>
          ) : null}
          {stopButton("Stop")}
        </div>
      ) : null}
      <ResearchRecap content={view.content} pending={recapPending} />
      {view.displayedTimelineItems.length === 0 ? (
        emptyText ? <p className="research-response-empty">{emptyText}</p> : null
      ) : (
        <>
          {view.hiddenTimelineItemCount > 0 && !view.isConversation ? (
            <button
              type="button"
              className="control-button research-show-earlier"
              onClick={() => onExpandTurns(node.id)}
            >
              Show {view.hiddenTimelineItemCount} earlier response item
              {view.hiddenTimelineItemCount === 1 ? "" : "s"}
            </button>
          ) : null}
          <div
            className={`research-answer-wrap${
              clampable ? (overflows ? (clamped ? " is-clamped" : " is-expanded") : " fits") : ""
            }`}
          >
            <div
              className={`research-answer-clamp${clamped && overflows ? " is-clamped" : ""}`}
              // Focus or find-in-page can scroll a clipped answer inside its
              // clamp; keep the clamp showing the start of the answer.
              onScroll={(event) => {
                event.currentTarget.scrollTop = 0;
              }}
            >
              <div
                ref={contentRootRef}
                data-node-id={node.id}
                className={`research-response-content-root${
                  pointerOverAnnotation ? " is-highlight-hovered" : ""
                }`}
                onMouseDown={onRootMouseDown}
                onMouseUp={onRootMouseUp}
                onKeyUp={onRootKeyUp}
                onClick={onRootClick}
                onMouseMove={onRootMouseMove}
                onMouseLeave={onRootMouseLeave}
              >
                {view.visibleTimelineItems.map((item) => (
                  <ResearchTimelineItem
                    key={item.key}
                    item={item}
                    conversation={view.isConversation}
                    imported={node.origin === "imported"}
                  />
                ))}
              </div>
            </div>
            {clampable && overflows && clamped ? (
              <button
                type="button"
                className="research-answer-fade"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => onToggleAnswer(node.id)}
              >
                <span>Show more</span>
              </button>
            ) : null}
            {clampable && overflows ? (
              <button
                type="button"
                className="research-answer-dots"
                aria-expanded={!clamped}
                aria-label={clamped ? "Show more" : "Show less"}
                title={clamped ? `${Math.round(shown * 100)}% shown · Show more` : "Show less"}
                onClick={() => onToggleAnswer(node.id)}
              >
                {Array.from({ length: pages }, (_, index) => (
                  <i key={index} className={index === 0 && clamped ? "is-on" : undefined} />
                ))}
              </button>
            ) : null}
          </div>
          {view.hiddenTimelineItemCount > 0 && view.isConversation ? (
            <button
              type="button"
              className="control-button research-show-earlier"
              onClick={() => onExpandTurns(node.id)}
            >
              Show {view.hiddenTimelineItemCount} more turn
              {view.hiddenTimelineItemCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      )}
      {failure}
      {cancellation}
    </section>
  );
}, propsEqualExceptNode);

/** The question side of a turn: the prompt, then one meta row with the short
 * relative time, the star (root-conversation follow-ups only) and the branch
 * button. The branch button is always there; with no branches and no way to
 * start one it is disabled and says why. */
export const ResearchTurnQuestion = memo(function ResearchTurnQuestion({
  node,
  showPrompt,
  replyQuote = null,
  now,
  promotable = false,
  branchCount = 0,
  branchOpen = false,
  branchUnread = false,
  branchMenuOpen = false,
  branchBlocker = null,
  answerMenuOpen = false,
  onTogglePromoted,
  onBranchButton,
  onOpenAnswerMenu,
}: {
  node: ResearchNode;
  /** Documents and conversations carry no question; their meta row stands
   * alone above the content. */
  showPrompt: boolean;
  /** For a follow-up of a note asked about one reply: that reply's text,
   * quoted above the question. */
  replyQuote?: string | null;
  /** Clock for the relative time; the parent refreshes it once a minute. */
  now: number;
  promotable?: boolean;
  branchCount?: number;
  branchOpen?: boolean;
  branchUnread?: boolean;
  branchMenuOpen?: boolean;
  /** Why no branch can start from this answer, or null when one can. */
  branchBlocker?: string | null;
  /** The answer menu (details and actions) is open. */
  answerMenuOpen?: boolean;
  onTogglePromoted?: (nodeId: string) => void;
  onBranchButton?: (nodeId: string, trigger: HTMLButtonElement) => void;
  /** The … button after the branch button: the answer's length, run time
   * and model, and its actions. A queued run has no answer yet. */
  onOpenAnswerMenu?: (trigger: HTMLButtonElement, nodeId: string) => void;
}) {
  const settled = node.status === "complete" || node.status === "failed" || node.status === "cancelled";
  const promoted = Boolean(node.promotedAt);
  const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
  const branchDisabled = branchCount === 0 && branchBlocker !== null;
  const branchName =
    (branchCount > 0 ? `${branchLabel} from this answer` : "Branch from this answer") +
    (branchUnread ? ", one with a new answer" : "");
  return (
    <div className="research-turn-question">
      {showPrompt && replyQuote ? (
        <blockquote className="research-prompt-quote">
          {replyQuote.split(/\s+/).join(" ").trim()}
        </blockquote>
      ) : null}
      {showPrompt ? (
        <ResearchUserMessage className="research-prompt research-turn-prompt">
          <ResearchMessageBody prompt={node.prompt} attachments={node.attachments} />
        </ResearchUserMessage>
      ) : null}
      <div className="research-turn-meta">
        <time
          dateTime={new Date(node.createdAt).toISOString()}
          title={new Date(node.createdAt).toLocaleString()}
        >
          {node.origin === "imported" ? "Imported " : ""}
          {shortWhen(node.createdAt, now)}
        </time>
        {promotable && settled && onTogglePromoted ? (
          <button
            type="button"
            className={`control-button research-turn-meta-button research-turn-star${
              promoted ? " is-on" : ""
            }`}
            aria-pressed={promoted}
            aria-label="Star"
            title={
              promoted
                ? "Unstar: stop listing this follow-up under its question"
                : "Star: list this follow-up under its question in the feed"
            }
            onClick={() => onTogglePromoted(node.id)}
          >
            <Star size={13} aria-hidden="true" fill={promoted ? "currentColor" : "none"} />
          </button>
        ) : null}
        {onBranchButton ? (
          <button
            type="button"
            className={`control-button research-turn-meta-button research-turn-branches${
              branchCount > 0 ? " has-count" : ""
            }${branchOpen ? " is-open" : ""}`}
            aria-haspopup={branchCount > 0 ? "menu" : undefined}
            aria-expanded={branchCount > 0 ? branchMenuOpen : undefined}
            aria-disabled={branchDisabled || undefined}
            aria-label={branchName}
            title={branchDisabled ? branchBlocker ?? undefined : branchCount > 0 ? branchLabel : "Branch from this answer"}
            data-research-branch-trigger={node.id}
            onClick={(event) => {
              if (!branchDisabled) {
                onBranchButton(node.id, event.currentTarget);
              }
            }}
          >
            <ResearchBranchIcon size={13} />
            {branchCount > 0 ? <span className="research-tnum">{branchCount}</span> : null}
            {branchUnread ? <span className="research-turn-unread" aria-hidden="true" /> : null}
          </button>
        ) : null}
        {onOpenAnswerMenu && node.status !== "queued" ? (
          <button
            type="button"
            className="control-button research-turn-meta-button research-turn-more"
            aria-haspopup="menu"
            aria-expanded={answerMenuOpen}
            aria-label="Answer actions"
            title="Answer details and actions"
            onClick={(event) => onOpenAnswerMenu(event.currentTarget, node.id)}
          >
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
});

interface ResearchTurnProps extends ResearchAnswerPaneProps {
  replyQuote: string | null;
  now: number;
  promotable: boolean;
  branchCount: number;
  branchOpen: boolean;
  branchUnread: boolean;
  branchMenuOpen: boolean;
  branchBlocker: string | null;
  answerMenuOpen: boolean;
  onOpenAnswerMenu: (trigger: HTMLButtonElement, nodeId: string) => void;
  onTogglePromoted: (nodeId: string) => void;
  onBranchButton: (nodeId: string, trigger: HTMLButtonElement) => void;
  onOpenContextMenu: (nodeId: string, clientX: number, clientY: number) => void;
}

/** One question | answer turn. The grid switches from stacked to two columns
 * at 600px of column width (a container query), so the same turn reads
 * stacked in the drawer and side by side in a wide conversation column. */
export const ResearchTurn = memo(function ResearchTurn({
  replyQuote,
  now,
  promotable,
  branchCount,
  branchOpen,
  branchUnread,
  branchMenuOpen,
  branchBlocker,
  answerMenuOpen,
  onOpenAnswerMenu,
  onTogglePromoted,
  onBranchButton,
  onOpenContextMenu,
  ...answer
}: ResearchTurnProps) {
  const { node, view, registerSegmentElement } = answer;
  const whole = view.isDocument || view.isConversation;
  return (
    <article
      ref={(element) => registerSegmentElement(node.id, "anchor", element)}
      className={`research-turn is-status-${node.status}${whole ? " is-whole" : ""}`}
      data-segment-anchor={node.id}
      onContextMenu={(event) => {
        // Links and other nested controls may own a more specific context
        // menu. Everywhere else in the turn opens its answer menu.
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(node.id, event.clientX, event.clientY);
      }}
    >
      <ResearchTurnQuestion
        node={node}
        showPrompt={!whole}
        replyQuote={replyQuote}
        now={now}
        promotable={promotable}
        branchCount={branchCount}
        branchOpen={branchOpen}
        branchUnread={branchUnread}
        branchMenuOpen={branchMenuOpen}
        branchBlocker={branchBlocker}
        answerMenuOpen={answerMenuOpen}
        onTogglePromoted={onTogglePromoted}
        onBranchButton={onBranchButton}
        onOpenAnswerMenu={onOpenAnswerMenu}
      />
      <div className="research-turn-answer">
        <ResearchAnswerPane {...answer} />
      </div>
    </article>
  );
}, propsEqualExceptNode);
