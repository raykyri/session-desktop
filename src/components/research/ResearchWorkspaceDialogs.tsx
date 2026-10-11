import { useEffect, useRef, useState } from "react";
import { useConfirmDialogFocus } from "../../hooks/useConfirmDialogFocus";
import type { GroupInfo } from "../../types";

/** Confirms removing a research workspace from Session; its folder stays on
 * disk. The dialog stays open while `removing`. */
export function ResearchWorkspaceRemovalDialog({
  workspace,
  name,
  error,
  removing,
  onCancel,
  onConfirm,
}: {
  workspace: GroupInfo;
  name: string;
  error: string | null;
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  useConfirmDialogFocus(confirmButtonRef, workspace);
  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !removing) {
          onCancel();
        }
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-dialog-title"
      >
        <h2 id="close-dialog-title">{`Remove ${name}?`}</h2>
        <p>Remove this workspace from Session?</p>
        <p>The folder and its files will remain on disk, with history in the .session directory.</p>
        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={removing} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            className="control-button danger"
            autoFocus
            disabled={removing}
            onClick={onConfirm}
          >
            {removing ? "Removing…" : "Remove workspace"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Renames a group. A research workspace's dialog names the folder its
 * contents stay in. The name starts selected. */
export function ResearchWorkspaceRenameDialog({
  initialName,
  researchFolder,
  onSubmit,
  onClose,
}: {
  initialName: string;
  /** The group when it is a research workspace. */
  researchFolder: GroupInfo | undefined;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus and select the name when the dialog opens, so the user can type a
  // new name straight away.
  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, []);
  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <h2 id="rename-dialog-title">
          {researchFolder ? "Rename workspace" : "Rename group"}
        </h2>
        <input
          ref={inputRef}
          className="rename-dialog-input"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          aria-label={researchFolder ? "Workspace name" : "Group name"}
          aria-describedby={researchFolder ? "rename-folder-hint" : undefined}
        />
        {researchFolder ? (
          <p id="rename-folder-hint" className="rename-dialog-hint">
            Contents will remain in {researchFolder.dir}
          </p>
        ) : null}
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="control-button" type="submit">Rename</button>
        </div>
      </form>
    </div>
  );
}
