// One message and its answer in a thread (`09-research-document-view.md`
// §3, §7), ported from the desktop `ResearchTurn.tsx`: the answer pane an
// answer column shows, its timeline items, and the message row a messages
// column lists. Message text is clamped to 12 lines with Show more; posts it
// links to (tweets) and its images follow the clamped text.

import type {
  MessageBlock,
  MessageItem,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchNodeStatus,
  Turn,
} from "@session/shared";
import { researchImageUrl, visibleResearchPrompt } from "@session/shared";
import {
  documentSource,
  nodeAttachments,
  nodePrompt,
  nodeRun,
  nodeStatus,
} from "@session/shared/lib/researchNodeTypes";
import {
  researchMessageRowHasGlyph,
  researchRowKind,
  researchRowState,
  type ResearchRowState,
} from "@session/shared/lib/researchRowGlyph";
import { researchBranchBlocker } from "@session/shared/lib/researchThreadView";
import { researchTileOverflows } from "@session/shared/lib/researchTileClamp";
import { formatRunDuration } from "@session/shared/lib/shortTime";
import { Ellipsis, GripVertical, LoaderCircle, RotateCcw, Square } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { TweetAttachments } from "../journal/TweetAttachments.js";
import {
  ACTIVITY_PAYLOAD_CHAR_LIMIT,
  OVERSIZED_MARKDOWN_POLICY,
  RawTranscriptDisclosure,
  ResearchMarkdown,
  TranscriptActivityItem,
  timelineContextStatusClass,
  timelineStatusClass,
} from "../markdown/index.js";
import { AuthorChip } from "../sharing/AuthorChip.js";
import { useThreadCollaboration } from "../sharing/context.js";
import { SessionWidgetStreamingContext, WidgetAnswerContext } from "../widgets/context.js";

import { Recap } from "./Recap.js";
import { SourcesFooter } from "./SourcesFooter.js";
import { BranchOpenGlyph } from "./icons.js";
import { runActive, runRetryable } from "./runState.js";
import type { SegmentView } from "./segmentView.js";
import { RESPONSE_MESSAGE_CLASS, RESPONSE_ROOT_ATTRIBUTE } from "./textRanges.js";
import type { MessageDragStart } from "./useMessageDrag.js";
import type { SegmentDomKind } from "./useThreadAnnotations.js";

/* ----------------------------------------------------------- timeline items */

function unexpectedRoleLabel(role: string): string {
  if (role === "system") return "System content";
  if (role === "user") return "Additional user content";
  return `${role || "Unknown"} content`;
}

function MessageBlockView({
  block,
  role,
  nodeId,
  conversation,
}: {
  block: MessageBlock;
  role: string;
  nodeId: string;
  conversation: boolean;
}) {
  if (block.type === "text") {
    // A conversation transcript's user messages are content, not leakage.
    if (role === "assistant" || conversation) {
      return (
        <ResearchMarkdown
          widgetNodeId={role === "assistant" ? nodeId : undefined}
          markdown={block.text}
          oversized={OVERSIZED_MARKDOWN_POLICY}
        />
      );
    }
    return <p className="text-fg-muted text-sm whitespace-pre-wrap">{block.text}</p>;
  }
  return (
    <RawTranscriptDisclosure
      value={block.value}
      maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
      deferPayload
    />
  );
}

/** The answer a widget in this timeline item belongs to: what its "Ask for
 * changes" quotes, the key its revisions are recorded under, and why a branch
 * cannot be asked from it now. */
function WidgetAnswerScope({
  node,
  item,
  children,
}: {
  node: ResearchNode;
  item: MessageItem;
  children: ReactNode;
}) {
  const blocked = researchBranchBlocker(node, false);
  const value = useMemo(
    () => ({
      nodeId: node.id,
      treeId: node.treeId,
      messageKey: item.key,
      blocked,
      answer: item.blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join("\n\n"),
    }),
    [blocked, item, node.id, node.treeId],
  );
  return <WidgetAnswerContext.Provider value={value}>{children}</WidgetAnswerContext.Provider>;
}

