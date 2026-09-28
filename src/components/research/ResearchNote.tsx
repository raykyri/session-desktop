import { useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ExternalLink, LoaderCircle, Sparkles, Users, X } from "lucide-react";
import type {
  NoteReply,
  RecentResearchQuery,
  ResearchMessageAttachment,
} from "../../types";
import { openExternalUrl } from "../../lib/api";
import { noteReplyAuthorName } from "../../lib/activity";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import {
  ResearchMarkdown,
  ResearchMessageBody,
  type ResearchProseVariant,
} from "./ResearchMessage";

/** Handlers shared by the Home note card and the note page. Each rejects
 * with the backend's message so the control that started it can show it. */
export interface NoteActions {
  /** An AI follow-up (a run child) or, with `network`, a network follow-up
   * (a note child). `replyAnchor` names the reply an AI follow-up is about. */
  onAskFollowUp: (input: {
    parentNodeId: string;
    prompt: string;
    network: boolean;
    replyAnchor: string | null;
  }) => Promise<void>;
  onRespond: (nodeId: string, replyId: string, body: string) => Promise<void>;
  onDeleteResponse: (nodeId: string, replyId: string) => Promise<void>;
  onRetry: (nodeId: string) => Promise<void>;
}

/** The reply an AI follow-up is being composed about. */
export interface NoteReplyTarget {
  id: string;
  author: string;
}

/** Mirrors the backend's `note_body_is_single_url`: such a body was saved as
 * a link or post rather than asked as a question. */
export function noteBodyIsSingleUrl(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stopForInteractive(event: MouseEvent) {
  event.stopPropagation();
}

/** A note's own content. A saved link renders as a link card, a saved post
 * as its tweet embed (through the shared message body, which hides the URL
 * once the tweet resolved), and a question as Markdown. */
export function NoteBody({
  prompt,
  attachments = [],
  variant = "body",
  renderPrompt,
}: {
  prompt: string;
  attachments?: ResearchMessageAttachment[];
  variant?: ResearchProseVariant;
  renderPrompt?: (content: ReactNode) => ReactNode;
}) {
  const resolvedTweet = attachments.some(
    (attachment) => attachment.status === "resolved" && attachment.tweet,
  );
  if (noteBodyIsSingleUrl(prompt) && !resolvedTweet) {
    const url = prompt.trim();
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // noteBodyIsSingleUrl already parsed it.
    }
    return (
      <a
        className="note-link-card research-content-card"
        href={url}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openExternalUrl(url);
        }}
      >
        <span className="note-link-card-url">{url}</span>
        <span className="note-link-card-host">
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
      renderPrompt={renderPrompt}
    />
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((part) => Array.from(part)[0] ?? "").join("").toUpperCase() || "?";
}

/** Stable avatar tint per member id, from a small fixed palette. */
function avatarTone(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 3;
}

function ReplyAvatar({ reply }: { reply: NoteReply }) {
  if (reply.author.kind === "author") {
    return (
      <span className="note-avatar is-self" aria-hidden="true">
        You
      </span>
    );
  }
  return (
    <span className={`note-avatar tone-${avatarTone(reply.author.id)}`} aria-hidden="true">
      {initials(reply.author.displayName)}
    </span>
  );
}

/** The gutter glyph for a follow-up row: AI runs and network follow-ups. */
export function NoteFollowUpGlyph({ network }: { network: boolean }) {
  return (
    <span className="note-glyph" aria-hidden="true">
      {network ? <Users size={12} /> : <Sparkles size={12} />}
    </span>
  );
}

