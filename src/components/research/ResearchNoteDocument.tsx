import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { shortWhen } from "../../lib/shortTime";
import { ResearchUserMessage } from "./ResearchMessage";
import { NoteBody } from "./ResearchNote";

function excerpt(text: string, maxChars = 90): string {
  const normalized = text.split(/\s+/).filter(Boolean).join(" ");
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trimEnd()}…` : normalized;
}

/** A note's post column body: the note as a turn's question. Replies,
 * follow-ups and the follow-up composer are in the thread column to its
 * right (ResearchNoteThread). The column header carries the history buttons. */
export default function ResearchNoteDocument({
  detail,
  note,
  onSelectNode,
}: {
  detail: ResearchTreeDetail;
  note: ResearchNode;
  onSelectNode: (nodeId: string) => void;
}) {
  const parent = note.parentNodeId
    ? detail.nodes.find((node) => node.id === note.parentNodeId) ?? null
    : null;

  return (
    <div className="note-document">
      {/* Use the turn layout for the note. */}
      <article className="research-turn note-turn">
        <div className="research-turn-question">
          {parent ? (
            <button
              type="button"
              className="note-document-parent"
              onClick={() => onSelectNode(parent.id)}
            >
              ↳ Network follow-up of “{excerpt(parent.prompt, 60)}”
            </button>
          ) : null}
          <ResearchUserMessage className="research-prompt research-turn-prompt">
            <NoteBody prompt={note.prompt} attachments={note.attachments} />
          </ResearchUserMessage>
          <div className="research-turn-meta">
            <time
              dateTime={new Date(note.createdAt).toISOString()}
              title={new Date(note.createdAt).toLocaleString()}
            >
              {shortWhen(note.createdAt, Date.now())}
            </time>
          </div>
        </div>
      </article>
    </div>
  );
}
