import { useId, useImperativeHandle, useMemo, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Globe, Pencil, Sparkles } from "lucide-react";
import type { NoteCorrection, NoteReply, ResearchNode } from "../../types";
import { nodeType } from "../../lib/researchNodeTypes";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { shortWhen } from "../../lib/shortTime";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import { ResearchMarkdown } from "./ResearchMessage";
import {
  NoteFollowUpField,
  NoteFollowUpStatus,
  NoteReplyItem,
  noteReplyTargetFor,
  type NoteActions,
  type NoteReplyTarget,
} from "./ResearchNote";

/** One row of a note's thread column: a top-level reply (with the author's
 * responses to it), a follow-up, or a correction the author appended. */
type NoteThreadEntry =
  | { kind: "reply"; key: string; at: number; reply: NoteReply }
  | { kind: "follow-up"; key: string; at: number; node: ResearchNode }
  | { kind: "correction"; key: string; at: number; correction: NoteCorrection };

/** Makes `row` (a row element of this thread) the one in the tab order
 * without focusing it, for ⌃Tab with focus kept in a text field. */
export interface ResearchNoteThreadHandle {
  makeCurrent: (row: HTMLElement) => void;
}

/** The rows of a note's thread, oldest first: its top-level network replies,
 * its follow-ups (child nodes other than documents) and its corrections,
 * merged by time. A follow-up row's key is its node id. */
export function noteThreadEntries(nodes: readonly ResearchNode[], note: ResearchNode): NoteThreadEntry[] {
  const followUps = nodes
    .filter((node) => node.parentNodeId === note.id && nodeType(node) !== "document")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const replies = (note.delivery?.replies ?? []).filter((reply) => !reply.inReplyTo);
  return [
    ...replies.map((reply): NoteThreadEntry => ({ kind: "reply", key: `reply:${reply.id}`, at: reply.createdAt, reply })),
    ...followUps.map((node): NoteThreadEntry => ({ kind: "follow-up", key: node.id, at: node.createdAt, node })),
    ...(note.corrections ?? []).map(
      (correction): NoteThreadEntry => ({
        kind: "correction",
        key: `correction:${correction.id}`,
        at: correction.createdAt,
        correction,
      }),
    ),
  ].sort((left, right) => left.at - right.at);
}

/** A note's thread column body: the follow-up composer at the top, then one
 * row per reply and follow-up, oldest first. A reply shows in full with its
 * responses nested under it; a follow-up row shows its reply count (a network
 * follow-up) or its answer state (an AI follow-up), and opens the follow-up
 * as the next level. One row is in the tab order: the open follow-up's, else
 * the row focused last, else the first. ResearchDocument handles the column's
 * keys. Each row carries its entry's key in `data-thread-key`. */
export default function ResearchNoteThread({
  nodes,
  note,
  archived,
  actions,
  requireCmdEnterToSend,
  openNodeId,
  composerRef,
  threadRef,
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
  threadRef?: Ref<ResearchNoteThreadHandle>;
  onOpenFollowUp: (nodeId: string) => void;
}) {
  const [target, setTarget] = useState<NoteReplyTarget | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(openNodeId);
  useImperativeHandle(
    threadRef,
    () => ({
      makeCurrent: (row) => {
        const key = row.dataset.threadKey;
        if (key) setActiveKey(key);
      },
    }),
    [],
  );
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
            entry.kind === "correction" ? (
              <NoteCorrectionRow
                key={entry.key}
                threadKey={entry.key}
                correction={entry.correction}
                tabbable={tabKey === entry.key}
                onFocus={() => setActiveKey(entry.key)}
              />
            ) : entry.kind === "reply" ? (
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
                  "data-thread-key": entry.key,
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
    state = count > 0 ? <div className="note-thread-meta">{count === 1 ? "1 reply" : `${count} replies`}</div> : null;
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
        data-thread-key={child.id}
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
          {network ? null : <span>{`asked ${model}${anchored ? ` about ${anchored.author}’s reply` : ""}`}</span>}
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

/** A correction the author appended to the post, as a row in its thread. */
function NoteCorrectionRow({
  threadKey,
  correction,
  tabbable,
  onFocus,
}: {
  threadKey: string;
  correction: NoteCorrection;
  tabbable: boolean;
  onFocus: () => void;
}) {
  return (
    <li
      className="note-thread-item note-thread-correction"
      data-type="correction"
      data-research-thread-row=""
      data-thread-key={threadKey}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
    >
      <div className="note-thread-gutter">
        <span className="note-glyph" aria-hidden="true">
          <Pencil size={10} />
        </span>
      </div>
      <div className="note-thread-body">
        <div className="note-reply-head">
          <span className="note-reply-author">You</span>
          <span className="note-correction-label">Correction</span>
          <span aria-hidden="true">·</span>
          <time
            dateTime={new Date(correction.createdAt).toISOString()}
            title={new Date(correction.createdAt).toLocaleString()}
          >
            {shortWhen(correction.createdAt)}
          </time>
        </div>
        <ResearchMarkdown className="note-reply-text" text={correction.body} variant="compact" />
      </div>
    </li>
  );
}
