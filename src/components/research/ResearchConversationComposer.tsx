import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
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

/** The follow-up composer at the end of one column. It scrolls with the
 * conversation (nothing is docked or sticky). The send shortcut follows the
 * "Require ⌘↵ to send" setting, and ⇧⌘↵ starts a branch from the column's
 * last finished answer instead of continuing the conversation. */
const ResearchConversationComposer = forwardRef<
  ResearchComposerHandle,
  {
    value: string;
    placeholder: string;
    disabled: boolean;
    canSubmit: boolean;
    submitting: boolean;
    /** Shown above the field (editing a failed question, a stalled tail). */
    note?: React.ReactNode;
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
    <div ref={wrapRef} className="research-composer-wrap">
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
            <ArrowUp size={15} aria-hidden="true" />
          )}
          <ComposerSubmitShortcutGlyph
            requireCmdEnter={requireCmdEnter}
            className="research-composer-enter"
            ariaHidden
          />
        </button>
      </form>
    </div>
  );
});

export default ResearchConversationComposer;
