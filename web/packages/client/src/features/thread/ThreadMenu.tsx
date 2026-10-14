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
import { ArrowUpRight, Copy, Files, Pencil, RefreshCw, ScrollText, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useNodeContent } from "../../api/queries.js";
import { cn } from "../../lib/cn.js";
import { POPOVER_SURFACE } from "../../ui/surfaces.js";

import { RerunMenuItem } from "./RerunMenuItem.js";
import { ThreadMenuItem, ThreadMenuMeta, ThreadMenuSeparator } from "./ThreadMenuItem.js";
import { BranchIcon } from "./icons.js";
import { runActive } from "./runState.js";
import { buildSegmentView, type SegmentView } from "./segmentView.js";

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
  actions: ThreadMenuActions;
}) {
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
        {highlight ? (
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
            <ThreadMenuItem
              icon={<X size={15} aria-hidden="true" />}
              label="Remove highlight"
              onSelect={() => {
                onClose();
                actions.onRemoveHighlight(menu.nodeId, highlight.id);
              }}
            />
          </>
        ) : null}
      </MenuFrame>
    );
  }
  if (menu.kind === "post") {
    const isRoot = node.id === rootNodeId;
    const info = isRoot ? null : branchInfo(nodes, node.id);
    return (
      <MenuFrame anchor={menu.anchor} label="Note actions" onClose={onClose}>
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
        <ThreadMenuItem
          icon={<Copy size={15} aria-hidden="true" />}
          label="Copy note"
          onSelect={() => {
            onClose();
            actions.onCopyNote(node.id);
          }}
        />
        {info || isRoot ? (
          <>
            <ThreadMenuSeparator />
            <ThreadMenuItem
              icon={<Trash2 size={15} aria-hidden="true" />}
              label={isRoot ? "Delete research" : "Delete note"}
              shortcut="D"
              danger
              disabled={Boolean(info?.hasActiveRuns)}
              title={
                info?.hasActiveRuns
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
  const canGenerateRecap = Boolean(
    !archived &&
    content?.responseRevision &&
    nodeStatus(node) === "complete" &&
    node.type === "exchange",
  );
  const run = nodeRun(node);
  const active = runActive(node);
  const durationText =
    view.isConversation || active || !run || run.status === "cancelled" || !run.startedAt
      ? null
      : `${run.status === "complete" ? "" : "Ran for "}${formatRunDuration(
          (run.completedAt ?? run.startedAt) - run.startedAt,
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
  const recap = nodeRecap(node);
  return (
    <MenuFrame anchor={menu.anchor} label="Answer actions" onClose={onClose}>
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
        archived={archived}
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
          title={recap?.text.trim() ? "Write a new recap of this answer" : undefined}
          onSelect={() => {
            onClose();
            actions.onGenerateRecap(node.id);
          }}
        />
      ) : null}
      {isRoot || !node.inline ? (
        <ThreadMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Rename…"
          onSelect={() => {
            onClose();
            actions.onRename(node.id, isRoot ? treeTitle : (node.title ?? nodePrompt(node)).trim());
          }}
        />
      ) : null}
      {isRoot && documentHoldsMarkdown(node) ? (
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
      <ThreadMenuSeparator />
      <ThreadMenuItem
        icon={<Trash2 size={15} aria-hidden="true" />}
        label={deleteLabel}
        danger
        disabled={info.hasActiveRuns}
        title={
          info.hasActiveRuns ? "This branch must finish or be cancelled before deletion" : undefined
        }
        onSelect={() => {
          onClose();
          actions.onDelete(node.id);
        }}
      />
    </MenuFrame>
  );
}
