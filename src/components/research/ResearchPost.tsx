import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ExternalLink, LoaderCircle } from "lucide-react";
import type {
  AgentSpec,
  PostFormat,
  RecentResearchQuery,
  ResearchImageAttachment,
  ResearchMessageAttachment,
} from "../../types";
import { openExternalUrl } from "../../lib/api";
import { ResearchMessageBody, type ResearchProseVariant } from "./ResearchMessage";

/** Handlers for a note's follow-ups column. Each rejects with the backend's
 * message so the control that started it can show it. */
export interface PostActions {
  /** An AI follow-up (a run child) or, with `asNote`, a follow-up note (a
   * post child). Only an AI follow-up has images. `agent` is the agent,
   * model and effort chosen in the box's model menu; null or absent runs it
   * on the note's follow-up agent, as the backend picks it. */
  onAskFollowUp: (input: {
    parentNodeId: string;
    prompt: string;
    asNote: boolean;
    images: ResearchImageAttachment[];
    agent?: AgentSpec | null;
  }) => Promise<void>;
  onRetry: (nodeId: string) => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopForInteractive(event: MouseEvent) {
  event.stopPropagation();
}

/** A post's own content, by its stored format. A link post renders as a
 * link card, or as its tweet embed once the tweet resolved (through the
 * shared message body, which then hides the URL); a text post as Markdown.
 * `lead` (a row glyph) starts the first line: the link card's URL, or as in
 * ResearchMessageBody. */
export function PostContent({
  prompt,
  format,
  attachments = [],
  variant = "body",
  lead,
  renderPrompt,
  tweetLabels,
}: {
  prompt: string;
  format: PostFormat;
  attachments?: ResearchMessageAttachment[];
  variant?: ResearchProseVariant;
  lead?: ReactNode;
  renderPrompt?: (content: ReactNode) => ReactNode;
  /** As in ResearchMessageBody. */
  tweetLabels?: boolean;
}) {
  const resolvedTweet = attachments.some(
    (attachment) =>
      attachment.kind === "tweet" && attachment.status === "resolved" && attachment.tweet,
  );
  if (format === "link" && !resolvedTweet) {
    const url = prompt.trim();
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // A link post's text is one URL; show it whole if it does not parse.
    }
    return (
      <a
        className="post-link-card research-content-card"
        href={url}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openExternalUrl(url);
        }}
      >
        <span className="post-link-card-url">
          {lead}
          {url}
        </span>
        <span className="post-link-card-host">
          <ExternalLink size={11} aria-hidden="true" />
          {host}
        </span>
      </a>
    );
  }
  return (
    <ResearchMessageBody
      prompt={prompt}
      attachments={attachments}
      variant={variant}
      lead={lead}
      renderPrompt={renderPrompt}
      tweetLabels={tweetLabels}
    />
  );
}

/** Status line of an AI follow-up that has no answer to show: a spinner
 * while it runs, and the error with Retry (which reruns the same node) after
 * a failure or cancellation. */
export function PostFollowUpStatus({
  child,
  archived,
  onRetry,
}: {
  child: RecentResearchQuery;
  archived: boolean;
  onRetry: (nodeId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (child.status === "queued" || child.status === "starting" || child.status === "running") {
    return (
      <div className="post-thread-meta" role="status">
        <LoaderCircle className="post-thread-spinner" size={12} aria-hidden="true" />
        Answering
      </div>
    );
  }
  if (child.status === "failed" || child.status === "cancelled") {
    const label =
      child.status === "failed"
        ? child.error
          ? `Failed: ${child.error}`
          : "Failed"
        : "Cancelled";
    return (
      <div className="post-thread-meta is-failed" onClick={stopForInteractive}>
        <span className="post-thread-meta-text">{error ?? label}</span>
        {!archived ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="post-thread-link"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                setError(null);
                onRetry(child.nodeId)
                  .catch((err) => setError(errorMessage(err)))
                  .finally(() => setRetrying(false));
              }}
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          </>
        ) : null}
      </div>
    );
  }
  return null;
}
