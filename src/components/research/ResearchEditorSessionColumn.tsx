import type { ComponentProps, ReactNode, Ref } from "react";
import type { ResearchEditorColumn as EditorColumn } from "@session/shared/lib/researchColumns";
import {
  RESEARCH_DOCUMENT_WORD_LIMIT,
  deriveResearchDocumentTitle,
  researchDocumentEditGate,
} from "@session/shared/lib/researchDocuments";
import { researchEditorCanSave, type researchEditorStats } from "@session/shared/lib/researchThreadView";
import type { AgentAdapterMetadata, ResearchHighlightAnchor } from "../../types";
import { ResearchEditorColumn } from "./ResearchEditorColumn";
import type { ResearchLaunchChoice } from "./ResearchQueryComposer";

/** The root's document (E0), or a note (the root note or a follow-up note,
 * E{level}), open in the editor column. */
export interface EditorSession {
  nodeId: string;
  kind: "document" | "post";
  /** The saved text when the editor opened (or the field's text when ⌘S
   * last saved it), and the text in the field. */
  initialText: string;
  text: string;
  /** Documents: the thread title when the editor opened (or when ⌘S last
   * saved it), and in the field. */
  initialTitle: string;
  title: string;
  /** The stored note text and thread title the next save expects to
   * replace. A save that keeps the editor open (⌘S) makes the saved field
   * values the initial ones, while these follow what was stored, which the
   * backend trims (and, for a blank title, derives from the first line). */
  expectedText: string;
  expectedTitle: string;
  /** Documents: the snapshot revision and highlight ids the save expects. */
  responseRevision: string | null;
  highlightIds: string[];
  /** Highlights and branch anchors the edit may leave without a match. */
  highlightAnchors: ResearchHighlightAnchor[];
  branchAnchors: ResearchHighlightAnchor[];
  imported: boolean;
  /** Where focus returns when the column closes. */
  returnFocus: HTMLElement | null;
  /** Notes: the note column's scroll offset when the editor took its place,
   * restored when the note column returns. */
  noteScrollTop: number;
}

/** The editor column for an editor session: the field (and a document's
 * title), with notices for the limits and for the highlights and branch
 * passages the edit leaves without a match, and a document's word count. */
export function ResearchEditorSessionColumn({
  column,
  current,
  session,
  stats,
  saving,
  asking,
  error,
  questionAdapters,
  questionDefault,
  textareaRef,
  history,
  onChange,
  onCancel,
  onSave,
  onSaveInPlace,
  onAskAsQuestion,
}: {
  column: EditorColumn;
  current: boolean;
  session: EditorSession;
  /** Counts for the text in the field (researchEditorStats), which follow
   * the field at a lower priority than typing. */
  stats: ReturnType<typeof researchEditorStats> | null;
  saving: boolean;
  asking: boolean;
  error: string | null;
  /** The agents "Ask as a question" can use, and the Home ask box's
   * selection it starts from (null when none is ready). */
  questionAdapters: AgentAdapterMetadata[];
  questionDefault: ResearchLaunchChoice | null;
  textareaRef: Ref<HTMLTextAreaElement>;
  history: ComponentProps<typeof ResearchEditorColumn>["history"];
  onChange: (patch: Partial<Pick<EditorSession, "text" | "title">>) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveInPlace: () => void;
  onAskAsQuestion: (choice: ResearchLaunchChoice) => void;
}) {
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
        <p key="limit" className="research-editor-note is-error" role="alert">
          {gate.limitNotice}
        </p>,
      );
    }
  }
  const removed = session.text !== session.initialText ? (stats?.removedHighlights ?? 0) : 0;
  if (removed > 0) {
    notices.push(
      <p key="highlights" className="research-editor-note is-warning">
        {removed === 1
          ? "1 highlight no longer matches the text and will be removed."
          : `${removed.toLocaleString()} highlights no longer match the text and will be removed.`}
      </p>,
    );
  }
  const unmatchedBranches = session.text !== session.initialText ? (stats?.unmatchedBranches ?? 0) : 0;
  if (unmatchedBranches > 0) {
    notices.push(
      <p key="branches" className="research-editor-note">
        {unmatchedBranches === 1
          ? "1 branch was asked about a passage that is no longer in the text. The branch keeps its quote."
          : `${unmatchedBranches.toLocaleString()} branches were asked about passages that are no longer in the text. The branches keep their quotes.`}
      </p>,
    );
  }
  return (
    <ResearchEditorColumn
      column={column}
      current={current}
      kind={session.kind}
      value={session.text}
      onChange={(text) => onChange({ text })}
      title={
        session.kind === "document"
          ? {
              value: session.title,
              placeholder: session.text.trim()
                ? deriveResearchDocumentTitle(session.text)
                : "Title (uses the first line if left blank)",
              onChange: (title) => onChange({ title }),
            }
          : undefined
      }
      dirty={session.text !== session.initialText || session.title !== session.initialTitle}
      canSave={researchEditorCanSave(session, stats)}
      saving={saving}
      notices={notices}
      countText={
        session.kind === "document" && stats
          ? {
              text: `${stats.overWordLimit ? `Over ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()}` : `${stats.wordCount.toLocaleString()} / ${RESEARCH_DOCUMENT_WORD_LIMIT.toLocaleString()}`} words${stats.overByteLimit ? " · over 10 MB" : ""}`,
              over: stats.overWordLimit || stats.overByteLimit,
            }
          : null
      }
      error={error}
      questionAdapters={questionAdapters}
      questionDefault={questionDefault}
      asking={asking}
      textareaRef={textareaRef}
      onCancel={onCancel}
      onSave={onSave}
      onSaveInPlace={onSaveInPlace}
      onAskAsQuestion={onAskAsQuestion}
      history={history}
    />
  );
}
