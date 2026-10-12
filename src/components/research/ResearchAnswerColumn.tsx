import { useLayoutEffect, useRef, useState, type ComponentProps, type UIEvent } from "react";
import { createPortal } from "react-dom";
import type { ResearchBranchMarker } from "../../hooks/useResearchAnnotations";
import { researchPairLabel } from "../../lib/researchBranchView";
import { canRetryResearchNode, isActiveResearchStatus } from "../../lib/researchChains";
import { columnAttributes, type ResearchColumn } from "../../lib/researchColumns";
import { nodeEditedAt, nodePrompt, nodeRun, nodeStatus } from "../../lib/researchNodeTypes";
import type { SegmentView } from "../../lib/researchSegmentView";
import { researchMarkerLabel } from "../../lib/researchThreadView";
import type { QueuedResearchFollowup } from "../../lib/researchNavigation";
import type { ResearchNode } from "../../types";
import { ResearchRelativeTime } from "./ResearchClock";
import { ResearchColumnResizer } from "./ResearchColumnResizer";
import { ResearchEditPreview } from "./ResearchEditorColumn";
import { ResearchBranchOpenGlyph } from "./ResearchIcons";
import { ResearchAnswerPane } from "./ResearchTurn";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";

/** The answer pane's callbacks, the same for every answer column. */
export type ResearchAnswerPaneHandlers = Pick<
  ComponentProps<typeof ResearchAnswerPane>,
  | "registerSegmentElement"
  | "onExpandTurns"
  | "onRetryContentLoad"
  | "onToggleFullTrace"
  | "onCancelNode"
  | "onRetryNode"
  | "onRemoveQueuedRetry"
  | "onEditQuestion"
  | "onRootKeyUp"
  | "onRootClick"
  | "onRootMouseMove"
  | "onRootMouseLeave"
>;

/** What the margin markers of an answer column act on. */
export interface ResearchMarkerActions {
  nodeById: ReadonlyMap<string, ResearchNode>;
  /** Running or failed, when a message in a branch (or below it) is. */
  branchState: (branchId: string) => "running" | "failed" | null;
  /** Shows the tip for a marker's branches, or hides it (null). */
  onTip: (tip: { element: HTMLElement; branchIds: string[]; level: number } | null) => void;
  /** A click on the marker of the open branch: closes the levels after
   * `level`. */
  onCloseBranch: (level: number, markerKey: string) => void;
  onOpenBranch: (level: number, branchId: string) => void;
}

/** The … button of a message's answer menu, in its messages-column row. */
function answerMenuButton(nodeId: string) {
  return (
    document
      .querySelector(`[data-research-row][data-node-id="${CSS.escape(nodeId)}"]`)
      ?.closest("li")
      ?.querySelector<HTMLElement>(".research-feed-card-menu") ?? null
  );
}

/** A margin marker beside an answer, styled as a link: an up-right arrow and
 * the number of branches from one paragraph (at its height), or from the
 * whole answer (in the foot, after the last paragraph). The arrow is the
 * running or failed glyph while a message in those branches runs or has
 * failed. A click selects the first branch in the next column, or, when one
 * of the marker's branches is selected there, clears that column. */
function ResearchBranchMarkerButton({
  level,
  marker,
  openHeadId,
  actions,
}: {
  level: number;
  marker: ResearchBranchMarker;
  /** The head of the branch open as the next level, if any. */
  openHeadId: string | null;
  actions: ResearchMarkerActions;
}) {
  const openIndex = openHeadId ? marker.branchIds.indexOf(openHeadId) : -1;
  const target = marker.branchIds[openIndex < 0 ? 0 : openIndex];
  const count = marker.branchIds.length;
  const states = marker.branchIds.map(actions.branchState);
  const state = states.includes("failed") ? "failed" : states.includes("running") ? "running" : null;
  const whole = marker.top === null;
  const targetNode = actions.nodeById.get(target);
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
      className={`research-marker${openIndex >= 0 ? " is-open" : ""}${state ? ` is-${state}` : ""}${
        whole ? " is-end" : ""
      }`}
      style={whole ? undefined : { top: marker.top ?? 0 }}
      data-research-marker={marker.key}
      aria-label={label}
      aria-current={openIndex >= 0 ? "true" : undefined}
      onMouseEnter={(event) => showTip(event.currentTarget)}
      onMouseLeave={() => actions.onTip(null)}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) {
          showTip(event.currentTarget);
        }
      }}
      onBlur={() => actions.onTip(null)}
      onClick={() => {
        actions.onTip(null);
        if (openIndex >= 0) {
          actions.onCloseBranch(level, marker.key);
        } else if (target) {
          actions.onOpenBranch(level, target);
        }
      }}
    >
      <ResearchBranchOpenGlyph state={state} size={12} />
      <span className="research-tnum">{count}</span>
    </button>
  );
}

