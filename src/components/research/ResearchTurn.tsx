import { researchBranchBlocker } from "../../lib/researchThreadView";
import { memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Square,
  Wrench,
} from "lucide-react";
import { ResearchBranchOpenGlyph } from "./ResearchIcons";
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
import { ResearchTileToggle, useResearchTileClamp } from "./ResearchTileClamp";
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

/** The widget owner for one timeline item. Memoized on its primitive inputs:
 * a value built inline would be a new object on every streaming tick and
 * re-render every widget of the answer. */
function WidgetAnswerScope({ nodeId, treeId, messageKey, blocked, answer, children }: {
  nodeId: string;
  treeId: string;
  messageKey: string;
  blocked: string | null;
  answer: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ nodeId, treeId, messageKey, blocked, answer }), [nodeId, treeId, messageKey, blocked, answer]);
  return <WidgetAnswerContext.Provider value={value}>{children}</WidgetAnswerContext.Provider>;
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
  const blockOwner = useMemo(() => owner ? { ...owner, messageKey: `${owner.messageKey}:${blockIndex}` } : null, [owner, blockIndex]);
  if (block.type === "text") {
    // In a transcript document every turn is included as content: user
    // messages render as markdown prompts, not as unexpected-content
    // callouts (that framing exists for run responses, where a mid-response
    // user turn signals leakage).
    if (role === "assistant" || conversation) {
      return (
        <WidgetAnswerContext.Provider value={blockOwner}>
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
    nodeRun(a)?.sessionReady === nodeRun(b)?.sessionReady &&
    a.parentNodeId === b.parentNodeId &&
    nodePrompt(a) === nodePrompt(b) &&
    nodeRun(a)?.startedAt === nodeRun(b)?.startedAt &&
    nodeRun(a)?.completedAt === nodeRun(b)?.completedAt &&
    a.createdAt === b.createdAt &&
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
  onRootKeyUp: () => void;
  onRootClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRootMouseLeave: () => void;
}

/** The status line of an active run: "Working", with the run's latest tool
 * activity when it has one ("Working · reading lesswrong.com"). */
export function runStatusText(status: ResearchNodeStatus, activity: string | null = null) {
  if (status === "running") {
    return activity ? `Working · ${activity}` : "Working";
  }
  if (status === "starting") {
    return "Starting…";
  }
  return "Queued";
}

const QUEUED_RETRY_TEXT = "Queued. Starts when the running answer in this conversation finishes.";

/** The answer column's content for one message: the answer in full (the
 * column scrolls), under a status line with the elapsed time and Stop while
 * it runs. A failed answer ends in "Error." and the error, with Retry and
 * Edit question; a stopped one in "Stopped after …" with Run again. Memoized
 * so the message rows (branch counts) can change without rebuilding
 * the answer's timeline element tree. */
export const ResearchAnswerPane = memo(function ResearchAnswerPane({
  view,
  node,
  contentError,
  cancelling,
  elapsedSince,
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
  onRootKeyUp,
  onRootClick,
  onRootMouseMove,
  onRootMouseLeave,
}: ResearchAnswerPaneProps) {
  const active = nodeStatus(node) === "queued" || nodeStatus(node) === "starting" || nodeStatus(node) === "running";
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
  // After Retry this question, the panel goes away with the failure; focus
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
          {retryQueued ? QUEUED_RETRY_TEXT : runStatusText(nodeStatus(node))}
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
            <span>{runStatusText(nodeStatus(node))}</span>
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
            onKeyUp={onRootKeyUp}
            onClick={onRootClick}
            onMouseMove={onRootMouseMove}
            onMouseLeave={onRootMouseLeave}
          >
            <SessionWidgetStreamingContext.Provider value={active}>
              {view.visibleTimelineItems.map((item) => (
                <WidgetAnswerScope key={item.key} nodeId={node.id} treeId={node.treeId} messageKey={item.key} blocked={researchBranchBlocker(node, false)} answer={item.blocks.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join("\n\n")}>
                <ResearchTimelineItem
                  item={item}
                  conversation={view.isConversation}
                  // Provenance: the document source records it.
                  imported={documentSource(node) === "imported"}
                  expandActivities={active}
                />
                </WidgetAnswerScope>
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
 * for an imported report, or the word Queued or Stopped. A message whose answer has branches shows the branch
 * indicator at the right end of its first line. The first line starts with the row's glyph (ResearchRowGlyph)
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
 * a drag that reorders the column. The row's text is clamped to 12 lines,
 * with Show more below it when it is longer (`expanded` shows it in full);
 * a tweet card after the text shows whole. */
export const ResearchMessageRow = memo(function ResearchMessageRow({
  node,
  level,
  label,
  showPrompt,
  selected,
  focusable = false,
  retryQueued = false,
  branchCount,
  branchOpen,
  branchState = null,
  branchUnread,
  answerMenuOpen,
  expanded = false,
  registerSegmentElement,
  onSelect,
  onToggleBranches,
  onOpenAnswerMenu,
  onOpenContextMenu,
  onToggleExpanded,
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
  /** In the tab order although not selected: the first row of a branches
   * column with no selected message. */
  focusable?: boolean;
  retryQueued?: boolean;
  branchCount: number;
  /** One of the answer's branches is selected in the next column. */
  branchOpen: boolean;
  /** A message in the answer's branches (or below them) is running or has
   * failed: the indicator shows that state's glyph. */
  branchState?: "running" | "failed" | null;
  branchUnread: boolean;
  /** The answer's menu is open from this row's … button. */
  answerMenuOpen: boolean;
  /** The row's text shows in full (Show less), not clamped. */
  expanded?: boolean;
  registerSegmentElement: (nodeId: string, kind: SegmentDomKind, element: HTMLElement | null) => void;
  onSelect: (nodeId: string, level: number, row: HTMLElement) => void;
  /** The branch indicator: selects the answer's first branch in the next
   * column, or clears that column when one of its branches is selected. */
  onToggleBranches: (nodeId: string, level: number) => void;
  onOpenAnswerMenu: (trigger: HTMLButtonElement, nodeId: string) => void;
  /** Opens the answer's menu at `placement`: a right-click on the row, or
   * Shift+F10 or the ContextMenu key with focus in it. */
  onOpenContextMenu: (nodeId: string, placement: ResearchUnitMenuPlacement) => void;
  /** Show more or Show less; without it the row has no toggle. */
  onToggleExpanded?: (nodeId: string) => void;
  dragPlace?: string | null;
  onDragStart?: ResearchCardDragStart;
}) {
  const labelId = useId();
  const draggable = Boolean(dragPlace && onDragStart);
  const status = nodeStatus(node);
  const settled = status === "complete" || status === "failed" || status === "cancelled";
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
  const tabIndex = selected || focusable ? 0 : -1;
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
  const clamp = useResearchTileClamp(expanded);
  let prompt: ReactNode = (
    <div ref={clamp.ref} id={clamp.id} className={clamp.className}>
      <span className="research-msg-plain">
        {glyph}
        {label}
      </span>
    </div>
  );
  if (showPrompt) {
    // Only the text is clamped: tweet cards follow the clamp box.
    prompt = (
      <ResearchUserMessage className="research-prompt research-msg-prompt">
        <ResearchMessageBody
          prompt={nodePrompt(node)}
          attachments={nodeAttachments(node)}
          lead={glyph}
          imageTabIndex={tabIndex}
          renderPrompt={(content) => (
            <div ref={clamp.ref} id={clamp.id} className={clamp.className}>
              <div className="research-msg-clamp-text">
                {glyph}
                {content}
              </div>
            </div>
          )}
        />
      </ResearchUserMessage>
    );
  }
  return (
    <li
      ref={(element) => registerSegmentElement(node.id, "anchor", element)}
      className={`research-msg-row is-status-${retryQueued ? "queued" : status}${selected ? " is-selected" : ""}${
        answerMenuOpen ? " has-open-menu" : ""
      }${showBranches ? " has-branches" : ""}`}
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
      {onToggleExpanded && clamp.overflows ? (
        <ResearchTileToggle
          controls={clamp.id}
          expanded={expanded}
          tabIndex={tabIndex}
          onToggle={() => onToggleExpanded(node.id)}
        />
      ) : null}
      {stateWord || imported ? (
        <div className="research-msg-meta">
          {imported ? (
            <span className="research-msg-provenance" title={new Date(node.createdAt).toLocaleString()}>
              Imported
            </span>
          ) : null}
          {stateWord ? <span className="research-msg-state">{stateWord}</span> : null}
        </div>
      ) : null}
      {showBranches ? (
        <button
          type="button"
          className={`control-button research-msg-button research-msg-branches${branchOpen ? " is-open" : ""}${
            branchState ? ` is-${branchState}` : ""
          }`}
          data-research-no-drag=""
          aria-label={`${branchLabel} from this answer${branchOpen ? ", one selected in the next column" : ""}${
            branchState ? `, ${branchState}` : ""
          }${branchUnread ? ", one with a new answer" : ""}`}
          title={
            branchOpen
              ? "Clear the branch selected in the next column"
              : `${branchLabel}: select the first in the next column`
          }
          data-research-branch-trigger={node.id}
          tabIndex={tabIndex}
          onClick={() => onToggleBranches(node.id, level)}
        >
          <ResearchBranchOpenGlyph state={branchState} />
          {branchUnread ? <span className="research-turn-unread" aria-hidden="true" /> : null}
        </button>
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
