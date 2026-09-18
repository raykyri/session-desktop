// One node of the rendered spine (`09-research-document-view.md` §2, §3).
//
// Structure only: the prompt above, then a two-track grid holding the connector
// overlay, the answer, and the rail. The prompt, answer, connectors and rail
// each own a memo boundary, so a follow-up streaming a preview in the margin
// does not rebuild the answer's element tree.
//
// This is also where a segment's content is fetched. The hook has to live at a
// fixed position in the tree — a chain that grows would otherwise change the
// number of hooks the page calls — so each segment reads its own node and
// publishes what the page's cross-segment machinery needs (the revision the
// highlights anchor against, the answer text the next segment quotes) back up.

import { isActiveResearchStatus } from "@session/shared";
import type { ResearchNode, ResearchNodeContent, Turn } from "@session/shared";
import { memo, useEffect, useMemo } from "react";
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
  showRunControls: boolean;
  cancelling: boolean;
  canRetryNode: boolean;
  retryingNode: boolean;
  askComposer: ReactNode;
  answerMenuItems: ReactNode;

  registerElement: (nodeId: string, kind: SegmentElementKind, element: HTMLElement | null) => void;
  publish: (segment: PublishedSegment) => void;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
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
    showRunControls,
    cancelling,
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
      ref={(element) => registerElement(node.id, "anchor", element)}
      className={cn("scroll-mt-4", index > 0 && "mt-11", isSelected && "is-selected")}
      data-segment-anchor={node.id}
    >
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
      />
      <div
        ref={(element) => registerElement(node.id, "grid", element)}
        className="relative grid max-w-full min-w-0 grid-cols-[minmax(0,var(--research-answer-max-width))_minmax(220px,260px)] items-start gap-(--research-column-gap) max-[900px]:grid-cols-[minmax(0,1fr)]"
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
            showRunControls={showRunControls}
            cancelling={cancelling}
            canRetryNode={canRetryNode}
            retryingNode={retryingNode}
            pointerOverHighlight={pointerOverHighlight}
            menuItems={answerMenuItems}
            registerRoot={(element) => registerElement(node.id, "root", element)}
            onExpandTurns={props.onExpandTurns}
            onShowFullTrace={props.onShowFullTrace}
            onRetryContentLoad={nodeContent.refetch}
            onCopyAnswer={() => onCopyAnswer(node.id)}
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
          registerAside={(element) => registerElement(node.id, "aside", element)}
          onSelectNode={onSelectNode}
          onCardHover={props.onCardHover}
        />
      </div>
    </div>
  );
});
