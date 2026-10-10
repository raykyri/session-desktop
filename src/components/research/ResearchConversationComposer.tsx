import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { growComposerTextarea } from "../../lib/composerTextarea";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";

export interface ResearchComposerHandle {
  focus: () => void;
  element: () => HTMLElement | null;
}

type EnterKeyEvent = Parameters<typeof isComposerSubmitShortcut>[0];

/** What an Enter key press in a column composer does: ⇧⌘↵ starts a branch;
 * the send shortcut of the "Require ⌘↵ to send" setting (⌘↵ when on, a bare
 * ↵ when off) sends; any other Enter adds a line (null: left to the field).
 * Null for every other key and during IME composition. */
export function researchComposerEnterAction(
  event: EnterKeyEvent,
  requireCmdEnter: boolean,
): "branch" | "send" | null {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
    return null;
  }
  if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
    return "branch";
  }
  return isComposerSubmitShortcut(event, requireCmdEnter) ? "send" : null;
}

/** The ask box at the end of a messages column. It scrolls with the
 * messages (nothing is docked or sticky). The send shortcut follows the
 * "Require ⌘↵ to send" setting, and ⇧⌘↵ starts a branch from the column's
 * last finished answer instead of continuing the conversation. A mode label
 * ("Draft", "New branch", "Editing …") sits above the field, with a × that
 * Esc also triggers; a draft gives the text the full width, with Send on its
 * own row. */
const ResearchConversationComposer = forwardRef<
  ResearchComposerHandle,
  {
    value: string;
    placeholder: string;
    disabled: boolean;
    canSubmit: boolean;
    submitting: boolean;
    /** Shown above the field (a stalled tail, an archived question). */
    note?: React.ReactNode;
    /** The box's mode, above the field: "Draft", "New branch", "Editing …". */
    mode?: { label: React.ReactNode; cancelLabel?: string; onCancel?: () => void } | null;
    /** A draft: the text takes the full width and Send sits on its own row. */
    fullWidth?: boolean;
    /** The agent a draft was written for, under the field. */
    agent?: string | null;
    shortcutHint?: string | null;
    ariaLabel?: string;
    /** The "Require ⌘↵ to send" setting. */
    requireCmdEnter: boolean;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onSubmitBranch?: () => void;
  }
>(function ResearchConversationComposer(
  {
    value,
    placeholder,
    disabled,
    canSubmit,
    submitting,
    note,
    mode = null,
    fullWidth = false,
    agent = null,
    shortcutHint,
    ariaLabel = "Ask a follow-up",
    requireCmdEnter,
    onChange,
    onSubmit,
    onSubmitBranch,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus({ preventScroll: true }),
      element: () => wrapRef.current,
    }),
    [],
  );
  useLayoutEffect(() => {
    if (textareaRef.current) {
      growComposerTextarea(textareaRef.current);
    }
  }, [value]);
  const ready = canSubmit && value.trim().length > 0;
  const noteId = useId();
  return (
    <div ref={wrapRef} className={`research-composer-wrap${fullWidth ? " is-full-width" : ""}`}>
      {mode ? (
        <div className="research-composer-mode">
          <span className="research-composer-mode-label">{mode.label}</span>
          {mode.onCancel ? (
            <button
              type="button"
              className="control-button research-icon-button research-composer-mode-cancel"
              aria-label={mode.cancelLabel ?? "Cancel"}
              title={mode.cancelLabel ? `${mode.cancelLabel} (Esc)` : "Cancel (Esc)"}
              onClick={mode.onCancel}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <div id={noteId} className="research-composer-note">
          {note}
        </div>
      ) : null}
      <form
        className={`research-composer${ready ? " is-ready" : ""}${disabled ? " is-disabled" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            onSubmit();
          }
        }}
      >
        {shortcutHint ? (
          <span className="pane-tab-shortcut-hint research-composer-shortcut-hint" aria-hidden="true">
            {shortcutHint}
          </span>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-describedby={note ? noteId : undefined}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && mode?.onCancel && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              mode.onCancel();
              return;
            }
            const action = researchComposerEnterAction(event, requireCmdEnter);
            if (action === null) {
              return;
            }
            event.preventDefault();
            if (action === "branch") {
              if (value.trim() && onSubmitBranch) {
                onSubmitBranch();
              }
            } else if (ready) {
              onSubmit();
            }
          }}
        />
        <button
          className="control-button research-composer-send"
          type="submit"
          disabled={!ready || submitting}
          aria-label="Send"
          title={requireCmdEnter ? "Send (⌘↵)" : "Send (↵)"}
        >
          {submitting ? (
            <LoaderCircle className="research-spinner" size={15} aria-hidden="true" />
          ) : (
            <ArrowRight size={15} aria-hidden="true" />
          )}
          <ComposerSubmitShortcutGlyph
            requireCmdEnter={requireCmdEnter}
            className="research-composer-enter"
            ariaHidden
          />
        </button>
      </form>
      {agent ? <div className="research-composer-agent">{agent}</div> : null}
    </div>
  );
});

export default ResearchConversationComposer;
