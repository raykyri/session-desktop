// The offer after "Ask as a question" (the desktop's
// `ResearchTreeDeleteOfferDialog` in `ResearchTreeMenu.tsx`, opened from
// `App.tsx` `askResearchEditorQuestion`): once the new thread exists, a
// dialog asks whether to delete the edited thread, stating what deleting it
// also deletes, counted from its nodes as they were when the question was
// asked. Keep (focused first; also Escape) closes it; Delete… hands over to
// the thread's delete confirmation (Move to Trash with Undo, or Delete now),
// with the children listed under it in Home.
//
// The thread page navigates to the new thread when it is created, so the
// offer lives in a store and is rendered by the shell. Both dialogs apply only
// while the original thread is listed in its workspace and not archived;
// otherwise they close. Web only: the offer is made for the reader's own
// thread, since a shared thread's Delete leaves it rather than deleting it.

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ResearchTreeSummary } from "@session/shared";
import {
  researchTreeContentsSentence,
  type ResearchTreeContents,
} from "@session/shared/lib/researchTreeContents";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useResearchTrash, useTreeSummaries } from "../../api/queries.js";
import { ControlButton } from "../../ui/Button.js";
import { DeleteDialog } from "../../ui/DeleteDialog.js";
import { ConfirmDialogActionButton } from "../../ui/Dialog.js";
import { DIALOG_BACKDROP, DIALOG_POPUP } from "../../ui/surfaces.js";
import { treeDeleteDialogProps } from "../home/TreeMenu.js";
import { useFiling } from "../home/useFiling.js";
import { useGroupActions } from "../home/useGroupActions.js";
import { useOwnerMemberCount } from "../sharing/ownerWarnings.js";

export interface DeleteOffer {
  treeId: string;
  workspaceId: string;
  newTreeId: string;
  contents: ResearchTreeContents;
}

interface DeleteOfferState {
  offer: DeleteOffer | null;
  /** The thread whose delete confirmation Delete… opened. */
  deleting: { treeId: string; workspaceId: string } | null;
  show: (offer: DeleteOffer) => void;
  keep: () => void;
  startDelete: () => void;
  closeDelete: () => void;
}

export const useDeleteOfferStore = create<DeleteOfferState>()((set) => ({
  offer: null,
  deleting: null,
  show: (offer) => set({ offer, deleting: null }),
  keep: () => set({ offer: null }),
  startDelete: () =>
    set((state) =>
      state.offer
        ? {
            offer: null,
            deleting: { treeId: state.offer.treeId, workspaceId: state.offer.workspaceId },
          }
        : state,
    ),
  closeDelete: () => set({ deleting: null }),
}));

const NO_TREES: ResearchTreeSummary[] = [];

/** "Delete the original thread?" (the desktop's
 * `ResearchTreeDeleteOfferPanel`). */
export function DeleteOfferDialog({
  tree,
  contents,
  onKeep,
  onDelete,
}: {
  tree: ResearchTreeSummary;
  contents: ResearchTreeContents;
  onKeep: () => void;
  onDelete: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  const running = tree.runningCount > 0;
  return (
    <BaseDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={DIALOG_BACKDROP} />
        <BaseDialog.Popup className={DIALOG_POPUP} initialFocus={keepRef}>
          <BaseDialog.Title className="text-fg-heading text-reading m-0 font-semibold">
            Delete the original thread?
          </BaseDialog.Title>
          <BaseDialog.Description
            render={<div />}
            className="text-fg-secondary mt-2 mb-0 flex flex-col gap-2 text-base"
          >
            <p className="m-0">
              The question was asked in a new thread. The original thread, “{tree.title}”, is
              unchanged.
            </p>
            <p className="m-0">{researchTreeContentsSentence(contents)}</p>
            {running ? (
              <p className="m-0">
                It has active runs, which must finish or be cancelled before it can be deleted.
              </p>
            ) : null}
          </BaseDialog.Description>
          <div className="mt-5 flex items-center justify-end gap-2">
            <ControlButton ref={keepRef} onClick={onKeep}>
              Keep
            </ControlButton>
            <ConfirmDialogActionButton
              tone="danger"
              disabled={running}
              title={running ? "Research with active runs cannot be deleted" : undefined}
              onClick={onDelete}
            >
              Delete…
            </ConfirmDialogActionButton>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** Rendered once by the shell for a signed-in reader. */
export function DeleteOfferHost() {
  const offer = useDeleteOfferStore((state) => state.offer);
  const deleting = useDeleteOfferStore((state) => state.deleting);
  const keep = useDeleteOfferStore((state) => state.keep);
  const startDelete = useDeleteOfferStore((state) => state.startDelete);
  const closeDelete = useDeleteOfferStore((state) => state.closeDelete);
  const target = offer ?? deleting;
  const workspaceId = target?.workspaceId ?? "";
  const filing = useFiling(workspaceId);
  const trash = useResearchTrash(workspaceId).data ?? NO_TREES;
  const group = useGroupActions(filing, trash);
  // Listed (its workspace's list holds only threads out of the Trash) and
  // not archived.
  const tree = target
    ? (filing.trees.find(
        (candidate) => candidate.id === target.treeId && candidate.archivedAt == null,
      ) ?? null)
    : null;
  const listsLoaded = useTreeSummaries({ workspaceId, includeArchived: true }).isSuccess;
  const memberCount = useOwnerMemberCount(deleting?.treeId ?? "", deleting !== null);

  useEffect(() => {
    if (!target || !listsLoaded || tree) return;
    if (offer) keep();
    else closeDelete();
  }, [closeDelete, keep, listsLoaded, offer, target, tree]);

  if (!tree) return null;
  if (offer) {
    return (
      <DeleteOfferDialog
        tree={tree}
        contents={offer.contents}
        onKeep={keep}
        onDelete={startDelete}
      />
    );
  }
  return (
    <DeleteDialog
      {...treeDeleteDialogProps({
        tree,
        groupChildren: group.groupChildren(tree.id),
        memberCount,
        onClose: closeDelete,
        onTrash: group.trashGroup,
        onRemove: group.removeGroup,
      })}
    />
  );
}
