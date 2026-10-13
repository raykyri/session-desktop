import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";

/** Dialog for a custom model name. Enter and Use model submit; Escape, Cancel,
 * and outside clicks close it without changing the model. */
export function ResearchModelNameDialog({
  agentLabel,
  initialName,
  onSubmit,
  onClose,
}: {
  agentLabel: string;
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useResearchDialogReturnFocus(true);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const name = value.trim();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      data-research-model-dialog=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="confirm-dialog rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        noValidate
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          trapResearchDialogTab(event);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (name) onSubmit(name);
        }}
      >
        <h2 id={titleId}>Custom model</h2>
        <p id={descriptionId}>Enter the model name to use with {agentLabel}.</p>
        <input
          ref={inputRef}
          className="rename-dialog-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="Model name"
          aria-label="Model name"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="control-button primary" type="submit" disabled={!name}>
            Use model
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
