import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { ArrowRight, ExternalLink, LoaderCircle, Sparkles } from "lucide-react";
import type {
  PostFormat,
  RecentResearchQuery,
  ResearchImageAttachment,
  ResearchMessageAttachment,
} from "../../types";
import { openExternalUrl } from "../../lib/api";
import { RESEARCH_NOTE_IMAGE_ERROR, researchImageBlockReason } from "../../lib/researchImages";
import { ResearchImageStrip, useResearchImageInput } from "./ResearchImages";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { growComposerTextarea } from "../../lib/composerTextarea";
import { ResearchMessageBody, type ResearchProseVariant } from "./ResearchMessage";
import { AskNoteSwitch, type AskMode } from "./AskNoteSwitch";
import { useComposerPopOpen } from "../../hooks/useComposerPopOpen";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";

/** Handlers for a note's follow-ups column. Each rejects with the backend's
 * message so the control that started it can show it. */
export interface PostActions {
  /** An AI follow-up (a run child) or, with `asNote`, a follow-up note (a
   * post child). Only an AI follow-up has images. */
  onAskFollowUp: (input: {
    parentNodeId: string;
    prompt: string;
    asNote: boolean;
    images: ResearchImageAttachment[];
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

/** The follow-up box's placeholder and send button name and tooltip for a
 * mode. `askPlaceholder` and `askLabel` ("Ask {model}") apply in Ask. */
export function postFollowUpCopy(
  asNote: boolean,
  askPlaceholder: string,
  askLabel: string,
): { placeholder: string; sendName: string; sendTitle: string } {
  return asNote
    ? { placeholder: "Add a note (not visible to agent)", sendName: "Add note", sendTitle: "Add note" }
    : { placeholder: askPlaceholder, sendName: "Ask", sendTitle: askLabel };
}

/** Follow-up composer at the top of a note's follow-ups column. Like the
 * Home ask box it is one line until focused or filled; then the Ask/Note
 * switch and Send appear on a row under the text. It starts in Ask, marked
 * with the AI follow-up rows' icon, which uses the note's model, so the
 * switch has no model menu. "Add a note" adds a follow-up note instead. The
 * send shortcut follows the "Require ⌘↵ to send" setting. Images pasted or
 * dropped on the box go with an AI follow-up; a note keeps none. */
export function PostFollowUpField({
  modelLabel,
  adapterId = null,
  placeholder = "Ask a follow-up",
  autoFocus = false,
  fullWidth = false,
  requireCmdEnter,
  composerRef,
  onSubmit,
}: {
  modelLabel: string;
  /** The agent of AI follow-ups, which decides whether images can go. */
  adapterId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
  fullWidth?: boolean;
  requireCmdEnter: boolean;
  /** Lets the document focus the field (⌘J). */
  composerRef?: Ref<ResearchComposerHandle>;
  onSubmit: (prompt: string, asNote: boolean, images: ResearchImageAttachment[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ResearchImageAttachment[]>([]);
  const [mode, setMode] = useState<AskMode>("ai");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useResearchImageInput({
    images,
    onImagesChange: (update) => setImages((current) => update(current)),
    disabled: submitting,
    dropTarget: wrapRef,
  });
  const imageProblemId = useId();
  const { focused, collapseIfFocusLeft, rootProps } = useComposerPopOpen(wrapRef);
  useImperativeHandle(
    composerRef,
    () => ({ focus: () => textareaRef.current?.focus(), element: () => wrapRef.current }),
    [],
  );
  useLayoutEffect(() => {
    if (textareaRef.current) {
      growComposerTextarea(textareaRef.current);
    }
  }, [draft]);
  const expanded = focused || Boolean(draft) || submitting || images.length > 0;
  const asNote = mode === "note";
  const askLabel = `Ask ${modelLabel || "AI"}`;
  const imageBlock =
    images.length === 0
      ? null
      : asNote
        ? RESEARCH_NOTE_IMAGE_ERROR
        : researchImageBlockReason(adapterId, null, images.length);
  const imageProblem = imageInput.error ?? imageBlock;
  const ready = Boolean(draft.trim()) && !submitting && imageInput.saving === 0 && !imageBlock;
  const submit = () => {
    const prompt = draft.trim();
    if (!prompt || !ready) return;
    setSubmitting(true);
    setError(null);
    onSubmit(prompt, asNote, asNote ? [] : images)
      .then(() => {
        setDraft("");
        setImages([]);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        setSubmitting(false);
        window.requestAnimationFrame(collapseIfFocusLeft);
      });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerSubmitShortcut(event, requireCmdEnter)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      // Esc leaves the field, which collapses again when it is empty.
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  const copy = postFollowUpCopy(asNote, placeholder, askLabel);
  const shortcut = requireCmdEnter ? "⌘↵" : "↵";

  return (
    <div
      ref={wrapRef}
      className={`research-composer-wrap post-composer${fullWidth ? " is-full-width" : ""}${
        expanded ? " is-expanded" : ""
      }`}
      onClick={stopForInteractive}
      {...rootProps}
      {...imageInput.fieldProps}
    >
      <ResearchImageStrip
        className="research-composer-images"
        images={images}
        saving={imageInput.saving}
        onRemove={
          submitting
            ? undefined
            : (id) => {
                imageInput.remove(id);
                // The removed × had focus.
                textareaRef.current?.focus();
              }
        }
      />
      <form
        className={`research-composer${ready ? " is-ready" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          autoFocus={autoFocus}
          disabled={submitting}
          placeholder={copy.placeholder}
          aria-label="Follow-up"
          aria-describedby={imageProblem ? imageProblemId : undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            imageInput.clearError();
          }}
          onKeyDown={onKeyDown}
        />
        {expanded ? (
          <div className="post-composer-row">
            <AskNoteSwitch
              askMode={mode}
              askIcon={<Sparkles size={14} aria-hidden="true" />}
              askLabel={askLabel}
              noteLabel="Add a note"
              onModeChange={(next) => {
                setMode(next);
                setError(null);
              }}
            />
            <button
              className="control-button research-composer-send"
              type="submit"
              disabled={!ready}
              aria-label={copy.sendName}
              title={`${copy.sendTitle} (${shortcut})`}
            >
              {submitting ? (
                <LoaderCircle className="research-spinner" size={15} aria-hidden="true" />
              ) : (
                <ArrowRight size={15} aria-hidden="true" />
              )}
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnter}
                className="research-composer-enter"
                ariaHidden
              />
            </button>
          </div>
        ) : null}
      </form>
      {imageProblem ? (
        <p id={imageProblemId} className="post-thread-error" role="alert">
          {imageProblem}
        </p>
      ) : null}
      {error ? (
        <p className="post-thread-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
