// One thread segment's question (`09-research-document-view.md` §2).
//
// Index 0 is the page's own question and owns the thread's chrome: the Back
// link to the parent it branched from, the Follow / Bookmark pair, the
// answering model and when it was asked. Every later segment is an inline
// follow-up and shows only what orients the reader inside the thread — the
// snippet it replies to and, for a targeted ask, the passage it was asked
// about.

import type { ResearchNode } from "@session/shared";
import { visibleResearchPrompt } from "@session/shared";
import { ArrowLeft, Reply } from "lucide-react";
import { memo } from "react";

import { useSignedIn } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { ControlButton } from "../../ui/Button.js";
import { ModelMeta } from "../../ui/ModelMark.js";
import { METADATA_LINE } from "../../ui/surfaces.js";
import { TweetAttachments, resolvedTweets } from "../journal/TweetAttachments.js";
import { ResearchMarkdown } from "../markdown/index.js";

import { DocumentChips } from "./DocumentChips.js";
import { ThreadActions } from "./ThreadActions.js";
import { formatResearchReplySnippet, quoteDisplayText } from "./selection/dom.js";

/** Follow and Bookmark for one thread. Both flags live on the tree, so Home's
 * card and the open thread render the same pair from the same state. */
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
  actionsBusy?: boolean;
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
  actionsBusy = false,
}: SegmentPromptProps) {
  const signedIn = useSignedIn();
  if ((node.kind ?? "run") === "document") return null;
  const replySnippet = index > 0 ? formatResearchReplySnippet(replyToAnswer ?? "") : "";
  // The posts the question links to are embedded below it, and a permalink
  // that trailed the question is dropped from the text the card replaces
  // (`ResearchMessage.tsx:visibleResearchPrompt`). The stored prompt is
  // untouched: it is what the run was launched with.
  const prompt = visibleResearchPrompt(node.prompt, node.attachments);
  const embedded = resolvedTweets(node.attachments).length > 0;
  const askedAt = index === 0 && Number.isFinite(node.createdAt) ? node.createdAt : null;
  // Metadata items (follow button, model badge, elapsed time) are displayed only after the run completes.
  const showFooter = index === 0 && !running;
  const parentNodeId = node.parentNodeId ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
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
      {prompt ? (
        <div
          className={cn(
            "text-fg-strong w-fit max-w-full",
            showFooter || embedded ? "mb-0" : "mb-6",
          )}
        >
          <ResearchMarkdown markdown={prompt} />
        </div>
      ) : null}
      <TweetAttachments
        attachments={node.attachments}
        className={cn("w-full pb-1", prompt && "mt-2.5", !showFooter && "mb-6")}
      />
      {node.documentIds.length > 0 ? (
        <DocumentChips documentIds={node.documentIds} workspaceId={workspaceId} />
      ) : null}
      {showFooter ? (
        <div
          className={cn(
            "text-fg-subtle mt-[5px] mb-6 flex min-w-0 items-center gap-3",
            METADATA_LINE,
          )}
        >
          <ModelMeta modelId={node.model} origin={node.origin} at={askedAt} />
          {signedIn ? (
            <ThreadActions
              className="ml-auto"
              followed={followed}
              bookmarked={bookmarked}
              onToggleFollow={onToggleFollow}
              onToggleBookmark={onToggleBookmark}
              busy={actionsBusy}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
