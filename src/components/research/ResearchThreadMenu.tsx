import {
  ArrowUpRight,
  Copy,
  Files,
  Pencil,
  RefreshCw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { researchBranchInfo } from "../../lib/researchBranches";
import { inlineChainFor, isActiveResearchStatus } from "../../lib/researchChains";
import { formatResearchModelSummary } from "../../lib/researchModelSummary";
import { researchNoteEditable } from "../../lib/researchNoteEdit";
import {
  documentHoldsMarkdown,
  documentSource,
  nodeAdapter,
  nodeAgent,
  nodePrompt,
  nodeRecap,
  nodeRun,
  nodeStatus,
} from "../../lib/researchNodeTypes";
import type { SegmentView } from "../../lib/researchSegmentView";
import { researchBranchBlocker, researchDeleteLabel, researchNodeLabel } from "../../lib/researchThreadView";
import { formatRunDuration } from "../../lib/shortTime";
import type { ResearchHighlightAnchor, ResearchNode, ResearchNodeContent } from "../../types";
import { ResearchBranchIcon } from "./ResearchIcons";
import {
  ResearchMenu,
  ResearchMenuItem,
  ResearchMenuMeta,
  ResearchMenuSeparator,
  type ResearchMenuAlign,
  type ResearchMenuRect,
} from "./ResearchMenu";
import { ResearchTreeMenuItems, type ResearchTreeMenuProps } from "./ResearchMoveMenu";
import { ResearchRerunMenuItem } from "./ResearchRerunMenuItem";

/** The whole question's Move to actions, which the root level's answer
 * menus and the root note's menu list below their own. */
export interface ResearchThreadTreeMenu
  extends Omit<ResearchTreeMenuProps, "onMove" | "onNewFolder"> {
  onMove: (place: string) => void;
  /** `trigger` is where focus returns when the folder dialog closes. */
  onNewFolder: (trigger: HTMLElement | undefined) => void;
}

interface ThreadMenuPlacement {
  anchor: HTMLElement | ResearchMenuRect;
  align: ResearchMenuAlign;
  /** The button that opened the menu: focus returns to it when it closes. */
  trigger?: HTMLElement | null;
}

/** The thread page's open menu: a message's answer menu (its … button or
 * context menu), a note's menu (the root note or a follow-up note), or the
 * menu of a passage that carries several branches or a highlight. */
export type ThreadMenuState =
  | ({ kind: "answer"; nodeId: string } & ThreadMenuPlacement)
  | ({ kind: "post"; nodeId: string } & ThreadMenuPlacement)
  | ({
      kind: "mark";
      nodeId: string;
      branchIds: string[];
      highlightId: string | null;
    } & ThreadMenuPlacement);

/** The thread page's menus. Each item closes the menu (`onClose`) before it
 * acts; the page owns what the actions change. */
export function ResearchThreadMenu({
  menu,
  nodes,
  nodeById,
  treeNodes,
  rootNodeId,
  treeTitle,
  archived,
  treeMenu,
  content,
  view,
  hiddenHighlights,
  fullTrace,
  openBranchIds,
  relaunchPending,
  isPassagePress,
  onClose,
  onOpenBranch,
  onBranch,
  onRemoveHighlight,
  onEdit,
  onShowFullTrace,
  onToggleFullTrace,
  onCopyAnswer,
  onCopyNote,
  onCopyThread,
  onRerun,
  onGenerateRecap,
  onRename,
  onDelete,
}: {
  menu: ThreadMenuState;
  /** The tree's nodes with the ones created a moment ago. */
  nodes: ResearchNode[];
  nodeById: ReadonlyMap<string, ResearchNode>;
  /** The tree detail's nodes, which deletion counts. */
  treeNodes: ResearchNode[];
  rootNodeId: string;
  treeTitle: string;
  archived: boolean;
  treeMenu?: ResearchThreadTreeMenu;
  /** The menu's message's loaded answer and its view, when loaded. */
  content: ResearchNodeContent | null;
  view: SegmentView | null;
  /** Saved highlights of the answer that did not resolve in the view. */
  hiddenHighlights: number;
  /** The answer shows its full transcript. */
  fullTrace: boolean;
  openBranchIds: ReadonlySet<string>;
  /** A retry or rerun request is in flight. */
  relaunchPending: boolean;
  /** Whether a press targets the passage that opened the passage menu. */
  isPassagePress: (
    event: MouseEvent,
    passage: { nodeId: string; branchIds: string[]; highlightId: string | null },
  ) => boolean;
  onClose: () => void;
  onOpenBranch: (parentNodeId: string, branchId: string) => void;
  onBranch: (parentNodeId: string, anchor: ResearchHighlightAnchor | null) => void;
  onRemoveHighlight: (nodeId: string, highlightId: string) => void;
  /** Opens the editor column; `trigger` is where focus returns. */
  onEdit: (nodeId: string, trigger: HTMLElement | null) => void;
  onShowFullTrace: (nodeId: string) => void;
  onToggleFullTrace: (nodeId: string) => void;
  onCopyAnswer: (view: SegmentView) => void;
  /** Copies a note's text. */
  onCopyNote: (nodeId: string) => void;
  onCopyThread: (chainIds: string[]) => void;
  onRerun: (nodeId: string) => void;
  onGenerateRecap: (nodeId: string) => void;
  onRename: (nodeId: string, title: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  const menuNode = nodeById.get(menu.nodeId) ?? null;
  if (!menuNode) {
    return null;
  }
  if (menu.kind === "mark") {
    const highlight = menu.highlightId
      ? (content?.node.highlights ?? []).find((item) => item.id === menu.highlightId) ?? null
      : null;
    const blocker = researchBranchBlocker(menuNode, archived);
    return (
      <ResearchMenu
        anchor={menu.anchor}
        align={menu.align}
        trigger={menu.trigger}
        isTriggerPress={(event) => isPassagePress(event, menu)}
        label="Passage"
        compact
        onClose={onClose}
      >
        {menu.branchIds.map((branchId) => (
          <ResearchMenuItem
            key={branchId}
            icon={<ArrowUpRight size={15} aria-hidden="true" />}
            label={researchNodeLabel(nodeById.get(branchId), "Branch")}
            current={openBranchIds.has(branchId)}
            onSelect={() => {
              onClose();
              onOpenBranch(menu.nodeId, branchId);
            }}
          />
        ))}
        {highlight ? (
          <>
            <ResearchMenuItem
              icon={<ResearchBranchIcon size={15} />}
              label="Branch to right"
              disabled={blocker !== null}
              title={blocker ?? undefined}
              onSelect={() => onBranch(menu.nodeId, highlight.anchor)}
            />
            <ResearchMenuItem
              icon={<X size={15} aria-hidden="true" />}
              label="Remove highlight"
              onSelect={() => {
                onClose();
                onRemoveHighlight(menu.nodeId, highlight.id);
              }}
            />
          </>
        ) : null}
      </ResearchMenu>
    );
  }
  if (menu.kind === "post") {
    const post = menuNode;
    // The root note stands for the thread: it has the thread's Move to, and
    // is deleted with the thread. A follow-up note is deleted on its own.
    const isRoot = post.id === rootNodeId;
    const info = isRoot ? null : researchBranchInfo(treeNodes, post.id);
    return (
      <ResearchMenu
        anchor={menu.anchor}
        align={menu.align}
        trigger={menu.trigger}
        label="Note actions"
        onClose={onClose}
      >
        <ResearchMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Edit note"
          disabled={!researchNoteEditable(post, archived)}
          title={
            !archived
              ? undefined
              : isRoot
                ? "Move this note out of Archive to edit it"
                : "Move this thread out of Archive to edit its notes"
          }
          onSelect={() => {
            const trigger = menu.trigger ?? null;
            onClose();
            onEdit(post.id, trigger);
          }}
        />
        <ResearchMenuItem
          icon={<Copy size={15} aria-hidden="true" />}
          label="Copy note"
          onSelect={() => {
            onClose();
            onCopyNote(post.id);
          }}
        />
        {info ? (
          <>
            <ResearchMenuSeparator />
            <ResearchMenuItem
              icon={<Trash2 size={15} aria-hidden="true" />}
              label="Delete note"
              shortcut="D"
              danger
              disabled={info.hasActiveRuns}
              title={info.hasActiveRuns ? "Its follow-ups must finish or be cancelled before deletion" : undefined}
              onSelect={() => {
                onClose();
                onDelete(post.id);
              }}
            />
          </>
        ) : null}
        {treeMenu && isRoot ? (
          <>
            <ResearchMenuSeparator />
            <ResearchTreeMenuItems
              currentPlace={treeMenu.currentPlace}
              folders={treeMenu.folders}
              onMove={(place) => {
                onClose();
                treeMenu.onMove(place);
              }}
              onNewFolder={() => {
                onClose();
                treeMenu.onNewFolder(menu.trigger ?? undefined);
              }}
            />
          </>
        ) : null}
      </ResearchMenu>
    );
  }
  const node = menuNode;
  const info = researchBranchInfo(treeNodes, node.id);
  if (!info) {
    return null;
  }
  const isRoot = node.id === rootNodeId;
  const chainIds = inlineChainFor(nodes, node.id);
  const deleteLabel = researchDeleteLabel(isRoot, node.inline, info.descendantCount);
  const canRegenerateRecap = Boolean(
    !archived && content?.responseRevision && nodeRecap(content.node)?.text.trim(),
  );
  const active = isActiveResearchStatus(nodeStatus(node));
  // A cancelled turn already says how long it ran ("Stopped after"). A run
  // without a completion time is measured up to this render; the menu
  // carries no clock of its own.
  const run = nodeRun(node);
  const durationText =
    view?.isConversation || active || !run || run.status === "cancelled" || !run.startedAt
      ? null
      : `${run.status === "complete" ? "" : "Ran for "}${formatRunDuration(
          (run.completedAt ?? Date.now()) - run.startedAt,
        )}`;
  const stats = [
    nodeStatus(node) === "complete" && view
      ? `${view.answerWordCount.toLocaleString()} ${view.answerWordCount === 1 ? "word" : "words"}`
      : null,
    durationText,
    // Provenance: an imported report has no model to name.
    documentSource(node) === "imported"
      ? null
      : formatResearchModelSummary(nodeAdapter(node), nodeAgent(node)?.model) || null,
  ]
    .filter(Boolean)
    .join(" · ");
      // What can hide a run's passage sits behind the answer fold; a
  // conversation has no fold and hides only windowed-off turns.
  const revealsHighlights = hiddenHighlights > 0 && Boolean(view?.hasTranscriptActivity) && !fullTrace;
  const copyText = nodeStatus(node) === "complete" ? view?.conversationCopyText ?? view?.rawAnswer : null;
  const branchBlocker = researchBranchBlocker(node, archived);
  return (
    <ResearchMenu
      anchor={menu.anchor}
      align={menu.align}
      trigger={menu.trigger}
      label="Answer actions"
      describedBy={stats || hiddenHighlights > 0 ? "research-answer-menu-meta" : undefined}
      // Retry hides the … button (a queued run has no answer yet).
      fallbackFocus={() =>
        document.querySelector<HTMLElement>(
          `[data-research-row][data-node-id="${CSS.escape(node.id)}"]`,
        )
      }
      onClose={onClose}
    >
      {stats || hiddenHighlights > 0 ? (
        <div id="research-answer-menu-meta">
          {stats ? <ResearchMenuMeta>{stats}</ResearchMenuMeta> : null}
          {hiddenHighlights > 0 ? (
            <ResearchMenuMeta title="These saved highlights aren't in the current view. They may refer to content that isn't currently displayed.">
              {hiddenHighlights} {hiddenHighlights === 1 ? "highlight" : "highlights"} not visible in this view
            </ResearchMenuMeta>
          ) : null}
        </div>
      ) : null}
      {revealsHighlights ? (
        <ResearchMenuItem
          icon={<ScrollText size={15} aria-hidden="true" />}
          label="Show full transcript"
          onSelect={() => {
            onClose();
            onShowFullTrace(node.id);
          }}
        />
      ) : null}
      {stats || hiddenHighlights > 0 ? <ResearchMenuSeparator /> : null}
      <ResearchMenuItem
        icon={<ResearchBranchIcon size={15} />}
        label="Branch to right"
        disabled={branchBlocker !== null}
        title={branchBlocker ?? undefined}
        onSelect={() => onBranch(node.id, null)}
      />
      {copyText && view ? (
        <ResearchMenuItem
          icon={<Copy size={15} aria-hidden="true" />}
          label={view.isConversation ? "Copy conversation as Markdown" : "Copy answer as Markdown"}
          onSelect={() => {
            onClose();
            onCopyAnswer(view);
          }}
        />
      ) : null}
      {chainIds.length > 1 ? (
        <ResearchMenuItem
          icon={<Files size={15} aria-hidden="true" />}
          label="Copy thread as Markdown"
          onSelect={() => {
            onClose();
            onCopyThread(chainIds);
          }}
        />
      ) : null}
      {view?.hasTranscriptActivity && !revealsHighlights ? (
        <ResearchMenuItem
          icon={<ScrollText size={15} aria-hidden="true" />}
          label={fullTrace ? "Hide full transcript" : "Show full transcript"}
          onSelect={() => {
            onClose();
            onToggleFullTrace(node.id);
          }}
        />
      ) : null}
      <ResearchRerunMenuItem
        node={node}
        parent={nodeById.get(node.parentNodeId ?? "") ?? null}
        archived={archived}
        pending={relaunchPending}
        onRerun={() => {
          onClose();
          onRerun(node.id);
        }}
      />
      {canRegenerateRecap ? (
        <ResearchMenuItem
          icon={<RefreshCw size={15} aria-hidden="true" />}
          label="Generate recap"
          onSelect={() => {
            onClose();
            onGenerateRecap(node.id);
          }}
        />
      ) : null}
      {isRoot || !node.inline ? (
        <ResearchMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Rename…"
          onSelect={() => {
            onClose();
            onRename(node.id, isRoot ? treeTitle : (node.title ?? nodePrompt(node)).trim());
          }}
        />
      ) : null}
      {/* Only an imported or authored document holds editable Markdown. */}
      {isRoot && documentHoldsMarkdown(node) ? (
        <ResearchMenuItem
          icon={<Pencil size={15} aria-hidden="true" />}
          label="Edit document"
          disabled={
            archived || !content?.responseRevision || view?.editableDocumentMarkdown == null
          }
          title={
            archived
              ? "Move this question out of Archive to edit its document"
              : !content?.responseRevision || view?.editableDocumentMarkdown == null
                ? "The document content is unavailable"
                : undefined
          }
          onSelect={() => {
            const trigger = menu.trigger ?? null;
            onClose();
            onEdit(node.id, trigger);
          }}
        />
      ) : null}
      <ResearchMenuSeparator />
      <ResearchMenuItem
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
          onDelete(node.id);
        }}
      />
      {treeMenu && chainIds[0] === rootNodeId ? (
        <>
          <ResearchMenuSeparator />
          <ResearchTreeMenuItems
            currentPlace={treeMenu.currentPlace}
            folders={treeMenu.folders}
            onMove={(place) => {
              onClose();
              treeMenu.onMove(place);
            }}
            onNewFolder={() => {
              onClose();
              treeMenu.onNewFolder(
                menu.trigger ??
                  document.querySelector<HTMLElement>(
                    `[data-research-row][data-node-id="${CSS.escape(node.id)}"]`,
                  ) ??
                  undefined,
              );
            }}
          />
        </>
      ) : null}
    </ResearchMenu>
  );
}
