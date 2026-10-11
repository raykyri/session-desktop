import { useId, useImperativeHandle, useMemo, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Globe, Sparkles } from "lucide-react";
import type { PostReply, ResearchNode } from "../../types";
import { nodeAdapter, nodeAgent, nodeDelivery, nodePrompt, nodeStatus, nodeType, replyAnchorId } from "../../lib/researchNodeTypes";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { shortWhen } from "../../lib/shortTime";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import {
  PostFollowUpField,
  PostFollowUpStatus,
  PostReplyItem,
  postReplyTargetFor,
  type PostActions,
  type PostReplyTarget,
} from "./ResearchPost";

/** One row of a post's thread column: a top-level reply (with the author's
 * responses to it) or a follow-up. */
type PostThreadEntry =
  | { kind: "reply"; key: string; at: number; reply: PostReply }
  | { kind: "follow-up"; key: string; at: number; node: ResearchNode };

/** Makes `row` (a row element of this thread) the one in the tab order
 * without focusing it, for ⌃Tab with focus kept in a text field. The row is
 * marked (`data-current`) until a row takes focus, since no focus ring shows
 * which row the keys act on. */
export interface ResearchPostThreadHandle {
  makeCurrent: (row: HTMLElement) => void;
}

/** The rows of a post's thread, oldest first: its top-level network replies,
 * and its follow-ups (child nodes other than documents), merged by time. A follow-up row's key is its node id. */
export function postThreadEntries(nodes: readonly ResearchNode[], post: ResearchNode): PostThreadEntry[] {
  const followUps = nodes
    .filter((node) => node.parentNodeId === post.id && nodeType(node) !== "document")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const replies = (nodeDelivery(post)?.replies ?? []).filter((reply) => !reply.inReplyTo);
  return [
    ...replies.map((reply): PostThreadEntry => ({ kind: "reply", key: `reply:${reply.id}`, at: reply.createdAt, reply })),
    ...followUps.map((node): PostThreadEntry => ({ kind: "follow-up", key: node.id, at: node.createdAt, node })),
  ].sort((left, right) => left.at - right.at);
}

/** A post's thread column body: the follow-up composer at the top, then one
 * row per reply and follow-up, oldest first. A reply shows in full with its
 * responses nested under it; a follow-up row shows its reply count (a network
 * follow-up) or its answer state (an AI follow-up), and opens the follow-up
 * as the next level. One row is in the tab order: the open follow-up's, else
 * the row focused last, else the first. ResearchThreadPage handles the column's
 * keys. Each row carries its entry's key in `data-thread-key`. */
