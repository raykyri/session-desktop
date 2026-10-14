// A level's messages column (`09-research-document-view.md` §3), ported from
// the desktop `ResearchMessagesColumn.tsx`: what a branch was asked about,
// the chain's messages in display order (reordered by drag), the server's
// follow-up queue for the chain, and the ask box after them. The pieces a
// branches column reuses (the source block, the rows, the queue) are exported
// for `BranchesColumn.tsx`.

import type {
  ResearchFollowupQueueItem,
  ResearchHighlightAnchor,
  ResearchNode,
} from "@session/shared";
import { columnAttributes, type ResearchColumn } from "@session/shared/lib/researchColumns";
import { nodeMessage, postFollowUpSourceExcerpt } from "@session/shared/lib/researchNodeTypes";
import { researchNodeLabel, researchQuoteText } from "@session/shared/lib/researchThreadView";
import { CornerDownRight, RefreshCw } from "lucide-react";
import type { ReactNode, UIEvent } from "react";

import { cn } from "../../lib/cn.js";
import { RowGlyph } from "../../ui/RowGlyph.js";
import { FOCUS_RING } from "../../ui/surfaces.js";

import { PairHeader, type ThreadHistoryNav } from "./ColumnChrome.js";
import { ColumnResizer } from "./ColumnResizer.js";
import {
  MessageImages,
  MessageRow,
  TileToggle,
  useTileClamp,
  type MessageRowActions,
} from "./Turn.js";

const NO_BRANCHES: ResearchNode[] = [];

/** The drop place of the list whose chain starts at `headId`. */
export const chainDropPlace = (headId: string) => `chain:${headId}`;

export const COLUMN_SCROLL =
  "research-column-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain [scrollbar-width:thin] focus-visible:outline-none";

/** What a branch was asked about: the passage of its parent's answer, the
 * whole answer, or, for a follow-up of a note, the note's text. */
export interface BranchSourceProps {
  anchor: ResearchHighlightAnchor | null;
  parent: ResearchNode | undefined;
  /** A created branch (not the unsent one). */
  created: boolean;
  /** The passage resolved in the parent's rendered answer. */
  resolves: boolean;
  /** The parent's answer is on screen. */
  parentLoaded: boolean;
  /** In a branches column: the name of the message it was asked from. */
  from?: string | null;
}

export function BranchSource({
  anchor,
  parent,
  created,
  resolves,
  parentLoaded,
  from = null,
}: BranchSourceProps) {
  const postExcerpt = parent && created ? postFollowUpSourceExcerpt(parent) : null;
  const quote = anchor ? researchQuoteText(anchor.exact) : null;
  return (
    <div className="text-fg-muted flex items-start gap-1.5 px-4 pt-2.5 pb-1 text-[length:calc(12.5px+var(--font-ui-size-offset))] leading-[1.45]">
      <CornerDownRight size={13} className="text-fg-faint mt-[3px] shrink-0" aria-hidden="true" />
      <span className="flex min-w-0 flex-col gap-0.5">
        {from !== null ? (
          <span className="text-fg-secondary truncate font-medium" title={from}>
            {from}
          </span>
        ) : null}
        <span className="line-clamp-3 [overflow-wrap:anywhere]">
          {postExcerpt !== null ? (
            <>
              Follow-up to <i>“{postExcerpt}”</i>
            </>
          ) : quote && (resolves || !parentLoaded) ? (
            <i>“{quote}”</i>
          ) : quote ? (
            `Whole answer · selected text before rerun: “${quote}”`
          ) : from !== null ? null : (
            "The whole answer"
          )}
        </span>
      </span>
    </div>
  );
}

/** The chain's server queue and its items' actions. */
export interface QueueProps {
  items: readonly ResearchFollowupQueueItem[];
  /** The selected queued message, if any. */
  selectedId: string | null;
  /** The chain's last answer stopped, so the first item cannot send. */
  tailStalled: boolean;
  busy: boolean;
  onSelect: (item: ResearchFollowupQueueItem) => void;
  onCancel: (item: ResearchFollowupQueueItem) => void;
  onRetry: (item: ResearchFollowupQueueItem, row: HTMLElement | null) => void;
}

