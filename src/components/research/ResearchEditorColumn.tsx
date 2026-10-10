import { memo, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Eye, MessageSquarePlus } from "lucide-react";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { ResearchPairHeader } from "./ResearchDocumentChrome";
import { ResearchMarkdown } from "./ResearchMessage";
import { editedMarkdownBlocks, QUESTION_CHARACTER_LIMIT, researchQuestionLength } from "../../lib/researchEditor";
import { stripImportedReportCitations } from "../../lib/researchDocuments";
import { columnAttributes, type ResearchEditorColumn as EditorColumn } from "../../lib/researchColumns";
import { shortWhen } from "../../lib/shortTime";
import type { NoteCorrection } from "../../types";

interface ResearchEditorColumnProps {
  column: EditorColumn;
  current: boolean;
  /** What is edited: a document's Markdown, or a post's text. A post with
   * replies or follow-ups is corrected (`correction`) instead. */
  kind: "document" | "post";
  correction: boolean;
  value: string;
  onChange: (value: string) => void;
  /** Documents: the title field. */
  title?: { value: string; placeholder: string; onChange: (value: string) => void };
  /** Whether the text or title differs from what was opened. */
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  /** Notes under the field: what Save does, what it removes, limits. */
  notices: ReactNode;
  /** The document's word count line. */
  countText?: { text: string; over: boolean } | null;
  error: string | null;
  /** The model a question is asked with, as the Home ask box has it
   * selected; null when no agent is ready. */
  questionModel: string | null;
  asking: boolean;
  textareaRef: Ref<HTMLTextAreaElement>;
  onCancel: () => void;
  onSave: () => void;
  onAskAsQuestion: () => void;
}

/** The editor column (E0): the Markdown source of a document, or a post's
 * text, in a plain field, with Cancel, Save and "Ask as a question" in its
 * footer. The column to its left previews the text. ⌘↵ (Ctrl↵) saves; Esc
 * closes the column when nothing changed, and otherwise asks in the footer
 * whether to discard the changes. */
