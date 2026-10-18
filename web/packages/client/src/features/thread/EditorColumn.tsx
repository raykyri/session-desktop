// The editor column (`09-research-document-view.md` §8), ported from the
// desktop `ResearchEditorColumn.tsx` and `ResearchEditorSessionColumn.tsx`:
// the Markdown source of the root document, or a note's text, in a field that
// fills the column above its footer, with Cancel, Save and "Ask as a
// question" (and the model it asks with). A document's editor follows its
// answer column, which previews the edit; a note's editor takes its note
// column's place.
//
// ⌘↵ (Ctrl+↵) saves and closes the column; ⌘S (Ctrl+S) saves and keeps it
// open. Esc closes it when nothing changed, and otherwise asks in the footer
// whether to discard the changes.

import type { ResearchHighlightAnchor, ModelInfo } from "@session/shared";
import {
  columnAttributes,
  type ResearchEditorColumn as EditorColumnData,
} from "@session/shared/lib/researchColumns";
import {
  RESEARCH_DOCUMENT_WORD_LIMIT,
  deriveResearchDocumentTitle,
  researchDocumentEditGate,
} from "@session/shared/lib/researchDocuments";
import {
  QUESTION_CHARACTER_LIMIT,
  researchQuestionLength,
} from "@session/shared/lib/researchEditor";
import {
  researchEditorCanSave,
  type researchEditorStats,
} from "@session/shared/lib/researchThreadView";
import { MessageSquarePlus } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "../../lib/cn.js";
import { isApplePlatform } from "../../lib/platform.js";
import { ControlButton } from "../../ui/Button.js";
import { ComposerSubmitShortcutGlyph } from "../../ui/ComposerSubmitShortcut.js";
import { FOCUS_RING } from "../../ui/surfaces.js";
import { QuestionModelPicker, type ModelChoice } from "../composer/QuestionModelPicker.js";

import { PairHeader, type ThreadHistoryNav } from "./ColumnChrome.js";
import { ColumnResizer } from "./ColumnResizer.js";
import { COLUMN_SCROLL } from "./MessagesColumn.js";

/** The root's document, or a note, open in the editor column. */
export interface EditorSession {
  nodeId: string;
  kind: "document" | "post";
  /** The saved text when the editor opened (or when ⌘S last saved it), and
   * the text in the field. */
  initialText: string;
  text: string;
  /** Documents: the thread title as opened, and in the field. */
  initialTitle: string;
  title: string;
  /** What the next save expects the server to hold. */
  expectedText: string;
  expectedTitle: string;
  /** Documents: the snapshot revision and highlight ids the save expects. */
  responseRevision: string | null;
  highlightIds: string[];
  highlightAnchors: ResearchHighlightAnchor[];
  branchAnchors: ResearchHighlightAnchor[];
  imported: boolean;
  /** Where focus returns when the column closes. */
  returnFocus: HTMLElement | null;
}

/** ⌘S on Apple platforms, Ctrl+S elsewhere. */
function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "s" || event.shiftKey || event.altKey) return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function isSaveAndCloseShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.shiftKey) return false;
  return event.metaKey || event.ctrlKey;
}