function QueuedFollowup({
  item,
  stalled,
  selectedId,
  busy,
  expanded,
  onSelect,
  onCancel,
  onRetry,
  onToggleExpanded,
}: Omit<QueueProps, "items" | "tailStalled"> & {
  item: ResearchFollowupQueueItem;
  stalled: boolean;
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
}) {
  const selected = item.id === selectedId;
  const labelId = `research-queued-${item.id}`;
  const { id: clampId, setBox, className: clampClass, overflows } = useTileClamp(expanded);
  const failed = item.failedReason;
  return (
    <li
      className={cn(
        "research-msg-row group/row relative mx-2 mt-0.5 rounded-[10px] pb-1",
        "hover:bg-[color-mix(in_srgb,var(--research-card-selected-bg)_55%,transparent)]",
        selected && "is-selected bg-[var(--research-card-selected-bg)]",
      )}
      data-research-queued={item.id}
    >
      <button
        type="button"
        className="research-msg-hit absolute inset-0 z-0 w-full cursor-pointer rounded-[inherit] border-0 bg-transparent p-0 focus:outline-none"
        aria-current={selected ? "true" : undefined}
        aria-labelledby={labelId}
        tabIndex={selected ? 0 : -1}
        onClick={() => onSelect(item)}
      />
      <div id={labelId} className="pointer-events-none relative z-[1] flow-root px-3 pt-2.5 pb-0.5">
        <div
          ref={setBox}
          id={clampId}
          className={cn(
            clampClass,
            "text-fg-muted text-[length:calc(var(--research-compact-font-size)+1px)] leading-(--research-compact-line-height) [overflow-wrap:anywhere] whitespace-pre-wrap",
          )}
        >
          <RowGlyph
            kind="exchange"
            state="queued"
            className="float-left mt-[calc((1lh-14px)/2)] mr-1.5"
          />
          {item.message.text}
        </div>
        <MessageImages attachments={item.message.attachments ?? []} className="mt-2" />
      </div>
      {overflows ? (
        <TileToggle
          controls={clampId}
          expanded={expanded}
          tabIndex={selected ? 0 : -1}
          onToggle={() => onToggleExpanded(item.id)}
        />
      ) : null}
      <div className="text-fg-faint pointer-events-none relative z-[1] flex min-h-7 flex-wrap items-center gap-1 px-3 pt-0.5 pb-1.5 text-[length:calc(12px+var(--font-ui-size-offset))]">
        {failed || stalled ? (
          <span className="bg-status-failed-bg text-status-failed rounded-full px-[7px] py-px font-medium">
            Not sent
          </span>
        ) : (
          <span className="mr-1">Queued</span>
        )}
        <button
          type="button"
          className={cn(
            "text-fg-muted hover:bg-surface-fill-hover hover:text-fg-primary pointer-events-auto rounded-sm px-[5px] py-px",
            FOCUS_RING,
          )}
          aria-label="Cancel this queued message"
          data-research-queue-cancel=""
          disabled={busy}
          onClick={() => onCancel(item)}
        >
          Cancel
        </button>
      </div>
      {failed || stalled ? (
        <p
          className="text-fg-muted pointer-events-none relative z-[1] m-0 pr-2 pl-3 text-[length:calc(12.5px+var(--font-ui-size-offset))]"
          role={failed ? "alert" : undefined}
        >
          {failed ?? "The last answer stopped; retry it, or cancel this question."}
        </p>
      ) : null}
      {failed ? (
        <div className="relative z-[1] mt-1 pr-2 pl-3">
          <button
            type="button"
            className={cn(
              "border-border-control bg-control text-fg-control hover:bg-control-hover inline-flex min-h-[26px] items-center gap-1.5 rounded-md border px-2 text-sm",
              FOCUS_RING,
            )}
            disabled={busy}
            onClick={(event) => onRetry(item, event.currentTarget.closest("li"))}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>Retry</span>
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** What every list of a chain's messages shares. */
export interface ChainRowsShared {
  archived: boolean;
  treeTitle: string;
  nodeById: ReadonlyMap<string, ResearchNode>;
  branchesByParent: ReadonlyMap<string, ResearchNode[]>;
  /** The message whose answer menu is open from its … button. */
  answerMenuOpenId: string | null;
  isUnread: (branch: ResearchNode) => boolean;
  branchStateOf: (nodeId: string) => "running" | "failed" | null;
  expandedTiles: ReadonlySet<string>;
  rowActions: MessageRowActions;
}

/** A chain's messages in display order, then its queue. */
export function ChainRows({
  shared,
  level,
  headId,
  displayIds,
  selectedId,
  openSourceId,
  firstFocusable,
  queue,
}: {
  shared: ChainRowsShared;
  level: number;
  headId: string;
  displayIds: readonly string[];
  selectedId: string | null;
  openSourceId: string | null;
  firstFocusable: boolean;
  queue: QueueProps;
}) {
  const {
    archived,
    treeTitle,
    nodeById,
    branchesByParent,
    answerMenuOpenId,
    isUnread,
    branchStateOf,
  } = shared;
  const dragPlace = !archived && displayIds.length > 1 ? chainDropPlace(headId) : null;
  const selectedRowId = queue.selectedId === null ? selectedId : null;
  return (
    <ul
      className="m-0 list-none py-1.5"
      data-research-drop={chainDropPlace(headId)}
      aria-label="Messages"
    >
      {displayIds.map((id, index) => {
        const node = nodeById.get(id);
        if (!node) return null;
        const branches = branchesByParent.get(id) ?? NO_BRANCHES;
        return (
          <MessageRow
            key={id}
            node={node}
            level={level}
            label={researchNodeLabel(node, treeTitle)}
            showPrompt={nodeMessage(node) !== null}
            selected={selectedRowId === id}
            focusable={firstFocusable && index === 0}
            branchCount={branches.length}
            branchOpen={openSourceId === id}
            branchState={branches.length > 0 ? branchStateOf(id) : null}
            branchUnread={branches.some(isUnread)}
            answerMenuOpen={answerMenuOpenId === id}
            expanded={shared.expandedTiles.has(id)}
            dragPlace={dragPlace}
            actions={shared.rowActions}
          />
        );
      })}
      {queue.items.map((item, index) => (
        <QueuedFollowup
          key={item.id}
          item={item}
          stalled={index === 0 && !item.failedReason && queue.tailStalled}
          selectedId={queue.selectedId}
          busy={queue.busy}
          expanded={shared.expandedTiles.has(item.id)}
          onSelect={queue.onSelect}
          onCancel={queue.onCancel}
          onRetry={queue.onRetry}
          onToggleExpanded={shared.rowActions.onToggleExpanded}
        />
      ))}
    </ul>
  );
}

/** A level's messages column (T{level}). */
export function MessagesColumn({
  column,
  current,
  title,
  history,
  imported,
  shared,
  openSourceId,
  menu,
  source,
  composer,
  queue,
  onScroll,
}: {
  column: Extract<ResearchColumn, { role: "messages" }>;
  current: boolean;
  title: string;
  history: ThreadHistoryNav | null;
  /** The root is a transcript of an imported conversation. */
  imported: boolean;
  shared: ChainRowsShared;
  openSourceId: string | null;
  menu: { label: string; open: boolean; onOpen: (trigger: HTMLButtonElement) => void } | null;
  source: BranchSourceProps | null;
  composer: ReactNode;
  queue: QueueProps;
  onScroll: ((event: UIEvent<HTMLElement>) => void) | undefined;
}) {
  const { index: level, chainIds, displayIds, headId, selectedId } = column.level;
  return (
    <section
      className={cn(
        "research-pair-messages relative flex h-full w-(--research-messages-width) min-w-0 shrink-0 flex-col",
        "border-border-strong border-r border-l border-r-[var(--surface-divider)] bg-[var(--research-feed-bg)]",
        current && "is-current",
      )}
      {...columnAttributes(column)}
      aria-label={`${level === 0 ? "Messages" : "Branch messages"}: ${title}`}
    >
      <PairHeader
        title={title}
        branch={level === 0 ? null : chainIds.length}
        history={history}
        imported={imported}
        menu={menu}
        archived={level === 0 && shared.archived}
        current={current}
        spanned
      />
      <div className={COLUMN_SCROLL} data-research-scroll="" onScroll={onScroll}>
        <div className="research-column-content research-reading-surface">
          {source ? <BranchSource {...source} /> : null}
          <ChainRows
            shared={shared}
            level={level}
            headId={headId}
            displayIds={displayIds}
            selectedId={selectedId}
            openSourceId={openSourceId}
            firstFocusable={false}
            queue={queue}
          />
          {composer}
        </div>
      </div>
      <ColumnResizer kind="messages" label="Resize messages column" belowHeader />
    </section>
  );
}