/** One item of an answer's timeline: its message blocks, then its tool calls
 * and thinking. Memoized on the item, whose identity follows the node's
 * content: a streaming sibling does not re-parse this item's Markdown. */
export const TimelineItem = memo(function TimelineItem({
  item,
  nodeId,
  conversation = false,
}: {
  item: MessageItem;
  nodeId: string;
  conversation?: boolean;
}) {
  const unexpected = !conversation && item.role !== "assistant" && item.blocks.length > 0;
  const prompt = conversation && item.role === "user";
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2",
        timelineContextStatusClass(item.contextStatus).trim(),
      )}
      data-timeline-key={item.key}
    >
      {item.contextStatus === "rolledBack" ? (
        <div className="text-fg-faint text-xs">Excluded from active context</div>
      ) : null}
      {item.blocks.length > 0 ? (
        <div
          className={cn(
            RESPONSE_MESSAGE_CLASS,
            "min-w-0",
            unexpected && "border-border-subtle rounded-md border border-dashed p-2",
            prompt && "bg-surface-fill-subtle rounded-lg px-3 py-2",
            timelineStatusClass(item.status).trim(),
          )}
        >
          {unexpected ? (
            <span className="text-fg-faint text-xs">{unexpectedRoleLabel(item.role)}</span>
          ) : null}
          {item.blocks.map((block, index) => (
            <MessageBlockView
              key={`${item.key}-${index}`}
              block={block}
              role={item.role}
              nodeId={nodeId}
              conversation={conversation}
            />
          ))}
        </div>
      ) : null}
      {item.activities.map((activity) => (
        <TranscriptActivityItem
          key={activity.key}
          item={activity}
          isRootActivity
          maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
          deferPayloads
          showResultTokenCount={false}
        />
      ))}
    </section>
  );
});

/* -------------------------------------------------------------- answer pane */

/** The status line of an active run: its place in the admission queue while
 * it waits behind others, then what it is doing. */
export function runStatusText(
  node: ResearchNode,
  thinking: boolean,
  queuePosition: number | undefined,
): string {
  const status = nodeStatus(node);
  if (status === "interrupted") return "Interrupted · resuming";
  if (status === "queued") {
    return queuePosition !== undefined && queuePosition > 0
      ? `Queued · ${queuePosition} ahead`
      : "Queued";
  }
  if (status === "starting") return "Starting…";
  return thinking ? "Thinking" : "Working";
}

const TURN_BUTTON =
  "inline-flex min-h-control-sm items-center gap-1.5 rounded-md border border-border-control bg-control px-2.5 " +
  "text-sm text-fg-control hover:not-disabled:bg-control-hover disabled:text-fg-disabled " +
  FOCUS_RING;
const TURN_BUTTON_GHOST =
  "inline-flex min-h-control-sm items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 " +
  "text-sm text-fg-muted hover:not-disabled:bg-surface-fill-hover hover:not-disabled:text-fg-primary " +
  "disabled:text-fg-disabled " +
  FOCUS_RING;

/** The elapsed time of a running answer, ticking in its own leaf. */
function ElapsedClock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="text-fg-faint tabular-nums" aria-hidden="true">
      {formatRunDuration(Math.max(0, now - since))}
    </span>
  );
}

