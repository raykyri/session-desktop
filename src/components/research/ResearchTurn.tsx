import { memo, useCallback, useId } from "react";
import type { ReactNode } from "react";
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

/** Content-derived render state for one turn, cached per node so the whole
 * view identity survives detail replacements — which is what lets the turn's
 * memo and the markdown renderer's cache hold. `node` is the node as of the
 * last content/toggle change and MAY BE STALE on volatile fields (status,
 * error, timestamps); consumers needing fresh metadata take the live node
 * separately. */
export interface SegmentView {
  node: ResearchNode;
  content: ResearchNodeContent | null;
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
  canRetry: boolean;
  retrying: boolean;
  /** A Retry waiting for the running answer in this conversation. */
  retryQueued: boolean;
  canEditQuestion: boolean;
  registerSegmentElement: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
  onExpandTurns: (nodeId: string) => void;
  onRetryContentLoad: () => void;
  onToggleFullTrace: (nodeId: string) => void;
  onCancelNode: (nodeId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onRemoveQueuedRetry: (nodeId: string) => void;
  onEditQuestion: (nodeId: string) => void;
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

const QUEUED_RETRY_TEXT = "Queued. Starts when the running answer in this conversation finishes.";

/** The answer column's content for one message: the answer in full (the
 * column scrolls), under a status line with the elapsed time and Stop while
 * it runs. A failed answer ends in "Error." and the error, with Retry and
 * Edit question; a stopped one in "Stopped after …" with Run again. Memoized
 * so the message rows (branch counts, star) can change without rebuilding
 * the answer's timeline element tree. */
export const ResearchAnswerPane = memo(function ResearchAnswerPane({
  view,
  node,
  contentError,
  cancelling,
  elapsedText,
  waitsForParent,
  recapPending,
  pointerOverAnnotation,
  canRetry,
  retrying,
  retryQueued,
  canEditQuestion,
  registerSegmentElement,
  onExpandTurns,
  onRetryContentLoad,
  onToggleFullTrace,
  onCancelNode,
  onRetryNode,
  onRemoveQueuedRetry,
  onEditQuestion,
  onRootMouseDown,
  onRootMouseUp,
  onRootKeyUp,
  onRootClick,
  onRootMouseMove,
  onRootMouseLeave,
}: ResearchAnswerPaneProps) {
  const active = node.status === "queued" || node.status === "starting" || node.status === "running";
  const lingeringPane = node.status === "cancelled" && Boolean(node.paneId);
  // Stable, so React does not detach and reattach the root on every render.
  const nodeId = node.id;
  const contentRootRef = useCallback(
    (element: HTMLDivElement | null) => registerSegmentElement(nodeId, "root", element),
    [nodeId, registerSegmentElement],
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

  // A queued run (waiting for its turn on the backend), or a Retry waiting
  // for the running answer: the state as a plain line, with the action that
  // takes it out of the queue below.
  if (node.status === "queued" || retryQueued) {
    return (
      <section className="research-response" aria-label="Research response">
        <div className="research-turn-note is-state" role="status">
          {retryQueued ? QUEUED_RETRY_TEXT : runStatusText(node, waitsForParent)}
        </div>
        <div className="research-turn-actions">
          <button
            className="control-button research-turn-button is-ghost"
            type="button"
            disabled={cancelling}
            onClick={() => (retryQueued ? onRemoveQueuedRetry(node.id) : onCancelNode(node.id))}
          >
            {retryQueued ? "Remove" : cancelling ? "Stopping…" : "Stop"}
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
            <b>Error.</b> {node.error ?? "The research run failed."}
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
            ? `Stopped after ${formatRunDuration((node.completedAt ?? node.startedAt) - node.startedAt)}. The answer is incomplete.`
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
    <section
      className={`research-response${node.status === "running" ? " is-running" : ""}`}
      aria-label="Research response"
    >
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
                // Provenance, which only the stored origin records.
                imported={node.origin === "imported"}
              />
            ))}
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

/** A message's state as a small pill in its row's meta line. */
export function researchMessagePill(
  node: Pick<ResearchNode, "status">,
  retryQueued = false,
): { label: string; tone: "run" | "error" | "plain" } | null {
  if (retryQueued || node.status === "queued") return { label: "Queued", tone: "plain" };
  if (node.status === "running" || node.status === "starting") return { label: "Running", tone: "run" };
  if (node.status === "failed") return { label: "Failed", tone: "error" };
  if (node.status === "cancelled") return { label: "Stopped", tone: "plain" };
  return null;
}

/** One message in a level's messages column: the user's message in full,
 * then a meta line with the short time, the state pill, the star (root
 * follow-ups and a branch's first message), the branch count (only once the
 * answer has branches) and the answer's … menu. The row is a bubble: one
 * button under its content selects the message; links in the message and
 * the meta line's buttons stay their own targets. Only the selected row is
 * in the tab order (the column's keys move between rows). */
export const ResearchMessageRow = memo(function ResearchMessageRow({
  node,
  level,
  label,
  showPrompt,
  replyQuote = null,
  selected,
  now,
  starrable,
  retryQueued = false,
  branchCount,
  branchOpen,
  branchUnread,
  answerMenuOpen,
  registerSegmentElement,
  onSelect,
  onTogglePromoted,
  onShowBranches,
  onOpenAnswerMenu,
  onOpenContextMenu,
}: {
  node: ResearchNode;
  level: number;
  /** The row's name: the question, or a document's title. */
  label: string;
  /** Documents and conversations carry no question: the row shows `label`. */
  showPrompt: boolean;
  /** For a follow-up of a note asked about one reply: that reply's text. */
  replyQuote?: string | null;
  selected: boolean;
  /** Clock for the relative time; the parent refreshes it once a minute. */
  now: number;
  starrable: boolean;
  retryQueued?: boolean;
  branchCount: number;
  /** One of the answer's branches is open as the next level. */
  branchOpen: boolean;
  branchUnread: boolean;
  answerMenuOpen: boolean;
  registerSegmentElement: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
  onSelect: (nodeId: string, level: number, row: HTMLElement) => void;
  onTogglePromoted: (nodeId: string) => void;
  onShowBranches: (nodeId: string, level: number) => void;
  onOpenAnswerMenu: (trigger: HTMLButtonElement, nodeId: string) => void;
  onOpenContextMenu: (nodeId: string, clientX: number, clientY: number) => void;
}) {
  const labelId = useId();
  const settled = node.status === "complete" || node.status === "failed" || node.status === "cancelled";
  const promoted = Boolean(node.promotedAt);
  const pill = researchMessagePill(node, retryQueued);
  const tabIndex = selected ? 0 : -1;
  const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
  let prompt: ReactNode = <span className="research-msg-plain">{label}</span>;
  if (showPrompt) {
    prompt = (
      <ResearchUserMessage className="research-prompt research-msg-prompt">
        <ResearchMessageBody prompt={node.prompt} attachments={node.attachments} />
      </ResearchUserMessage>
    );
  }
  return (
    <li
      ref={(element) => registerSegmentElement(node.id, "anchor", element)}
      className={`research-msg-row is-status-${retryQueued ? "queued" : node.status}${selected ? " is-selected" : ""}`}
      data-segment-anchor={node.id}
      onContextMenu={(event) => {
        // Links and other nested controls may own a more specific context
        // menu. Everywhere else in the row opens its answer menu.
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(node.id, event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        className="research-msg-hit"
        data-research-row
        data-node-id={node.id}
        aria-current={selected ? "true" : undefined}
        aria-labelledby={labelId}
        tabIndex={tabIndex}
        onClick={(event) => onSelect(node.id, level, event.currentTarget)}
      />
      <div id={labelId} className="research-msg-content">
        {showPrompt && replyQuote ? (
          <blockquote className="research-prompt-quote">{replyQuote.split(/\s+/).join(" ").trim()}</blockquote>
        ) : null}
        {prompt}
      </div>
      <div className="research-msg-meta">
        <time dateTime={new Date(node.createdAt).toISOString()} title={new Date(node.createdAt).toLocaleString()}>
          {/* Provenance, which only the stored origin records. */}
          {node.origin === "imported" ? "Imported " : ""}
          {shortWhen(node.createdAt, now)}
        </time>
        {pill ? (
          <span className={`research-msg-pill is-${pill.tone}`}>
            {pill.tone === "run" ? <span className="research-pulse" aria-hidden="true" /> : null}
            {pill.label}
          </span>
        ) : null}
        {starrable && node.status !== "queued" ? (
          <button
            type="button"
            className={`control-button research-msg-button research-msg-star${promoted ? " is-on" : ""}`}
            aria-pressed={promoted}
            aria-label="Star"
            title={promoted ? "Unstar" : "Star: list this under its question in the feed"}
            tabIndex={tabIndex}
            onClick={() => onTogglePromoted(node.id)}
          >
            <Star size={13} aria-hidden="true" fill={promoted ? "currentColor" : "none"} />
          </button>
        ) : null}
        {settled && branchCount > 0 ? (
          <button
            type="button"
            className={`control-button research-msg-button research-msg-branches${branchOpen ? " is-open" : ""}`}
            aria-label={`${branchLabel} from this answer${branchUnread ? ", one with a new answer" : ""}`}
            title={`${branchLabel}: marked in the answer's right margin`}
            data-research-branch-trigger={node.id}
            tabIndex={tabIndex}
            onClick={() => onShowBranches(node.id, level)}
          >
            <ResearchBranchIcon size={13} />
            <span className="research-tnum">{branchCount}</span>
            {branchUnread ? <span className="research-turn-unread" aria-hidden="true" /> : null}
          </button>
        ) : null}
        {node.status !== "queued" && !retryQueued ? (
          <button
            type="button"
            className="control-button research-msg-button research-turn-more"
            aria-haspopup="menu"
            aria-expanded={answerMenuOpen}
            aria-label="Answer actions"
            title="Answer details and actions"
            tabIndex={tabIndex}
            onClick={(event) => onOpenAnswerMenu(event.currentTarget, node.id)}
          >
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </li>
  );
}, propsEqualExceptNode);
