import type { ComponentProps, ReactNode, Ref, UIEvent } from "react";
import { CornerDownRight, RefreshCw } from "lucide-react";
import { researchMessageStarrable } from "../../lib/researchChains";
import { columnAttributes, type ResearchColumn, type ResearchPendingColumn } from "../../lib/researchColumns";
import type { QueuedResearchFollowup } from "../../lib/researchNavigation";
import { nodeMessage, postFollowUpSourceExcerpt } from "../../lib/researchNodeTypes";
import { researchChainComposerState, researchNodeLabel, researchQuoteText } from "../../lib/researchThreadView";
import type { ResearchHighlightAnchor, ResearchNode } from "../../types";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import { ResearchColumnResizer } from "./ResearchColumnResizer";
import ResearchConversationComposer, { type ResearchComposerHandle } from "./ResearchConversationComposer";
import ResearchRowGlyph from "./ResearchRowGlyph";
import { ResearchMessageRow } from "./ResearchTurn";

const EMPTY_BRANCHES: ResearchNode[] = [];

type HistoryNav = ComponentProps<typeof ResearchPairHeader>["history"];

/** The drop zone of the messages column whose chain starts at `headId`. */
const chainDropPlace = (headId: string) => `chain:${headId}`;

/** What a branch was asked about, a muted block at the top of its first
 * column: the passage of the parent's answer, the whole answer, or, for a
 * follow-up of a note, the note's text. */
export interface ResearchBranchSourceProps {
  anchor: ResearchHighlightAnchor | null;
  parent: ResearchNode | undefined;
  /** The column is a created branch (not the unsent one). */
  created: boolean;
  /** The passage resolved in the parent's rendered answer. */
  resolves: boolean;
  /** The parent's answer has loaded. */
  parentLoaded: boolean;
}

function ResearchBranchSource({ anchor, parent, created, resolves, parentLoaded }: ResearchBranchSourceProps) {
  const postExcerpt = parent && created ? postFollowUpSourceExcerpt(parent) : null;
  const quote = anchor ? researchQuoteText(anchor.exact) : null;
  return (
    <div className="research-branch-source">
      <CornerDownRight size={13} aria-hidden="true" />
      <span className="research-branch-source-quote">
        {postExcerpt !== null ? (
          <>
            Follow-up to <i>“{postExcerpt}”</i>
          </>
        ) : quote && (resolves || !parentLoaded) ? (
          <i>“{quote}”</i>
        ) : quote ? (
          `The whole answer (was “${quote}”, before the answer was rerun)`
        ) : (
          "The whole answer"
        )}
      </span>
    </div>
  );
}

/** A messages column's ask box: continue the chain (queueing while it
 * runs), or replace a failed question being edited. */
export function ResearchChainComposer({
  nodes,
  chain,
  level,
  editing,
  queued,
  archived,
  value,
  submitting,
  shortcutHint,
  requireCmdEnter,
  composerRef,
  onChange,
  onSubmit,
  onSubmitBranch,
  onCancelEditing,
}: {
  nodes: ResearchNode[];
  /** The chain's messages, head first; not empty. */
  chain: readonly ResearchNode[];
  level: number;
  editing: boolean;
  queued: boolean;
  archived: boolean;
  value: string;
  submitting: boolean;
  shortcutHint: string | null;
  requireCmdEnter: boolean;
  composerRef: Ref<ResearchComposerHandle>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitBranch: () => void;
  onCancelEditing: () => void;
}) {
  const { canSend, disabled, note, placeholder } = researchChainComposerState({
    nodes,
    chain,
    editing,
    queued,
    archived,
  });
  return (
    <ResearchConversationComposer
      ref={composerRef}
      value={value}
      placeholder={placeholder}
      ariaLabel={
        editing ? "Edit the failed question" : level === 0 ? "Follow-up in this conversation" : "Follow-up in this branch"
      }
      mode={
        editing
          ? {
              label: (
                <>
                  <b>Editing</b> the failed question. Sending replaces the failed attempt.
                </>
              ),
              cancelLabel: "Cancel editing",
              onCancel: onCancelEditing,
            }
          : null
      }
      disabled={disabled}
      canSubmit={canSend}
      submitting={submitting}
      note={note}
      shortcutHint={shortcutHint}
      requireCmdEnter={requireCmdEnter}
      onChange={onChange}
      onSubmit={onSubmit}
      onSubmitBranch={onSubmitBranch}
    />
  );
}