export interface AnswerPaneHandlers {
  registerSegmentElement: (
    nodeId: string,
    kind: SegmentDomKind,
    element: HTMLElement | null,
  ) => void;
  onExpandTurns: (nodeId: string) => void;
  onRetryContentLoad: (nodeId: string) => void;
  onToggleFullTrace: (nodeId: string) => void;
  onCancelNode: (nodeId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onEditQuestion: (nodeId: string) => void;
  onRootKeyUp: () => void;
  onRootClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseLeave: () => void;
}

/** The answer column's content for one message: under a status line with
 * the elapsed time and Stop while it runs, the recap, the answer, and its
 * sources. A failed answer ends in "Error." and the error, with Retry and
 * Edit question; a stopped one in "Stopped after …" with Run again. */
export const AnswerPane = memo(function AnswerPane({
  view,
  node,
  turns,
  contentError,
  loading,
  thinking,
  cancelling,
  recapPending,
  pointerOverAnnotation,
  canRetry,
  retrying,
  canEditQuestion,
  canCancel = true,
  handlers,
}: {
  view: SegmentView;
  node: ResearchNode;
  turns: readonly Turn[];
  contentError: string | null;
  loading: boolean;
  thinking: boolean;
  cancelling: boolean;
  recapPending: boolean;
  pointerOverAnnotation: boolean;
  canRetry: boolean;
  retrying: boolean;
  canEditQuestion: boolean;
  /** The reader may stop the run (web only: its asker or the owner). */
  canCancel?: boolean;
  handlers: AnswerPaneHandlers;
}) {
  const status = nodeStatus(node);
  const active = runActive(node);
  const run = nodeRun(node);
  const nodeId = node.id;
  const register = handlers.registerSegmentElement;
  // Stable, so React does not detach and reattach the root on every render.
  const rootCallback = useCallback(
    (element: HTMLDivElement | null) => register(nodeId, "root", element),
    [nodeId, register],
  );

  const retryButton = (label: string) =>
    canRetry ? (
      <button
        className={TURN_BUTTON}
        type="button"
        aria-disabled={retrying || undefined}
        onClick={() => {
          if (!retrying) handlers.onRetryNode(nodeId);
        }}
      >
        {retrying ? (
          <LoaderCircle className="session-spin" size={13} aria-hidden="true" />
        ) : (
          <RotateCcw size={13} aria-hidden="true" />
        )}
        <span>{retrying ? "Retrying…" : label}</span>
      </button>
    ) : null;
  const stopButton = !canCancel ? null : (
    <button
      className={TURN_BUTTON_GHOST}
      type="button"
      disabled={cancelling}
      onClick={() => handlers.onCancelNode(nodeId)}
    >
      <Square size={12} aria-hidden="true" />
      <span>{cancelling ? "Stopping…" : "Stop"}</span>
    </button>
  );
  const runLine = active ? (
    <div className="text-fg-muted mb-3 flex flex-wrap items-center gap-2 text-sm">
      <span
        className="bg-status-active session-thinking-dot size-1.5 rounded-full"
        aria-hidden="true"
      />
      <span role="status">{runStatusText(node, thinking, view.content?.queuePosition)}</span>
      {run?.startedAt && status === "running" ? <ElapsedClock since={run.startedAt} /> : null}
      {view.hasTranscriptActivity ? (
        <button
          type="button"
          className={cn(
            "text-fg-muted hover:text-fg-primary bg-transparent p-0 text-sm underline-offset-2 hover:underline",
            FOCUS_RING,
          )}
          aria-pressed={view.showFullTrace}
          onClick={() => handlers.onToggleFullTrace(nodeId)}
        >
          {view.showFullTrace ? "Hide trace" : "Show trace"}
        </button>
      ) : null}
      {stopButton}
    </div>
  ) : null;

  if (status === "queued") {
    return (
      <section className="min-w-0" aria-label="Research response">
        {runLine}
      </section>
    );
  }

  if (!view.content && view.timelineItems.length === 0) {
    return (
      <section className="min-w-0" aria-label="Research response">
        {runLine}
        <div className="flex min-h-24 flex-col items-center justify-center gap-2">
          {contentError ? (
            <>
              <p className="text-fg-muted m-0 text-sm" role="alert">
                {contentError}
              </p>
              <button
                className={TURN_BUTTON}
                type="button"
                onClick={() => handlers.onRetryContentLoad(nodeId)}
              >
                Retry
              </button>
            </>
          ) : loading ? (
            <LoaderCircle
              className="session-spin text-fg-muted"
              size={18}
              aria-label="Loading answer"
            />
          ) : null}
        </div>
      </section>
    );
  }

  const failure =
    status === "failed" ? (
      <>
        <div
          className="border-status-failed/40 bg-status-failed-bg mt-3 rounded-md border px-3 py-2 text-sm"
          role="alert"
        >
          <b>Error.</b> {run?.error ?? "The research run failed."}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {retryButton("Retry")}
          {canEditQuestion ? (
            <button
              className={TURN_BUTTON_GHOST}
              type="button"
              onClick={() => handlers.onEditQuestion(nodeId)}
            >
              Edit question
            </button>
          ) : null}
        </div>
      </>
    ) : null;
  const stopped =
    status === "cancelled" || (status === "interrupted" && !active) ? (
      <>
        <div className="text-fg-muted mt-3 text-sm">
          {status === "interrupted"
            ? "The run was interrupted and could not resume. The answer is incomplete."
            : run?.startedAt
              ? `Stopped after ${formatRunDuration((run.completedAt ?? run.startedAt) - run.startedAt)}. The answer is incomplete.`
              : "Stopped before it started."}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">{retryButton("Run again")}</div>
      </>
    ) : null;
  const emptyText =
    status === "failed" || status === "cancelled" || (status === "interrupted" && !active)
      ? null
      : view.content?.sourceError
        ? `The response is no longer available: ${view.content.sourceError}`
        : status === "complete"
          ? "Research completed, but its response is unavailable."
          : active
            ? view.timelineItems.length > 0
              ? "Waiting for the final response…"
              : null
            : "No response is available.";

  return (
    <section className="min-w-0" aria-label="Research response">
      {contentError ? (
        <div className="text-fg-muted mb-3 flex items-center gap-2 text-sm" role="alert">
          <p className="m-0">Refreshing this response failed: {contentError}</p>
          <button
            className={TURN_BUTTON}
            type="button"
            onClick={() => handlers.onRetryContentLoad(nodeId)}
          >
            Retry
          </button>
        </div>
      ) : null}
      {runLine}
      {view.content ? <Recap content={view.content} pending={recapPending} /> : null}
      {view.displayedTimelineItems.length === 0 ? (
        emptyText ? (
          <p className="text-fg-muted m-0 text-sm">{emptyText}</p>
        ) : null
      ) : (
        <>
          {view.hiddenTimelineItemCount > 0 && !view.isConversation ? (
            <button
              className={cn(TURN_BUTTON, "mb-3")}
              type="button"
              onClick={() => handlers.onExpandTurns(nodeId)}
            >
              Show {view.hiddenTimelineItemCount} earlier response item
              {view.hiddenTimelineItemCount === 1 ? "" : "s"}
            </button>
          ) : null}
          {/* The selection root: the `answer-v1` projection is this element's
              text (09 §5). */}
          {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
          <div
            ref={rootCallback}
            {...{ [RESPONSE_ROOT_ATTRIBUTE]: nodeId }}
            className={cn(
              "relative flex min-w-0 flex-col gap-2",
              pointerOverAnnotation && "cursor-pointer",
            )}
            onKeyUp={handlers.onRootKeyUp}
            onClick={handlers.onRootClick}
            onMouseMove={handlers.onRootMouseMove}
            onMouseLeave={handlers.onRootMouseLeave}
          >
            <SessionWidgetStreamingContext.Provider value={active}>
              {view.visibleTimelineItems.map((item) => (
                <WidgetAnswerScope key={item.key} node={node} item={item}>
                  <TimelineItem item={item} nodeId={nodeId} conversation={view.isConversation} />
                </WidgetAnswerScope>
              ))}
            </SessionWidgetStreamingContext.Provider>
          </div>
          {view.hiddenTimelineItemCount > 0 && view.isConversation ? (
            <button
              className={cn(TURN_BUTTON, "mt-3")}
              type="button"
              onClick={() => handlers.onExpandTurns(nodeId)}
            >
              Show {view.hiddenTimelineItemCount} more turn
              {view.hiddenTimelineItemCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      )}
      {failure}
      {stopped}
      {status === "complete" ? <SourcesFooter turns={turns} /> : null}
    </section>
  );
});

/* -------------------------------------------------------------- message row */

/** A message's run state for its row's glyph. */
export function messageRowState(node: ResearchNode): ResearchRowState {
  const status: ResearchNodeStatus = nodeStatus(node);
  if (status === "interrupted") return runActive(node) ? "running" : "stopped";
  return researchRowState(status);
}

/** The states the row's meta line also names in words. */
export function messageStateWord(state: ResearchRowState): string | null {
  if (state === "queued") return "Queued";
  if (state === "stopped") return "Stopped";
  return null;
}

// One observer for every clamped row.
let clampObserver: ResizeObserver | null = null;
const clampMeasures = new WeakMap<Element, () => void>();

function observeSize(element: Element, measure: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  clampObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) clampMeasures.get(entry.target)?.();
  });
  clampMeasures.set(element, measure);
  clampObserver.observe(element);
  return () => {
    clampObserver?.unobserve(element);
    clampMeasures.delete(element);
  };
}

/** The 12-line clamp of a row's text: `ref` and `id` go on the clamp box,
 * and `overflows` says whether the text is longer, so the row shows Show
 * more. Expanded text is not measured: the row keeps Show less. */
export function useTileClamp(expanded: boolean) {
  const id = useId();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflows, setOverflows] = useState(expanded);
  const expandedRef = useRef(expanded);
  useLayoutEffect(() => {
    expandedRef.current = expanded;
    if (element && !expanded) {
      // Measured after layout: the clamp box's size decides.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOverflows(researchTileOverflows(element.scrollHeight, element.clientHeight));
    }
  }, [element, expanded]);
  useEffect(() => {
    if (!element) return;
    return observeSize(element, () => {
      if (!expandedRef.current) {
        setOverflows(researchTileOverflows(element.scrollHeight, element.clientHeight));
      }
    });
  }, [element]);
  return {
    id,
    setBox: setElement,
    className: cn("research-msg-clamp", !expanded && "line-clamp-12 overflow-hidden"),
    overflows,
  };
}

/** Show more or Show less below a clamped row's text. */
export function TileToggle({
  controls,
  expanded,
  tabIndex,
  onToggle,
}: {
  controls: string;
  expanded: boolean;
  tabIndex: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "text-fg-faint relative z-[1] mt-0.5 ml-2 block rounded-sm border-0 bg-transparent px-1 py-px text-[length:calc(12px+var(--font-ui-size-offset))] hover:underline",
        FOCUS_RING,
      )}
      data-research-no-drag=""
      aria-expanded={expanded}
      aria-controls={controls}
      tabIndex={tabIndex}
      onClick={onToggle}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {expanded ? "Show less" : "Show more"}
    </button>
  );
}

