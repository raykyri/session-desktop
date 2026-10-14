// A Home card's body (the desktop's `renderTreeCard` body in
// `ResearchActivityFeed.tsx`): the question as plain text with URLs in the
// link color — its Markdown renders in the conversation. A link post shows its
// link card. Each X post shows as a "[Tweet: @handle]" label and images as an
// "[Image]" label, their embeds only in the conversation. A note, and a
// question still waiting for its title, show at most four lines in the muted
// color with blank lines removed; a note whose first line is a Markdown
// heading shows that line in the card title's style.

import type { RecentResearchQuery, ResearchTweetAttachment } from "@session/shared";
import { stripTaggedInstructionBlocksForPreview, visibleResearchPrompt } from "@session/shared";
import { collapseBlankLines, splitNoteHeading } from "@session/shared/lib/feedLinkText";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { researchImageLabel, researchImages } from "../../lib/researchImages.js";

import { feedText } from "./feedText.js";

/** "[Tweet: @handle]", or "[Tweet]" without a handle. */
export function tweetLabelText(tweet?: { author?: { handle?: string } } | null): string {
  const handle = tweet?.author?.handle?.trim().replace(/^@+/, "");
  return handle ? `[Tweet: @${handle}]` : "[Tweet]";
}

const QUESTION =
  "min-w-0 whitespace-pre-line text-fg-primary [overflow-wrap:anywhere] " +
  "text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height)";

/** Under a title the question is muted and at most two lines. */
const QUESTION_UNDER_TITLE = "line-clamp-2 text-fg-muted";

/** The question, as the card's text. */
export function CardQuestion({
  children,
  underTitle = false,
}: {
  children: ReactNode;
  underTitle?: boolean;
}) {
  return (
    <div
      className={cn(QUESTION, underTitle && QUESTION_UNDER_TITLE)}
      data-research-card-question=""
    >
      {children}
    </div>
  );
}

function resolvedTweets(query: RecentResearchQuery): ResearchTweetAttachment[] {
  return (query.attachments ?? []).filter(
    (attachment): attachment is ResearchTweetAttachment =>
      attachment.kind === "tweet" && attachment.status === "resolved" && Boolean(attachment.tweet),
  );
}

/** A link post whose URL did not resolve to an X post: its link card. */
function LinkCard({ url }: { url: string }) {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // A link post's text is one URL; show it whole if it does not parse.
  }
  return (
    <a
      className="border-border-subtle bg-surface-card hover:border-border-strong pointer-events-auto mt-0.5 flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 no-underline"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      data-research-no-drag=""
      onClick={(event) => event.stopPropagation()}
    >
      <span className="text-accent text-sm break-all">{url}</span>
      <span className="text-fg-faint flex items-center gap-1 text-xs">
        <ExternalLink size={11} aria-hidden="true" />
        {host}
      </span>
    </a>
  );
}

export function CardBody({
  query,
  fallback,
  isPost,
  awaitingTitle,
  underTitle,
}: {
  /** The thread's root entry, when loaded. */
  query: RecentResearchQuery | undefined;
  /** The text shown until the root loads: the thread's title. */
  fallback: string;
  isPost: boolean;
  /** A question whose title has not been generated yet. */
  awaitingTitle: boolean;
  /** The card shows a title above the body. */
  underTitle: boolean;
}) {
  if (!query) return <CardQuestion underTitle={underTitle}>{feedText(fallback)}</CardQuestion>;
  const tweets = resolvedTweets(query);
  if (isPost && query.format === "link" && tweets.length === 0) {
    return <LinkCard url={query.prompt.trim()} />;
  }
  const text = stripTaggedInstructionBlocksForPreview(
    visibleResearchPrompt(query.prompt, query.attachments),
  ).trim();
  let content: ReactNode = null;
  if (!isPost && !awaitingTitle) {
    content = text ? <CardQuestion underTitle={underTitle}>{feedText(text)}</CardQuestion> : null;
  } else {
    const { heading, rest } = isPost ? splitNoteHeading(text) : { heading: null, rest: text };
    const preview = collapseBlankLines(rest).trim();
    content =
      heading || preview ? (
        <div className="min-w-0" data-research-card-question="">
          {heading ? (
            <span className="text-fg-heading line-clamp-2 text-[length:calc(var(--fs-base)+0.5px)] leading-[1.4] font-semibold [overflow-wrap:anywhere]">
              {heading}
            </span>
          ) : null}
          {preview ? (
            <span
              className={cn(QUESTION, "text-fg-muted", heading ? "line-clamp-3" : "line-clamp-4")}
              data-research-feed-preview=""
            >
              {feedText(preview)}
            </span>
          ) : null}
        </div>
      ) : null;
  }
  const labels = tweets
    .filter((attachment) => !text.includes(attachment.sourceUrl))
    .map((attachment) => tweetLabelText(attachment.tweet));
  const imageLabel = researchImageLabel(researchImages(query.attachments).length);
  if (imageLabel) labels.push(imageLabel);
  return (
    <>
      {content}
      {labels.length > 0 ? (
        <p
          className="text-fg-faint m-0 text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height) [overflow-wrap:anywhere]"
          data-research-card-labels=""
        >
          {labels.join(" ")}
        </p>
      ) : null}
    </>
  );
}
