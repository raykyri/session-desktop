import type { ResearchNode, ResearchTreeDetail } from "../../types";
import { shortWhen } from "../../lib/shortTime";
import { ResearchUserMessage } from "./ResearchMessage";
import { NoteBody } from "./ResearchNote";

function excerpt(text: string, maxChars = 90): string {
  const normalized = text.split(/\s+/).filter(Boolean).join(" ");
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1).trimEnd()}…` : normalized;
}

/** What happened to a note, where an answer would be: "Saved the link and
 * posted it to your network. No replies yet." */
export function noteDeliveryText(
  note: Pick<ResearchNode, "prompt" | "attachments" | "delivery">,
  topLevelReplyCount: number,
): string {
  const post = note.attachments?.some((attachment) => attachment.tweet) ?? false;
  // A note that carries a URL saved that link (with or without a comment).
  const link = !post && /\bhttps?:\/\/\S/.test(note.prompt);
  const saved = post ? "Saved the post" : link ? "Saved the link" : null;
  if (!note.delivery) {
    return saved ? `${saved}.` : "Saved.";
  }
  const posted = saved ? `${saved} and posted it to your network.` : "Posted to your network.";
  return topLevelReplyCount === 0 ? `${posted} No replies yet.` : posted;
}

/** A note's post column body: the note as a turn's question, and its
 * delivery line where an answer would be. Replies, follow-ups and the
 * follow-up composer are in the thread column to its right
 * (ResearchNoteThread). The column header carries the history buttons. */
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
  const topLevelReplies = (note.delivery?.replies ?? []).filter((reply) => !reply.inReplyTo);
  const deliveryText = noteDeliveryText(note, topLevelReplies.length);

  return (
    <div className="note-document">
      {/* Use the turn layout for the note and its delivery details. */}
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
        <div className="research-turn-answer">
          <section className="research-response note-response" aria-label="Delivery">
            <p className="note-document-status">{deliveryText}</p>
          </section>
        </div>
      </article>
    </div>
  );
}
