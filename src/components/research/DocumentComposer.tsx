import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  RESEARCH_DOCUMENT_BYTE_LIMIT,
  RESEARCH_DOCUMENT_WORD_LIMIT,
  ResearchDocumentWordLimitExceeded,
  countResearchDocumentWords,
  deriveResearchDocumentTitle,
} from "../../lib/researchDocuments";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";
interface DocumentComposerProps {
  initialMarkdown?: string;
  initialTitle?: string;
  highlightCount?: number;
  resetKey?: string;
  onClose: () => void;
  onSubmit: (input: { markdown: string; title: string | null }) => Promise<void>;
}

/** Modal editor retained for legacy research-document snapshots. Creation is
 * no longer exposed, and legacy document trees are hidden by the app shell. */
export default function DocumentComposer({
  initialMarkdown = "",
  initialTitle = "",
  highlightCount = 0,
  resetKey = "",
  onClose,
  onSubmit,
}: DocumentComposerProps) {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [title, setTitle] = useState(initialTitle);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markdownRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setMarkdown(initialMarkdown);
    setTitle(initialTitle);
    setSubmitting(false);
    setError(null);
  }, [initialMarkdown, initialTitle, resetKey]);

  // Autogrow until the modal card's max-height makes the textarea take over
  // scrolling.
  useLayoutEffect(() => {
    const textarea = markdownRef.current;
    if (!textarea) {
      return;
    }
    const measure = () => {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [markdown]);

  // These scan up to the 10 MB document cap. Counting stops immediately after
  // the first word over the limit so a dense import cannot monopolize the UI.
  const { wordCount, byteCount, derivedTitle, overWordLimit } = useMemo(() => {
    let wordCount: number;
    let overWordLimit = false;
    try {
      wordCount = countResearchDocumentWords(markdown, RESEARCH_DOCUMENT_WORD_LIMIT);
    } catch (caught) {
      if (!(caught instanceof ResearchDocumentWordLimitExceeded)) {
        throw caught;
      }
      wordCount = caught.count;
      overWordLimit = true;
    }
    return {
      wordCount,
      overWordLimit,
      byteCount: new TextEncoder().encode(markdown).length,
      derivedTitle: markdown.trim() ? deriveResearchDocumentTitle(markdown) : "",
    };
  }, [markdown]);

  const changed = markdown !== initialMarkdown || title !== initialTitle;
  const pristine = !changed;

  const overByteLimit = byteCount > RESEARCH_DOCUMENT_BYTE_LIMIT;
  const canSubmit =
    Boolean(markdown.trim()) &&
    !overWordLimit &&
    !overByteLimit &&
    !submitting &&
    changed;
  const warningId = highlightCount > 0 ? "edit-document-highlight-warning" : undefined;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ markdown, title: title.trim() || null });
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    onClose();
  }

  const form = (
      <form
        className="new-document-composer"
        role="dialog"
        aria-modal="true"
        aria-label="Edit document"
        aria-describedby={warningId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && pristine && !submitting) {
            close();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>Edit document</h2>
        <input
          className="new-document-title"
          type="text"
          value={title}
          placeholder={derivedTitle || "Title (uses the first line if left blank)"}
          aria-label="Document title"
          onChange={(event) => {
            setTitle(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Document submission is deliberate (Cmd+Enter or the button),
            // never an implicit side effect of Enter in the title field.
            if (event.key === "Enter" && !isComposerSubmitShortcut(event, true)) {
              event.preventDefault();
            }
          }}
        />
        <textarea
          autoFocus
          ref={markdownRef}
          className="new-document-markdown"
          value={markdown}
          placeholder="Paste or write Markdown…"
          aria-label="Document markdown"
          onChange={(event) => {
            setMarkdown(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isComposerSubmitShortcut(event, true)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <footer className="new-document-footer">
          {warningId ? (
            <p id={warningId} className="edit-document-highlight-warning">
              This document has {highlightCount.toLocaleString()} highlight
              {highlightCount === 1 ? "" : "s"}. Changing its content will erase{" "}
              {highlightCount === 1 ? "it" : "them"}. Title-only changes keep highlights.
            </p>
          ) : null}
          <div className="new-document-footer-row">
            <span
              className={`new-document-wordcount${overWordLimit || overByteLimit ? " is-over" : ""}`}
              role={overWordLimit || overByteLimit ? "alert" : undefined}
              title={
                overWordLimit
                  ? `Documents are limited to ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()} words for now`
                  : undefined
              }
            >
              {wordCount.toLocaleString()} / {RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()} words
              {overByteLimit ? " · over the 10 MB size limit" : ""}
            </span>
            {error ? (
              <p className="new-document-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="confirm-dialog-actions">
              <button className="control-button" type="button" disabled={submitting} onClick={close}>
                Cancel
              </button>
              <button className="control-button" type="submit" disabled={!canSubmit}>
                <span>{submitting ? "Saving…" : "Save changes"}</span>
                {!submitting ? (
                  <ComposerSubmitShortcutGlyph requireCmdEnter className="shortcut-hint" />
                ) : null}
              </button>
            </div>
          </div>
        </footer>
      </form>
  );

  return (
    <div
      className="confirm-dialog-backdrop new-document-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && pristine && !submitting) {
          close();
        }
      }}
    >
      {form}
    </div>
  );
}
