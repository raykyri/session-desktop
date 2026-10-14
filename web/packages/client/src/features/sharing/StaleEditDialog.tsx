// The prompt for an edit refused because someone else changed the same thing
// first (web only; the server answers CONFLICT for a stale note, document,
// recap or messages order). It offers to reload the latest version; the
// text the reader wrote is kept and shown so it is not lost.

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRef } from "react";

import { writeClipboardText } from "../../lib/clipboard.js";
import { cn } from "../../lib/cn.js";
import { pushToast } from "../../lib/toast.js";
import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { CONTROL_BUTTON, CONTROL_BUTTON_SIZE, FORM_FIELD } from "../../ui/surfaces.js";

/** Whether a failed call was refused as stale (tRPC `CONFLICT`). */
export function isConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    data?: { code?: unknown } | null;
    shape?: { data?: { code?: unknown } } | null;
  };
  return candidate.data?.code === "CONFLICT" || candidate.shape?.data?.code === "CONFLICT";
}

export type StaleEditSubject = "note" | "document" | "recap" | "order";

const TITLES: Record<StaleEditSubject, string> = {
  note: "This note changed",
  document: "This document changed",
  recap: "This answer changed",
  order: "This conversation changed",
};

const BODIES: Record<StaleEditSubject, string> = {
  note: "A newer version of this note was saved while you were editing it. Reload to edit the latest version. Your text stays in the editor, so you can keep it or change it before saving.",
  document:
    "A newer version of this document was saved while you were editing it. Reload to edit the latest version. Your text stays in the editor, so you can keep it or change it before saving.",
  recap:
    "The answer or its recap changed since this recap was generated. Reload the latest version and generate the recap again.",
  order:
    "The order of these messages changed since they were shown. Reload the latest version before reordering them.",
};

export function StaleEditDialog({
  subject,
  keptText = null,
  pending = false,
  onReload,
  onClose,
}: {
  subject: StaleEditSubject;
  /** The reader's unsaved text, shown read-only with Copy. */
  keptText?: string | null;
  pending?: boolean;
  onReload: () => void;
  onClose: () => void;
}) {
  const reloadRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={TITLES[subject]}
      description={BODIES[subject]}
      initialFocus={reloadRef}
      footer={
        <>
          {keptText ? (
            <ControlButton
              className="mr-auto"
              onClick={() =>
                void writeClipboardText(keptText)
                  .then(() => pushToast({ title: "Your text was copied.", tone: "success" }))
                  .catch(() => pushToast({ title: "Couldn't copy.", tone: "error" }))
              }
            >
              Copy my text
            </ControlButton>
          ) : null}
          <BaseDialog.Close
            className={cn(CONTROL_BUTTON, CONTROL_BUTTON_SIZE.md)}
            disabled={pending}
          >
            Cancel
          </BaseDialog.Close>
          <ConfirmDialogActionButton
            ref={reloadRef}
            pending={pending}
            pendingLabel="Reloading…"
            onClick={onReload}
          >
            Reload latest version
          </ConfirmDialogActionButton>
        </>
      }
    >
      {keptText ? (
        <textarea
          className={cn(FORM_FIELD, "text-fg-secondary h-32 w-full resize-none py-2 text-sm")}
          aria-label="Your text"
          readOnly
          value={keptText}
        />
      ) : null}
    </Dialog>
  );
}
