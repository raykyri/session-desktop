// The feed's research card (`10-home-feed-journal-encyclopedia.md` §2, ported
// from `ResearchActivityFeed.tsx:334-474`).
//
// The prompt is shown as the reader's own question, which means the launch
// scaffolding comes off first (`stripTaggedInstructionBlocksForPreview`) and
// wikilinks render as their labels rather than as `[[…]]`. Follow and Bookmark
// appear only once the run has settled: a card whose answer is still being
// written has nothing to follow yet.

import type { RecentResearchQuery, ResearchTreeSummary } from "@session/shared";
import {
  isActiveResearchStatus,
  stripTaggedInstructionBlocksForPreview,
  stripWikilinks,
} from "@session/shared";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { ContextMenu } from "../../ui/ContextMenu.js";
import { ModelMeta } from "../../ui/ModelMark.js";
import { METADATA_LINE } from "../../ui/surfaces.js";
import { TweetEmbed } from "../journal/TweetEmbed.js";
import { ResearchMarkdown } from "../markdown/index.js";
import { ThreadActions } from "../research/ThreadActions.js";

/** The short quote a follow-up anchored to a passage shows above its question
 * (`ResearchActivityFeed.tsx:318`). */
export function queryTargetExcerpt(target: string, maxWords = 5, maxChars = 40): string {
  const normalized = target.split(/\s+/).filter(Boolean).join(" ");
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const wordExcerpt = words.slice(0, maxWords).join(" ");
  const truncated = words.length > maxWords || [...normalized].length > maxChars;
  if (!truncated) return wordExcerpt;
  const characterLimit = Math.max(1, maxChars - 1);
  let excerpt = [...wordExcerpt].slice(0, characterLimit).join("").trimEnd();
  if ([...wordExcerpt].length > characterLimit) {
    excerpt = excerpt.replace(/\s+\S*$/u, "").trimEnd() || excerpt;
  }
  return `${excerpt}…`;
}

export function promptPreview(prompt: string): string {
  return stripWikilinks(stripTaggedInstructionBlocksForPreview(prompt)).trim();
}

/** Opens the thread the way the question does: a clickable block, no hover
 * underline, and inner links/buttons keep their own clicks. */
function OpenThreadControl({
  onOpen,
  className,
  children,
}: {
  onOpen: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "w-fit max-w-full cursor-pointer rounded-[5px] text-left no-underline hover:no-underline",
        className,
      )}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, button")) return;
        onOpen();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      {children}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function ResearchQueryCard({
  query,
  tree,
  menuItems,
  onOpen,
  onOpenChild,
  onToggleFollow,
  onToggleBookmark,
  actionsBusy = false,
}: {
  query: RecentResearchQuery;
  tree: ResearchTreeSummary | undefined;
  /** The thread menu, shared with the sidebar. */
  menuItems: ReactNode;
  onOpen: () => void;
  onOpenChild: (child: RecentResearchQuery) => void;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
  actionsBusy?: boolean;
}) {
  const recap = query.recap?.trim() ?? "";
  const running = isActiveResearchStatus(query.status);
  const status = STATUS_LABEL[query.status];
  const attachments = (query.attachments ?? []).filter(
    (attachment) => attachment.status === "resolved" && attachment.tweet,
  );
  const followed = Boolean(tree?.followed);
  const bookmarked = Boolean(tree?.bookmarked);

  return (
    <ContextMenu label={`Actions for ${tree?.title ?? "this thread"}`} items={menuItems}>
      <div className="flex flex-col gap-2">
        {query.queryTarget ? (
          <p className="research-prompt-quote m-0 truncate" title={query.queryTarget}>
            @{queryTargetExcerpt(query.queryTarget)}
          </p>
        ) : null}

        <article className="mb-0.5">
          <OpenThreadControl onOpen={onOpen} className="research-prose">
            {promptPreview(query.prompt)}
          </OpenThreadControl>
        </article>

        {attachments.length > 0 ? (
          <ul aria-label="Attached posts" className="m-0 flex list-none flex-col gap-2 p-0">
            {attachments.map((attachment) =>
              attachment.tweet ? (
                <li key={attachment.tweetId} className="border-border-divider rounded-lg border">
                  <TweetEmbed tweet={attachment.tweet} />
                </li>
              ) : null,
            )}
          </ul>
        ) : null}

        {running ? (
          <p className="text-fg-muted m-0 flex items-center gap-1.5 text-sm" role="status">
            <LoaderCircle size={13} aria-hidden="true" className="session-spin" />
            <span>Generating answer</span>
          </p>
        ) : recap ? (
          <OpenThreadControl onOpen={onOpen}>
            <ResearchMarkdown markdown={`Summary: ${recap}`} variant="summary" />
          </OpenThreadControl>
        ) : null}

        {query.children && query.children.length > 0 ? (
          <ul aria-label="Follow-up questions" className="m-0 flex list-none flex-col gap-1 p-0">
            {query.children.map((child) => {
              const excerpt = queryTargetExcerpt(child.queryTarget ?? "");
              return (
                <li key={child.nodeId} className="text-fg-secondary min-w-0 text-sm">
                  {excerpt ? (
                    <span className="text-fg-subtle" title={child.queryTarget ?? undefined}>
                      @{excerpt}{" "}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="border-0 bg-transparent p-0 text-left underline-offset-2 hover:underline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenChild(child);
                    }}
                  >
                    {promptPreview(child.prompt)}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div
          className={cn(
            "text-fg-subtle flex flex-wrap items-center gap-x-3 gap-y-1",
            METADATA_LINE,
          )}
        >
          <ModelMeta modelId={query.model} origin={query.origin} at={query.createdAt} />
          {status ? (
            <span className={cn(query.status === "failed" && "text-status-failed")}>{status}</span>
          ) : null}
          <span className="flex-1" />
          {!running ? (
            <ThreadActions
              followed={followed}
              bookmarked={bookmarked}
              onToggleFollow={onToggleFollow}
              onToggleBookmark={onToggleBookmark}
              busy={actionsBusy}
            />
          ) : null}
        </div>
      </div>
    </ContextMenu>
  );
}
