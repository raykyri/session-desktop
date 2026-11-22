// The inline composer (02 §5, the mock's `composer`): asks on a thread,
// comments and replies. A growing field, an optional Close button and a text
// submit ("Ask", "Comment", "Reply"). ⌘↵ (Ctrl↵ elsewhere) sends, Enter is a
// newline. While it has focus it is a layer of the Escape stack
// (`OVERLAY_PRIORITY.inlineComposer`, 02 §10.2): Escape closes it and keeps
// the draft. After Escape, Close or a send, focus goes where 02 §10.1 says
// (`returnFocus`: the selected tree row, or the control that opened it).
// The text lives in `drafts` under the composer's key, so it survives a
// route change, a reload and a refused write.

import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../lib/cn.js";
import { scrollIntoPadded } from "../../lib/motion.js";
import type { DraftRef } from "../../replica/source.js";
import { useDraftsStore } from "../../stores/drafts.js";
import { OVERLAY_PRIORITY, useOverlaysStore } from "../../stores/overlays.js";
import { CloseIcon } from "../feed/icons.js";

export function growField(field: HTMLTextAreaElement): void {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

export function isSendChord(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

/** Focuses what `target` finds once the DOM has settled (a closed composer
 * or a deleted item has gone by then). */
export function focusSoon(target: (() => HTMLElement | null | undefined) | undefined): void {
  if (!target) return;
  requestAnimationFrame(() => target()?.focus({ preventScroll: true }));
}

export interface InlineComposerProps {
  draftKey: string;
  placeholder: string;
  submitLabel: string;
  /** Resolves true when the write was accepted: the field empties. */
  /** Sends the text; `draft` names this composer and the text sent, for
   * the write to return it here when it is discarded or refused. */
  onSubmit: (text: string, draft: DraftRef) => Promise<boolean>;
  /** Closes the composer (Escape, and Close when it is shown). */
  onClose: () => void;
  /** Whether the composer draws its own Close button (a quoted composer's
   * Close sits on the quote). */
  showClose?: boolean;
  /** Where focus goes after Escape, Close or a send. */
  returnFocus?: () => HTMLElement | null | undefined;
  /** Scroll the composer into view and focus it when it opens. */
  focusOnOpen?: boolean;
}

export function InlineComposer({
  draftKey,
  placeholder,
  submitLabel,
  onSubmit,
  onClose,
  showClose = true,
  returnFocus,
  focusOnOpen = true,
}: InlineComposerProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const draft = useDraftsStore((state) => (state.hidden ? undefined : state.byKey[draftKey]));
  const setDraft = useDraftsStore((state) => state.setDraft);
  const clearDraft = useDraftsStore((state) => state.clearDraft);
  const [text, setText] = useState(draft?.text ?? "");
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const register = useOverlaysStore((state) => state.register);
  const unregister = useOverlaysStore((state) => state.unregister);
  const layer = `composer:${useId()}`;

  const close = () => {
    onClose();
    focusSoon(returnFocus);
  };
  // The Escape layer calls the latest `close`.
  const latestClose = useRef(close);
  useLayoutEffect(() => {
    latestClose.current = close;
  });
  const escape = useRef(() => latestClose.current());
  const enter = () => register(layer, OVERLAY_PRIORITY.inlineComposer, escape.current);

  useEffect(() => {
    if (field.current && text) growField(field.current);
    if (focusOnOpen) scrollIntoPadded(field.current);
    // Focus that arrived before this effect (or survived a remount of it)
    // fires no focus event, so the layer is entered here too.
    if (form.current?.contains(document.activeElement)) enter();
    return () => unregister(layer);
    // Once, when the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Any text puts Close and the submit button on a row under the field; its
  // height is measured again at its new width.
  const open = text !== "";
  useLayoutEffect(() => {
    if (field.current && open) growField(field.current);
  }, [open]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || busy.current) {
      field.current?.focus();
      return;
    }
    busy.current = true;
    setSending(true);
    const sent = text;
    const ok = await onSubmit(value, { key: draftKey, text: sent });
    busy.current = false;
    setSending(false);
    if (ok) {
      // Text typed while the write was in flight stays.
      const now = useDraftsStore.getState().byKey[draftKey]?.text ?? "";
      if (now === sent || now === "") {
        setText("");
        clearDraft(draftKey);
      }
      focusSoon(returnFocus);
    }
  };

  return (
    <form
      className={cn("icomp", open && "open")}
      onSubmit={(event) => void submit(event)}
      ref={form}
      onFocus={enter}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) unregister(layer);
      }}
    >
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
          }
        }}
      />
      {showClose ? (
        <button type="button" className="cx" aria-label="Close" title="Close" onClick={close}>
          <CloseIcon />
        </button>
      ) : null}
      <button type="submit" className="send-text" disabled={sending} aria-busy={sending}>
        {submitLabel}
      </button>
    </form>
  );
}

/** The selected row of a thread's side column, or `fallback`. */
export function selectedRowOr(thread: string, fallback: string): () => HTMLElement | null {
  return () =>
    document.querySelector<HTMLElement>(
      `[data-side="${thread}"] [role="treeitem"][aria-selected="true"]`,
    ) ?? document.querySelector<HTMLElement>(fallback);
}
