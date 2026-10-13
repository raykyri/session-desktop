import { useRef } from "react";
import type { ExitDialogState } from "../appTypes";
import { useConfirmDialogFocus } from "../hooks/useConfirmDialogFocus";
import ConfirmDialogActionButton from "./ConfirmDialogActionButton";
import { trapResearchDialogTab } from "./research/researchFocus";

/** The Quit Session confirmation, naming the research runs that quitting
 * cancels. */
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
        onKeyDown={trapResearchDialogTab}
        aria-busy={quitting}
      >
        <h2 id="exit-dialog-title">Quit Session?</h2>
        <p>
          {dialog.researchRunCount} active research run
          {dialog.researchRunCount === 1 ? "" : "s"} will be cancelled and kept in
          their threads.
        </p>
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
            pendingLabel="Quitting…"
            onClick={onConfirm}
          >
            Quit Session
          </ConfirmDialogActionButton>
        </div>
      </div>
    </div>
  );
}
