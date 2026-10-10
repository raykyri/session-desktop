import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { shortWhen } from "../../lib/shortTime";
import { ResearchUserMessage } from "./ResearchMessage";
import { NoteBody } from "./ResearchNote";
import {
  nodeAttachments,
  nodeEditedAt,
  nodePrompt,
  postFollowUpSourceExcerpt,
} from "../../lib/researchNodeTypes";

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
  // A network follow-up's parent is always a post (the backend refuses any
  // other parent).
  const parentExcerpt = parent ? postFollowUpSourceExcerpt(parent, note, 60) : null;
  const editedAt = nodeEditedAt(note);

  return (
    <div className="note-document">
      {/* Use the turn layout for the note. */}
      <article className="research-turn note-turn">
        <div className="research-turn-question">
          {parent && parentExcerpt !== null ? (
            <button
              type="button"
              className="note-document-parent"
              onClick={() => onSelectNode(parent.id)}
            >
              ↳ Network follow-up of “{parentExcerpt}”
            </button>
          ) : null}
          <ResearchUserMessage className="research-prompt research-turn-prompt">
            <NoteBody
              prompt={nodePrompt(note)}
              format={note.type === "post" ? note.format : "text"}
              attachments={nodeAttachments(note)}
            />
          </ResearchUserMessage>
          <div className="research-turn-meta">
            <time
              dateTime={new Date(note.createdAt).toISOString()}
              title={new Date(note.createdAt).toLocaleString()}
            >
              {shortWhen(note.createdAt, Date.now())}
            </time>
            {editedAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span title={new Date(editedAt).toLocaleString()}>
                  Edited {shortWhen(editedAt, Date.now())}
                </span>
              </>
            ) : null}
          </div>
        </div>
      </article>
    </div>
  );
}
