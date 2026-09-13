import type { ResearchMessageAttachment } from "../../types";
import TranscriptMarkdown from "../TranscriptMarkdown";
import { TweetEmbed } from "./TweetEmbed";

/** Presentation-only removal of resolved tweet URLs occupying the message's
 * trailing URL block. The persisted prompt is never rewritten. */
export function visibleResearchPrompt(
  prompt: string,
  attachments: ResearchMessageAttachment[] = [],
): string {
  let visible = prompt;
  for (const attachment of [...attachments].reverse()) {
    if (
      attachment.status !== "resolved" ||
      attachment.placement !== "trailing" ||
      !attachment.tweet
    ) {
      continue;
    }
    const trimmedEnd = visible.trimEnd();
    if (!trimmedEnd.endsWith(attachment.sourceUrl)) {
      continue;
    }
    visible = trimmedEnd.slice(0, -attachment.sourceUrl.length).trimEnd();
  }
  return visible;
}

export function ResearchMessageBody({
  prompt,
  attachments = [],
}: {
  prompt: string;
  attachments?: ResearchMessageAttachment[];
}) {
  const visiblePrompt = visibleResearchPrompt(prompt, attachments);
  const tweets = attachments.flatMap((attachment) =>
    attachment.status === "resolved" && attachment.tweet ? [attachment.tweet] : [],
  );
  return (
    <>
      {visiblePrompt ? (
        <TranscriptMarkdown text={visiblePrompt} imageBehavior="open" />
      ) : null}
      {tweets.length > 0 ? (
        <div
          className={`research-message-attachments${visiblePrompt ? " has-prompt" : ""}`}
        >
          {tweets.map((tweet, index) => (
            <div
              className="research-message-attachment"
              key={`${tweet.id}:${index}`}
            >
              <TweetEmbed tweet={tweet} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
