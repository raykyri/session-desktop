// Deleting a follow-up, a branch, or the thread's root
// (`09-research-document-view.md` §8).
//
// One dialog handles all three branch shapes because only the confirmation copy
// differs. `researchBranchInfo` provides the descendant count in each case.
// Active runs must be cancelled before deletion to prevent partial deletion or
// orphaned background processes.

import { researchBranchInfo } from "@session/shared";
import type { ResearchNode, ResearchTreeDetail } from "@session/shared";

import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";

export function deleteBranchLabel(node: ResearchNode, descendantCount: number): string {
  if (node.inline && descendantCount > 0) return "Delete from here";
  return descendantCount > 0 ? "Delete branch" : "Delete follow-up";
}

export interface DeleteBranchDialogProps {
  detail: ResearchTreeDetail;
  nodeId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteBranchDialog({
  detail,
  nodeId,
  busy,
  error,
  onCancel,
  onConfirm,
}: DeleteBranchDialogProps) {
  const node = detail.nodes.find((candidate) => candidate.id === nodeId) ?? null;
  const info = researchBranchInfo(detail.nodes, nodeId);
  if (!node || !info) return null;

  const isRoot = node.id === detail.tree.rootNodeId;
  const count = info.descendantCount;
  const title = isRoot
    ? "Delete research"
    : node.inline && count > 0
      ? "Delete the rest of this thread?"
      : count > 0
        ? "Delete this research branch?"
        : "Delete this follow-up?";
  const body = isRoot
    ? count > 0
      ? `This permanently deletes the root answer and all ${count} follow-up${count === 1 ? "" : "s"}.`
      : "This permanently deletes the root answer and its research history."
    : node.inline && count > 0
      ? `This permanently deletes this follow-up and everything after it in the thread — ${count} descendant node${count === 1 ? "" : "s"} in total, including any branches. The parent answer will remain in place without this branch.`
      : count > 0
        ? `This also permanently deletes ${count} descendant follow-up${count === 1 ? "" : "s"}.`
        : "This permanently deletes the follow-up and its response.";

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      title={title}
      description={<>{body} This cannot be undone.</>}
      footer={
        <>
          <ControlButton disabled={busy} onClick={onCancel}>
            Cancel
          </ControlButton>
          <ConfirmDialogActionButton
            tone="danger"
            pending={busy}
            pendingLabel="Deleting…"
            disabled={info.hasActiveRuns}
            title={
              info.hasActiveRuns
                ? "Stop or wait for this branch to finish before deleting it"
                : undefined
            }
            onClick={onConfirm}
          >
            {isRoot ? "Delete research" : deleteBranchLabel(node, count)}
          </ConfirmDialogActionButton>
        </>
      }
    >
      {error ? (
        <p className="text-status-failed m-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
