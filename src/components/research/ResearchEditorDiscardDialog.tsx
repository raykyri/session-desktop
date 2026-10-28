import { isSaveShortcut } from "../../lib/editorShortcuts";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useConfirmDialogFocus } from "../../hooks/useConfirmDialogFocus";
import { trapResearchDialogTab } from "./researchFocus";

export function ResearchEditorDiscardDialog({ onCancel, onDiscard, onSave }: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave?: () => void;
}) {
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useConfirmDialogFocus(keepRef, true);
  return createPortal(
    <div className="confirm-dialog-backdrop" role="presentation">
      <div className="confirm-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="research-editor-discard-title"
        onKeyDown={(event) => {
          trapResearchDialogTab(event);
          if (onSave && isSaveShortcut(event)) {
            event.preventDefault();
            onSave();
          }
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}>
        <h2 id="research-editor-discard-title">Discard your changes?</h2>
        <p>Your unsaved edits will be lost.</p>
        <div className="confirm-dialog-actions">
          <button ref={keepRef} type="button" className="control-button" onClick={onCancel}>Keep editing</button>
          <button type="button" className="control-button danger" onClick={onDiscard}>Discard</button>
        </div>
      </div>
    </div>, document.body,
  );
}
