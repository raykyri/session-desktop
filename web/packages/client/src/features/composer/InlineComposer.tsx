// The inline composer (02 §5, the mock's `composer`): asks on a thread,
// comments and replies. A growing field, an optional Close button and a text
// submit ("Ask", "Comment", "Reply"). ⌘↵ (Ctrl↵ elsewhere) sends, Enter is a
// newline, Escape closes it and keeps the draft. The text lives in `drafts`
// under the composer's key, so it survives a route change, a reload and a
// refused write.

import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { scrollIntoPadded } from "../../lib/motion.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { CloseIcon } from "../feed/icons.js";

/** A Base UI layer that owns Escape while open. */
const OPEN_LAYER =
  '[data-open][role="dialog"],[data-open][role="menu"],[data-open][role="alertdialog"]';

export function growField(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

export function isSendChord(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

export interface InlineComposerProps {
  draftKey: string;
  placeholder: string;
  submitLabel: string;
  /** Resolves true when the write was accepted: the field empties. */
  onSubmit: (text: string) => Promise<boolean>;
  /** Without it there is no Close button. */
  onClose?: (() => void) | undefined;
  /** Scroll the composer into view and focus it when it opens. */
  focusOnOpen?: boolean;
}

export function InlineComposer({
  draftKey,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
  focusOnOpen = true,
}: InlineComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = useDraftsStore((state) => (state.hidden ? undefined : state.byKey[draftKey]));
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);
  const [text, setText] = useState(draft?.text ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (field.current && text) growField(field.current);
    if (focusOnOpen) scrollIntoPadded(field.current);
    // Once, when the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || busy) {
      field.current?.focus();
      return;
    }
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) {
      setText("");
      clearDraft(draftKey);
    }
  };

  return (
    <form className="icomp" onSubmit={(event) => void submit(event)}>
      <textarea
        ref={field}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDraft(draftKey, event.target.value);
          growField(event.target);
        }}
        onKeyDown={(event) => {
          if (isSendChord(event)) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape" && onClose && !document.querySelector(OPEN_LAYER)) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      {onClose ? (
        <button type="button" className="cx" aria-label="Close" title="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      ) : null}
      <button type="submit" className="send-text">
        {submitLabel}
      </button>
    </form>
  );
}
