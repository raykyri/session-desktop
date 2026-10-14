// A level's answer column (`09-research-document-view.md` §3), ported from
// the desktop `ResearchAnswerColumn.tsx`: the selected message's answer, its
// margin markers, and a foot with the answer's time and the whole-answer
// marker. A marker is a link-style button beside the paragraph a branch was
// asked about (an up-right arrow and the number of branches); a click selects
// the first of them in the next column, or clears that column when one is
// open. While the root document is being edited, the column previews the
// edit instead.
//
// Each answer column loads its own content (`useNodeContent`) and reports it
// to the page, which the annotations, the menus and the editor read.

import type { ResearchNode, ResearchNodeContent, Turn } from "@session/shared";
import { researchPairLabel } from "@session/shared/lib/researchBranchView";
import { columnAttributes, type ResearchColumn } from "@session/shared/lib/researchColumns";
import {
  nodeEditedAt,
  nodePrompt,
  nodeRun,
  nodeStatus,
} from "@session/shared/lib/researchNodeTypes";
import { researchMarkerLabel } from "@session/shared/lib/researchThreadView";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { createPortal } from "react-dom";

import { useNodeContent } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { formatRelativeTime } from "../../lib/relativeTime.js";
import { errorMessage } from "../../lib/toast.js";
import { useLiveTurnsStore } from "../../stores/liveTurns.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { useAuthorName } from "../sharing/AuthorChip.js";
import { editedByOther, useThreadCollaboration } from "../sharing/context.js";
import { mayCancel, mayEditText, mayRelaunch } from "../sharing/permissions.js";

import { SpannedHeaderSlot } from "./ColumnChrome.js";
import { ColumnResizer } from "./ColumnResizer.js";
import { EditPreview } from "./EditPreview.js";
import { COLUMN_SCROLL } from "./MessagesColumn.js";
import { AnswerPane, answerRetryable, type AnswerPaneHandlers } from "./Turn.js";
import { BranchOpenGlyph } from "./icons.js";
import { buildSegmentView, timelineTurns, type SegmentView } from "./segmentView.js";
import type { BranchMarker } from "./useThreadAnnotations.js";

/** What an answer column reports about its content. */
export interface PublishedAnswer {
  nodeId: string;
  content: ResearchNodeContent | undefined;
  view: SegmentView;
  turns: readonly Turn[];
  /** Content landed, or a load error did. */
  settled: boolean;
}

/** What the margin markers act on. */
export interface MarkerActions {
  nodeById: ReadonlyMap<string, ResearchNode>;
  branchState: (branchId: string) => "running" | "failed" | null;
  onTip: (tip: { element: HTMLElement; branchIds: string[]; level: number } | null) => void;
  onCloseBranch: (level: number, markerKey: string) => void;
  onOpenBranch: (level: number, branchId: string) => void;
}

const NO_TURNS: readonly Turn[] = [];
const NO_NODES: readonly ResearchNode[] = [];

function MarkerButton({
  level,
  marker,
  openHeadId,
  actions,
}: {
  level: number;
  marker: BranchMarker;
  openHeadId: string | null;
  actions: MarkerActions;
}) {
  const openIndex = openHeadId ? marker.branchIds.indexOf(openHeadId) : -1;
  const target = marker.branchIds[openIndex < 0 ? 0 : openIndex];
  const count = marker.branchIds.length;
  const states = marker.branchIds.map(actions.branchState);
  const state = states.includes("failed")
    ? "failed"
    : states.includes("running")
      ? "running"
      : null;
  const whole = marker.top === null;
  const targetNode = target ? actions.nodeById.get(target) : undefined;
  const label = researchMarkerLabel({
    count,
    whole,
    open: openIndex >= 0,
    state,
    targetPrompt: targetNode ? nodePrompt(targetNode) : "",
  });
  const showTip = (element: HTMLElement) =>
    actions.onTip(openIndex >= 0 ? null : { element, branchIds: marker.branchIds, level });
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[22px] min-w-[26px] items-center justify-center gap-[3px] rounded-sm border-0 bg-transparent px-1 select-none",
        "text-[length:calc(11.5px+var(--font-ui-size-offset))] leading-none font-medium tabular-nums underline-offset-[3px]",
        openIndex >= 0
          ? "text-accent decoration-accent underline"
          : "text-fg-faint hover:text-fg-heading hover:underline hover:decoration-[var(--surface-border-strong)]",
        !whole && "absolute right-1.5",
        FOCUS_RING,
      )}
      style={whole ? undefined : { top: marker.top ?? 0 }}
      data-research-marker={marker.key}
      aria-label={label}
      aria-current={openIndex >= 0 ? "true" : undefined}
      onMouseEnter={(event) => showTip(event.currentTarget)}
      onMouseLeave={() => actions.onTip(null)}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) showTip(event.currentTarget);
      }}
      onBlur={() => actions.onTip(null)}
      onClick={() => {
        actions.onTip(null);
        if (openIndex >= 0) actions.onCloseBranch(level, marker.key);
        else if (target) actions.onOpenBranch(level, target);
      }}
    >
      <BranchOpenGlyph state={state} size={12} />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

