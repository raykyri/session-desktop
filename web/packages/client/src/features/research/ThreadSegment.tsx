// One node of the rendered spine (`09-research-document-view.md` §2, §3).
//
// Structure only: the prompt above, then a two-track grid holding the connector
// overlay, the answer, and the rail. The prompt, answer, connectors and rail
// each own a memo boundary, so a follow-up streaming a preview in the margin
// does not rebuild the answer's element tree.
//
// Each segment fetches its own content independently to comply with React hook rules during dynamic list growth, bubbling required state back to the parent.

import { isActiveResearchStatus } from "@session/shared";
import type { ResearchNode, ResearchNodeContent, Turn } from "@session/shared";
import { memo, useCallback, useEffect, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { useNodeContent } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { errorMessage } from "../../lib/toast.js";
import { useLiveTurnsStore } from "../../stores/liveTurns.js";
import { useWikilinkActions } from "../encyclopedia/wikilinkActions.js";
import { WikilinkActionsProvider } from "../markdown/index.js";

import { AnswerPane } from "./AnswerPane.js";
import { ConnectorOverlay, FollowupRail } from "./FollowupRail.js";
import { SegmentPrompt } from "./SegmentPrompt.js";
import { RESEARCH_COLUMNS_CLASS } from "./layout.js";
import type { SegmentConnector } from "./layout.js";
import { buildSegmentView, timelineTurns } from "./timeline.js";
import type { SegmentView } from "./timeline.js";

export type SegmentElementKind = "anchor" | "grid" | "root" | "aside";

/** `useNodeContent` answers with a fresh `[]` while a node's snapshot is still
 * in flight. Collapsing every empty list onto one identity is what keeps the
 * memos below — and the publish effect, which feeds the page's own state —
 * from re-running on every render. */
const NO_TURNS: readonly Turn[] = [];

/** What one segment tells the page about its content. Everything here is
 * cross-segment: the revision the highlight painter resolves against, the text
 * the next segment's "Reply to" line quotes, the turns Copy-thread joins. */
export interface PublishedSegment {
  nodeId: string;
  content: ResearchNodeContent | undefined;
  responseRevision: string | undefined;
  turns: readonly Turn[];
  rawAnswer: string;
  editableDocumentMarkdown: string | null;
  /** Content landed, or a terminal error did. Scroll restoration waits for
   * every chain node to reach this. */
  settled: boolean;
}

export interface ThreadSegmentProps {
  node: ResearchNode;
  index: number;
  treeId: string;
  workspaceId: string;
  isSelected: boolean;
  replyToAnswer: string | null;
  followed: boolean;
  bookmarked: boolean;
  showAllTurns: boolean;
  showFullTrace: boolean;
  durationText: string | null;
  hiddenHighlightCount: number;
  recapPending: boolean;
  pointerOverHighlight: boolean;
  linkedAnchorId: string | null;
  connectors: readonly SegmentConnector[];
  segmentChildren: readonly ResearchNode[];
  unreadIds: ReadonlySet<string>;
  anchoredCardTops: Record<string, number>;
  resolvedCardTops: Record<string, number>;
  cancelling: boolean;
  canCancel: boolean;
  canRetryNode: boolean;
  retryingNode: boolean;
  askComposer: ReactNode;
  answerMenuItems: ReactNode;

  registerElement: (nodeId: string, kind: SegmentElementKind, element: HTMLElement | null) => void;
  publish: (segment: PublishedSegment) => void;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  actionsBusy?: boolean;
  onSelectNode: (nodeId: string) => void;
  onExpandTurns: (nodeId: string) => void;
  onShowFullTrace: (nodeId: string) => void;
  onCopyAnswer: (nodeId: string) => void;
  onCancelNode: (nodeId: string) => void;
  onRetryNode: (nodeId: string) => void;
  onCardHover: (childId: string, entering: boolean) => void;
  onRootMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseUp: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootKeyUp: () => void;
  onRootClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRootMouseLeave: () => void;
}

export const ThreadSegment = memo(function ThreadSegment(props: ThreadSegmentProps) {
  const {
    node,
    index,
    workspaceId,
    isSelected,
    replyToAnswer,
    followed,
    bookmarked,
    showAllTurns,
    showFullTrace,
    durationText,
    hiddenHighlightCount,
    recapPending,
    pointerOverHighlight,
    linkedAnchorId,
    connectors,
    segmentChildren,
    unreadIds,
    anchoredCardTops,
    resolvedCardTops,
    cancelling,
    canCancel,
    canRetryNode,
    retryingNode,
    askComposer,
    answerMenuItems,
    registerElement,
    publish,
    onSelectNode,
    onCopyAnswer,
  } = props;

  const nodeContent = useNodeContent(node.id);
  // The in-flight turn's id, so the growing text block keeps one timeline key
  // across the commit and the durable swap (`timeline.ts:timelineTurns`).
  const inFlightTurnId = useLiveTurnsStore(
    (state) => state.byNode[node.id]?.inFlightTurnId ?? null,
  );

  const committedTurns = nodeContent.turns.length === 0 ? NO_TURNS : nodeContent.turns;
  const turns = useMemo(
    () => timelineTurns(node.id, committedTurns, nodeContent.inFlightText, inFlightTurnId),
    [node.id, committedTurns, nodeContent.inFlightText, inFlightTurnId],
  );

  const view: SegmentView = useMemo(
    () =>
      buildSegmentView({
        node,
        content: nodeContent.content,
        turns,
        showAllTurns,
        showFullTrace,
      }),
    [node, nodeContent.content, turns, showAllTurns, showFullTrace],
  );

  const contentError = nodeContent.error ? errorMessage(nodeContent.error) : null;
  const responseRevision = nodeContent.content?.responseRevision;
  const settled = nodeContent.content !== undefined || contentError !== null;
  const rawAnswer = view.rawAnswer;
  const editableDocumentMarkdown = view.editableDocumentMarkdown;
  const content = nodeContent.content;

  useEffect(() => {
    publish({
      nodeId: node.id,
      content,
      responseRevision,
      turns,
      rawAnswer,
      editableDocumentMarkdown,
      settled,
    });
  }, [
    publish,
    node.id,
    content,
    responseRevision,
    turns,
    rawAnswer,
    editableDocumentMarkdown,
    settled,
  ]);

  // Bound once per node. An inline `ref` closure is a different function every
  // render, which makes React detach and re-attach the ref — deleting and
  // re-adding the entry in the page's element registry on every commit — and
  // makes the memo on the pane and the rail miss unconditionally.
  const nodeId = node.id;
  const registerAnchor = useCallback(
    (element: HTMLElement | null) => registerElement(nodeId, "anchor", element),
    [registerElement, nodeId],
  );
  const registerGrid = useCallback(
    (element: HTMLElement | null) => registerElement(nodeId, "grid", element),
    [registerElement, nodeId],
  );
  const registerRoot = useCallback(
    (element: HTMLElement | null) => registerElement(nodeId, "root", element),
    [registerElement, nodeId],
  );
  const registerAside = useCallback(
    (element: HTMLElement | null) => registerElement(nodeId, "aside", element),
    [registerElement, nodeId],
  );
  const handleCopyAnswer = useCallback(() => onCopyAnswer(nodeId), [onCopyAnswer, nodeId]);

  const segmentActive = isActiveResearchStatus(node.status);
  // `[[Term]]` links resolve per segment, because the page a term opens records
  // the question it was linked from (`10-home-feed-journal-encyclopedia.md` §6).
  const wikilinkActions = useWikilinkActions(workspaceId, {
    kind: "node",
    nodeId: node.id,
    treeId: props.treeId,
    question: node.prompt,
  });

  return (
    <div
      ref={registerAnchor}
      className={cn("scroll-mt-4", index > 0 && "mt-11", isSelected && "is-selected")}
      data-segment-anchor={node.id}
    >
      <div className={RESEARCH_COLUMNS_CLASS}>
        <SegmentPrompt
          node={node}
          index={index}
          replyToAnswer={replyToAnswer}
          running={segmentActive}
          followed={followed}
          bookmarked={bookmarked}
          workspaceId={workspaceId}
          onSelectNode={onSelectNode}
          onToggleFollow={props.onToggleFollow}
          onToggleBookmark={props.onToggleBookmark}
          actionsBusy={props.actionsBusy ?? false}
        />
      </div>
      <div
        ref={registerGrid}
        className={cn(RESEARCH_COLUMNS_CLASS, "relative max-w-full min-w-0 items-start")}
        data-node-id={node.id}
      >
        <ConnectorOverlay connectors={connectors} linkedAnchorId={linkedAnchorId} />
        <WikilinkActionsProvider actions={wikilinkActions}>
          <AnswerPane
            view={view}
            node={node}
            turns={turns}
            contentError={contentError}
            contentLoading={nodeContent.isLoading || content === undefined}
            segmentActive={segmentActive}
            queuePosition={content?.queuePosition}
            thinking={nodeContent.status === "thinking"}
            durationText={durationText}
            hiddenHighlightCount={hiddenHighlightCount}
            recapPending={recapPending}
            cancelling={cancelling}
            canCancel={canCancel}
            canRetryNode={canRetryNode}
            retryingNode={retryingNode}
            pointerOverHighlight={pointerOverHighlight}
            menuItems={answerMenuItems}
            registerRoot={registerRoot}
            onExpandTurns={props.onExpandTurns}
            onShowFullTrace={props.onShowFullTrace}
            onRetryContentLoad={nodeContent.refetch}
            onCopyAnswer={handleCopyAnswer}
            onCancelNode={props.onCancelNode}
            onRetryNode={props.onRetryNode}
            onRootMouseDown={props.onRootMouseDown}
            onRootMouseUp={props.onRootMouseUp}
            onRootKeyUp={props.onRootKeyUp}
            onRootClick={props.onRootClick}
            onRootMouseMove={props.onRootMouseMove}
            onRootMouseLeave={props.onRootMouseLeave}
          />
        </WikilinkActionsProvider>
        <FollowupRail
          nodeId={node.id}
          cards={segmentChildren}
          unreadIds={unreadIds}
          linkedAnchorId={linkedAnchorId}
          anchoredCardTops={anchoredCardTops}
          resolvedCardTops={resolvedCardTops}
          askComposer={askComposer}
          registerAside={registerAside}
          onSelectNode={onSelectNode}
          onCardHover={props.onCardHover}
        />
      </div>
    </div>
  );
});
