// The posts attached to a research message
// (`09-research-document-view.md` §2, ported from
// `ResearchMessage.tsx:ResearchMessageBody`).
//
// One list, mounted by both surfaces that show a question: the Home feed card
// and the thread's own prompt. The desktop drew the same card in both places
// (`.research-message-attachment`), and the wrapper is here rather than in
// each caller so it cannot drift between them.

import type { ResearchMessageAttachment, TweetSnapshot } from "@session/shared";

import { cn } from "../../lib/cn.js";

import { TweetEmbed } from "./TweetEmbed.js";

/** The bordered box around one embed: the desktop's 12px radius, its padding,
 * and its hover, which reads as "this opens the post". */
const ATTACHMENT_CARD =
  "border-border-default rounded-xl border px-3.5 pt-3 pb-[11px] " +
  "transition-[color,background-color,border-color] duration-[120ms] " +
  "hover:border-border-overlay-strong hover:bg-surface-fill-hover/25";

/** The snapshots a message carries, in the order the permalinks appeared. An
 * attachment that did not resolve contributes nothing: its permalink is still
 * in the question's own text. */
export function resolvedTweets(
  attachments: readonly ResearchMessageAttachment[] | undefined,
): TweetSnapshot[] {
  return (attachments ?? []).flatMap((attachment) =>
    attachment.status === "resolved" && attachment.tweet ? [attachment.tweet] : [],
  );
}

export function TweetAttachments({
  attachments,
  className,
}: {
  attachments: readonly ResearchMessageAttachment[] | undefined;
  className?: string;
}) {
  const tweets = resolvedTweets(attachments);
  if (tweets.length === 0) return null;
  return (
    <ul
      aria-label="Attached posts"
      className={cn("m-0 flex list-none flex-col gap-2.5 p-0", className)}
    >
      {tweets.map((tweet, index) => (
        <li key={`${tweet.id}:${index}`} className={ATTACHMENT_CARD}>
          <TweetEmbed tweet={tweet} />
        </li>
      ))}
    </ul>
  );
}
