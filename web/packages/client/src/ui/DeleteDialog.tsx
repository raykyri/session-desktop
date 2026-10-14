// The delete confirmation (the desktop's `ResearchDeleteDialog.tsx`): a
// centred dialog whose first step moves the item to the Trash, with a
// "Delete now" link that opens a second confirmation for the permanent
// deletion. Deletions that are always permanent (emptying the Trash, a Trash
// entry's Delete now) show the second step alone.

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { KeyboardEvent, ReactNode } from "react";
import { useRef, useState } from "react";

import { cn } from "../lib/cn.js";
import { errorMessage } from "../lib/toast.js";

import { ControlButton, LinkButton } from "./Button.js";
import { ConfirmDialogActionButton } from "./Dialog.js";
import { DIALOG_BACKDROP, DIALOG_POPUP } from "./surfaces.js";

/** One step of a delete confirmation. `onConfirm` rejects to keep the dialog
 * open with the message. */
export interface DeleteStep {
  title: ReactNode;
  body?: ReactNode;
  label?: string;
  pendingLabel?: string;
  /** The confirming button's style: danger for a permanent deletion (the
   * default), primary for a confirmation that deletes nothing. */
  tone?: "danger" | "primary";
  onConfirm: () => Promise<unknown> | void;
}

export interface DeleteDialogProps {
  /** The first step, which moves the item to the Trash: Move to Trash,
   * Cancel, and a Delete now link that opens `remove`. Omitted for deletions
   * that are always permanent; the dialog is then `remove` alone. */
  trash?: DeleteStep | undefined;
  /** The permanent deletion. Title, body and label default to "Delete
   * permanently?", "This can’t be undone." and Delete. */
  remove: Partial<Omit<DeleteStep, "onConfirm">> & Pick<DeleteStep, "onConfirm">;
  /** Why neither action is available (active runs); shown, and both
   * confirming buttons are disabled. */
  disabledReason?: string | null | undefined;
  onClose: () => void;
  /** For tests: the step to render first. */
  initialStep?: "trash" | "remove";
}

/** The primary button of a confirm dialog that deletes nothing (Move to
 * Trash, Archive, Move). */
const PRIMARY_CLASS =
  "border-accent bg-accent text-fg-on-accent hover:not-disabled:bg-accent-strong " +
  "disabled:border-border-control disabled:bg-control";

export function DeleteDialog({
  trash,
  remove,
  disabledReason = null,
  onClose,
  initialStep,
}: DeleteDialogProps) {
  const [step, setStep] = useState<"trash" | "remove">(initialStep ?? (trash ? "trash" : "remove"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const current: DeleteStep =
    step === "trash" && trash
      ? { label: "Move to Trash", pendingLabel: "Moving…", ...trash }
      : {
          title: "Delete permanently?",
          body: <p className="m-0">This can’t be undone.</p>,
          label: "Delete",
          pendingLabel: "Deleting…",
          ...remove,
        };
  const primary = step === "trash" || current.tone === "primary";

  async function confirm() {
    if (busy || disabledReason) return;
    setError(null);
    setBusy(true);
    try {
      await current.onConfirm();
      setBusy(false);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Enter on a button presses that button; anywhere else it confirms.
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      void confirm();
    }
  }

  return (
    <BaseDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={DIALOG_BACKDROP} />
        <BaseDialog.Popup
          className={DIALOG_POPUP}
          initialFocus={disabledReason ? cancelRef : confirmRef}
          aria-busy={busy}
          onKeyDown={onKeyDown}
          data-research-delete-dialog=""
        >
          <BaseDialog.Title className="text-fg-heading text-reading m-0 font-semibold">
            {current.title}
          </BaseDialog.Title>
          {current.body ? (
            <BaseDialog.Description
              render={<div />}
              className="text-fg-secondary mt-2 mb-0 flex flex-col gap-2 text-base"
            >
              {current.body}
            </BaseDialog.Description>
          ) : null}
          {disabledReason ? (
            <p className="text-fg-secondary mt-2 mb-0 text-base" role="status">
              {disabledReason}
            </p>
          ) : null}
          {error ? (
            <p className="text-status-failed mt-2 mb-0 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {/* Keyed by step: the new step's buttons mount and take focus. */}
          <div key={step} className="mt-5 flex items-center justify-end gap-2">
            {step === "trash" ? (
              <LinkButton
                className="text-fg-secondary mr-auto text-sm"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep("remove");
                  requestAnimationFrame(() =>
                    (disabledReason ? cancelRef : confirmRef).current?.focus(),
                  );
                }}
              >
                Delete now
              </LinkButton>
            ) : null}
            <ControlButton ref={cancelRef} disabled={busy} onClick={onClose}>
              Cancel
            </ControlButton>
            <ConfirmDialogActionButton
              ref={confirmRef}
              tone={primary ? "default" : "danger"}
              className={cn(primary && PRIMARY_CLASS)}
              pending={busy}
              pendingLabel={current.pendingLabel}
              disabled={disabledReason !== null}
              onClick={() => void confirm()}
            >
              {current.label}
            </ConfirmDialogActionButton>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