function ReplyItem({
  nodeId,
  reply,
  responses,
  archived,
  actions,
  onAskAbout,
}: {
  nodeId: string;
  reply: NoteReply;
  responses: NoteReply[];
  archived: boolean;
  actions: NoteActions;
  onAskAbout?: (target: NoteReplyTarget) => void;
}) {
  const [responding, setResponding] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const member = reply.author.kind === "member" ? reply.author : null;
  const submitResponse = () => {
    const body = draft.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setError(null);
    actions
      .onRespond(nodeId, reply.id, body)
      .then(() => {
        setDraft("");
        setResponding(false);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setSubmitting(false));
  };
  return (
    <li className="note-thread-item" data-type={member ? "reply" : "self"}>
      <div className="note-thread-gutter">
        <ReplyAvatar reply={reply} />
      </div>
      <div className="note-thread-body">
        <div className="note-reply-head">
          <span className="note-reply-author">{member ? member.displayName : "You"}</span>
          {member?.handle ? <span>@{member.handle}</span> : null}
          <span aria-hidden="true">·</span>
          <time
            dateTime={new Date(reply.createdAt).toISOString()}
            title={new Date(reply.createdAt).toLocaleString()}
          >
            {formatRelativeTime(reply.createdAt)}
          </time>
        </div>
        <ResearchMarkdown className="note-reply-text" text={reply.body} variant="compact" />
        {!archived ? (
          <div className="note-thread-actions" onClick={stopForInteractive}>
            {member ? (
              <>
                <button
                  type="button"
                  className="note-thread-link"
                  onClick={() => setResponding(true)}
                >
                  Respond
                </button>
                {onAskAbout ? (
                  <button
                    type="button"
                    className="note-thread-link"
                    onClick={() => onAskAbout({ id: reply.id, author: member.displayName })}
                  >
                    Ask AI about this
                  </button>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                className="note-thread-link"
                onClick={() => {
                  setError(null);
                  actions
                    .onDeleteResponse(nodeId, reply.id)
                    .catch((err) => setError(errorMessage(err)));
                }}
              >
                Delete
              </button>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="note-thread-error" role="alert">
            {error}
          </p>
        ) : null}
        {responses.length > 0 ? (
          <ol className="note-thread-list is-nested">
            {responses.map((response) => (
              <ReplyItem
                key={response.id}
                nodeId={nodeId}
                reply={response}
                responses={[]}
                archived={archived}
                actions={actions}
              />
            ))}
          </ol>
        ) : null}
        {responding ? (
          <label className="note-field is-respond" onClick={stopForInteractive}>
            <input
              type="text"
              autoFocus
              value={draft}
              disabled={submitting}
              placeholder={`Respond to ${member?.displayName ?? "this reply"}`}
              aria-label="Response"
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submitResponse();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setResponding(false);
                }
              }}
            />
            {submitting ? <LoaderCircle className="note-field-spinner" size={13} /> : null}
          </label>
        ) : null}
      </div>
    </li>
  );
}

/** Replies to a network note with the avatar-spine outline: top-level
 * replies in order, each followed one level down by the author's responses. */
export function NoteReplyThread({
  nodeId,
  replies,
  archived,
  actions,
  nested = false,
  onAskAbout,
}: {
  nodeId: string;
  replies: NoteReply[];
  archived: boolean;
  actions: NoteActions;
  /** Replies to a network follow-up, drawn one level down its row. */
  nested?: boolean;
  onAskAbout?: (target: NoteReplyTarget) => void;
}) {
  const topLevel = replies.filter((reply) => !reply.inReplyTo);
  return (
    <ol className={`note-thread-list${nested ? " is-nested" : ""}`}>
      {topLevel.map((reply) => (
        <ReplyItem
          key={reply.id}
          nodeId={nodeId}
          reply={reply}
          responses={replies.filter((candidate) => candidate.inReplyTo === reply.id)}
          archived={archived}
          actions={actions}
          onAskAbout={onAskAbout}
        />
      ))}
    </ol>
  );
}

export function noteReplyTargetFor(
  replies: NoteReply[] | undefined,
  replyId: string | null | undefined,
): NoteReplyTarget | null {
  const reply = replyId ? replies?.find((candidate) => candidate.id === replyId) : undefined;
  return reply ? { id: reply.id, author: noteReplyAuthorName(reply) } : null;
}

/** Status line of a follow-up: model and time once answered, a spinner while
 * running, and the error with Retry (which reruns the same node) after a
 * failure or cancellation. */
export function NoteFollowUpStatus({
  child,
  modelLabel,
  archived,
  onRetry,
}: {
  child: RecentResearchQuery;
  modelLabel: string;
  archived: boolean;
  onRetry: (nodeId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (child.kind === "note") {
    const replies = child.replyCount ?? 0;
    return (
      <div className="note-thread-meta">
        Posted to network
        <span aria-hidden="true">·</span>
        {replies === 1 ? "1 reply" : replies > 0 ? `${replies} replies` : "no replies yet"}
        <span aria-hidden="true">·</span>
        {formatRelativeTime(child.createdAt)}
      </div>
    );
  }
  if (child.status === "queued" || child.status === "starting" || child.status === "running") {
    return (
      <div className="note-thread-meta" role="status">
        <LoaderCircle className="note-thread-spinner" size={12} aria-hidden="true" />
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
      <div className="note-thread-meta is-failed" onClick={stopForInteractive}>
        <span className="note-thread-meta-text">{error ?? label}</span>
        {!archived ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              className="note-thread-link"
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
  return (
    <div className="note-thread-meta">
      {modelLabel ? (
        <>
          {modelLabel}
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      {formatRelativeTime(child.createdAt)}
    </div>
  );
}

/** One-line follow-up field for a note. `networkAvailable` adds the
 * AI / Network toggle (network notes only); AI is the default. A reply
 * target shows as a removable "@Ana's reply" chip. */
export function NoteFollowUpField({
  networkAvailable,
  modelLabel,
  target,
  placeholder = "Ask a follow-up",
  autoFocus = false,
  onClearTarget,
  onSubmit,
}: {
  networkAvailable: boolean;
  modelLabel: string;
  target: NoteReplyTarget | null;
  placeholder?: string;
  autoFocus?: boolean;
  onClearTarget: () => void;
  onSubmit: (prompt: string, network: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [network, setNetwork] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toNetwork = networkAvailable && network && !target;
  const submit = () => {
    const prompt = draft.trim();
    if (!prompt || submitting) return;
    setSubmitting(true);
    setError(null);
    onSubmit(prompt, toNetwork)
      .then(() => setDraft(""))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setSubmitting(false));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && target) {
      event.preventDefault();
      onClearTarget();
    }
  };
  return (
    <div className="note-field-stack" onClick={stopForInteractive}>
      <label className="note-field">
        {networkAvailable ? (
          <span className="note-field-mode" role="group" aria-label="Ask">
            {(["ai", "network"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`note-field-mode-button${
                  (mode === "network") === toNetwork ? " is-active" : ""
                }`}
                aria-pressed={(mode === "network") === toNetwork}
                onClick={() => {
                  setNetwork(mode === "network");
                  if (mode === "network") onClearTarget();
                }}
              >
                {mode === "ai" ? "AI" : "Network"}
              </button>
            ))}
          </span>
        ) : null}
        {target ? (
          <button
            type="button"
            className="note-field-target"
            title="Ask without this reply"
            onClick={onClearTarget}
          >
            @{target.author}’s reply
            <X size={11} aria-hidden="true" />
          </button>
        ) : null}
        <input
          type="text"
          value={draft}
          autoFocus={autoFocus}
          disabled={submitting}
          placeholder={toNetwork ? "Post a follow-up to your network" : placeholder}
          aria-label="Follow-up"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {submitting ? (
          <LoaderCircle className="note-field-spinner" size={13} aria-hidden="true" />
        ) : !toNetwork && modelLabel ? (
          <span className="note-field-model" title="Answers with the model the note was posted with">
            {modelLabel}
          </span>
        ) : null}
      </label>
      {error ? (
        <p className="note-thread-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
