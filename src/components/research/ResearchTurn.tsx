import { researchBranchBlocker } from "../../lib/researchThreadView";
import { memo, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  KeyRound,
  LoaderCircle,
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
import { formatRunDuration } from "../../lib/shortTime";
import { latestToolActivityLabel, type MessageBlock, type MessageItem } from "../../lib/turnTimeline";
import type { ResearchNode, ResearchNodeStatus } from "../../types";
import {
  RawTranscriptDisclosure,
  TranscriptActivityItem,
  timelineContextStatusClass,
  timelineStatusClass,
} from "../TranscriptActivity";
import { ResearchElapsedClock } from "./ResearchClock";
import ResearchSignInRepair from "./ResearchSignInRepair";
import type { SegmentView } from "../../lib/researchSegmentView";
import ResearchRecap from "./ResearchRecap";
import ResearchRowRail from "./ResearchRowRail";
import ResearchRowGlyph from "./ResearchRowGlyph";
import { WidgetAnswerContext } from "../../lib/sessionWidgetActions";
import { SessionWidgetStreamingContext } from "../SessionWidget";
import { ResearchMarkdown, ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";
import type { ResearchCardDragStart } from "../../hooks/useResearchCardDrag";
import { documentSource, nodeAdapter, nodeAgent, nodeAttachments, nodePrompt, nodeRun, nodeStatus } from "../../lib/researchNodeTypes";
import {
  researchMessageRowHasGlyph,
  researchRowKind,
  researchRowState,
  type ResearchRowState,
} from "../../lib/researchRowGlyph";

// The backend's 64MB snapshot limit is too large for synchronous Markdown
// rendering. Content above these limits uses capped preformatted text, and long
// transcripts render only their final portion until expanded.
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
  blockIndex,
  role,
  conversation = false,
  imported = false,
}: {
  block: MessageBlock;
  blockIndex: number;
  role: string;
  conversation?: boolean;
  imported?: boolean;
}) {
  const owner = useContext(WidgetAnswerContext);
  if (block.type === "text") {
    // In a transcript document every turn is included as content: user
    // messages render as markdown prompts, not as unexpected-content
    // callouts (that framing exists for run responses, where a mid-response
    // user turn signals leakage).
    if (role === "assistant" || conversation) {
      return (
        <WidgetAnswerContext.Provider value={owner ? { ...owner, messageKey: `${owner.messageKey}:${blockIndex}` } : null}>
        <ResearchMarkdown
          text={imported ? stripImportedReportCitations(block.text) : block.text}
          oversizedContent={imported ? undefined : OVERSIZED_MARKDOWN_POLICY}
          widgets={role === "assistant"}
        />
        </WidgetAnswerContext.Provider>
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
  expandActivities = false,
}: {
  item: MessageItem;
  conversation?: boolean;
  imported?: boolean;
  /** Opens the item's root-level activities (tool calls, thinking) when they
   * mount: a running answer's trace shows them expanded. */
  expandActivities?: boolean;
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
                blockIndex={index}
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
                blockIndex={index}
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
                defaultOpen={expandActivities}
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
                blockIndex={index}
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
          defaultOpen={expandActivities}
        />
      ))}
    </section>
  );
});

