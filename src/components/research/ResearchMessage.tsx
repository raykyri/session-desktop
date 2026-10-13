import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ResearchMessageAttachment, ResearchTweetAttachment } from "../../types";
import TranscriptMarkdown, {
  type OversizedMarkdownPolicy,
} from "../TranscriptMarkdown";
import { researchImageLabel, researchImages } from "../../lib/researchImages";
import { tweetLabelText } from "../../lib/tweets";
import { ResearchImageStrip } from "./ResearchImages";
import { TweetEmbed } from "./TweetEmbed";

/** The message's tweets whose snapshot resolved, in order. */
function resolvedTweets(attachments: readonly ResearchMessageAttachment[]) {
  return attachments.filter(
    (attachment): attachment is ResearchTweetAttachment =>
      attachment.kind === "tweet" && attachment.status === "resolved" && Boolean(attachment.tweet),
  );
}

export type ResearchProseVariant = "body" | "compact";

/** The "Widgets in answers" setting: whether answers that opt in with
 * `widgets` display `session-html` blocks as widget frames. */
export const ResearchInlineWidgetsContext = createContext(false);

/** Research-owned adapter around the generic transcript Markdown renderer.
 * Typography is selected on the renderer itself instead of inherited from a
 * page-layout ancestor, so the same semantic content cannot change scale when
 * it moves between Home, a run, and an imported conversation. */
export function ResearchMarkdown({
  text,
  className,
  variant = "body",
  inline = false,
  oversizedContent,
  widgets = false,
}: {
  text: string;
  className?: string;
  variant?: ResearchProseVariant;
  inline?: boolean;
  oversizedContent?: OversizedMarkdownPolicy;
  /** Agent-written answer text, whose `session-html` blocks may display as
   * widgets while the setting is on. */
  widgets?: boolean;
}) {
  const widgetsEnabled = useContext(ResearchInlineWidgetsContext);
  const proseClassName = `research-prose research-prose--${variant}${
    className ? ` ${className}` : ""
  }`;
  return (
    <TranscriptMarkdown
      text={text}
      className={proseClassName}
      imageBehavior="open"
      inline={inline}
      oversizedContent={oversizedContent}
      widgets={widgets && widgetsEnabled && variant === "body" && !inline}
    />
  );
}

/** Shared authored-user-message wrapper. Context-specific callers own only
 * placement; this primitive keeps semantic and typography composition aligned. */
export function ResearchUserMessage({
  children,
  className,
  as: Element = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "article" | "div";
}) {
  return (
    <Element
      className={`research-user-message${className ? ` ${className}` : ""}`}
    >
      {children}
    </Element>
  );
}

/** Presentation-only removal of resolved tweet URLs occupying the message's
 * trailing URL block. The persisted prompt is never rewritten. */
export function visibleResearchPrompt(
  prompt: string,
  attachments: ResearchMessageAttachment[] = [],
): string {
  let visible = prompt;
  for (const attachment of [...resolvedTweets(attachments)].reverse()) {
    if (attachment.placement !== "trailing") {
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
  variant = "body",
  lead,
  renderPrompt,
  tweetLabels = false,
  imageTabIndex,
}: {
  prompt: string;
  attachments?: ResearchMessageAttachment[];
  /** Compact for previews such as Home posts; body where the message is read. */
  variant?: ResearchProseVariant;
  /** Show each resolved tweet as a "[Tweet: @handle]" label instead of its
   * embed, and images as one "[Image]" or "[2 images]" label instead of
   * thumbnails (Home cards). A tweet whose URL still shows in the prompt
   * text gets no label. */
  tweetLabels?: boolean;
  /** A row glyph for the start of the first line: before the prompt's
   * Markdown, or in the first tweet's header when no prompt shows. With
   * `renderPrompt`, the prompt's renderer places it instead. */
  lead?: ReactNode;
  renderPrompt?: (content: ReactNode) => ReactNode;
  /** The image thumbnails' tab stop, following the message row's. */
  imageTabIndex?: number;
}) {
  const visiblePrompt = visibleResearchPrompt(prompt, attachments);
  const resolved = resolvedTweets(attachments);
  const images = researchImages(attachments);
  const promptContent = visiblePrompt ? (
    renderPrompt ? (
      renderPrompt(<ResearchMarkdown text={visiblePrompt} variant={variant} />)
    ) : (
      <>
        {lead}
        <ResearchMarkdown text={visiblePrompt} variant={variant} />
      </>
    )
  ) : null;
  if (tweetLabels) {
    const labels = resolved
      .filter((attachment) => !visiblePrompt.includes(attachment.sourceUrl))
      .map((attachment) => tweetLabelText(attachment.tweet));
    const imageLabel = researchImageLabel(images.length);
    if (imageLabel) labels.push(imageLabel);
    return (
      <>
        {promptContent}
        {labels.length > 0 ? (
          <p className="research-message-tweet-labels">{labels.join(" ")}</p>
        ) : null}
      </>
    );
  }
  const tweets = resolved.flatMap((attachment) => (attachment.tweet ? [attachment.tweet] : []));
  return (
    <>
      {promptContent}
      <ResearchImageStrip
        className={`research-message-images${visiblePrompt ? " has-prompt" : ""}`}
        images={images}
        tabIndex={imageTabIndex}
      />
      {tweets.length > 0 ? (
        <div
          className={`research-message-attachments${visiblePrompt ? " has-prompt" : ""}`}
        >
          {tweets.map((tweet, index) => (
            <div
              className="research-message-attachment"
              key={`${tweet.id}:${index}`}
            >
              <TweetEmbed tweet={tweet} lead={visiblePrompt || index > 0 ? undefined : lead} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
