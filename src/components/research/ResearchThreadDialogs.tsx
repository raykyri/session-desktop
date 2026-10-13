import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { researchBranchInfo } from "../../lib/researchBranches";
import { RESEARCH_RERUN_PENDING_REASON, researchRerunBlocker } from "../../lib/researchChains";
import { nodePrompt, nodeType } from "../../lib/researchNodeTypes";
import { researchDeleteLabel } from "../../lib/researchThreadView";
import { researchTrashTreeSentence } from "../../lib/researchTrash";
import type { ResearchNode } from "../../types";
import { ResearchDeleteDialog, type ResearchDeleteDialogProps } from "./ResearchDeleteDialog";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ResearchRerunDialog({
  node,
  parent,
  pending,
  onConfirm,
  onClose,
}: {
  node: ResearchNode;
  parent: ResearchNode | null;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useResearchDialogReturnFocus(true);
  const blocker = researchRerunBlocker(node, parent);
  // Why Continue is disabled, if it is.
  const reason = blocker ?? (pending ? RESEARCH_RERUN_PENDING_REASON : null);
  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rerun-research-dialog-title"
        aria-describedby="rerun-research-dialog-description"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
      >
        <h2 id="rerun-research-dialog-title">Rerun</h2>
        <p id="rerun-research-dialog-description">
          Rerun will replace the current answer. Continue?
        </p>
        {reason ? <p role="status">{reason}</p> : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button
            className="control-button primary"
            type="button"
            disabled={reason !== null}
            onClick={onConfirm}
          >
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The thread page's Rename dialog for the research (the root) or a branch.
 * Mounted while it is open; focus returns to the control that opened it. */
export function ResearchRenameDialog({
  initialValue,
  isRoot,
  onRename,
  onClose,
}: {
  initialValue: string;
  isRoot: boolean;
  /** Saves the title; a rejection keeps the dialog open with its message. */
  onRename: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResearchDialogReturnFocus(true);

  async function confirm() {
    const title = value.trim();
    if (renaming || !title) {
      return;
    }
    setRenaming(true);
    try {
      await onRename(title);
      onClose();
    } catch (err) {
      // The dialog stays open with the typed title.
      setError(errorText(err));
    } finally {
      setRenaming(false);
    }
  }

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !renaming) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog research-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-research-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !renaming) {
            event.preventDefault();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
      >
        <h2 id="rename-research-dialog-title">{isRoot ? "Rename research" : "Rename branch"}</h2>
        <input
          className="research-rename-input"
          autoFocus
          aria-label="Title"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={renaming} onClick={onClose}>
            Cancel
          </button>
          <button className="control-button primary" type="submit" disabled={renaming || !value.trim()}>
            {renaming ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}


/** The steps of the thread page's delete confirmation for `node`. Deleting
 * the root deletes the whole research: it moves to the Trash, or with Delete
 * now is deleted permanently. A message inside a thread is deleted at once with what follows it
 * (messages have no Trash), so its dialog is the permanent step alone. */
export function researchBranchDeleteDialogProps({
  node,
  info,
  isRoot,
  treeTitle,
  groupChildCount = 0,
  onTrashRoot,
  onRemove,
  onClose,
}: {
  node: ResearchNode;
  info: { descendantCount: number; hasActiveRuns: boolean };
  isRoot: boolean;
  treeTitle: string;
  /** For the root: the children listed under the research in Home, which
   * move to the Trash or are deleted with it. */
  groupChildCount?: number;
  onTrashRoot: () => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}): ResearchDeleteDialogProps {
  const name = (node.title ?? nodePrompt(node)) || treeTitle;
  const count = info.descendantCount;
  const plural = (noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const disabledReason = info.hasActiveRuns
    ? "It has active runs, which must finish or be cancelled before it can be deleted."
    : null;
  if (isRoot) {
    const children = `${groupChildCount} ${groupChildCount === 1 ? "child" : "children"}`;
    return {
      trash: {
        title: groupChildCount > 0 ? `Delete “${name}” and its ${children}?` : `Delete “${name}”?`,
        body: <p>{researchTrashTreeSentence(count, groupChildCount)}</p>,
        onConfirm: onTrashRoot,
      },
      remove: {
        ...(groupChildCount > 0
          ? {
              body: (
                <p>
                  “{name}” and its {children} will be deleted. This can’t be undone.
                </p>
              ),
            }
          : null),
        onConfirm: onRemove,
      },
      disabledReason,
      onClose,
    };
  }
  // A follow-up note: deleting it deletes its own follow-ups.
  const note = nodeType(node) === "post";
  const title = note
    ? "Delete this note?"
    : node.inline && count > 0
      ? "Delete the rest of this thread?"
      : count > 0
        ? "Delete this research branch?"
        : "Delete this follow-up?";
  const what = note
    ? count > 0
      ? `This deletes the note and ${plural("follow-up")} under it.`
      : "This deletes the note."
    : node.inline && count > 0
      ? `This deletes this follow-up and everything after it in the thread, ${plural("message")} in all, including any branches. A new follow-up can then be asked from the answer before it.`
      : count > 0
        ? `This also deletes ${plural("follow-up")} under it.`
        : "This deletes the follow-up and its response.";
  return {
    remove: {
      title,
      body: (
        <>
          <p>“{name}”</p>
          <p>{what} This can’t be undone.</p>
        </>
      ),
      label: note ? "Delete note" : researchDeleteLabel(false, node.inline, count),
      onConfirm: onRemove,
    },
    disabledReason,
    onClose,
  };
}

/** The thread page's delete confirmation for a message and what follows it
 * (or, for the root, the whole research). Mounted while a deletion is asked
 * for; it renders nothing once the message has left `nodes`. Focus returns to
 * the control that opened it, else to `returnFocusFallback`. */
export function ResearchDeleteBranchDialog({
  nodes,
  nodeId,
  rootNodeId,
  treeTitle,
  groupChildCount,
  onTrashRoot,
  onRemove,
  onClose,
  returnFocusFallback,
}: {
  nodes: ResearchNode[];
  nodeId: string;
  rootNodeId: string | null;
  treeTitle: string;
  groupChildCount?: number;
  /** Moves the research to the Trash (the root's default). */
  onTrashRoot: () => Promise<void>;
  /** Deletes `node` permanently; a rejection keeps the dialog open with its
   * message. */
  onRemove: (node: ResearchNode) => Promise<void>;
  onClose: () => void;
  returnFocusFallback: () => HTMLElement | null | undefined;
}) {
  const node = useMemo(() => nodes.find((candidate) => candidate.id === nodeId) ?? null, [nodeId, nodes]);
  const info = useMemo(() => researchBranchInfo(nodes, nodeId), [nodeId, nodes]);
  if (!node || !info) {
    return null;
  }
  return (
    <ResearchDeleteDialog
      {...researchBranchDeleteDialogProps({
        node,
        info,
        isRoot: node.id === rootNodeId,
        treeTitle,
        groupChildCount,
        onTrashRoot,
        onRemove: () => onRemove(node),
        onClose,
      })}
      fallbackFocus={returnFocusFallback}
    />
  );
}
