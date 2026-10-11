import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";

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
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const id = useId();
  const titleId = `${id}-title`;
  const inputId = `${id}-name`;
  const name = value.trim();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const returnFocus = returnFocusRef.current;
    return () => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  function trapFocus(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
    ];
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
      event.preventDefault();
      focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
    }
  }

  return createPortal(
    <div className="research-folder-dialog-layer research-model-dialog">
      <div className="research-folder-dialog-scrim" onMouseDown={onClose} />
      <form
        ref={dialogRef}
        className={`research-folder-dialog${name ? " is-ready" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        noValidate
        onKeyDown={trapFocus}
        onSubmit={(event) => {
          event.preventDefault();
          if (name) onSubmit(name);
        }}
      >
        <h3 id={titleId}>Custom model</h3>
        <p className="research-folder-dialog-sub">Enter the model name to use with {agentLabel}.</p>
        <label className="research-visually-hidden" htmlFor={inputId}>
          Model name
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="research-folder-dialog-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="Model name"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <div className="research-folder-dialog-row">
          <span className="research-feed-header-spacer" />
          <button type="button" className="research-feed-button is-tint" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="research-feed-button is-primary" disabled={!name}>
            Use model
            <span className="research-feed-enter" aria-hidden="true">↵</span>
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