export function EditorColumn({
  column,
  current,
  session,
  stats,
  saving,
  asking,
  error,
  models,
  defaultChoice,
  textareaRef,
  history,
  onChange,
  onCancel,
  onSave,
  onSaveInPlace,
  onAskAsQuestion,
}: {
  column: EditorColumnData;
  current: boolean;
  session: EditorSession;
  /** Counts for the field's text, which follow it at a lower priority. */
  stats: ReturnType<typeof researchEditorStats> | null;
  saving: boolean;
  asking: boolean;
  error: string | null;
  /** The models "Ask as a question" can use, and the one it starts on. */
  models: readonly ModelInfo[];
  defaultChoice: ModelChoice | null;
  /** Receives the field element, for focus requests. */
  textareaRef: (element: HTMLTextAreaElement | null) => void;
  history: ThreadHistoryNav | null;
  onChange: (patch: Partial<Pick<EditorSession, "text" | "title">>) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveInPlace: () => void;
  onAskAsQuestion: (choice: ModelChoice) => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const questionNoteId = useId();
  const [chosen, setChosen] = useState<ModelChoice | null>(null);
  const choice = chosen ?? defaultChoice;
  const question = researchQuestionLength(session.text);
  const questionBlocker = !question.allowed
    ? question.count === 0
      ? "Write the question first"
      : `${question.count.toLocaleString()} / ${QUESTION_CHARACTER_LIMIT} characters`
    : choice === null
      ? "No model is available"
      : null;
  const heading = session.kind === "document" ? "Edit document" : "Edit note";
  const dirty = session.text !== session.initialText || session.title !== session.initialTitle;
  const canSave = researchEditorCanSave(session, stats);

  const notices: ReactNode[] = [];
  if (session.kind === "document") {
    const gate = researchDocumentEditGate({
      markdown: session.text,
      initialMarkdown: session.initialText,
      title: session.title,
      initialTitle: session.initialTitle,
      overWordLimit: stats?.overWordLimit ?? false,
      overByteLimit: stats?.overByteLimit ?? false,
    });
    if (gate.limitNotice) {
      notices.push(
        <p key="limit" className="text-status-failed m-0" role="alert">
          {gate.limitNotice}
        </p>,
      );
    }
  }
  const changed = session.text !== session.initialText;
  const removed = changed ? (stats?.removedHighlights ?? 0) : 0;
  if (removed > 0) {
    notices.push(
      <p key="highlights" className="text-status-warning m-0">
        {removed === 1
          ? "1 highlight no longer matches the text and will be removed."
          : `${removed.toLocaleString()} highlights no longer match the text and will be removed.`}
      </p>,
    );
  }
  const unmatched = changed ? (stats?.unmatchedBranches ?? 0) : 0;
  if (unmatched > 0) {
    notices.push(
      <p key="branches" className="m-0">
        {unmatched === 1
          ? "1 branch was asked about a passage that is no longer in the text. The branch keeps its quote."
          : `${unmatched.toLocaleString()} branches were asked about passages that are no longer in the text. The branches keep their quotes.`}
      </p>,
    );
  }
  const countText =
    session.kind === "document" && stats
      ? {
          text: `${
            stats.overWordLimit
              ? `Over ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()}`
              : `${stats.wordCount.toLocaleString()} / ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()}`
          } words${stats.overByteLimit ? " · over 10 MB" : ""}`,
          over: stats.overWordLimit || stats.overByteLimit,
        }
      : null;

  const setField = (element: HTMLTextAreaElement | null) => {
    fieldRef.current = element;
    textareaRef(element);
  };
  const requestClose = () => {
    if (saving) return;
    if (!dirty) {
      onCancel();
      return;
    }
    setConfirmingDiscard(true);
    requestAnimationFrame(() => keepEditingRef.current?.focus());
  };
  const keepEditing = () => {
    setConfirmingDiscard(false);
    requestAnimationFrame(() => fieldRef.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmingDiscard) keepEditing();
      else requestClose();
      return;
    }
    if (isSaveShortcut(event)) {
      // Taken even with nothing to save, so the browser's Save page does not
      // run.
      event.preventDefault();
      if (canSave && !saving) {
        if (confirmingDiscard) keepEditing();
        onSaveInPlace();
      }
      return;
    }
    if (isSaveAndCloseShortcut(event)) {
      event.preventDefault();
      if (canSave && !saving) onSave();
    }
  };

  // The column's keys (Esc, ⌘S, ⌘↵) apply wherever focus is inside it.
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      className={cn(
        "research-pair-editor relative flex h-full w-(--research-answer-width) min-w-0 shrink-0 flex-col",
        "border-border-strong border-r border-l border-r-[var(--surface-divider)] bg-[var(--research-thread-page-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label={heading}
      onKeyDown={onKeyDown}
    >
      <PairHeader title={heading} history={history} current={current} />
      <div className={cn(COLUMN_SCROLL, "flex flex-col")} data-research-scroll="">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-2 px-6 pt-4 pb-3",
            session.kind === "post" && "research-reading-surface",
          )}
        >
          {session.kind === "document" ? (
            <input
              className="text-fg-heading placeholder:text-fg-placeholder border-border-divider w-full border-0 border-b bg-transparent pb-2 text-[length:calc(17px+var(--font-ui-size-offset))] font-semibold outline-none"
              type="text"
              value={session.title}
              placeholder={
                session.text.trim()
                  ? deriveResearchDocumentTitle(session.text)
                  : "Title (uses the first line if left blank)"
              }
              aria-label="Document title"
              onChange={(event) => onChange({ title: event.currentTarget.value })}
            />
          ) : null}
          <textarea
            ref={setField}
            className={cn(
              "text-fg-primary min-h-40 w-full flex-1 resize-none border-0 bg-transparent p-0 outline-none",
              session.kind === "document"
                ? "font-mono text-sm leading-relaxed"
                : "text-[length:var(--research-body-font-size)] leading-(--research-body-line-height)",
            )}
            value={session.text}
            spellCheck={session.kind === "post"}
            aria-label={session.kind === "document" ? "Document Markdown" : "Note text"}
            onChange={(event) => {
              setConfirmingDiscard(false);
              onChange({ text: event.currentTarget.value });
            }}
          />
          {notices.length > 0 ? (
            <div className="text-fg-muted flex flex-col gap-1 text-sm">{notices}</div>
          ) : null}
        </div>
      </div>
      <footer className="border-border-divider flex shrink-0 flex-col gap-2 border-t px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            className={cn(
              "text-fg-secondary hover:bg-surface-fill-hover hover:text-fg-strong min-h-control-sm inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-sm aria-disabled:opacity-50",
              FOCUS_RING,
            )}
            aria-disabled={questionBlocker !== null || asking || saving || undefined}
            aria-describedby={questionBlocker !== null ? questionNoteId : undefined}
            onClick={() => {
              if (questionBlocker === null && choice && !asking && !saving) onAskAsQuestion(choice);
            }}
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            <span>{asking ? "Asking…" : "Ask as a question"}</span>
          </button>
          {choice ? (
            <QuestionModelPicker
              choice={choice}
              models={models}
              title="Model for the question"
              disabled={asking || saving || (!question.allowed && question.count > 0)}
              onChange={setChosen}
            />
          ) : null}
          {questionBlocker !== null ? (
            <span
              id={questionNoteId}
              className={cn(
                "text-xs",
                !question.allowed && question.count > 0 ? "text-status-failed" : "text-fg-faint",
              )}
            >
              {questionBlocker}
            </span>
          ) : null}
        </div>
        {confirmingDiscard ? (
          <div className="flex items-center gap-2" role="group" aria-label="Discard changes">
            <span className="text-fg-secondary min-w-0 flex-1 text-sm">Discard your changes?</span>
            <ControlButton ref={keepEditingRef} size="sm" onClick={keepEditing}>
              Keep editing
            </ControlButton>
            <ControlButton size="sm" tone="danger" onClick={onCancel}>
              Discard
            </ControlButton>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {countText ? (
              <span
                className={cn("text-xs", countText.over ? "text-status-failed" : "text-fg-faint")}
              >
                {countText.text}
              </span>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              <ControlButton size="sm" disabled={saving} onClick={requestClose}>
                Cancel
              </ControlButton>
              <ControlButton
                size="sm"
                className="bg-accent text-fg-on-accent hover:bg-accent-strong border-transparent"
                disabled={!canSave || saving}
                title={`Save and close (${isApplePlatform() ? "⌘↵" : "Ctrl+↵"}) · Save and keep editing (${isApplePlatform() ? "⌘S" : "Ctrl+S"})`}
                onClick={onSave}
              >
                <span>{saving ? "Saving…" : "Save"}</span>
                {!saving ? <ComposerSubmitShortcutGlyph ariaHidden /> : null}
              </ControlButton>
            </span>
          </div>
        )}
        {error ? (
          <p className="text-status-failed m-0 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </footer>
      <ColumnResizer kind="answer" label="Resize editor column" />
    </section>
  );
}