/** The chain's client-side queue, listed below its messages in the order it
 * sends (the next to send is first). */
export interface ResearchQueueProps {
  items: readonly QueuedResearchFollowup[];
  /** The chain's last answer stopped, so the first item cannot send. */
  tailStalled: boolean;
  onRemove: (item: QueuedResearchFollowup) => void;
  /** `row` is the item's list row, where focus moves next. */
  onRetry: (item: QueuedResearchFollowup, row: HTMLElement | null) => void;
  onEdit: (item: QueuedResearchFollowup) => void;
}

function ResearchQueuedFollowups({ items, tailStalled, onRemove, onRetry, onEdit }: ResearchQueueProps) {
  return (
    <>
      {items.map((item, index) => {
        const stalled = index === 0 && !item.failed && tailStalled;
        return (
          <li key={item.id} className="research-msg-row is-status-queued is-client-queued">
            <div className="research-msg-content">
              <div className="research-msg-plain is-typed">
                <ResearchRowGlyph kind="exchange" state="queued" />
                {item.prompt}
              </div>
            </div>
            <div className="research-msg-meta">
              {item.failed || stalled ? (
                <span className="research-msg-pill is-error">Not sent</span>
              ) : (
                <span className="research-msg-state">Queued</span>
              )}
              <button
                type="button"
                className="research-msg-meta-button research-queue-remove"
                onClick={() => onRemove(item)}
              >
                Remove
              </button>
            </div>
            {item.failed || stalled ? (
              <p className="research-msg-note" role={item.failed ? "alert" : undefined}>
                {item.failed ?? "The last answer stopped; retry it, or edit this question."}
              </p>
            ) : null}
            {item.failed || stalled ? (
              <div className="research-turn-actions research-msg-actions">
                {item.failed ? (
                  <button
                    type="button"
                    className="control-button research-turn-button"
                    onClick={(event) => onRetry(item, event.currentTarget.closest("li"))}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>Retry</span>
                  </button>
                ) : null}
                <button type="button" className="control-button research-turn-button is-ghost" onClick={() => onEdit(item)}>
                  Edit question
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </>
  );
}

/** The message rows' callbacks, the same for every messages column. */
export type ResearchMessageRowActions = Pick<
  ComponentProps<typeof ResearchMessageRow>,
  "registerSegmentElement" | "onSelect" | "onShowBranches" | "onOpenAnswerMenu" | "onOpenContextMenu" | "onDragStart"
>;

/** A level's messages column (T{level}): what a branch was asked about, the
 * ask box, the chain's messages in display order (reordered by drag when
 * there is more than one and the tree is not archived), and its queue. */
export function ResearchMessagesColumn({
  column,
  current,
  title,
  history,
  imported,
  archived,
  treeTitle,
  nodeById,
  branchesByParent,
  branchOpen,
  queuedRetries,
  answerMenuOpenId,
  isUnread,
  rowActions,
  source,
  composer,
  queue,
  onScroll,
}: {
  column: Extract<ResearchColumn, { role: "messages" }>;
  current: boolean;
  title: string;
  history: HistoryNav;
  /** Provenance: the root is a transcript from a terminal session. */
  imported: boolean;
  archived: boolean;
  /** The research's title, the label of a row without one. */
  treeTitle: string;
  nodeById: ReadonlyMap<string, ResearchNode>;
  branchesByParent: ReadonlyMap<string, ResearchNode[]>;
  /** A branch of the selected message is open as the next level. */
  branchOpen: boolean;
  queuedRetries: ReadonlySet<string>;
  /** The message whose answer menu is open from its … button. */
  answerMenuOpenId: string | null;
  /** A branch finished while the thread was open and was not opened. */
  isUnread: (branch: ResearchNode) => boolean;
  rowActions: ResearchMessageRowActions;
  source: ResearchBranchSourceProps | null;
  composer: ReactNode;
  queue: ResearchQueueProps;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const { index: level, chainIds, displayIds, headId, selectedId } = column.level;
  const head = nodeById.get(headId);
  const dragPlace = !archived && displayIds.length > 1 ? chainDropPlace(headId) : null;
  return (
    <section
      className={`research-pair-messages${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label={`${level === 0 ? "Messages" : "Branch messages"}: ${title}`}
    >
      <ResearchPairHeader
        title={title}
        branch={level === 0 ? null : chainIds.length}
        history={history}
        imported={imported}
        archived={level === 0 && archived}
      />
      <div className="research-column-scroll" data-research-scroll onScroll={onScroll}>
        <div className="research-column-content research-reading-surface">
          {source ? <ResearchBranchSource {...source} /> : null}
          {composer}
          <ul
            className="research-msg-list"
            data-research-drop={chainDropPlace(headId)}
            data-research-drop-kinds="message"
          >
            {displayIds.map((id) => {
              const node = nodeById.get(id);
              if (!node) {
                return null;
              }
              const branches = branchesByParent.get(id) ?? EMPTY_BRANCHES;
              const selected = selectedId === id;
              return (
                <ResearchMessageRow
                  key={id}
                  node={node}
                  level={level}
                  label={researchNodeLabel(node, treeTitle)}
                  // A transcript, or a document with no question, is one row
                  // for the whole document (nodeMessage is null for both).
                  showPrompt={nodeMessage(node) !== null}
                  selected={selected}
                  starrable={researchMessageStarrable(node, head)}
                  retryQueued={queuedRetries.has(id)}
                  branchCount={branches.length}
                  branchOpen={selected && branchOpen}
                  branchUnread={branches.some(isUnread)}
                  answerMenuOpen={answerMenuOpenId === id}
                  dragPlace={dragPlace}
                  {...rowActions}
                />
              );
            })}
            <ResearchQueuedFollowups {...queue} />
          </ul>
        </div>
      </div>
      <ResearchColumnResizer kind="messages" label="Resize messages column" belowHeader />
    </section>
  );
}

/** The unsent branch's column (P{level}): what it is asked about and the ask
 * box for its first question. Sending creates the branch. */
export function ResearchNewBranchColumn({
  column,
  current,
  archived,
  source,
  value,
  submitting,
  shortcutHint,
  requireCmdEnter,
  composerRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  column: ResearchPendingColumn;
  current: boolean;
  archived: boolean;
  source: ResearchBranchSourceProps;
  value: string;
  submitting: boolean;
  shortcutHint: string | null;
  requireCmdEnter: boolean;
  composerRef: Ref<ResearchComposerHandle>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      className={`research-pair-messages is-pending${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      aria-label="New branch"
    >
      <ResearchPairHeader title="New branch" branch="new" />
      <div className="research-column-scroll">
        <div className="research-column-content research-reading-surface">
          <ResearchBranchSource {...source} />
          <ResearchConversationComposer
            ref={composerRef}
            value={value}
            placeholder={column.anchor ? "Ask about this passage" : "Ask about this answer"}
            ariaLabel="First question of the new branch"
            mode={{ label: <b>New branch</b>, cancelLabel: "Cancel branch", onCancel }}
            requireCmdEnter={requireCmdEnter}
            disabled={archived}
            canSubmit={!archived}
            submitting={submitting}
            shortcutHint={shortcutHint}
            onChange={onChange}
            onSubmit={onSubmit}
          />
        </div>
      </div>
      <ResearchColumnResizer kind="messages" label="Resize messages column" />
    </section>
  );
}
