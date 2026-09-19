// One thread segment's question (`09-research-document-view.md` §2).
//
// Index 0 is the page's own question and owns the thread's chrome: the Back
// link to the parent it branched from, the Follow / Bookmark pair, the
// answering model and when it was asked. Every later segment is an inline
// follow-up and shows only what orients the reader inside the thread — the
// snippet it replies to and, for a targeted ask, the passage it was asked
// about.

import type { ResearchNode } from "@session/shared";
import { ArrowLeft, Bookmark, Reply } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/cn.js";
import { formatRelativeTime } from "../../lib/relativeTime.js";
import { formatResearchModelSummary } from "../../ui/ActivityMetadataLine.js";
import { ControlButton } from "../../ui/Button.js";
import { ResearchMarkdown } from "../markdown/index.js";

import { DocumentChips } from "./DocumentChips.js";
import { formatResearchReplySnippet, quoteDisplayText } from "./selection/dom.js";

/** Follow and Bookmark for one thread. Both flags live on the tree, so Home's
 * card and the open thread render the same pair from the same state. */
export function ThreadActions({
  followed,
  bookmarked,
  onToggleFollow,
  onToggleBookmark,
}: {
  followed: boolean;
  bookmarked: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ControlButton
        size="sm"
        aria-pressed={followed}
        title={followed ? "Stop following this thread" : "Follow this thread"}
        className={cn(followed && "text-fg-strong border-border-control-accent")}
        onClick={onToggleFollow}
      >
        {followed ? "Following" : "Follow"}
      </ControlButton>
      <ControlButton
        size="sm"
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
        title={bookmarked ? "Remove bookmark" : "Bookmark this thread"}
        className={cn("px-2", bookmarked && "text-fg-strong border-border-control-accent")}
        onClick={onToggleBookmark}
      >
        <Bookmark size={13} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
      </ControlButton>
    </div>
  );
}

export interface SegmentPromptProps {
  node: ResearchNode;
  /** Position in the rendered spine. Index 0 is the page's question. */
  index: number;
  /** The previous segment's answer, for the "Reply to" line. */
  replyToAnswer: string | null;
  running: boolean;
  followed: boolean;
  bookmarked: boolean;
  workspaceId: string;
  onSelectNode: (nodeId: string) => void;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
}

export const SegmentPrompt = memo(function SegmentPrompt({
  node,
  index,
  replyToAnswer,
  running,
  followed,
  bookmarked,
  workspaceId,
  onSelectNode,
  onToggleFollow,
  onToggleBookmark,
}: SegmentPromptProps) {
  if ((node.kind ?? "run") === "document") return null;

  const replySnippet = index > 0 ? formatResearchReplySnippet(replyToAnswer ?? "") : "";
  const modelSummary = index === 0 ? formatResearchModelSummary(node.model, node.origin) : "";
  const askedAt = index === 0 && Number.isFinite(node.createdAt) ? node.createdAt : null;
  // Metadata items (follow button, model badge, elapsed time) are displayed only after the run completes.
  const showFooter = index === 0 && !running;
  const parentNodeId = node.parentNodeId ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-[5px]">
      {index === 0 && parentNodeId ? (
        <div>
          <ControlButton size="sm" onClick={() => onSelectNode(parentNodeId)}>
            <ArrowLeft size={13} aria-hidden="true" />
            Back
          </ControlButton>
        </div>
      ) : null}
      {index > 0 && replySnippet ? (
        <div className="text-fg-subtle flex min-w-0 items-center gap-1.5 text-sm">
          <Reply size={12} aria-hidden="true" />
          <span className="min-w-0 truncate">{`Reply to: ${replySnippet}`}</span>
        </div>
      ) : null}
      {node.queryAnchor ? (
        <blockquote className="research-prompt-quote border-accent my-1.5 w-fit max-w-full border-l-2 pl-2.5">
          {quoteDisplayText(node.queryAnchor.exact)}
        </blockquote>
      ) : null}
      <div className={cn("text-fg-strong w-fit max-w-full", showFooter ? "mb-0" : "mb-[26px]")}>
        <ResearchMarkdown markdown={node.prompt} />
      </div>
      {node.documentIds.length > 0 ? (
        <DocumentChips documentIds={node.documentIds} workspaceId={workspaceId} />
      ) : null}
      {showFooter ? (
        <div className="text-fg-subtle mt-1.5 mb-[26px] flex min-w-0 items-center gap-2.5 text-sm">
          <ThreadActions
            followed={followed}
            bookmarked={bookmarked}
            onToggleFollow={onToggleFollow}
            onToggleBookmark={onToggleBookmark}
          />
          <span
            className="min-w-0 truncate"
            title={askedAt !== null ? new Date(askedAt).toLocaleString() : undefined}
          >
            {modelSummary}
            {modelSummary && askedAt !== null ? " · " : null}
            {askedAt !== null ? (
              <time dateTime={new Date(askedAt).toISOString()}>{formatRelativeTime(askedAt)}</time>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
});
