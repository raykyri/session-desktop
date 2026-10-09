import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FilePen, Trash2, X } from "lucide-react";
import type { ResearchDraft } from "../../types";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";

const SAVE_DELAY_MS = 500;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** An unsent draft, open in the content column: the "Draft · Not sent"
 * header with Delete and Close, then the question in an editable field and
 * Send. Edits save as you type and when the view closes; a deleted or sent
 * draft saves nothing more. */
export default function ResearchDraftView({
  draft,
  requireCmdEnterToSend,
  onSave,
  onSend,
  onDelete,
  onClose,
}: {
  draft: ResearchDraft;
  requireCmdEnterToSend: boolean;
  onSave: (prompt: string) => Promise<void>;
  onSend: (prompt: string) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(draft.prompt);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const savedRef = useRef(draft.prompt);
  const valueRef = useRef(value);
  valueRef.current = value;
  // Set before a delete or send, so the unmount flush can't recreate or
  // touch a draft that no longer exists.
  const finishedRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const save = (prompt: string) => {
    savedRef.current = prompt;
    void onSaveRef.current(prompt).catch((err: unknown) => {
      if (!finishedRef.current) setError(errorMessage(err));
    });
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (!value.trim() || value === savedRef.current) return;
    const timer = window.setTimeout(() => save(value), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  useEffect(
    () => () => {
      const latest = valueRef.current;
      if (!finishedRef.current && latest.trim() && latest !== savedRef.current) save(latest);
    },
    [],
  );

  async function send() {
    const prompt = value.trim();
    if (!prompt || sending) return;
    setSending(true);
    setError(null);
    finishedRef.current = true;
    try {
      await onSend(prompt);
    } catch (err) {
      finishedRef.current = false;
      setError(errorMessage(err));
      setSending(false);
    }
  }

  const ready = focused && Boolean(value.trim());
  return (
    <section className="research-draft-view" aria-label="Draft">
      <header className="research-column-header">
        <div className="research-column-bar" data-tauri-drag-region>
          <h2 className="research-column-title is-one-line research-draft-view-title" tabIndex={-1}>
            <FilePen size={14} aria-hidden="true" />
            Draft · Not sent
          </h2>
          <span className="research-column-spacer" data-tauri-drag-region />
          <span className="research-column-actions">
            <button
              type="button"
              className="control-button research-icon-button"
              aria-label="Delete draft"
              title="Delete draft"
              onClick={() => {
                finishedRef.current = true;
                onDelete();
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="control-button research-icon-button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        </div>
      </header>
      <form
        className={`research-draft-view-body${ready ? " is-ready" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={textareaRef}
          className="research-draft-view-input"
          rows={5}
          value={value}
          aria-label="Draft question"
          disabled={sending}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !value.trim()) {
              event.preventDefault();
              return;
            }
            if (isComposerSubmitShortcut(event, requireCmdEnterToSend)) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {error ? (
          <div className="research-feed-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="research-draft-view-row">
          <span className="research-feed-header-spacer" />
          <button
            type="submit"
            className="research-feed-button is-primary"
            disabled={sending || !value.trim()}
          >
            {sending ? "Sending…" : "Send"}
            {ready ? (
              <ComposerSubmitShortcutGlyph
                requireCmdEnter={requireCmdEnterToSend}
                className="research-feed-enter"
                ariaHidden
              />
            ) : null}
          </button>
        </div>
      </form>
    </section>
  );
}
