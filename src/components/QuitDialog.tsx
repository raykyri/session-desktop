import { useRef } from "react";
import type { ExitDialogState } from "../appTypes";
import { useConfirmDialogFocus } from "../hooks/useConfirmDialogFocus";
import ConfirmDialogActionButton from "./ConfirmDialogActionButton";

/** The Quit Session confirmation, naming the tabs and research runs that
 * quitting stops. */
export default function QuitDialog({
  dialog,
  quitting,
  onCancel,
  onConfirm,
}: {
  dialog: ExitDialogState;
  quitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  useConfirmDialogFocus(confirmButtonRef, dialog);
  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !quitting) {
          onCancel();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-dialog-title"
        aria-busy={quitting}
      >
        <h2 id="exit-dialog-title">Quit Session?</h2>
        {dialog.paneCount > 0 ? (
          <p>
            Quitting will close{" "}
            {dialog.paneCount === 1 ? "the open tab" : `all ${dialog.paneCount} tabs`}{" "}
            and stop any running agents or processes.
          </p>
        ) : (
          <p>Quitting will stop running agents or processes.</p>
        )}
        {dialog.researchRunCount > 0 ? (
          <p>
            {dialog.researchRunCount} active research run
            {dialog.researchRunCount === 1 ? "" : "s"} will be cancelled and kept in
            Research history.
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={quitting} onClick={onCancel}>
            Cancel
          </button>
          <ConfirmDialogActionButton
            ref={confirmButtonRef}
            type="button"
            className="danger"
            autoFocus
            pending={quitting}
            pendingLabel="Closing terminals..."
            onClick={onConfirm}
          >
            Quit Session
          </ConfirmDialogActionButton>
        </div>
      </div>
    </div>
  );
}