/** A row's drag handle and … button in one pill in its top-right corner,
 * shown on hover, on focus within the row and while its menu is open. */
export function RowRail({
  grip,
  menuLabel,
  menuTitle = menuLabel,
  menuOpen,
  menuTabIndex,
  onMenu,
  className,
}: {
  grip: boolean;
  menuLabel: string;
  menuTitle?: string;
  menuOpen: boolean;
  menuTabIndex?: number;
  onMenu?: (anchor: HTMLButtonElement) => void;
  className?: string;
}) {
  if (!grip && !onMenu) return null;
  return (
    <span
      className={cn(
        "bg-surface-popover border-border-divider absolute top-1.5 z-[2] flex items-center rounded-md border opacity-0 shadow-sm",
        "group-focus-within/row:opacity-100 group-hover/row:opacity-100 group-data-[menu-open]/row:opacity-100",
        "[.is-research-dragging_&]:opacity-0",
        className ?? "right-1.5",
      )}
    >
      {grip ? (
        <span className="text-fg-faint flex h-6 w-4 items-center justify-center" aria-hidden="true">
          <GripVertical size={14} />
        </span>
      ) : null}
      {onMenu ? (
        <button
          type="button"
          className={cn(
            "text-fg-muted hover:text-fg-strong flex size-6 items-center justify-center rounded-md border-0 bg-transparent",
            FOCUS_RING,
          )}
          title={menuTitle}
          aria-label={menuLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          tabIndex={menuTabIndex}
          data-research-no-drag=""
          data-research-row-menu=""
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/** The images attached to a message, as thumbnails that open full size. */
export function MessageImages({
  attachments,
  tabIndex,
  className,
}: {
  attachments: readonly ResearchMessageAttachment[];
  tabIndex?: number;
  className?: string;
}) {
  const images = attachments.flatMap((attachment) =>
    attachment.kind === "image" ? [attachment] : [],
  );
  if (images.length === 0) return null;
  return (
    <ul className={cn("m-0 flex list-none flex-wrap gap-1.5 p-0", className)} aria-label="Images">
      {images.map((image) => (
        <li key={image.id}>
          <a
            href={researchImageUrl(image.id)}
            target="_blank"
            rel="noopener noreferrer"
            tabIndex={tabIndex}
            className={cn("pointer-events-auto block", FOCUS_RING)}
          >
            <img
              src={researchImageUrl(image.id, { thumbnail: true })}
              alt={image.fileName ?? "Attached image"}
              className="border-border-subtle block h-16 max-w-32 rounded-md border object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A message's text with the posts it links to embedded below it: a
 * permalink that trailed the text is dropped from it, since the card
 * replaces it. `renderPrompt` wraps the text (the clamp box). */
export function MessageBody({
  prompt,
  attachments,
  lead,
  imageTabIndex,
  renderPrompt,
  variant = "compact",
}: {
  prompt: string;
  attachments: ResearchMessageAttachment[];
  lead?: ReactNode;
  imageTabIndex?: number;
  renderPrompt?: (content: ReactNode) => ReactNode;
  /** `prose` reads at the answer's size (a note's own column). */
  variant?: "compact" | "prose";
}) {
  const text = visibleResearchPrompt(prompt, attachments);
  const content = text ? <ResearchMarkdown markdown={text} variant={variant} /> : null;
  return (
    <>
      {renderPrompt ? (
        renderPrompt(content)
      ) : (
        <>
          {lead}
          {content}
        </>
      )}
      <TweetAttachments attachments={attachments} className="pointer-events-auto mt-2 w-full" />
      <MessageImages attachments={attachments} tabIndex={imageTabIndex} className="mt-2" />
    </>
  );
}

export interface MessageRowActions {
  registerSegmentElement: (
    nodeId: string,
    kind: SegmentDomKind,
    element: HTMLElement | null,
  ) => void;
  onSelect: (nodeId: string, level: number) => void;
  onToggleBranches: (nodeId: string, level: number) => void;
  onOpenAnswerMenu: (trigger: HTMLButtonElement, nodeId: string) => void;
  onOpenContextMenu: (nodeId: string, point: { x: number; y: number }) => void;
  onToggleExpanded: (nodeId: string) => void;
  onDragStart: MessageDragStart;
}

/** One message in a messages column: its text (or a document's title), a
 * meta line when there is something to say (Imported, Queued, Stopped), the
 * branch indicator at the end of its first line when its answer has
 * branches, and the … pill. One button under the content selects the
 * message; only the selected row is in the tab order. */
export const MessageRow = memo(function MessageRow({
  node,
  level,
  label,
  showPrompt,
  selected,
  focusable = false,
  branchCount,
  branchOpen,
  branchState = null,
  branchUnread,
  answerMenuOpen,
  expanded = false,
  dragPlace = null,
  actions,
}: {
  node: ResearchNode;
  level: number;
  label: string;
  /** Documents and conversations carry no question: the row shows `label`. */
  showPrompt: boolean;
  selected: boolean;
  focusable?: boolean;
  branchCount: number;
  branchOpen: boolean;
  branchState?: "running" | "failed" | null;
  branchUnread: boolean;
  answerMenuOpen: boolean;
  expanded?: boolean;
  /** The drop place the row reorders in; null when it does not move. */
  dragPlace?: string | null;
  actions: MessageRowActions;
}) {
  const labelId = useId();
  const status = nodeStatus(node);
  const settled = !runActive(node);
  const { people } = useThreadCollaboration();
  const authorShown = people.shared && Boolean(node.authorId);
  const imported = documentSource(node) === "imported";
  const state = messageRowState(node);
  const stateWord = messageStateWord(state);
  const kind = researchRowKind({
    type: node.type,
    source: documentSource(node),
    format: node.type === "post" ? node.format : null,
    attachments: nodeAttachments(node),
  });
  const glyph = researchMessageRowHasGlyph(kind, state) ? (
    <RowGlyph kind={kind} state={state} className="float-left mt-[calc((1lh-14px)/2)] mr-1.5" />
  ) : null;
  const tabIndex = selected || focusable ? 0 : -1;
  const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
  const branchStatusLabel = [
    `${branchLabel} from this answer.`,
    branchOpen ? "One is selected." : null,
    branchState === "running"
      ? "A branch is running."
      : branchState === "failed"
        ? "A branch failed."
        : null,
    branchUnread ? "One has a new answer." : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const showBranches = settled && branchCount > 0;
  const hasMenu = status !== "queued";
  const draggable = dragPlace !== null;
  const { id: clampId, setBox, className: clampClass, overflows } = useTileClamp(expanded);
  const promptClass = cn(
    "text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height) [overflow-wrap:anywhere]",
    selected ? "text-fg-heading" : state === "queued" ? "text-fg-muted" : "text-fg-primary",
  );
  const prompt = showPrompt ? (
    <MessageBody
      prompt={nodePrompt(node)}
      attachments={nodeAttachments(node)}
      lead={glyph}
      imageTabIndex={tabIndex}
      renderPrompt={(content) => (
        <div ref={setBox} id={clampId} className={cn(clampClass, promptClass)}>
          {glyph}
          {content}
        </div>
      )}
    />
  ) : (
    <div ref={setBox} id={clampId} className={cn(clampClass, promptClass, "whitespace-pre-wrap")}>
      {glyph}
      {label}
    </div>
  );
  const nodeId = node.id;
  const registerAnchor = actions.registerSegmentElement;
  const anchorRef = useCallback(
    (element: HTMLLIElement | null) => registerAnchor(nodeId, "anchor", element),
    [nodeId, registerAnchor],
  );
  return (
    <li
      ref={anchorRef}
      className={cn(
        "research-msg-row group/row relative mx-2 rounded-[10px] [&+&]:mt-0.5",
        "hover:bg-[color-mix(in_srgb,var(--research-card-selected-bg)_55%,transparent)]",
        "has-[>.research-msg-hit:focus]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-color)_35%,transparent)]",
        "data-[dragging]:opacity-40",
        "data-[insert=before]:before:bg-accent data-[insert=before]:before:rounded-px data-[insert=before]:before:absolute data-[insert=before]:before:inset-x-[-4px] data-[insert=before]:before:top-[-2px] data-[insert=before]:before:h-0.5",
        "data-[insert=after]:after:bg-accent data-[insert=after]:after:rounded-px data-[insert=after]:after:absolute data-[insert=after]:after:inset-x-[-4px] data-[insert=after]:after:bottom-[-2px] data-[insert=after]:after:h-0.5",
        selected &&
          "is-selected bg-[var(--research-card-selected-bg)] [--research-row-glyph-color:var(--text-muted)]",
        draggable && "select-none",
      )}
      data-research-msg-row=""
      data-segment-anchor={nodeId}
      data-research-card={draggable ? nodeId : undefined}
      data-menu-open={answerMenuOpen ? "" : undefined}
      data-status={status}
      onPointerDown={
        draggable
          ? (event) => actions.onDragStart(event, { id: nodeId, place: dragPlace })
          : undefined
      }
      onContextMenu={
        hasMenu
          ? (event) => {
              if (event.target instanceof Element && event.target.closest("a")) return;
              event.preventDefault();
              actions.onOpenContextMenu(nodeId, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      <button
        type="button"
        className="research-msg-hit absolute inset-0 z-0 w-full cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 focus:outline-none"
        data-research-row=""
        data-node-id={nodeId}
        aria-current={selected ? "true" : undefined}
        aria-labelledby={labelId}
        tabIndex={tabIndex}
        onClick={() => actions.onSelect(nodeId, level)}
      />
      <div
        id={labelId}
        className={cn(
          "pointer-events-none relative z-[1] flow-root px-3 pt-2.5 pb-0.5 [&_a]:pointer-events-auto",
          !stateWord && !imported && !overflows && "pb-2.5",
          showBranches && "pr-8",
        )}
      >
        {authorShown ? (
          <AuthorChip
            authorId={node.authorId}
            className={cn(
              "mb-1 flex text-[length:calc(12px+var(--font-ui-size-offset))]",
              selected ? "text-fg-muted" : "text-fg-faint",
            )}
          />
        ) : null}
        {prompt}
      </div>
      {overflows ? (
        <TileToggle
          controls={clampId}
          expanded={expanded}
          tabIndex={tabIndex}
          onToggle={() => actions.onToggleExpanded(nodeId)}
        />
      ) : null}
      {stateWord || imported ? (
        <div
          className={cn(
            "pointer-events-none relative z-[1] flex min-h-7 flex-wrap items-center gap-1 px-3 pt-0.5 pb-1.5 text-[length:calc(12px+var(--font-ui-size-offset))]",
            selected ? "text-fg-muted" : "text-fg-faint",
          )}
        >
          {imported ? (
            <span
              className="pointer-events-auto mr-1"
              title={new Date(node.createdAt).toLocaleString()}
            >
              Imported
            </span>
          ) : null}
          {stateWord ? <span className="mr-1">{stateWord}</span> : null}
        </div>
      ) : null}
      {showBranches ? (
        <button
          type="button"
          className={cn(
            "absolute top-2.5 right-1.5 z-[1] inline-flex h-5 min-w-[22px] items-center justify-center rounded-[5px] border-0 bg-transparent px-[4.5px]",
            "hover:bg-surface-fill-medium hover:text-fg-heading",
            branchOpen ? "text-accent" : "text-fg-faint",
            FOCUS_RING,
          )}
          data-research-no-drag=""
          data-research-branch-trigger={nodeId}
          aria-label={branchStatusLabel}
          title={
            branchOpen
              ? "Clear the branch selected in the next column"
              : branchCount === 1
                ? "Open branch"
                : `Open the first of ${branchCount} branches`
          }
          tabIndex={tabIndex}
          onClick={() => actions.onToggleBranches(nodeId, level)}
        >
          <BranchOpenGlyph state={branchState} />
          {branchUnread ? (
            <span
              className="bg-accent absolute top-0 -right-px size-1.5 rounded-full"
              aria-hidden="true"
            />
          ) : null}
        </button>
      ) : null}
      <RowRail
        grip={draggable}
        menuLabel="Answer actions"
        menuTitle="Answer details and actions"
        menuOpen={answerMenuOpen}
        menuTabIndex={tabIndex}
        className={showBranches ? "right-8" : "right-1.5"}
        onMenu={hasMenu ? (anchor) => actions.onOpenAnswerMenu(anchor, nodeId) : undefined}
      />
    </li>
  );
});

/** Whether a node's answer can take Retry from its answer pane. */
export function answerRetryable(node: ResearchNode, archived: boolean): boolean {
  return !archived && runRetryable(node);
}
