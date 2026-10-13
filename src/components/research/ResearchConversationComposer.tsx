import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import type { ResearchImageAttachment } from "../../types";
import { growComposerTextarea } from "../../lib/composerTextarea";
import { ComposerSubmitShortcutGlyph, isComposerSubmitShortcut } from "../ComposerSubmitShortcut";
import { ResearchImageStrip, useResearchImageInput, type ResearchImagesUpdate } from "./ResearchImages";

const NO_IMAGES: readonly ResearchImageAttachment[] = [];

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

/** A column's ask box, after the messages of its selected run (or a
 * draft's, or an unsent branch's). It scrolls with them (nothing is docked
 * or sticky). The send shortcut is the one `requireCmdEnter` names (a
 * thread's columns always ask for ⌘↵), and ⇧⌘↵ starts a branch from the column's
 * last finished answer instead of continuing the conversation. A mode label
 * ("Draft", "New branch", "Editing …") sits above the field, with a × that
 * Esc also triggers; a draft gives the text the full width, with Send on its
 * own row. With `onImagesChange`, images pasted or dropped on the box are
 * attached and shown above the field. */
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
    /** The attached images; with `onImagesChange`, the box accepts more. */
    images?: readonly ResearchImageAttachment[];
    onImagesChange?: ResearchImagesUpdate;
    /** Why the attached images cannot be sent (the agent can't read images,
     * or they exceed a message's size limit).
     * Shown under the field; Send stays disabled. */
    imageBlockReason?: string | null;
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
    images = NO_IMAGES,
    onImagesChange,
    imageBlockReason = null,
    onChange,
    onSubmit,
    onSubmitBranch,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imageInput = useResearchImageInput({
    images,
    onImagesChange,
    disabled,
    dropTarget: wrapRef,
  });
  const imageProblem = imageInput.error ?? (images.length > 0 ? imageBlockReason : null);
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
  // Send stays disabled while images are still saving or cannot be sent to
  // the agent.
  const ready =
    canSubmit &&
    value.trim().length > 0 &&
    imageInput.saving === 0 &&
    !(images.length > 0 && imageBlockReason);
  const noteId = useId();
  const imageProblemId = useId();
  const describedBy = [note ? noteId : null, imageProblem ? imageProblemId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={wrapRef}
      className={`research-composer-wrap${fullWidth ? " is-full-width" : ""}`}
      {...imageInput.fieldProps}
    >
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
      <ResearchImageStrip
        className="research-composer-images"
        images={images}
        saving={imageInput.saving}
        onRemove={
          onImagesChange && !disabled
            ? (id) => {
                imageInput.remove(id);
                // The removed × had focus.
                textareaRef.current?.focus({ preventScroll: true });
              }
            : undefined
        }
      />
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
          aria-describedby={describedBy || undefined}
          disabled={disabled}
          onChange={(event) => {
            imageInput.clearError();
            onChange(event.currentTarget.value);
          }}
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
              const imagesReady = imageInput.saving === 0 && !(images.length > 0 && imageBlockReason);
              if (value.trim() && onSubmitBranch && imagesReady) {
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
      {imageProblem ? (
        <p id={imageProblemId} className="research-composer-image-error" role="alert">
          {imageProblem}
        </p>
      ) : null}
      {agent ? <div className="research-composer-agent">{agent}</div> : null}
    </div>
  );
});

export default ResearchConversationComposer;