export function ResearchEditorColumn({
  column,
  current,
  kind,
  correction,
  value,
  onChange,
  title,
  dirty,
  canSave,
  saving,
  notices,
  countText,
  error,
  questionModel,
  asking,
  textareaRef,
  onCancel,
  onSave,
  onAskAsQuestion,
}: ResearchEditorColumnProps) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const questionNoteId = useId();
  const question = researchQuestionLength(value);
  const questionBlocker = !question.allowed
    ? question.count === 0
      ? "Write the question first"
      : `${question.count.toLocaleString()} / ${QUESTION_CHARACTER_LIMIT} characters`
    : questionModel === null
      ? "No research agent is ready"
      : null;
  const questionNote = questionBlocker ?? `Asks ${questionModel}`;
  const heading = kind === "document" ? "Edit document" : correction ? "Correct post" : "Edit post";
  const saveLabel = saving ? "Saving…" : correction ? "Add correction" : "Save";

  const setField = (element: HTMLTextAreaElement | null) => {
    fieldRef.current = element;
    if (typeof textareaRef === "function") textareaRef(element);
    else if (textareaRef) (textareaRef as { current: HTMLTextAreaElement | null }).current = element;
  };

  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onCancel();
      return;
    }
    setConfirmingDiscard(true);
    window.requestAnimationFrame(() => keepEditingRef.current?.focus());
  };
  const keepEditing = () => {
    setConfirmingDiscard(false);
    window.requestAnimationFrame(() => fieldRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.nativeEvent.isComposing) return;
      // Handled here, so the strip's own Esc (focus to the first column)
      // does not also run.
      event.preventDefault();
      if (confirmingDiscard) keepEditing();
      else requestClose();
      return;
    }
    if (isComposerSubmitShortcut(event, true) || (event.key === "Enter" && event.ctrlKey && !event.metaKey)) {
      event.preventDefault();
      if (canSave && !saving) onSave();
    }
  };

  return (
    <section
      className={`research-pair-editor${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label={heading}
      onKeyDown={onKeyDown}
    >
      <ResearchPairHeader title={heading} />
      <div className="research-column-scroll">
        <div className="research-editor">
          {title ? (
            <input
              className="research-editor-title"
              type="text"
              value={title.value}
              placeholder={title.placeholder}
              aria-label="Document title"
              onChange={(event) => title.onChange(event.currentTarget.value)}
            />
          ) : null}
          <textarea
            ref={setField}
            className={`research-editor-field${kind === "document" ? " is-source" : ""}`}
            value={value}
            spellCheck={kind === "post"}
            aria-label={kind === "document" ? "Document Markdown" : correction ? "Correction" : "Post text"}
            onChange={(event) => {
              setConfirmingDiscard(false);
              onChange(event.currentTarget.value);
            }}
          />
          <div className="research-editor-notes">{notices}</div>
        </div>
      </div>
      <footer className="research-editor-foot">
        <div className="research-editor-row">
          <button
            type="button"
            className="control-button research-editor-ask"
            aria-disabled={questionBlocker !== null || asking || saving || undefined}
            aria-describedby={questionNoteId}
            onClick={() => {
              if (questionBlocker === null && !asking && !saving) onAskAsQuestion();
            }}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            <span>{asking ? "Asking…" : "Ask as a question"}</span>
          </button>
          <span
            id={questionNoteId}
            className={`research-editor-count${!question.allowed && question.count > 0 ? " is-over" : ""}`}
          >
            {questionNote}
          </span>
        </div>
        {confirmingDiscard ? (
          <div className="research-editor-row is-confirm" role="group" aria-label="Discard changes">
            <span className="research-editor-confirm-text">Discard your changes?</span>
            <button ref={keepEditingRef} type="button" className="control-button" onClick={keepEditing}>
              Keep editing
            </button>
            <button type="button" className="control-button danger" onClick={onCancel}>
              Discard
            </button>
          </div>
        ) : (
          <div className="research-editor-row">
            {countText ? (
              <span className={`research-editor-count${countText.over ? " is-over" : ""}`}>{countText.text}</span>
            ) : null}
            <span className="research-editor-actions">
              <button type="button" className="control-button" disabled={saving} onClick={requestClose}>
                Cancel
              </button>
              <button
                type="button"
                className="control-button research-editor-save"
                disabled={!canSave || saving}
                onClick={onSave}
              >
                <span>{saveLabel}</span>
                {!saving ? <ComposerSubmitShortcutGlyph requireCmdEnter className="shortcut-hint" /> : null}
              </button>
            </span>
          </div>
        )}
        {error ? (
          <p className="research-editor-error" role="alert">
            {error}
          </p>
        ) : null}
      </footer>
    </section>
  );
}

/** The column to the editor's left while the text differs from the saved
 * one: the new text rendered block by block, each block not in the saved
 * text marked as changed. */
export const ResearchEditPreview = memo(function ResearchEditPreview({
  original,
  next,
  imported = false,
  label,
  marksChanges = true,
}: {
  original: string;
  next: string;
  /** An imported report: citation handles are hidden, as in the answer. */
  imported?: boolean;
  /** Names what is previewed: "Preview", "Correction preview". */
  label: string;
  /** Marks and counts the blocks not in `original`; off for new text. */
  marksChanges?: boolean;
}) {
  const blocks = useMemo(() => {
    const seen = new Map<string, number>();
    return editedMarkdownBlocks(original, next).map((block) => {
      const repeat = seen.get(block.text) ?? 0;
      seen.set(block.text, repeat + 1);
      return { ...block, key: `${repeat}:${block.text}` };
    });
  }, [original, next]);
  const changed = blocks.filter((block) => block.changed).length;
  return (
    <div className="research-edit-preview">
      <p className="research-edit-preview-bar">
        <Eye size={13} aria-hidden="true" />
        <span>
          {label}
          {marksChanges
            ? ` · ${changed === 0 ? "no paragraphs changed" : changed === 1 ? "1 paragraph changed" : `${changed} paragraphs changed`}`
            : null}
        </span>
      </p>
      {blocks.map((block) => (
        <PreviewBlock
          // Keyed by text (and repeat), so an unchanged block keeps its
          // rendered Markdown while another block is typed in or inserted.
          key={block.key}
          text={imported ? stripImportedReportCitations(block.text) : block.text}
          changed={marksChanges && block.changed}
        />
      ))}
    </div>
  );
});

const PreviewBlock = memo(function PreviewBlock({ text, changed }: { text: string; changed: boolean }) {
  return (
    <div className={`research-edit-block${changed ? " is-changed" : ""}`}>
      {changed ? <span className="research-edit-block-label">Changed: </span> : null}
      <ResearchMarkdown text={text} />
    </div>
  );
});

/** A post's corrections under the post, oldest first. */
export function ResearchPostCorrections({
  corrections,
  now,
}: {
  corrections: readonly NoteCorrection[];
  now: number;
}) {
  if (corrections.length === 0) {
    return null;
  }
  return (
    <ol className="research-post-corrections" aria-label="Corrections">
      {[...corrections]
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((correction) => (
          <li key={correction.id} className="research-post-correction">
            <div className="research-post-correction-meta">
              <span className="research-post-correction-label">Correction</span>
              <span aria-hidden="true">·</span>
              <time
                dateTime={new Date(correction.createdAt).toISOString()}
                title={new Date(correction.createdAt).toLocaleString()}
              >
                {shortWhen(correction.createdAt, now)}
              </time>
            </div>
            <ResearchMarkdown text={correction.body} />
          </li>
        ))}
    </ol>
  );
}
