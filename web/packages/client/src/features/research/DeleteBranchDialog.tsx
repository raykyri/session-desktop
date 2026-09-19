// Deleting a follow-up, a branch, or the thread's root
// (`09-research-document-view.md` §8).
//
// One dialog handles all three branch shapes because only the confirmation
// copy differs; `researchBranchInfo` gives the descendant count in each case.
// A branch with a run still in flight is refused rather than queued for
// deletion: the server would have to cancel it first, and a reader who cancels
// deliberately gets a better outcome than one who discovers a half-deleted
// thread.

import { researchBranchInfo } from "@session/shared";
import type { ResearchNode, ResearchTreeDetail } from "@session/shared";

import { ConfirmDialog } from "../../ui/Dialog.js";

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
    ? "Delete thread"
    : node.inline && count > 0
      ? "Delete the rest of this thread?"
      : count > 0
        ? "Delete this branch?"
        : "Delete this follow-up?";
  const body = isRoot
    ? count > 0
      ? `This permanently deletes the root answer and all ${count} follow-up${count === 1 ? "" : "s"}.`
      : "This permanently deletes the root answer and the thread’s history."
    : node.inline && count > 0
      ? `This permanently deletes this follow-up and everything after it in the thread — ${count} descendant node${count === 1 ? "" : "s"} in total, including any branches. The parent answer will remain in place without this branch.`
      : count > 0
        ? `This also permanently deletes ${count} descendant follow-up${count === 1 ? "" : "s"}.`
        : "This permanently deletes the follow-up and its response.";

  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      title={title}
      description={
        <>
          {body} This cannot be undone.
          {info.hasActiveRuns ? (
            <span className="mt-2 block">
              Stop or wait for this branch to finish before deleting it.
            </span>
          ) : null}
          {error ? (
            <span className="text-status-failed mt-2 block" role="alert">
              {error}
            </span>
          ) : null}
        </>
      }
      tone="danger"
      pending={busy}
      pendingLabel="Deleting…"
      confirmDisabled={info.hasActiveRuns}
      confirmLabel={isRoot ? "Delete thread" : deleteBranchLabel(node, count)}
      onConfirm={onConfirm}
    />
  );
}
