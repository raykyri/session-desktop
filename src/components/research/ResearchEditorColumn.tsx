import { memo, useId, useMemo, useRef, useState } from "react";
import type { ComponentProps, KeyboardEvent, ReactNode, Ref } from "react";
import { Eye, MessageSquarePlus } from "lucide-react";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import { ResearchColumnResizer } from "./ResearchColumnResizer";
import { ResearchMarkdown } from "./ResearchMessage";
import { editedMarkdownBlocks, QUESTION_CHARACTER_LIMIT, researchQuestionLength } from "../../lib/researchEditor";
import { stripImportedReportCitations } from "../../lib/researchDocuments";
import { columnAttributes, type ResearchEditorColumn as EditorColumn } from "../../lib/researchColumns";

interface ResearchEditorColumnProps {
  column: EditorColumn;
  current: boolean;
  /** What is edited: a document's Markdown, or a note's text (a post node). */
  kind: "document" | "post";
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
  /** Back and forward: the root note's editor takes the note column's place,
   * the root level's first column, whose header carries them. */
  history?: ComponentProps<typeof ResearchPairHeader>["history"];
}

/** The editor column (E{level}): the Markdown source of a document, or a post's
 * text, in a plain field, with Cancel, Save and "Ask as a question" in its
 * footer. A document's editor follows its answer column, which previews the
 * text; a note's editor is shown in place of the note column. ⌘↵ (Ctrl↵)
 * saves; Esc closes the column when nothing changed, and otherwise asks in
 * the footer whether to discard the changes. */
export function ResearchEditorColumn({
  column,
  current,
  kind,
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
  history = null,
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
  const heading = kind === "document" ? "Edit document" : "Edit note";
  const saveLabel = saving ? "Saving…" : "Save";

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
      <ResearchPairHeader title={heading} history={history} />
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
            aria-label={kind === "document" ? "Document Markdown" : "Note text"}
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
      <ResearchColumnResizer kind="answer" label="Resize editor column" />
    </section>
  );
}

/** A document's answer column, left of the editor, while the text differs
 * from the saved one: the new text rendered block by block, each block not
 * in the saved text marked as changed. */
export const ResearchEditPreview = memo(function ResearchEditPreview({
  original,
  next,
  imported = false,
  label,
}: {
  original: string;
  next: string;
  /** An imported report: citation handles are hidden, as in the answer. */
  imported?: boolean;
  /** Names what is previewed. */
  label: string;
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
          {`${label} · ${changed === 0 ? "no paragraphs changed" : changed === 1 ? "1 paragraph changed" : `${changed} paragraphs changed`}`}
        </span>
      </p>
      {blocks.map((block) => (
        <PreviewBlock
          // Keyed by text (and repeat), so an unchanged block keeps its
          // rendered Markdown while another block is typed in or inserted.
          key={block.key}
          text={imported ? stripImportedReportCitations(block.text) : block.text}
          changed={block.changed}
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