/** A level's answer column (A{level}): the selected message's answer, its
 * margin markers, and a foot with the answer's time and the whole-answer
 * marker. While the root document is being edited with changes, the column
 * shows the edit's preview instead. */
export function ResearchAnswerColumn({
  column,
  node,
  view,
  label,
  current,
  archived,
  markers,
  openBranchHeadId,
  preview,
  editing,
  contentError,
  cancelling,
  recapPending,
  pointerOverAnnotation,
  retrying,
  retryQueued,
  paneHandlers,
  markerActions,
  onOpenContextMenu,
  onScroll,
}: {
  column: Extract<ResearchColumn, { role: "answer" }>;
  node: ResearchNode;
  view: SegmentView;
  /** The message's label, for the column's accessible name. */
  label: string;
  /** The column's level is the current one. */
  current: boolean;
  archived: boolean;
  markers: readonly ResearchBranchMarker[];
  /** The head of the branch open as the next level, if any. */
  openBranchHeadId: string | null;
  /** The edited document's saved and edited text, while they differ. */
  preview: { original: string; next: string; imported: boolean } | null;
  /** The root document is open in the editor column. */
  editing: boolean;
  contentError: string | null;
  cancelling: boolean;
  recapPending: boolean;
  pointerOverAnnotation: boolean;
  /** A retry or rerun of this message is in flight. */
  retrying: boolean;
  /** A retry waits for the running answer in this conversation. */
  retryQueued: boolean;
  paneHandlers: ResearchAnswerPaneHandlers;
  markerActions: ResearchMarkerActions;
  onOpenContextMenu: (nodeId: string, placement: ResearchUnitMenuPlacement) => void;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const level = column.level.index;
  const nodeId = node.id;
  const active = isActiveResearchStatus(nodeStatus(node));
  const endMarker = markers.find((marker) => marker.top === null) ?? null;
  const footTime = nodeStatus(node) === "complete" ? (nodeRun(node)?.completedAt ?? node.createdAt) : null;
  const startedAt = nodeRun(node)?.startedAt ?? null;
  const editedAt = nodeEditedAt(node);
  // The answer's context menu is its … menu, which its message row shows
  // unless the question is queued. A text selection in the answer keeps the
  // Highlight/Branch bar and the webview's menu.
  const answerMenuProps =
    nodeStatus(node) !== "queued" && !retryQueued
      ? researchUnitMenuProps(
          (placement) => onOpenContextMenu(nodeId, placement),
          () => ({ element: answerMenuButton(nodeId), align: "end" }),
        )
      : null;
  return (
    <section
      className={`research-pair-answer${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label={`Answer to: ${researchPairLabel(label)}`}
    >
      <header className="research-column-header is-spanned">
        <div className="research-column-bar" data-tauri-drag-region />
      </header>
      <div
        className="research-column-scroll"
        // While the editor is open, Shift+Tab from it reaches the preview.
        tabIndex={editing ? 0 : -1}
        onScroll={onScroll}
        {...answerMenuProps}
      >
        <article className="research-answer research-reading-surface">
          {preview ? (
            <ResearchEditPreview
              original={preview.original}
              next={preview.next}
              imported={preview.imported}
              label="Preview"
            />
          ) : (
            <ResearchAnswerPane
              view={view}
              node={node}
              contentError={contentError}
              cancelling={cancelling}
              elapsedSince={active && startedAt ? startedAt : null}
              recapPending={recapPending}
              pointerOverAnnotation={pointerOverAnnotation}
              canRetry={!archived && canRetryResearchNode(node)}
              retrying={retrying}
              retryQueued={retryQueued}
              canEditQuestion={!archived && nodeStatus(node) === "failed" && Boolean(node.parentNodeId)}
              {...paneHandlers}
            />
          )}
          {preview
            ? null
            : markers
                .filter((marker) => marker.top !== null)
                .map((marker) => (
                  <ResearchBranchMarkerButton
                    key={marker.key}
                    level={level}
                    marker={marker}
                    openHeadId={openBranchHeadId}
                    actions={markerActions}
                  />
                ))}
          {preview ? null : footTime !== null || endMarker ? (
            <div className={`research-answer-foot${footTime === null ? " is-bare" : ""}`}>
              {footTime !== null ? (
                <div className="research-answer-foot-meta">
                  <time dateTime={new Date(footTime).toISOString()} title={new Date(footTime).toLocaleString()}>
                    <ResearchRelativeTime at={footTime} />
                  </time>
                  {editedAt ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      <span title={new Date(editedAt).toLocaleString()}>
                        Edited <ResearchRelativeTime at={editedAt} />
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
              {endMarker ? (
                <ResearchBranchMarkerButton
                  level={level}
                  marker={endMarker}
                  openHeadId={openBranchHeadId}
                  actions={markerActions}
                />
              ) : null}
            </div>
          ) : null}
        </article>
      </div>
      <ResearchColumnResizer kind="answer" label="Resize answer column" />
    </section>
  );
}

/** A level's answer column (A{level}) while a queued message of its column
 * is selected: the question, its state, and Cancel queued message, which
 * removes it from the queue (the message queued after it moves up). */
export function ResearchQueuedAnswerColumn({
  column,
  item,
  current,
  onCancel,
}: {
  column: Extract<ResearchColumn, { role: "answer" }>;
  item: QueuedResearchFollowup;
  current: boolean;
  onCancel: () => void;
}) {
  return (
    <section
      className={`research-pair-answer${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label={`Queued message: ${researchPairLabel(item.prompt)}`}
    >
      <header className="research-column-header is-spanned">
        <div className="research-column-bar" data-tauri-drag-region />
      </header>
      <div className="research-column-scroll" tabIndex={-1}>
        <article className="research-answer research-reading-surface">
          <section className="research-response" aria-label="Queued message">
            <div className="research-turn-note is-state" role="status">
              {item.failed ? `Not sent: ${item.failed}` : "Queued"}
            </div>
            <div className="research-turn-actions">
              <button className="control-button research-turn-button" type="button" onClick={onCancel}>
                Cancel queued message
              </button>
            </div>
          </section>
        </article>
      </div>
      <ResearchColumnResizer kind="answer" label="Resize answer column" />
    </section>
  );
}

/** The branch questions behind a margin marker, shown beside it on hover
 * or keyboard focus. Not interactive; Esc hides it. */
export function ResearchMarkerTip({
  anchor,
  items,
  opensNext,
  onDismiss,
}: {
  anchor: HTMLElement;
  items: { id: string; question: string; source: string; messages: number; state: "open" | "running" | null }[];
  /** One of the marker's branches is open: a click opens the next one. */
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
      setPosition((current) => (current?.left === left && current.top === top ? current : { left, top }));
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
      className="research-marker-tip"
      role="tooltip"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? undefined : "hidden" }}
    >
      {items.map((item) => (
        <div key={item.id} className="research-marker-tip-item">
          <span className="research-marker-tip-question">{clip(item.question, 160)}</span>
          <span className="research-marker-tip-meta">
            <span className="research-marker-tip-source">{clip(item.source, 62)}</span>
            <span>
              {item.messages} {item.messages === 1 ? "message" : "messages"}
            </span>
            {item.state === "open" ? <span className="is-open">Open</span> : null}
            {item.state === "running" ? <span className="is-running">Running</span> : null}
          </span>
        </div>
      ))}
      {items.length > 1 ? (
        <div className="research-marker-tip-item">
          <span className="research-marker-tip-meta">Click opens the {opensNext ? "next" : "first"} branch.</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