export default function ResearchPostThread({
  nodes,
  post,
  archived,
  actions,
  requireCmdEnterToSend,
  openNodeId,
  composerRef,
  threadRef,
  onOpenFollowUp,
}: {
  nodes: readonly ResearchNode[];
  post: ResearchNode;
  archived: boolean;
  actions: PostActions;
  /** The "Require ⌘↵ to send" setting, for the follow-up composer. */
  requireCmdEnterToSend: boolean;
  /** The follow-up open as the next level, if any. */
  openNodeId: string | null;
  composerRef?: Ref<ResearchComposerHandle>;
  threadRef?: Ref<ResearchPostThreadHandle>;
  onOpenFollowUp: (nodeId: string) => void;
}) {
  const [target, setTarget] = useState<PostReplyTarget | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(openNodeId);
  // The row made current by makeCurrent, marked while focus stays elsewhere.
  const [markedKey, setMarkedKey] = useState<string | null>(null);
  useImperativeHandle(
    threadRef,
    () => ({
      makeCurrent: (row) => {
        const key = row.dataset.threadKey;
        if (key) {
          setActiveKey(key);
          setMarkedKey(key);
        }
      },
    }),
    [],
  );
  const focusRow = (key: string) => {
    setActiveKey(key);
    setMarkedKey(null);
  };
  // Opening a follow-up (from the row, the feed or history) makes its row the
  // one in the tab order, so focus returns to it after the level closes.
  const [lastOpenNodeId, setLastOpenNodeId] = useState(openNodeId);
  if (openNodeId !== lastOpenNodeId) {
    setLastOpenNodeId(openNodeId);
    if (openNodeId) {
      setActiveKey(openNodeId);
    }
  }
  const entries = useMemo(() => postThreadEntries(nodes, post), [nodes, post]);
  const replies = nodeDelivery(post)?.replies ?? [];
  const tabKey = entries.some((entry) => entry.key === activeKey) ? activeKey : (entries[0]?.key ?? null);
  const markedRowKey = markedKey === tabKey ? markedKey : null;
  const modelLabel = formatResearchModelSummary(nodeAdapter(post), nodeAgent(post)?.model);

  return (
    <div className="post-thread">
      {!archived ? (
        <PostFollowUpField
          key={target?.id ?? "post"}
          composerRef={composerRef}
          networkAvailable={Boolean(nodeDelivery(post))}
          modelLabel={modelLabel}
          target={target}
          autoFocus={target !== null}
          fullWidth
          requireCmdEnter={requireCmdEnterToSend}
          onClearTarget={() => setTarget(null)}
          onSubmit={(prompt, network) =>
            actions
              .onAskFollowUp({
                parentNodeId: post.id,
                prompt,
                network,
                replyId: network ? null : target?.id ?? null,
              })
              .then(() => setTarget(null))
          }
        />
      ) : null}
      {entries.length > 0 ? (
        <ol className="post-thread-list post-thread-rows" aria-label="Replies and follow-ups">
          {entries.map((entry) =>
            entry.kind === "reply" ? (
              <PostReplyItem
                key={entry.key}
                nodeId={post.id}
                reply={entry.reply}
                responses={replies.filter((reply) => reply.inReplyTo === entry.reply.id)}
                archived={archived}
                actions={actions}
                onAskAbout={setTarget}
                rowProps={{
                  tabIndex: tabKey === entry.key ? 0 : -1,
                  "data-research-thread-row": "",
                  "data-thread-key": entry.key,
                  "data-current": markedRowKey === entry.key ? "" : undefined,
                  onFocus: (event) => {
                    if (event.target === event.currentTarget) {
                      focusRow(entry.key);
                    }
                  },
                }}
              />
            ) : (
              <PostFollowUpRow
                key={entry.key}
                child={entry.node}
                replies={replies}
                archived={archived}
                open={entry.node.id === openNodeId}
                tabbable={tabKey === entry.key}
                marked={markedRowKey === entry.key}
                onRetry={actions.onRetry}
                onOpen={onOpenFollowUp}
                onFocus={() => focusRow(entry.key)}
              />
            ),
          )}
        </ol>
      ) : (
        <p className="post-thread-empty">No replies or follow-ups yet.</p>
      )}
    </div>
  );
}

/** A follow-up as a row: who asked where, the question, and the reply count
 * or answer state. One button under the row's content opens the follow-up;
 * Retry stays its own target above it. */
function PostFollowUpRow({
  child,
  replies,
  archived,
  open,
  tabbable,
  marked,
  onRetry,
  onOpen,
  onFocus,
}: {
  child: ResearchNode;
  /** The post's replies, for a follow-up asked about one of them. */
  replies: PostReply[];
  archived: boolean;
  open: boolean;
  tabbable: boolean;
  marked: boolean;
  onRetry: (nodeId: string) => Promise<void>;
  onOpen: (nodeId: string) => void;
  onFocus: () => void;
}) {
  const labelId = useId();
  const network = nodeType(child) === "post";
  const anchored = postReplyTargetFor(replies, replyAnchorId(child));
  const model = formatResearchModelSummary(nodeAdapter(child), nodeAgent(child)?.model) || "AI";
  let state: ReactNode;
  if (network) {
    const count = nodeDelivery(child)?.replies?.filter((reply) => !reply.inReplyTo).length ?? 0;
    state = count > 0 ? <div className="post-thread-meta">{count === 1 ? "1 reply" : `${count} replies`}</div> : null;
  } else if (nodeStatus(child) === "complete") {
    state = <div className="post-thread-meta">Answered</div>;
  } else {
    const summary = recentResearchQueryFromNode(child, true);
    state = summary ? <PostFollowUpStatus child={summary} archived={archived} onRetry={onRetry} /> : null;
  }
  return (
    <li
      className={`post-thread-item post-thread-follow-up${open ? " is-selected" : ""}`}
      data-type="follow-up"
      data-current={marked ? "" : undefined}
    >
      <button
        type="button"
        className="post-thread-hit"
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
      <div className="post-thread-gutter">
        <span className="post-glyph" aria-hidden="true">
          {network ? <Globe size={10} /> : <Sparkles size={10} />}
        </span>
      </div>
      <div className="post-thread-body">
        <div className="post-reply-head">
          <span className="post-reply-author">You</span>
          {network ? null : <span>{`asked ${model}${anchored ? ` about ${anchored.author}’s reply` : ""}`}</span>}
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(child.createdAt).toISOString()} title={new Date(child.createdAt).toLocaleString()}>
            {shortWhen(child.createdAt)}
          </time>
        </div>
        <div id={labelId} className="post-thread-question">
          {nodePrompt(child)}
        </div>
        {state}
      </div>
    </li>
  );
}
