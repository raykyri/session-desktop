// The thread page's menus (`09-research-document-view.md` §8), ported from
// the desktop `ResearchThreadMenu.tsx`: a message's answer menu (its …
// button or context menu), a note's menu, and the menu of a passage that
// carries several branches or a highlight. Each item closes the menu before
// it acts; the page owns what the actions change.

import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ResearchHighlightAnchor, ResearchNode } from "@session/shared";
import { findModel, nodeModelId } from "@session/shared";
import { researchBranchInfo } from "@session/shared/lib/researchBranches";
import { inlineChainFor } from "@session/shared/lib/researchChains";
import {
  documentHoldsMarkdown,
  documentSource,
  nodePrompt,
  nodeRecap,
  nodeRun,
  nodeStatus,
} from "@session/shared/lib/researchNodeTypes";
import { researchNoteEditable } from "@session/shared/lib/researchNoteEdit";
import {
  researchBranchBlocker,
  researchDeleteLabel,
  researchNodeLabel,
} from "@session/shared/lib/researchThreadView";
import { formatRunDuration } from "@session/shared/lib/shortTime";
import {
  ArrowUpRight,
  Bell,
  BellOff,
  Copy,
  Files,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { useMemo } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useNodeContent } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { POPOVER_SURFACE } from "../../ui/surfaces.js";
import { MoveToItems } from "../home/TreeMenu.js";
import { AuthorChip } from "../sharing/AuthorChip.js";
import { useThreadCollaboration } from "../sharing/context.js";
import {
  mayChangeNode,
  mayEditText,
  mayRelaunch,
  mayRemoveHighlight,
  type ThreadPermissions,
} from "../sharing/permissions.js";

import { RerunMenuItem } from "./RerunMenuItem.js";
import { ThreadMenuItem, ThreadMenuMeta, ThreadMenuSeparator } from "./ThreadMenuItem.js";
import { BranchIcon } from "./icons.js";
import { runActive } from "./runState.js";
import { buildSegmentView, type SegmentView } from "./segmentView.js";
import { rowSelector } from "./stripDom.js";
import type { ThreadTreeMenu } from "./useThreadFiling.js";

/** Where a menu opens: below a button (its trigger, where focus returns), or
 * at a point (a context menu). */
export type ThreadMenuAnchor =
  { kind: "element"; element: HTMLElement } | { kind: "point"; x: number; y: number };

export type ThreadMenuState =
  | { kind: "answer"; nodeId: string; anchor: ThreadMenuAnchor }
  | { kind: "post"; nodeId: string; anchor: ThreadMenuAnchor }
  | {
      kind: "mark";
      nodeId: string;
      branchIds: string[];
      highlightId: string | null;
      anchor: ThreadMenuAnchor;
    };

/** The deletion facts of a message and what follows it. Active runs are
 * read as the server reads them (`runState.ts`). */
export function branchInfo(nodes: ResearchNode[], nodeId: string) {
  const info = researchBranchInfo(nodes, nodeId);
  if (!info) return null;
  const ids = new Set(info.nodeIds);
  return { ...info, hasActiveRuns: nodes.some((node) => ids.has(node.id) && runActive(node)) };
}

function virtualAnchor(anchor: ThreadMenuAnchor) {
  if (anchor.kind === "element") return anchor.element;
  return {
    getBoundingClientRect: () =>
      DOMRect.fromRect({ x: anchor.x, y: anchor.y, width: 0, height: 0 }),
  };
}

