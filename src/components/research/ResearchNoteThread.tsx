import { useId, useMemo, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Globe, Sparkles } from "lucide-react";
import type { NoteReply, ResearchNode } from "../../types";
import { nodeType } from "../../lib/researchNodeTypes";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { shortWhen } from "../../lib/shortTime";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import {
  NoteFollowUpField,
  NoteFollowUpStatus,
  NoteReplyItem,
  noteReplyTargetFor,
  type NoteActions,
  type NoteReplyTarget,
} from "./ResearchNote";

/** One row of a note's thread column: a top-level reply (with the author's
 * responses to it) or a follow-up. */
type NoteThreadEntry =
  | { kind: "reply"; key: string; at: number; reply: NoteReply }
  | { kind: "follow-up"; key: string; at: number; node: ResearchNode };

/** The rows of a note's thread, oldest first: its top-level network replies
 * and its follow-ups (child nodes other than documents), merged by time. A
 * follow-up row's key is its node id. */
export function noteThreadEntries(nodes: readonly ResearchNode[], note: ResearchNode): NoteThreadEntry[] {
  const followUps = nodes
    .filter((node) => node.parentNodeId === note.id && nodeType(node) !== "document")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const replies = (note.delivery?.replies ?? []).filter((reply) => !reply.inReplyTo);
  return [
    ...replies.map((reply): NoteThreadEntry => ({ kind: "reply", key: `reply:${reply.id}`, at: reply.createdAt, reply })),
    ...followUps.map((node): NoteThreadEntry => ({ kind: "follow-up", key: node.id, at: node.createdAt, node })),
  ].sort((left, right) => left.at - right.at);
}

/** A note's thread column body: the follow-up composer at the top, then one
 * row per reply and follow-up, oldest first. A reply shows in full with its
 * responses nested under it; a follow-up row shows its reply count (a network
 * follow-up) or its answer state (an AI follow-up), and opens the follow-up
 * as the next level. One row is in the tab order: the open follow-up's, else
 * the row focused last, else the first. ResearchDocument handles the column's
 * keys. */
export default function ResearchNoteThread({
  nodes,
  note,
  archived,
  actions,
  requireCmdEnterToSend,
  openNodeId,
  composerRef,
  onOpenFollowUp,
}: {
  nodes: readonly ResearchNode[];
  note: ResearchNode;
  archived: boolean;
  actions: NoteActions;
  /** The "Require ⌘↵ to send" setting, for the follow-up composer. */
  requireCmdEnterToSend: boolean;
  /** The follow-up open as the next level, if any. */
  openNodeId: string | null;
  composerRef?: Ref<ResearchComposerHandle>;
  onOpenFollowUp: (nodeId: string) => void;
}) {
  const [target, setTarget] = useState<NoteReplyTarget | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(openNodeId);
  // Opening a follow-up (from the row, the feed or history) makes its row the
  // one in the tab order, so focus returns to it after the level closes.
  const [lastOpenNodeId, setLastOpenNodeId] = useState(openNodeId);
  if (openNodeId !== lastOpenNodeId) {
    setLastOpenNodeId(openNodeId);
    if (openNodeId) {
      setActiveKey(openNodeId);
    }
  }
  const entries = useMemo(() => noteThreadEntries(nodes, note), [nodes, note]);
  const replies = note.delivery?.replies ?? [];
  const tabKey = entries.some((entry) => entry.key === activeKey) ? activeKey : (entries[0]?.key ?? null);
  const modelLabel = formatResearchModelSummary(note.adapter, note.model);

  return (
    <div className="note-thread">
      {!archived ? (
        <NoteFollowUpField
          key={target?.id ?? "note"}
          composerRef={composerRef}
          networkAvailable={Boolean(note.delivery)}
          modelLabel={modelLabel}
          target={target}
          autoFocus={target !== null}
          fullWidth
          placeholder="Ask a follow-up about this note"
          requireCmdEnter={requireCmdEnterToSend}
          onClearTarget={() => setTarget(null)}
          onSubmit={(prompt, network) =>
            actions
              .onAskFollowUp({
                parentNodeId: note.id,
                prompt,
                network,
                replyAnchor: network ? null : target?.id ?? null,
              })
              .then(() => setTarget(null))
          }
        />
      ) : null}
      {entries.length > 0 ? (
        <ol className="note-thread-list note-thread-rows" aria-label="Replies and follow-ups">
          {entries.map((entry) =>
            entry.kind === "reply" ? (
              <NoteReplyItem
                key={entry.key}
                nodeId={note.id}
                reply={entry.reply}
                responses={replies.filter((reply) => reply.inReplyTo === entry.reply.id)}
                archived={archived}
                actions={actions}
                onAskAbout={setTarget}
                rowProps={{
                  tabIndex: tabKey === entry.key ? 0 : -1,
                  "data-research-thread-row": "",
                  onFocus: (event) => {
                    if (event.target === event.currentTarget) {
                      setActiveKey(entry.key);
                    }
                  },
                }}
              />
            ) : (
              <NoteFollowUpRow
                key={entry.key}
                child={entry.node}
                replies={replies}
                archived={archived}
                open={entry.node.id === openNodeId}
                tabbable={tabKey === entry.key}
                onRetry={actions.onRetry}
                onOpen={onOpenFollowUp}
                onFocus={() => setActiveKey(entry.key)}
              />
            ),
          )}
        </ol>
      ) : (
        <p className="note-thread-empty">No replies or follow-ups yet.</p>
      )}
    </div>
  );
}

