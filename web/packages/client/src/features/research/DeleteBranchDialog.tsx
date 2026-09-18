// Deleting a follow-up, a branch, or the thread's root
// (`09-research-document-view.md` §8).
//
// One dialog for three shapes because the confirmation copy is the only thing
// that differs, and what it must say — how many nodes go with this one — comes
// from the same `researchBranchInfo` walk in every case. A branch with a run
// still in flight is refused rather than queued for deletion: the server would
// have to cancel it first, and a reader who cancels deliberately gets a better
// outcome than one who discovers a half-deleted thread.

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
  const name = (node.title ?? node.prompt) || detail.tree.title;
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
      ? `This permanently deletes this follow-up and everything after it in the thread — ${count} descendant node${count === 1 ? "" : "s"} in total, including any branches. Its parent answer keeps the freed inline slot.`
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
      description={
        <>
          Delete “{name}”? {body} This can’t be undone.
        </>
      }
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
                ? "This branch must finish or be cancelled before it can be deleted"
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
