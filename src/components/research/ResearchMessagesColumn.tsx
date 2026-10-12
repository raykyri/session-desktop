import type { ComponentProps, ReactNode, Ref, UIEvent } from "react";
import { CornerDownRight, Ellipsis, RefreshCw } from "lucide-react";
import { researchMessageStarrable } from "../../lib/researchChains";
import {
  columnAttributes,
  type ResearchBranchesColumn as ResearchBranchesColumnData,
  type ResearchColumn,
  type ResearchPendingGroup,
  type ResearchStackGroup,
} from "../../lib/researchColumns";
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
  /** In a branches column: the name of the message the branch was asked
   * from (a document's title, or the question of an answer), above the
   * passage. */
  from?: string | null;
}

function ResearchBranchSource({
  anchor,
  parent,
  created,
  resolves,
  parentLoaded,
  from = null,
  children,
}: ResearchBranchSourceProps & { children?: ReactNode }) {
  const postExcerpt = parent && created ? postFollowUpSourceExcerpt(parent) : null;
  const quote = anchor ? researchQuoteText(anchor.exact) : null;
  return (
    <div className="research-branch-source">
      <CornerDownRight size={13} aria-hidden="true" />
      <span className="research-branch-source-text">
        {from !== null ? (
          <span className="research-branch-source-from" title={from}>
            {from}
          </span>
        ) : null}
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
      </span>
      {children}
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

/** What every list of a chain's messages shares: the tree, the rows'
 * state and their callbacks. */
export interface ResearchChainRowsShared {
  archived: boolean;
  /** The research's title, the label of a row without one. */
  treeTitle: string;
  nodeById: ReadonlyMap<string, ResearchNode>;
  branchesByParent: ReadonlyMap<string, ResearchNode[]>;
  queuedRetries: ReadonlySet<string>;
  /** The message whose answer menu is open from its … button. */
  answerMenuOpenId: string | null;
  /** A branch finished while the thread was open and was not opened. */
  isUnread: (branch: ResearchNode) => boolean;
  rowActions: ResearchMessageRowActions;
}

/** A chain's messages in display order (reordered by drag when there is
 * more than one and the tree is not archived), then its queue. */
function ResearchChainRows({
  shared,
  level,
  headId,
  displayIds,
  selectedId,
  branchOpen,
  firstFocusable,
  queue,
}: {
  shared: ResearchChainRowsShared;
  /** The level the chain is (or opens as). */
  level: number;
  headId: string;
  displayIds: readonly string[];
  selectedId: string | null;
  /** A branch of the selected message is open as the next level. */
  branchOpen: boolean;
  /** The first row is in the tab order (no row of the column is selected). */
  firstFocusable: boolean;
  queue: ResearchQueueProps;
}) {
  const { archived, treeTitle, nodeById, branchesByParent, queuedRetries, answerMenuOpenId, isUnread, rowActions } =
    shared;
  const head = nodeById.get(headId);
  const dragPlace = !archived && displayIds.length > 1 ? chainDropPlace(headId) : null;
  return (
    <ul className="research-msg-list" data-research-drop={chainDropPlace(headId)} data-research-drop-kinds="message">
      {displayIds.map((id, index) => {
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
            focusable={firstFocusable && index === 0}
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
  );
}

/** A level's messages column (T{level}): what a branch was asked about, the
 * ask box, the chain's messages in display order, and its queue. */
export function ResearchMessagesColumn({
  column,
  current,
  title,
  history,
  imported,
  shared,
  branchOpen,
  menu,
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
  shared: ResearchChainRowsShared;
  /** A branch of the selected message is open as the next level. */
  branchOpen: boolean;
  /** Actions for the question that starts this pair. */
  menu: ComponentProps<typeof ResearchPairHeader>["menu"];
  source: ResearchBranchSourceProps | null;
  composer: ReactNode;
  queue: ResearchQueueProps;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const { index: level, chainIds, displayIds, headId, selectedId } = column.level;
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
        menu={menu}
        archived={level === 0 && shared.archived}
      />
      <div className="research-column-scroll" data-research-scroll onScroll={onScroll}>
        <div className="research-column-content research-reading-surface">
          {source ? <ResearchBranchSource {...source} /> : null}
          {composer}
          <ResearchChainRows
            shared={shared}
            level={level}
            headId={headId}
            displayIds={displayIds}
            selectedId={selectedId}
            branchOpen={branchOpen}
            firstFocusable={false}
            queue={queue}
          />
        </div>
      </div>
      <ResearchColumnResizer kind="messages" label="Resize messages column" belowHeader />
    </section>
  );
}

/** The ask box of the unsent branch: its first question. Sending creates
 * the branch. */
export function ResearchNewBranchComposer({
  group,
  archived,
  value,
  submitting,
  shortcutHint,
  requireCmdEnter,
  composerRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  group: ResearchPendingGroup;
  archived: boolean;
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
    <ResearchConversationComposer
      ref={composerRef}
      value={value}
      placeholder={group.anchor ? "Ask about this passage" : "Ask about this answer"}
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
  );
}

/** The branches column (T{level}) after a level: every branch asked from
 * the level's messages, stacked in reading order, each as a group with its
 * source (the message it was asked from and the passage), its … menu, its
 * messages, its queue and its ask box. The unsent branch is a group with
 * its source and the ask box for its first question. When one of the
 * branches is open as the next level, its selected message is the column's
 * selected row and the level's answer column follows. */
export function ResearchBranchesColumn({
  column,
  current,
  shared,
  branchOpen,
  sourceOf,
  menuOf,
  composerOf,
  queueOf,
  onScroll,
}: {
  column: ResearchBranchesColumnData;
  current: boolean;
  shared: ResearchChainRowsShared;
  /** A branch of the selected message is open as the level after this one. */
  branchOpen: boolean;
  /** What a group's branch was asked about. */
  sourceOf: (group: ResearchStackGroup) => ResearchBranchSourceProps;
  /** The … menu of a created branch, by its head. */
  menuOf: (headId: string) => { label: string; open: boolean; onOpen: (trigger: HTMLButtonElement) => void };
  /** A group's ask box. */
  composerOf: (group: ResearchStackGroup) => ReactNode;
  queueOf: (headId: string) => ResearchQueueProps;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const { levelIndex: level, groups } = column;
  const branchCount = groups.filter((group) => group.kind === "branch").length;
  const anySelected = groups.some((group) => group.kind === "branch" && group.selectedId !== null);
  const firstBranch = groups.find((group) => group.kind === "branch");
  return (
    <section
      className={`research-pair-messages is-branches${column.level ? "" : " is-closed"}${current ? " is-current" : ""}`}
      {...columnAttributes(column)}
      data-research-pending-only={branchCount === 0 ? "" : undefined}
      aria-label="Branches"
    >
      <ResearchPairHeader title="Branches" count={branchCount} />
      <div className="research-column-scroll" data-research-scroll onScroll={onScroll}>
        <div className="research-column-content research-reading-surface">
          {groups.map((group) => {
            if (group.kind === "pending") {
              return (
                <section
                  key={`pending:${group.parentNodeId}`}
                  className="research-branch-group is-pending"
                  data-research-branch-group={`pending:${group.parentNodeId}`}
                  aria-label="New branch"
                >
                  <ResearchBranchSource {...sourceOf(group)} />
                  {composerOf(group)}
                </section>
              );
            }
            const menu = menuOf(group.headId);
            const head = shared.nodeById.get(group.headId);
            return (
              <section
                key={group.headId}
                className={`research-branch-group${group.selectedId !== null ? " is-open" : ""}`}
                data-research-branch-group={group.headId}
                aria-label={`Branch: ${researchNodeLabel(head, "Branch")}`}
              >
                <ResearchBranchSource {...sourceOf(group)}>
                  <button
                    type="button"
                    className="control-button research-head-button research-head-menu research-branch-group-menu"
                    aria-label={menu.label}
                    title={menu.label}
                    aria-haspopup="menu"
                    aria-expanded={menu.open}
                    tabIndex={group.selectedId !== null ? 0 : -1}
                    onClick={(event) => menu.onOpen(event.currentTarget)}
                  >
                    <Ellipsis size={15} aria-hidden="true" />
                  </button>
                </ResearchBranchSource>
                <ResearchChainRows
                  shared={shared}
                  level={level}
                  headId={group.headId}
                  displayIds={group.displayIds}
                  selectedId={group.selectedId}
                  branchOpen={branchOpen}
                  firstFocusable={!anySelected && group === firstBranch}
                  queue={queueOf(group.headId)}
                />
                {composerOf(group)}
              </section>
            );
          })}
        </div>
      </div>
      <ResearchColumnResizer kind="messages" label="Resize messages column" belowHeader={column.level !== null} />
    </section>
  );
}
