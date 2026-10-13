import { useId, useImperativeHandle, useMemo, useState } from "react";
import type { ReactNode, Ref } from "react";
import { Sparkles, StickyNote } from "lucide-react";
import type { ResearchNode } from "../../types";
import { nodeAdapter, nodeAgent, nodePrompt, nodeStatus, nodeType } from "../../lib/researchNodeTypes";
import { recentResearchQueryFromNode } from "../../lib/activity";
import { shortWhen } from "../../lib/shortTime";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import type { ResearchComposerHandle } from "./ResearchConversationComposer";
import { PostFollowUpField, PostFollowUpStatus, type PostActions } from "./ResearchPost";
import { researchUnitMenuProps, type ResearchUnitMenuPlacement } from "./researchUnitMenu";
import { researchNoteDoubleClickProps } from "./researchNoteDoubleClick";
import { researchNoteEditable } from "../../lib/researchNoteEdit";

/** Makes `row` (a row element of this thread) the one in the tab order
 * without focusing it, for ⌃Tab with focus kept in a text field. The row is
 * marked (`data-current`) until a row takes focus, since no focus ring shows
 * which row the keys act on. */
export interface ResearchPostThreadHandle {
  makeCurrent: (row: HTMLElement) => void;
}

/** The rows of a note's follow-ups column, oldest first: its follow-ups
 * (child nodes other than documents), AI follow-ups and follow-up notes
 * alike. Stored replies (`delivery.replies`) are not rows. */
export function postThreadEntries(nodes: readonly ResearchNode[], post: ResearchNode): ResearchNode[] {
  return nodes
    .filter((node) => node.parentNodeId === post.id && nodeType(node) !== "document")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** A note's follow-ups column body: the follow-up composer at the top, then
 * one row per follow-up, oldest first. A follow-up note's row shows its text;
 * an AI follow-up's row also shows its answer state. A row opens its
 * follow-up as the next level. One row is in the tab order: the open
 * follow-up's, else the row focused last, else the first. ResearchThreadPage
 * handles the column's keys. Each row carries its node id in
 * `data-thread-key`. A right-click on a row, or Shift+F10 or the ContextMenu
 * key in it, opens its follow-up's menu (`onOpenContextMenu`). A
 * double-click on a follow-up note's row edits the note (`onEditNote`). */
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
  onOpenContextMenu,
  onEditNote,
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
  /** Opens the menu of a row's follow-up at `placement`: a follow-up note's
   * note menu, an AI follow-up's answer menu. */
  onOpenContextMenu: (node: ResearchNode, placement: ResearchUnitMenuPlacement) => void;
  /** Edits a follow-up note on a double-click of its row; `row` is the
   * row's button, which takes focus back when the editor closes. */
  onEditNote?: (nodeId: string, row: HTMLElement) => void;
}) {
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
  const followUps = useMemo(() => postThreadEntries(nodes, post), [nodes, post]);
  const tabKey = followUps.some((node) => node.id === activeKey) ? activeKey : (followUps[0]?.id ?? null);
  const markedRowKey = markedKey === tabKey ? markedKey : null;
  const modelLabel = formatResearchModelSummary(nodeAdapter(post), nodeAgent(post)?.model);

  return (
    <div className="post-thread">
      {!archived ? (
        <PostFollowUpField
          composerRef={composerRef}
          modelLabel={modelLabel}
          fullWidth
          requireCmdEnter={requireCmdEnterToSend}
          onSubmit={(prompt, asNote) => actions.onAskFollowUp({ parentNodeId: post.id, prompt, asNote })}
        />
      ) : null}
      {followUps.length > 0 ? (
        <ol className="post-thread-list post-thread-rows" aria-label="Follow-ups">
          {followUps.map((node) => (
            <PostFollowUpRow
              key={node.id}
              child={node}
              archived={archived}
              open={node.id === openNodeId}
              tabbable={tabKey === node.id}
              marked={markedRowKey === node.id}
              onRetry={actions.onRetry}
              onOpen={onOpenFollowUp}
              onOpenContextMenu={onOpenContextMenu}
              onEdit={
                onEditNote && researchNoteEditable(node, archived)
                  ? (row) => onEditNote(node.id, row)
                  : undefined
              }
              onFocus={() => focusRow(node.id)}
            />
          ))}
        </ol>
      ) : (
        <p className="post-thread-empty">No follow-ups yet.</p>
      )}
    </div>
  );
}

/** A follow-up as a row: who wrote or asked it, its text, and an AI
 * follow-up's answer state. One button under the row's content opens the
 * follow-up; Retry stays its own target above it. */
function PostFollowUpRow({
  child,
  archived,
  open,
  tabbable,
  marked,
  onRetry,
  onOpen,
  onOpenContextMenu,
  onEdit,
  onFocus,
}: {
  child: ResearchNode;
  archived: boolean;
  open: boolean;
  tabbable: boolean;
  marked: boolean;
  onRetry: (nodeId: string) => Promise<void>;
  onOpen: (nodeId: string) => void;
  onOpenContextMenu: (node: ResearchNode, placement: ResearchUnitMenuPlacement) => void;
  /** Edits the note; absent for an AI follow-up or a note that cannot be
   * edited. */
  onEdit?: (row: HTMLElement) => void;
  onFocus: () => void;
}) {
  const labelId = useId();
  const note = nodeType(child) === "post";
  const model = formatResearchModelSummary(nodeAdapter(child), nodeAgent(child)?.model) || "AI";
  // A note has no answer state.
  let state: ReactNode = null;
  if (!note && nodeStatus(child) === "complete") {
    state = <div className="post-thread-meta">Answered</div>;
  } else if (!note) {
    const summary = recentResearchQueryFromNode(child, true);
    state = summary ? <PostFollowUpStatus child={summary} archived={archived} onRetry={onRetry} /> : null;
  }
  // The row has no … button, so a menu opened from the keyboard opens at the
  // row.
  const menuProps = researchUnitMenuProps((placement) => onOpenContextMenu(child, placement));
  return (
    <li
      className={`post-thread-item post-thread-follow-up${open ? " is-selected" : ""}`}
      data-type="follow-up"
      data-current={marked ? "" : undefined}
      {...menuProps}
    >
      <button
        type="button"
        className="post-thread-hit"
        data-research-thread-row=""
        data-thread-key={child.id}
        data-node-id={child.id}
        aria-current={open ? "true" : undefined}
        aria-labelledby={labelId}
        title={note ? "Open this note" : "Open this answer"}
        tabIndex={tabbable ? 0 : -1}
        onClick={(event) => {
          // The second click of a double-click that edits the note does not
          // open the follow-up again; the first click opened it.
          if (onEdit && event.detail > 1) return;
          onOpen(child.id);
        }}
        onFocus={onFocus}
        {...researchNoteDoubleClickProps(onEdit)}
      />
      <div className="post-thread-gutter">
        <span className="post-glyph" aria-hidden="true">
          {note ? <StickyNote size={10} /> : <Sparkles size={10} />}
        </span>
      </div>
      <div className="post-thread-body">
        <div className="post-reply-head">
          <span className="post-reply-author">You</span>
          {note ? null : <span>{`asked ${model}`}</span>}
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