/** A follow-up as a row: who asked where, the question, and the reply count
 * or answer state. One button under the row's content opens the follow-up;
 * Retry stays its own target above it. */
function NoteFollowUpRow({
  child,
  replies,
  archived,
  open,
  tabbable,
  onRetry,
  onOpen,
  onFocus,
}: {
  child: ResearchNode;
  /** The note's replies, for a follow-up asked about one of them. */
  replies: NoteReply[];
  archived: boolean;
  open: boolean;
  tabbable: boolean;
  onRetry: (nodeId: string) => Promise<void>;
  onOpen: (nodeId: string) => void;
  onFocus: () => void;
}) {
  const labelId = useId();
  const network = nodeType(child) === "post";
  const anchored = noteReplyTargetFor(replies, child.replyAnchor);
  const model = formatResearchModelSummary(child.adapter, child.model) || "AI";
  let state: ReactNode;
  if (network) {
    const count = child.delivery?.replies?.filter((reply) => !reply.inReplyTo).length ?? 0;
    state = (
      <div className="note-thread-meta">
        {count === 1 ? "1 reply" : count > 0 ? `${count} replies` : "No replies yet"}
      </div>
    );
  } else if (child.status === "complete") {
    state = <div className="note-thread-meta">Answered</div>;
  } else {
    const summary = recentResearchQueryFromNode(child, true);
    state = summary ? <NoteFollowUpStatus child={summary} archived={archived} onRetry={onRetry} /> : null;
  }
  return (
    <li className={`note-thread-item note-thread-follow-up${open ? " is-selected" : ""}`} data-type="follow-up">
      <button
        type="button"
        className="note-thread-hit"
        data-research-thread-row=""
        data-node-id={child.id}
        aria-current={open ? "true" : undefined}
        aria-labelledby={labelId}
        title={network ? "Open this follow-up" : "Open this answer"}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onOpen(child.id)}
        onFocus={onFocus}
      />
      <div className="note-thread-gutter">
        <span className="note-glyph" aria-hidden="true">
          {network ? <Globe size={10} /> : <Sparkles size={10} />}
        </span>
      </div>
      <div className="note-thread-body">
        <div className="note-reply-head">
          <span className="note-reply-author">You</span>
          <span>
            {network ? "posted to network" : `asked ${model}${anchored ? ` about ${anchored.author}’s reply` : ""}`}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(child.createdAt).toISOString()} title={new Date(child.createdAt).toLocaleString()}>
            {shortWhen(child.createdAt)}
          </time>
        </div>
        <div id={labelId} className="note-thread-question">
          {child.prompt}
        </div>
        {state}
      </div>
    </li>
  );
}
