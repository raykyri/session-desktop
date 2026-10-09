import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { growComposerTextarea } from "../../lib/composerTextarea";

export interface ResearchComposerHandle {
  focus: () => void;
  element: () => HTMLElement | null;
}

/** The follow-up composer at the end of one column. It scrolls with the
 * conversation (nothing is docked or sticky). Enter sends when there is text,
 * Shift+Enter adds a line, and ⇧⌘↵ starts a branch from the column's last
 * finished answer instead of continuing the conversation. */
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
  return (
    <div ref={wrapRef} className="research-composer-wrap">
      {note ? <div className="research-composer-note">{note}</div> : null}
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
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) {
              return;
            }
            if (event.shiftKey && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (value.trim() && onSubmitBranch) {
                onSubmitBranch();
              }
              return;
            }
            if (event.shiftKey) {
              return;
            }
            event.preventDefault();
            if (ready) {
              onSubmit();
            }
          }}
        />
        <button
          className="control-button research-composer-send"
          type="submit"
          disabled={!ready || submitting}
          aria-label="Send"
          title="Send (↵)"
        >
          {submitting ? (
            <LoaderCircle className="research-spinner" size={15} aria-hidden="true" />
          ) : (
            <ArrowUp size={15} aria-hidden="true" />
          )}
          <span className="research-composer-enter" aria-hidden="true">
            ↵
          </span>
        </button>
      </form>
    </div>
  );
});

export default ResearchConversationComposer;
