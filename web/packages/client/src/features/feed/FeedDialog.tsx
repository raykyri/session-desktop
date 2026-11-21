// The feed's dialogs as the mock draws them (`.scrim`, `.dialog`): Base UI
// dialogs, so focus is trapped, Escape closes the innermost one and focus
// returns to the opener (02 §10.1, §10.2). A stacked dialog (the About
// editor over the info dialog) passes `stacked` for its own scrim above.

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode, RefObject } from "react";

import { cn } from "../../lib/cn.js";

export function FeedDialog({
  open,
  onOpenChange,
  labelledBy,
  className,
  stacked = false,
  initialFocus,
  finalFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The id of the heading that names the dialog. */
  labelledBy: string;
  className?: string;
  stacked?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  finalFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={cn("fscrim", stacked && "ce-scrim")} />
        <Dialog.Popup
          aria-labelledby={labelledBy}
          className={cn("fdialog", className)}
          {...(initialFocus ? { initialFocus } : {})}
          {...(finalFocus ? { finalFocus } : {})}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A delete confirmation (`alertdialog`): focus starts on Cancel, not on the
 * destructive button (02 §10.1). */
export function ConfirmDelete({
  open,
  onOpenChange,
  title,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fscrim" />
        <AlertDialog.Popup className="fdialog" aria-labelledby="del-h">
          <h3 id="del-h">{title}</h3>
          <p>This can't be undone.</p>
          <div className="dacts">
            <AlertDialog.Close className="btn2">Cancel</AlertDialog.Close>
            <button
              type="button"
              className="btn1 danger"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              Delete
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
