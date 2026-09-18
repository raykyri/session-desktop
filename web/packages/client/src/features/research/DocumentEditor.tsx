// The editor for a `document` root (`09-research-document-view.md` §2, §8).
//
// Document *creation* is not exposed — legacy imported reports are the only
// documents that exist — but editing one is, so a pasted report can be fixed
// without losing the thread hanging off it. The save carries the revision, the
// title and the highlight ids the editor opened with: the server refuses the
// write if any of them moved, which is what keeps two tabs from silently
// overwriting each other.
//
// Changing the markdown invalidates every anchor into it, so the count of
// highlights that will be erased is stated before the reader commits. A
// title-only change keeps them.

import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  ResearchDocumentWordLimitExceeded,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "@session/shared";
import { useMemo, useState } from "react";

import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { Input, Textarea } from "../../ui/Field.js";

export interface DocumentEditSession {
  nodeId: string;
  markdown: string;
  title: string;
  responseRevision: string;
  highlightIds: string[];
}

export function DocumentEditor({
  session,
  onClose,
  onSubmit,
}: {
  session: DocumentEditSession;
  onClose: () => void;
  onSubmit: (input: { markdown: string; title: string | null }) => Promise<void>;
}) {
  const [markdown, setMarkdown] = useState(session.markdown);
  const [title, setTitle] = useState(session.title);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // These scan up to the 10 MB cap. Counting stops at the first word over the
  // limit so a dense import cannot monopolize the tab merely to establish that
  // the button is disabled.
  const { wordCount, byteCount, derivedTitle, overWordLimit } = useMemo(() => {
    let count: number;
    let over = false;
    try {
      count = countResearchDocumentWords(markdown, RESEARCH_DOCUMENT_WORD_LIMIT);
    } catch (caught) {
      if (!(caught instanceof ResearchDocumentWordLimitExceeded)) throw caught;
      count = caught.count;
      over = true;
    }
    return {
      wordCount: count,
      overWordLimit: over,
      byteCount: new TextEncoder().encode(markdown).length,
      derivedTitle: markdown.trim() ? deriveResearchDocumentTitle(markdown) : "",
    };
  }, [markdown]);

  const changed = markdown !== session.markdown || title !== session.title;
  const overByteLimit = byteCount > RESEARCH_DOCUMENT_BYTE_LIMIT;
  const canSubmit = Boolean(markdown.trim()) && !overWordLimit && !overByteLimit && changed;
  const highlightCount = session.highlightIds.length;

  const submit = () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    onSubmit({ markdown, title: title.trim() || null })
      .then(onClose)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !submitting && !changed) onClose();
      }}
      title="Edit document"
      className="w-[min(760px,calc(100vw-32px))]"
      footer={
        <>
          <ControlButton disabled={submitting} onClick={onClose}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton
            pending={submitting}
            pendingLabel="Saving…"
            disabled={!canSubmit}
            onClick={submit}
          >
            Save changes
          </ConfirmDialogActionButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={title}
          aria-label="Document title"
          placeholder={derivedTitle || "Title (uses the first line if left blank)"}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
        <Textarea
          // The editor exists to be typed in, and it is the dialog's only
          // multi-line field; focusing it is what the reader asked for.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={markdown}
          aria-label="Document markdown"
          placeholder="Paste or write Markdown…"
          rows={16}
          className="max-h-[50vh] font-mono text-sm"
          onChange={(event) => setMarkdown(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.metaKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {highlightCount > 0 ? (
          <p className="text-fg-muted m-0 text-xs">
            This document has {highlightCount.toLocaleString()} highlight
            {highlightCount === 1 ? "" : "s"}. Changing its content will erase{" "}
            {highlightCount === 1 ? "it" : "them"}. Title-only changes keep{" "}
            {highlightCount === 1 ? "it" : "them"}.
          </p>
        ) : null}
        <p
          className={
            overWordLimit || overByteLimit
              ? "text-status-failed m-0 text-xs"
              : "text-fg-muted m-0 text-xs"
          }
          role={overWordLimit || overByteLimit ? "alert" : undefined}
        >
          {wordCount.toLocaleString()} / {RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()} words
          {overByteLimit ? " · over the 10 MB size limit" : ""}
        </p>
        {error ? (
          <p className="text-status-failed m-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
