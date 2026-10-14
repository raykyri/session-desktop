// A note's own column body (`09-research-document-view.md` §3), ported from
// the desktop `ResearchPostColumn.tsx` and the `PostContent` of
// `ResearchPost.tsx`: the note as a turn's question, its time and whether it
// was edited. A follow-up note says which note it follows. A link post shows
// a link card, or its tweet once the tweet resolved.

import type {
  PostFormat,
  ResearchMessageAttachment,
  ResearchNode,
  ResearchTreeDetail,
} from "@session/shared";
import { safeHref } from "@session/shared";
import {
  nodeAttachments,
  nodeEditedAt,
  nodePrompt,
  postFollowUpSourceExcerpt,
} from "@session/shared/lib/researchNodeTypes";
import { shortWhen } from "@session/shared/lib/shortTime";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { MessageBody } from "./Turn.js";

/** A post's content by its stored format. */
export function PostContent({
  prompt,
  format,
  attachments = [],
  lead,
  variant = "compact",
}: {
  prompt: string;
  format: PostFormat;
  attachments?: ResearchMessageAttachment[];
  lead?: ReactNode;
  variant?: "compact" | "prose";
}) {
  const resolvedTweet = attachments.some(
    (attachment) =>
      attachment.kind === "tweet" && attachment.status === "resolved" && attachment.tweet,
  );
  if (format === "link" && !resolvedTweet) {
    const url = prompt.trim();
    const href = safeHref(url);
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // A link post's text is one URL; show it whole if it does not parse.
    }
    return (
      <a
        className={cn(
          "border-border-default hover:bg-surface-fill-hover flex flex-col gap-1 rounded-xl border px-3.5 py-3 no-underline",
          FOCUS_RING,
        )}
        href={href ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="text-fg-primary [overflow-wrap:anywhere]">
          {lead}
          {url}
        </span>
        <span className="text-fg-muted flex items-center gap-1 text-xs">
          <ExternalLink size={11} aria-hidden="true" />
          {host}
        </span>
      </a>
    );
  }
  return (
    <MessageBody
      prompt={prompt}
      attachments={attachments}
      lead={lead}
      variant={variant}
      renderPrompt={(content) => (
        <div>
          {lead}
          {content}
        </div>
      )}
    />
  );
}

export function PostColumnBody({
  detail,
  post,
  onSelectNode,
}: {
  detail: ResearchTreeDetail;
  post: ResearchNode;
  onSelectNode: (nodeId: string) => void;
}) {
  const parent = post.parentNodeId
    ? (detail.nodes.find((node) => node.id === post.parentNodeId) ?? null)
    : null;
  const parentExcerpt = parent ? postFollowUpSourceExcerpt(parent, 60) : null;
  const editedAt = nodeEditedAt(post);
  return (
    <article className="flex flex-col gap-2 px-6 pt-5 pb-6">
      {parent && parentExcerpt !== null ? (
        <button
          type="button"
          className={cn(
            "text-fg-muted hover:text-fg-primary w-fit border-0 bg-transparent p-0 text-left text-sm",
            FOCUS_RING,
          )}
          onClick={() => onSelectNode(parent.id)}
        >
          ↳ Follow-up to “{parentExcerpt}”
        </button>
      ) : null}
      <div className="text-fg-strong">
        <PostContent
          prompt={nodePrompt(post)}
          format={post.type === "post" ? post.format : "text"}
          attachments={nodeAttachments(post)}
          variant="prose"
        />
      </div>
      <div className="text-fg-faint flex items-center gap-1.5 text-[length:calc(12px+var(--font-ui-size-offset))]">
        <time
          dateTime={new Date(post.createdAt).toISOString()}
          title={new Date(post.createdAt).toLocaleString()}
        >
          {shortWhen(post.createdAt)}
        </time>
        {editedAt ? (
          <>
            <span aria-hidden="true">·</span>
            <span title={`Edited ${new Date(editedAt).toLocaleString()}`}>Edited</span>
          </>
        ) : null}
      </div>
    </article>
  );
}
