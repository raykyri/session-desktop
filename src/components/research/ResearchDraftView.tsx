import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, FilePen, Trash2, X } from "lucide-react";
import type { ResearchDraft } from "../../types";
import { createResearchDraftAutosave } from "../../lib/researchDraftAutosave";
import { isEditableTarget } from "../../lib/appHelpers";
import {
  ComposerSubmitShortcutGlyph,
  isComposerSubmitShortcut,
} from "../ComposerSubmitShortcut";
import { ResearchColumnsContext } from "./ResearchColumns";

const SAVE_DELAY_MS = 500;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** An unsent draft, open in the content column: the "Draft · Not sent"
 * header with Delete and Close (and Back to feed in single-column mode), then the question in an editable field and
 * Send. Edits save as you type and when the view closes; once a send or
 * delete starts nothing more is saved. A failed send or delete keeps the
 * view open with the error. `[` and `]` move between the feed and the
 * draft, as between conversation columns. */
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
  /** Resolves once the draft is deleted; rejects with the reason. */
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(draft.prompt);
  const [busy, setBusy] = useState<"sending" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const [autosave] = useState(() =>
    createResearchDraftAutosave({
      initial: draft.prompt,
      delayMs: SAVE_DELAY_MS,
      save: (prompt) => onSaveRef.current(prompt),
      onError: setError,
    }),
  );
  const columns = useContext(ResearchColumnsContext);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

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

  useEffect(() => autosave.edit(value), [autosave, value]);
  useEffect(() => () => autosave.flush(), [autosave]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "[" && event.key !== "]") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      const layout = columnsRef.current;
      if (!layout) return;
      if (event.key === "[" && !layout.feedFocused) {
        event.preventDefault();
        layout.focusFeed({ moveFocus: true });
      } else if (event.key === "]" && layout.feedFocused) {
        event.preventDefault();
        layout.releaseFeed();
        window.requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function send() {
    const prompt = value.trim();
    if (!prompt || busy) return;
    setBusy("sending");
    setError(null);
    autosave.finish();
    try {
      await onSend(prompt);
    } catch (err) {
      autosave.resume();
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy("deleting");
    setError(null);
    autosave.finish();
    try {
      await onDelete();
    } catch (err) {
      autosave.resume();
      autosave.edit(value);
      setError(errorMessage(err));
      setBusy(null);
    }
  }

  const ready = focused && Boolean(value.trim());
  return (
    <section
      className={`research-draft-view${columns && !columns.feedFocused ? " is-focused" : ""}`}
      aria-label="Draft"
      onFocus={() => {
        if (columnsRef.current?.feedFocused) columnsRef.current.releaseFeed();
      }}
    >
      <header className="research-column-header">
        <div className="research-column-bar" data-tauri-drag-region>
          {columns?.singleColumn ? (
            <button
              type="button"
              className="control-button research-icon-button"
              aria-label="Back to feed"
              title="Back to feed"
              onClick={() => columns.focusFeed({ moveFocus: true })}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          ) : null}
          <h2
            ref={titleRef}
            className="research-column-title is-one-line research-draft-view-title"
            tabIndex={-1}
          >
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
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              <Trash2 size={16} aria-hidden="true" />
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
          disabled={busy !== null}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              titleRef.current?.focus({ preventScroll: true });
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
            disabled={busy !== null || !value.trim()}
          >
            {busy === "sending" ? "Sending…" : "Send"}
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
