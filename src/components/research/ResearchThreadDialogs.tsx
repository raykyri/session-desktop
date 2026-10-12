import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { researchBranchInfo } from "../../lib/researchBranches";
import { RESEARCH_RERUN_PENDING_REASON, researchRerunBlocker } from "../../lib/researchChains";
import { nodePrompt } from "../../lib/researchNodeTypes";
import { researchDeleteLabel } from "../../lib/researchThreadView";
import type { ResearchNode } from "../../types";
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

/** The thread page's delete confirmation for a message and what follows it
 * (or, for the root, the whole research). Mounted while a deletion is asked
 * for; it renders nothing once the message has left `nodes`. Focus returns to
 * the control that opened it, else to `returnFocusFallback`. */
export function ResearchDeleteBranchDialog({
  nodes,
  nodeId,
  rootNodeId,
  treeTitle,
  onRemove,
  onClose,
  returnFocusFallback,
}: {
  nodes: ResearchNode[];
  nodeId: string;
  rootNodeId: string | null;
  treeTitle: string;
  /** Deletes `node`; a rejection keeps the dialog open with its message. */
  onRemove: (node: ResearchNode) => Promise<void>;
  onClose: () => void;
  returnFocusFallback: () => HTMLElement | null | undefined;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useResearchDialogReturnFocus(true, returnFocusFallback);
  const node = useMemo(() => nodes.find((candidate) => candidate.id === nodeId) ?? null, [nodeId, nodes]);
  const info = useMemo(() => researchBranchInfo(nodes, nodeId), [nodeId, nodes]);
  if (!node || !info) {
    return null;
  }
  const isRoot = node.id === rootNodeId;

  async function confirm() {
    if (!node || !info || info.hasActiveRuns) {
      return;
    }
    setError(null);
    setRemoving(true);
    try {
      await onRemove(node);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRemoving(false);
    }
  }

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !removing) {
          onClose();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-research-branch-dialog-title"
        aria-busy={removing}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !removing) {
            event.preventDefault();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
      >
        <h2 id="delete-research-branch-dialog-title">
          {isRoot
            ? "Delete research"
            : node.inline && info.descendantCount > 0
            ? "Delete the rest of this thread?"
            : info.descendantCount > 0
            ? "Delete this research branch?"
            : "Delete this follow-up?"}
        </h2>
        <p>
          Delete "
          {(node.title ?? nodePrompt(node)) || treeTitle}
          "?
        </p>
        <p>
          {isRoot
            ? info.descendantCount > 0
              ? `This permanently deletes the root answer and all ${info.descendantCount} follow-up${info.descendantCount === 1 ? "" : "s"}.`
              : "This permanently deletes the root answer and its research history."
            : node.inline && info.descendantCount > 0
            ? `This permanently deletes this follow-up and everything after it in the thread — ${info.descendantCount} descendant node${info.descendantCount === 1 ? "" : "s"} in total, including any branches. Its parent answer keeps the freed inline slot.`
            : info.descendantCount > 0
            ? `This also permanently deletes ${info.descendantCount} descendant follow-up${info.descendantCount === 1 ? "" : "s"}.`
            : "This permanently deletes the follow-up and its response."} {" "}
          This can’t be undone.
        </p>
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button"
            type="button"
            disabled={removing}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="control-button danger"
            autoFocus
            disabled={removing || info.hasActiveRuns}
            onClick={() => void confirm()}
          >
            {removing ? "Deleting…" : researchDeleteLabel(isRoot, node.inline, info.descendantCount)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