function MenuFrame({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: ThreadMenuAnchor;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    const item = event.currentTarget.querySelector<HTMLElement>(
      `[data-shortcut="${event.key.toLowerCase()}"]:not([data-disabled])`,
    );
    if (item) {
      event.preventDefault();
      item.click();
    }
  };
  return (
    <BaseMenu.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          anchor={virtualAnchor(anchor)}
          side="bottom"
          align={anchor.kind === "element" ? "end" : "start"}
          sideOffset={anchor.kind === "element" ? 4 : 0}
          className="z-(--z-popover)"
        >
          <BaseMenu.Popup
            className={cn(POPOVER_SURFACE, "min-w-52 rounded-lg p-1")}
            aria-label={label}
            finalFocus={anchor.kind === "element" ? { current: anchor.element } : true}
            onKeyDown={onKeyDown}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export interface ThreadMenuActions {
  onClose: () => void;
  onOpenBranch: (parentNodeId: string, branchId: string) => void;
  onBranch: (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => void;
  onRemoveHighlight: (nodeId: string, highlightId: string) => void;
  /** Opens the editor column; `trigger` is where focus returns. */
  onEdit: (nodeId: string, trigger: HTMLElement | null) => void;
  onToggleFullTrace: (nodeId: string) => void;
  onCopyAnswer: (view: SegmentView) => void;
  onCopyNote: (nodeId: string) => void;
  onCopyThread: (chainIds: string[]) => void;
  onRerun: (nodeId: string) => void;
  onGenerateRecap: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
  /** Opens the Share dialog (web only). */
  onShare?: () => void;
  /** Turns Notify me on or off (web only). */
  onToggleFollow?: () => void;
}

/** The thread-level items of the root's menus (web only): Share… and Notify
 * me. Nothing for a guest. */
function ThreadSharingItems({
  permissions,
  followed,
  actions,
}: {
  permissions: ThreadPermissions;
  followed: boolean;
  actions: ThreadMenuActions;
}) {
  const { onClose, onShare, onToggleFollow } = actions;
  if (!permissions.canFollow || (!onShare && !onToggleFollow)) return null;
  return (
    <>
      {onShare ? (
        <ThreadMenuItem
          icon={<UserPlus size={15} aria-hidden="true" />}
          label="Share…"
          onSelect={() => {
            onClose();
            onShare();
          }}
        />
      ) : null}
      {onToggleFollow ? (
        <ThreadMenuItem
          icon={
            followed ? (
              <BellOff size={15} aria-hidden="true" />
            ) : (
              <Bell size={15} aria-hidden="true" />
            )
          }
          label={followed ? "Stop notifying me" : "Notify me"}
          title={
            followed
              ? "Stop notifications for new questions and notes in this thread"
              : "Get a notification for new questions and notes in this thread"
          }
          onSelect={() => {
            onClose();
            onToggleFollow();
          }}
        />
      ) : null}
      <ThreadMenuSeparator />
    </>
  );
}

/** The whole thread's Move to, below the root level's answer menus and the
 * root note's menu (the desktop's `ResearchTreeMenuItems`). `fallbackFocus`
 * is where focus returns from the folder dialog when the menu was opened at
 * a point. */
function TreeMoveItems({
  treeMenu,
  trigger,
  fallbackFocus,
  onClose,
}: {
  treeMenu: ThreadTreeMenu;
  trigger: HTMLElement | null;
  fallbackFocus: () => HTMLElement | null;
  onClose: () => void;
}) {
  return (
    <>
      <ThreadMenuSeparator />
      <MoveToItems
        currentPlace={treeMenu.currentPlace}
        folders={treeMenu.folders}
        onMove={(place) => {
          onClose();
          treeMenu.onMove(place);
        }}
        onNewFolder={() => {
          onClose();
          treeMenu.onNewFolder(trigger ?? fallbackFocus());
        }}
      />
    </>
  );
}

export function ThreadMenu({
  menu,
  nodes,
  nodeById,
  rootNodeId,
  treeTitle,
  archived,
  hiddenHighlights,
  fullTrace,
  openBranchIds,
  relaunchPending,
  followed = false,
  treeMenu,
  actions,
}: {
  menu: ThreadMenuState;
  nodes: ResearchNode[];
  nodeById: ReadonlyMap<string, ResearchNode>;
  rootNodeId: string;
  treeTitle: string;
  archived: boolean;
  hiddenHighlights: number;
  fullTrace: boolean;
  openBranchIds: ReadonlySet<string>;
  relaunchPending: boolean;
  /** The reader follows the thread (Notify me is on). */
  followed?: boolean;
  /** Move to and New folder… for the whole thread (web: the reader's own
   * thread only). */
  treeMenu?: ThreadTreeMenu | undefined;
  actions: ThreadMenuActions;
}) {
  const { permissions } = useThreadCollaboration();
  const node = nodeById.get(menu.nodeId) ?? null;
  if (!node) return null;
  const trigger = menu.anchor.kind === "element" ? menu.anchor.element : null;
  const { onClose } = actions;
  if (menu.kind === "mark") {
    const highlight = menu.highlightId
      ? (node.highlights.find((item) => item.id === menu.highlightId) ?? null)
      : null;
    const blocker = researchBranchBlocker(node, archived);
    return (
      <MenuFrame anchor={menu.anchor} label="Passage" onClose={onClose}>
        {highlight?.authorId ? (
          <ThreadMenuMeta>
            <AuthorChip authorId={highlight.authorId} prefix="Highlighted by" />
          </ThreadMenuMeta>
        ) : null}
        {menu.branchIds.map((branchId) => (
          <ThreadMenuItem
            key={branchId}
            icon={<ArrowUpRight size={15} aria-hidden="true" />}
            label={researchNodeLabel(nodeById.get(branchId), "Branch")}
            current={openBranchIds.has(branchId)}
            onSelect={() => {
              onClose();
              actions.onOpenBranch(menu.nodeId, branchId);
            }}
          />
        ))}
        {highlight && permissions.contributor ? (
          <>
            <ThreadMenuItem
              icon={<BranchIcon size={15} />}
              label="Branch to right"
              disabled={blocker !== null}
              title={blocker ?? undefined}
              onSelect={() => {
                onClose();
                actions.onBranch(menu.nodeId, highlight.anchor);
              }}
            />
            {mayRemoveHighlight(permissions, highlight) ? (
              <ThreadMenuItem
                icon={<X size={15} aria-hidden="true" />}
                label="Remove highlight"
                onSelect={() => {
                  onClose();
                  actions.onRemoveHighlight(menu.nodeId, highlight.id);
                }}
              />
            ) : null}
          </>
        ) : null}
      </MenuFrame>
    );
  }
  if (menu.kind === "post") {
    const isRoot = node.id === rootNodeId;
    const info = isRoot ? null : branchInfo(nodes, node.id);
    const owner = permissions.isOwner;
    // In the Archive the owner keeps seeing the items, disabled, as on the
    // desktop; a commenter sees what they may change.
    const editsText = archived ? owner : mayEditText(permissions, nodes, node);
    const deletes = owner || (!isRoot && mayChangeNode(permissions, nodes, node));
    return (
      <MenuFrame anchor={menu.anchor} label="Note actions" onClose={onClose}>
        {isRoot ? (
          <ThreadSharingItems permissions={permissions} followed={followed} actions={actions} />
        ) : null}
        {editsText ? (
          <ThreadMenuItem
            icon={<Pencil size={15} aria-hidden="true" />}
            label="Edit note"
            disabled={!researchNoteEditable(node, archived)}
            title={
              !archived
                ? undefined
                : isRoot
                  ? "Move this note out of Archive to edit it"
                  : "Move this thread out of Archive to edit its notes"
            }
            onSelect={() => {
              onClose();
              actions.onEdit(node.id, trigger);
            }}
          />
        ) : null}
        <ThreadMenuItem
          icon={<Copy size={15} aria-hidden="true" />}
          label="Copy note"
          onSelect={() => {
            onClose();
            actions.onCopyNote(node.id);
          }}
        />
        {/* The root note is the thread: it is deleted with the thread, from
            Home, as on the desktop. */}
        {info && deletes ? (
          <>
            <ThreadMenuSeparator />
            <ThreadMenuItem
              icon={<Trash2 size={15} aria-hidden="true" />}
              label="Delete note"
              shortcut="D"
              danger
              disabled={info.hasActiveRuns}
              title={
                info.hasActiveRuns
                  ? "Finish or cancel all follow-ups before deleting this note"
                  : undefined
              }
              onSelect={() => {
                onClose();
                actions.onDelete(node.id);
              }}
            />
          </>
        ) : null}
        {treeMenu && isRoot ? (
          <TreeMoveItems
            treeMenu={treeMenu}
            trigger={trigger}
            fallbackFocus={() => null}
            onClose={onClose}
          />
        ) : null}
      </MenuFrame>
    );
  }
  return (
    <AnswerMenu
      node={node}
      trigger={trigger}
      menu={menu}
      nodes={nodes}
      nodeById={nodeById}
      rootNodeId={rootNodeId}
      treeTitle={treeTitle}
      archived={archived}
      hiddenHighlights={hiddenHighlights}
      fullTrace={fullTrace}
      relaunchPending={relaunchPending}
      followed={followed}
      treeMenu={treeMenu}
      permissions={permissions}
      actions={actions}
    />
  );
}

function AnswerMenu({
  node,
  trigger,
  menu,
  nodes,
  nodeById,
  rootNodeId,
  treeTitle,
  archived,
  hiddenHighlights,
  fullTrace,
  relaunchPending,
  followed,
  treeMenu,
  permissions,
  actions,
}: {
  node: ResearchNode;
  trigger: HTMLElement | null;
  menu: ThreadMenuState;
  nodes: ResearchNode[];
  nodeById: ReadonlyMap<string, ResearchNode>;
  rootNodeId: string;
  treeTitle: string;
  archived: boolean;
  hiddenHighlights: number;
  fullTrace: boolean;
  relaunchPending: boolean;
  followed: boolean;
  treeMenu: ThreadTreeMenu | undefined;
  permissions: ThreadPermissions;
  actions: ThreadMenuActions;
}) {
  const { onClose } = actions;
  const loaded = useNodeContent(node.id);
  const view = useMemo(
    () =>
      buildSegmentView({
        node,
        content: loaded.content,
        turns: loaded.turns,
        showAllTurns: true,
        showFullTrace: fullTrace,
      }),
    [fullTrace, loaded.content, loaded.turns, node],
  );
  const info = branchInfo(nodes, node.id);
  if (!info) return null;
  const isRoot = node.id === rootNodeId;
  const chainIds = inlineChainFor(nodes, node.id);
  const deleteLabel = researchDeleteLabel(isRoot, node.inline, info.descendantCount);
  const content = loaded.content;
  // Offered only to replace a recap the answer already has, as on the
  // desktop: a new answer gets one automatically.
  const canGenerateRecap = Boolean(
    !archived &&
    permissions.canContribute &&
    content?.responseRevision &&
    (nodeRecap(node) ?? nodeRecap(content.node))?.text.trim(),
  );
  const run = nodeRun(node);
  const active = runActive(node);
  const durationText =
    view.isConversation || active || !run || run.status === "cancelled" || !run.startedAt
      ? null
      : `${run.status === "complete" ? "" : "Ran for "}${formatRunDuration(
          // A settled run without a completion time is measured up to this
          // render, as on the desktop.
          // eslint-disable-next-line react-hooks/purity -- the menu has no clock of its own
          (run.completedAt ?? Date.now()) - run.startedAt,
        )}`;
  const stats = [
    nodeStatus(node) === "complete" && content
      ? `${view.answerWordCount.toLocaleString()} ${view.answerWordCount === 1 ? "word" : "words"}`
      : null,
    durationText,
    documentSource(node) === "imported" || node.type !== "exchange"
      ? null
      : (findModel(nodeModelId(node))?.label ?? null),
  ]
    .filter(Boolean)
    .join(" · ");
  const revealsHighlights = hiddenHighlights > 0 && view.hasTranscriptActivity && !fullTrace;
  const copyText =
    nodeStatus(node) === "complete" ? (view.conversationCopyText ?? view.rawAnswer) : null;
  const branchBlocker = researchBranchBlocker(node, archived);
  const owner = permissions.isOwner;
  const renames = owner || (!isRoot && mayChangeNode(permissions, nodes, node));
  const deletes = owner || (!isRoot && mayChangeNode(permissions, nodes, node));
  return (
    <MenuFrame anchor={menu.anchor} label="Answer actions" onClose={onClose}>
      {isRoot ? (
        <ThreadSharingItems permissions={permissions} followed={followed} actions={actions} />
      ) : null}
      {stats || hiddenHighlights > 0 ? (
        <div>
          {stats ? <ThreadMenuMeta>{stats}</ThreadMenuMeta> : null}
          {hiddenHighlights > 0 ? (
            <ThreadMenuMeta title="These saved highlights aren't in the current view. They may refer to content that isn't currently displayed.">
              {hiddenHighlights} {hiddenHighlights === 1 ? "highlight" : "highlights"} not visible
              in this view
            </ThreadMenuMeta>
          ) : null}
        </div>
      ) : null}
      {revealsHighlights ? (
        <ThreadMenuItem
          icon={<ScrollText size={15} aria-hidden="true" />}
          label="Show full transcript"
          onSelect={() => {
            onClose();
            actions.onToggleFullTrace(node.id);
          }}
        />
      ) : null}
      {stats || hiddenHighlights > 0 ? <ThreadMenuSeparator /> : null}
      {permissions.contributor ? (
        <ThreadMenuItem
          icon={<BranchIcon size={15} />}
          label="Branch to right"
          disabled={branchBlocker !== null}
          title={branchBlocker ?? undefined}
          onSelect={() => {
            onClose();
            actions.onBranch(node.id, null);
          }}
        />
      ) : null}
      {copyText ? (
        <ThreadMenuItem
          icon={<Copy size={15} aria-hidden="true" />}
          label={view.isConversation ? "Copy conversation as Markdown" : "Copy answer as Markdown"}
          onSelect={() => {
            onClose();
            actions.onCopyAnswer(view);
          }}
        />
      ) : null}
      {chainIds.length > 1 ? (
        <ThreadMenuItem
          icon={<Files size={15} aria-hidden="true" />}
          label="Copy thread as Markdown"
          onSelect={() => {
            onClose();
            actions.onCopyThread(chainIds);
          }}
        />
      ) : null}
      {view.hasTranscriptActivity && !revealsHighlights ? (
        <ThreadMenuItem
          icon={<ScrollText size={15} aria-hidden="true" />}
          label={fullTrace ? "Hide full transcript" : "Show full transcript"}
          onSelect={() => {
            onClose();
            actions.onToggleFullTrace(node.id);
          }}
        />
      ) : null}
      <RerunMenuItem
        node={node}
        parent={node.parentNodeId ? (nodeById.get(node.parentNodeId) ?? null) : null}
        archived={archived || !mayRelaunch(permissions, node)}
        pending={relaunchPending}
        onRerun={() => {
          onClose();
          actions.onRerun(node.id);
        }}
      />
      {canGenerateRecap ? (
        <ThreadMenuItem
          icon={<RefreshCw size={15} aria-hidden="true" />}
          label="Generate recap"
          onSelect={() => {
            onClose();
            actions.onGenerateRecap(node.id);
          }}
        />
      ) : null}
      {(isRoot || !node.inline) && renames ? (
        <ThreadMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Rename…"
          onSelect={() => {
            onClose();
            actions.onRename(node.id, isRoot ? treeTitle : (node.title ?? nodePrompt(node)).trim());
          }}
        />
      ) : null}
      {isRoot && documentHoldsMarkdown(node) && owner ? (
        <ThreadMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Edit document"
          disabled={archived || !content?.responseRevision || view.editableDocumentMarkdown == null}
          title={
            archived
              ? "Move this question out of Archive to edit its document"
              : !content?.responseRevision || view.editableDocumentMarkdown == null
                ? "The document content is unavailable"
                : undefined
          }
          onSelect={() => {
            onClose();
            actions.onEdit(node.id, trigger);
          }}
        />
      ) : null}
      {deletes ? (
        <>
          <ThreadMenuSeparator />
          <ThreadMenuItem
            icon={<Trash2 size={15} aria-hidden="true" />}
            label={deleteLabel}
            danger
            disabled={info.hasActiveRuns}
            title={
              info.hasActiveRuns
                ? "This branch must finish or be cancelled before deletion"
                : undefined
            }
            onSelect={() => {
              onClose();
              actions.onDelete(node.id);
            }}
          />
        </>
      ) : null}
      {treeMenu && chainIds[0] === rootNodeId ? (
        <TreeMoveItems
          treeMenu={treeMenu}
          trigger={trigger}
          fallbackFocus={() => document.querySelector<HTMLElement>(rowSelector(node.id))}
          onClose={onClose}
        />
      ) : null}
    </MenuFrame>
  );
}