export function AnswerColumn({
  column,
  node,
  label,
  current,
  archived,
  markers,
  openBranchHeadId,
  preview,
  editing,
  expanded,
  fullTrace,
  cancelling,
  recapPending,
  pointerOverAnnotation,
  retrying,
  handlers,
  markerActions,
  onPublish,
  onOpenContextMenu,
  onScroll,
}: {
  column: Extract<ResearchColumn, { role: "answer" }>;
  node: ResearchNode;
  label: string;
  current: boolean;
  archived: boolean;
  markers: readonly BranchMarker[];
  openBranchHeadId: string | null;
  /** The edited document's saved and edited text, while they differ. */
  preview: { original: string; next: string; imported: boolean } | null;
  /** The root document is open in the editor column. */
  editing: boolean;
  expanded: boolean;
  fullTrace: boolean;
  cancelling: boolean;
  recapPending: boolean;
  pointerOverAnnotation: boolean;
  retrying: boolean;
  handlers: AnswerPaneHandlers;
  markerActions: MarkerActions;
  onPublish: (answer: PublishedAnswer) => void;
  onOpenContextMenu: (nodeId: string, point: { x: number; y: number }) => void;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const level = column.level.index;
  const nodeId = node.id;
  const content = useNodeContent(nodeId);
  const inFlightTurnId = useLiveTurnsStore((state) => state.byNode[nodeId]?.inFlightTurnId ?? null);
  const committed = content.turns.length === 0 ? NO_TURNS : content.turns;
  const turns = useMemo(
    () => timelineTurns(nodeId, committed, content.inFlightText, inFlightTurnId),
    [committed, content.inFlightText, inFlightTurnId, nodeId],
  );
  const view = useMemo(
    () =>
      buildSegmentView({
        node,
        content: content.content,
        turns,
        showAllTurns: expanded,
        showFullTrace: fullTrace,
      }),
    [content.content, expanded, fullTrace, node, turns],
  );
  const contentError = content.error ? errorMessage(content.error) : null;
  const settled = content.content !== undefined || contentError !== null;
  useEffect(() => {
    onPublish({ nodeId, content: content.content, view, turns, settled });
  }, [content.content, nodeId, onPublish, settled, turns, view]);

  const endMarker = markers.find((marker) => marker.top === null) ?? null;
  const status = nodeStatus(node);
  const footTime = status === "complete" ? (nodeRun(node)?.completedAt ?? node.createdAt) : null;
  const editedAt = nodeEditedAt(node);
  const { permissions } = useThreadCollaboration();
  const editedBy = useAuthorName(editedByOther(node));
  const refetch = content.refetch;
  const paneHandlers = useMemo<AnswerPaneHandlers>(
    () => ({ ...handlers, onRetryContentLoad: () => refetch() }),
    [handlers, refetch],
  );
  return (
    <section
      className={cn(
        "research-pair-answer relative flex h-full w-(--research-answer-width) min-w-0 shrink-0 flex-col",
        "border-r border-r-[var(--surface-divider)] bg-[var(--research-thread-page-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label={`Answer to: ${researchPairLabel(label)}`}
    >
      <SpannedHeaderSlot />
      {/* The scroll area takes focus so the keys read it (09 §4). */}
      <div
        className={COLUMN_SCROLL}
        data-research-scroll=""
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={editing ? 0 : -1}
        onScroll={onScroll}
        onContextMenu={
          status !== "queued"
            ? (event) => {
                if (event.target instanceof Element && event.target.closest("a")) return;
                const selection = window.getSelection();
                if (selection && !selection.isCollapsed) return;
                event.preventDefault();
                onOpenContextMenu(nodeId, { x: event.clientX, y: event.clientY });
              }
            : undefined
        }
      >
        <article
          className="research-answer research-reading-surface relative min-h-full pt-[18px] pr-[42px] pb-4 pl-6"
          data-research-answer=""
        >
          {preview ? (
            <EditPreview
              original={preview.original}
              next={preview.next}
              imported={preview.imported}
              label="Preview"
            />
          ) : (
            <AnswerPane
              view={view}
              node={node}
              turns={turns}
              contentError={contentError}
              loading={content.isLoading || content.content === undefined}
              thinking={content.status === "thinking"}
              cancelling={cancelling}
              recapPending={recapPending}
              pointerOverAnnotation={pointerOverAnnotation}
              canRetry={answerRetryable(node, archived) && mayRelaunch(permissions, node)}
              retrying={retrying}
              canEditQuestion={
                !archived &&
                status === "failed" &&
                Boolean(node.parentNodeId) &&
                mayEditText(permissions, NO_NODES, node)
              }
              canCancel={mayCancel(permissions, node)}
              handlers={paneHandlers}
            />
          )}
          {preview
            ? null
            : markers
                .filter((marker) => marker.top !== null)
                .map((marker) => (
                  <MarkerButton
                    key={marker.key}
                    level={level}
                    marker={marker}
                    openHeadId={openBranchHeadId}
                    actions={markerActions}
                  />
                ))}
          {preview ? null : footTime !== null || endMarker ? (
            <div className="text-fg-faint relative mt-2 flex min-h-[22px] items-start gap-2 text-[length:calc(12px+var(--font-ui-size-offset))]">
              {footTime !== null ? (
                <div className="border-border-divider min-w-0 flex-1 border-t pt-2.5">
                  <time
                    dateTime={new Date(footTime).toISOString()}
                    title={new Date(footTime).toLocaleString()}
                  >
                    {formatRelativeTime(footTime)}
                  </time>
                  {editedAt ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span title={new Date(editedAt).toLocaleString()}>
                        Edited {editedBy ? `by ${editedBy} ` : ""}
                        {formatRelativeTime(editedAt)}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="flex-1" />
              )}
              {endMarker ? (
                <span className="absolute top-2 right-[-36px]">
                  <MarkerButton
                    level={level}
                    marker={endMarker}
                    openHeadId={openBranchHeadId}
                    actions={markerActions}
                  />
                </span>
              ) : null}
            </div>
          ) : null}
        </article>
      </div>
      <ColumnResizer kind="answer" label="Resize answer column" />
    </section>
  );
}

/** A level's answer column while a queued message of its column is
 * selected: the question's state and Cancel queued message. */
export function QueuedAnswerColumn({
  column,
  prompt,
  failedReason,
  current,
  onCancel,
}: {
  column: Extract<ResearchColumn, { role: "answer" }>;
  prompt: string;
  failedReason: string | null;
  current: boolean;
  onCancel: () => void;
}) {
  return (
    <section
      className={cn(
        "research-pair-answer relative flex h-full w-(--research-answer-width) min-w-0 shrink-0 flex-col",
        "border-r border-r-[var(--surface-divider)] bg-[var(--research-thread-page-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label={`Queued message: ${researchPairLabel(prompt)}`}
    >
      <SpannedHeaderSlot />
      <div className={COLUMN_SCROLL} data-research-scroll="" tabIndex={-1}>
        <article className="research-answer research-reading-surface pt-[18px] pr-[42px] pb-4 pl-6">
          <section aria-label="Queued message">
            <div className="text-fg-muted text-sm" role="status">
              {failedReason ? `Not sent: ${failedReason}` : "Queued"}
            </div>
            <div className="mt-3">
              <button
                className={cn(
                  "border-border-control bg-control text-fg-control hover:bg-control-hover min-h-control-sm rounded-md border px-2.5 text-sm",
                  FOCUS_RING,
                )}
                type="button"
                onClick={onCancel}
              >
                Cancel queued message
              </button>
            </div>
          </section>
        </article>
      </div>
      <ColumnResizer kind="answer" label="Resize answer column" />
    </section>
  );
}

/** The branch questions behind a margin marker, beside it on hover or
 * keyboard focus. Not interactive; Esc hides it. */
export function MarkerTip({
  anchor,
  items,
  opensNext,
  onDismiss,
}: {
  anchor: HTMLElement;
  items: {
    id: string;
    question: string;
    source: string;
    messages: number;
    state: "open" | "running" | "failed" | null;
  }[];
  opensNext: boolean;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const tip = ref.current;
      if (!tip || !anchor.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      let left = rect.left - 8 - width;
      let top = rect.top - 6;
      if (left < 8) {
        left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
        top = rect.bottom + 6;
      }
      top = Math.max(8, Math.min(window.innerHeight - height - 8, top));
      setPosition((current) =>
        current?.left === left && current.top === top ? current : { left, top },
      );
    };
    place();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, items, onDismiss]);
  const clip = (text: string, length: number) => {
    const flat = text.split(/\s+/).join(" ").trim();
    return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
  };
  return createPortal(
    <div
      ref={ref}
      className="bg-surface-popover border-border-divider shadow-popover pointer-events-none fixed z-(--z-popover) flex w-72 flex-col rounded-lg border text-sm"
      role="tooltip"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? undefined : "hidden",
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="border-border-divider flex flex-col gap-1 border-b px-3 py-2 last:border-b-0"
        >
          <span className="text-fg-primary">{clip(item.question, 160)}</span>
          <span className="text-fg-muted flex flex-wrap gap-x-2 text-xs">
            <span className="min-w-0 truncate">{clip(item.source, 62)}</span>
            <span>
              {item.messages} {item.messages === 1 ? "message" : "messages"}
            </span>
            {item.state === "open" ? <span className="text-accent">Open</span> : null}
            {item.state === "running" ? <span className="text-status-active">Running</span> : null}
            {item.state === "failed" ? <span className="text-status-failed">Failed</span> : null}
          </span>
        </div>
      ))}
      {items.length > 1 ? (
        <div className="text-fg-muted px-3 py-2 text-xs">
          Click opens the {opensNext ? "next" : "first"} branch.
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