function sameTurnNode(a: ResearchNode, b: ResearchNode) {
  return (
    a.id === b.id &&
    nodeStatus(a) === nodeStatus(b) &&
    nodeRun(a)?.error === nodeRun(b)?.error &&
    nodeRun(a)?.errorKind === nodeRun(b)?.errorKind &&
    nodeRun(a)?.holdsProcess === nodeRun(b)?.holdsProcess &&
    nodeRun(a)?.sessionReady === nodeRun(b)?.sessionReady &&
    a.parentNodeId === b.parentNodeId &&
    nodePrompt(a) === nodePrompt(b) &&
    nodeRun(a)?.startedAt === nodeRun(b)?.startedAt &&
    nodeRun(a)?.completedAt === nodeRun(b)?.completedAt &&
    a.createdAt === b.createdAt &&
    a.starredAt === b.starredAt &&
    nodeAdapter(a) === nodeAdapter(b) &&
    nodeAgent(a)?.model === nodeAgent(b)?.model &&
    documentSource(a) === documentSource(b)
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
  /** When an active run started: the pane shows its elapsed clock ("1:08"),
   * which ticks in its own leaf (ResearchElapsedClock). */
  elapsedSince: number | null;
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
  status: ResearchNodeStatus,
  waitsForParent: boolean,
  activity: string | null = null,
) {
  if (status === "running") {
    return activity ? `Working · ${activity}` : "Working";
  }
  if (status === "starting") {
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
  elapsedSince,
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
  const active = nodeStatus(node) === "queued" || nodeStatus(node) === "starting" || nodeStatus(node) === "running";
  const lingeringPane = nodeStatus(node) === "cancelled" && Boolean(nodeRun(node)?.holdsProcess);
  const run = nodeRun(node);
  // Stable, so React does not detach and reattach the root on every render.
  const nodeId = node.id;
  const contentRootRef = useCallback(
    (element: HTMLDivElement | null) => registerSegmentElement(nodeId, "root", element),
    [nodeId, registerSegmentElement],
  );
  // The sign-in repair panel under a failed run whose agent is not signed
  // in. Held by node id: the pane shows other messages' answers too.
  const [repairNodeId, setRepairNodeId] = useState<string | null>(null);
  const repairButtonRef = useRef<HTMLButtonElement | null>(null);
  const signInFailure = nodeStatus(node) === "failed" && run?.errorKind === "auth";
  const repairOpen = signInFailure && canRetry && repairNodeId === nodeId;
  // After Retry this research, the panel goes away with the failure; focus
  // moves to the message's row in the messages column rather than the page.
  const repairRetryNodeIdRef = useRef<string | null>(null);
  const status = nodeStatus(node);
  useEffect(() => {
    if (repairRetryNodeIdRef.current !== nodeId || status === "failed") return;
    repairRetryNodeIdRef.current = null;
    document
      .querySelector<HTMLElement>(`[data-research-row][data-node-id="${CSS.escape(nodeId)}"]`)
      ?.focus({ preventScroll: true });
  }, [nodeId, status]);
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
  if (nodeStatus(node) === "queued" || retryQueued) {
    return (
      <section className="research-response" aria-label="Research response">
        <div className="research-turn-note is-state" role="status">
          {retryQueued ? QUEUED_RETRY_TEXT : runStatusText(nodeStatus(node), waitsForParent)}
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
            <span>{runStatusText(nodeStatus(node), waitsForParent)}</span>
            {elapsedSince !== null ? <ResearchElapsedClock since={elapsedSince} /> : null}
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
    nodeStatus(node) === "failed" ? (
      <>
        <div className="research-turn-alert is-error" role="alert">
          <div>
            <b>Error.</b> {nodeRun(node)?.error ?? "The research run failed."}
          </div>
        </div>
        <div className="research-turn-actions">
          {signInFailure && canRetry && !repairOpen ? (
            <button
              ref={repairButtonRef}
              className="control-button research-turn-button"
              type="button"
              onClick={() => setRepairNodeId(node.id)}
            >
              <KeyRound size={13} aria-hidden="true" />
              <span>Repair sign-in</span>
            </button>
          ) : null}
          {repairOpen ? null : retryButton("Retry")}
          {canEditQuestion && !repairOpen ? (
            <button
              className="control-button research-turn-button is-ghost"
              type="button"
              onClick={() => onEditQuestion(node.id)}
            >
              Edit question
            </button>
          ) : null}
        </div>
        {repairOpen ? (
          <ResearchSignInRepair
            adapterId={nodeAdapter(node)}
            retrying={retrying}
            onRetry={() => {
              repairRetryNodeIdRef.current = node.id;
              onRetryNode(node.id);
            }}
            onClose={() => {
              setRepairNodeId(null);
              window.requestAnimationFrame(() => repairButtonRef.current?.focus());
            }}
          />
        ) : null}
      </>
    ) : null;
  const cancellation =
    nodeStatus(node) === "cancelled" ? (
      <>
        <div className="research-turn-note">
          {run?.startedAt
            ? `Stopped after ${formatRunDuration((run.completedAt ?? run.startedAt) - run.startedAt)}. The answer is incomplete.`
            : "Stopped before it started."}
        </div>
        <div className="research-turn-actions">
          {retryButton("Run again")}
          {lingeringPane ? stopButton("Retry stop") : null}
        </div>
      </>
    ) : null;
  const emptyText =
    nodeStatus(node) === "failed" || nodeStatus(node) === "cancelled"
      ? null
      : view.content.sourceError
        ? `The response is no longer available: ${view.content.sourceError}`
        : nodeStatus(node) === "complete"
          ? "Research completed, but its response is unavailable. Open the original session transcript if it still exists."
          : active
            ? view.timelineItems.length > 0
              ? "Waiting for the final response…"
              : null
            : "No response is available.";

  return (
    <section
      className={`research-response${nodeStatus(node) === "running" ? " is-running" : ""}`}
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
              nodeStatus(node),
              waitsForParent,
              nodeStatus(node) === "running" ? latestToolActivityLabel(view.timelineItems) : null,
            )}
          </span>
          {elapsedSince !== null ? <ResearchElapsedClock since={elapsedSince} /> : null}
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
            <SessionWidgetStreamingContext.Provider value={active}>
              {view.visibleTimelineItems.map((item) => (
                <WidgetAnswerContext.Provider key={item.key} value={{ nodeId: node.id, treeId: node.treeId, messageKey: item.key, blocked: researchBranchBlocker(node, false), answer: item.blocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n\n") }}>
                <ResearchTimelineItem
                  item={item}
                  conversation={view.isConversation}
                  // Provenance: the document source records it.
                  imported={documentSource(node) === "imported"}
                  expandActivities={active}
                />
                </WidgetAnswerContext.Provider>
              ))}
            </SessionWidgetStreamingContext.Provider>
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

/** A message's run state for its row's glyph: a Retry queued behind the
 * running answer shows as queued. */
export function researchMessageState(
  status: ResearchNodeStatus,
  retryQueued = false,
): ResearchRowState {
  return retryQueued ? "queued" : researchRowState(status);
}

/** The states the row's meta line also names in words: Queued (a queued run
 * or Retry, whose text is muted) and Stopped (the answer is incomplete). */
export function researchMessageStateWord(state: ResearchRowState): string | null {
  if (state === "queued") return "Queued";
  if (state === "stopped") return "Stopped";
  return null;
}

/** One message in a level's messages column: the user's message in full,
 * then a meta line, shown only when it has something to show: "Imported"
 * for an imported report, the word Queued or Stopped, a filled star when the
 * message is starred, and the branch count (only once the answer has
 * branches). The first line starts with the row's glyph (ResearchRowGlyph)
 * unless the row is an answered exchange, the common case: a note, link, X
 * post or document shows its kind, and a queued, running, failed or stopped
 * question its state. The row's time is not shown; the answer's footer has
 * it. The row is a bubble:
 * one button under its content selects the message; links in the message
 * and the meta line's buttons stay their own targets. Only the selected row
 * is in the tab order (the column's keys move between rows). The answer's …
 * button sits in a pill in the row's top-right corner, which shows on hover
 * and focus as on a feed card, with a drag handle when the row reorders by
 * drag (`dragPlace`, the column's drop zone): a press on the row then starts
 * a drag that reorders the column. */
export const ResearchMessageRow = memo(function ResearchMessageRow({
  node,
  level,
  label,
  showPrompt,
  selected,
  starrable,
  retryQueued = false,
  branchCount,
  branchOpen,
  branchUnread,
  answerMenuOpen,
  registerSegmentElement,
  onSelect,
  onShowBranches,
  onOpenAnswerMenu,
  onOpenContextMenu,
  dragPlace = null,
  onDragStart,
}: {
  node: ResearchNode;
  level: number;
  /** The row's name: the question, or a document's title. */
  label: string;
  /** Documents and conversations carry no question: the row shows `label`. */
  showPrompt: boolean;
  selected: boolean;
  /** The message can be starred (root follow-ups and a branch's first
   * message); a starred one shows a filled star in its meta line. */
  starrable: boolean;
  retryQueued?: boolean;
  branchCount: number;
  /** One of the answer's branches is open as the next level. */
  branchOpen: boolean;
  branchUnread: boolean;
  /** The answer's menu is open from this row's … button. */
  answerMenuOpen: boolean;
  registerSegmentElement: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
  onSelect: (nodeId: string, level: number, row: HTMLElement) => void;
  onShowBranches: (nodeId: string, level: number) => void;
  onOpenAnswerMenu: (trigger: HTMLButtonElement, nodeId: string) => void;
  /** Opens the answer's menu at `placement`: a right-click on the row, or
   * Shift+F10 or the ContextMenu key with focus in it. */
  onOpenContextMenu: (nodeId: string, placement: ResearchUnitMenuPlacement) => void;
  dragPlace?: string | null;
  onDragStart?: ResearchCardDragStart;
}) {
  const labelId = useId();
  const draggable = Boolean(dragPlace && onDragStart);
  const status = nodeStatus(node);
  const settled = status === "complete" || status === "failed" || status === "cancelled";
  const starred = starrable && status !== "queued" && Boolean(node.starredAt);
  // Provenance: the document source records it.
  const imported = documentSource(node) === "imported";
  const state = researchMessageState(status, retryQueued);
  const stateWord = researchMessageStateWord(state);
  const kind = researchRowKind({
    type: node.type,
    source: documentSource(node),
    format: node.type === "post" ? node.format : null,
    attachments: nodeAttachments(node),
  });
  // The glyph's state name is part of the row's name: it is inside the
  // labelled content.
  const glyph = researchMessageRowHasGlyph(kind, state) ? (
    <ResearchRowGlyph kind={kind} state={state} />
  ) : null;
  const tabIndex = selected ? 0 : -1;
  const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
  const showBranches = settled && branchCount > 0;
  // The row's context menu is its … menu, so a row without the … button (a
  // queued question) keeps the webview's menu.
  const hasMenu = status !== "queued" && !retryQueued;
  const unitMenuProps = hasMenu
    ? researchUnitMenuProps(
        (placement) => onOpenContextMenu(node.id, placement),
        (row) => ({ element: row.querySelector<HTMLElement>(".research-feed-card-menu"), align: "end" }),
      )
    : null;
  let prompt: ReactNode = (
    <span className="research-msg-plain">
      {glyph}
      {label}
    </span>
  );
  if (showPrompt) {
    prompt = (
      <ResearchUserMessage className="research-prompt research-msg-prompt">
        <ResearchMessageBody prompt={nodePrompt(node)} attachments={nodeAttachments(node)} lead={glyph} />
      </ResearchUserMessage>
    );
  }
  return (
    <li
      ref={(element) => registerSegmentElement(node.id, "anchor", element)}
      className={`research-msg-row is-status-${retryQueued ? "queued" : status}${selected ? " is-selected" : ""}${
        answerMenuOpen ? " has-open-menu" : ""
      }`}
      data-segment-anchor={node.id}
      data-research-card={draggable ? node.id : undefined}
      data-research-card-kind={draggable ? "message" : undefined}
      onPointerDown={
        draggable
          ? (event) => onDragStart?.(event, { kind: "message", id: node.id, place: dragPlace ?? "" })
          : undefined
      }
      {...unitMenuProps}
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
      <div id={labelId} className="research-msg-content" data-research-drag-label="">
        {prompt}
      </div>
      {stateWord || imported || starred || showBranches ? (
        <div className="research-msg-meta">
          {imported ? (
            <span className="research-msg-provenance" title={new Date(node.createdAt).toLocaleString()}>
              Imported
            </span>
          ) : null}
          {stateWord ? <span className="research-msg-state">{stateWord}</span> : null}
          {starred ? (
            <span className="research-msg-starred" role="img" aria-label="Starred" title="Starred">
              <Star size={13} aria-hidden="true" fill="currentColor" />
            </span>
          ) : null}
          {showBranches ? (
            <button
              type="button"
              className={`control-button research-msg-button research-msg-branches${branchOpen ? " is-open" : ""}`}
              data-research-no-drag=""
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
        </div>
      ) : null}
      <ResearchRowRail
        grip={draggable}
        menuLabel="Answer actions"
        menuTitle="Answer details and actions"
        menuOpen={answerMenuOpen}
        menuTabIndex={tabIndex}
        onMenu={hasMenu ? (anchor) => onOpenAnswerMenu(anchor, node.id) : undefined}
      />
    </li>
  );
}, propsEqualExceptNode);
