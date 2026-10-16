import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ResearchDraft, ResearchImageAttachment } from "../../types";
import { createResearchDraftAutosave, createResearchDraftImageSave } from "../../lib/researchDraftAutosave";
import { researchImages } from "../../lib/researchImages";
import { columnAttributes } from "@session/shared/lib/researchColumns";
import { isSaveShortcut } from "../../lib/editorShortcuts";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import ResearchConversationComposer, { type ResearchComposerHandle } from "./ResearchConversationComposer";

const SAVE_DELAY_MS = 500;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Unsent draft view displayed alongside the feed. Edits are autosaved after
 * an input debounce delay and on unmount. Image changes save immediately when the
 * draft contains text, or defer to the next text edit. Keyboard shortcut
 * ⌘S (Ctrl+S) triggers an immediate save. Failed saves retain unpersisted
 * state so subsequent saves and unmounts retry persistence. If sending
 * fails, the view remains open and displays the error. */
export default function ResearchDraftView({
  draft,
  requireCmdEnterToSend,
  onSave,
  onSend,
  onToast,
}: {
  draft: ResearchDraft;
  requireCmdEnterToSend: boolean;
  /** When provided, `images` replaces the draft's image attachments; otherwise existing images are kept. */
  onSave: (prompt: string, images?: ResearchImageAttachment[]) => Promise<void>;
  onSend: (prompt: string, images: ResearchImageAttachment[]) => Promise<void>;
  /** Displays a toast notification after a ⌘S save. */
  onToast?: (message: string) => void;
}) {
  const [value, setValue] = useState(draft.prompt);
  const [images, setImages] = useState(() => researchImages(draft.attachments));
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const valueRef = useRef(value);
  valueRef.current = value;
  // Images from the last successful save. Unsaved changes persist across retry attempts.
  const savedImagesRef = useRef(images);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<ResearchComposerHandle | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const sendingRef = useRef(false);
  const [save] = useState(() => {
    const saveChanged = createResearchDraftImageSave(images, (prompt, changed) =>
      onSaveRef.current(prompt, changed ? [...changed] : undefined),
    );
    return async (prompt: string, current: ResearchImageAttachment[]) => {
      await saveChanged(prompt, current);
      savedImagesRef.current = current;
    };
  });
  const [autosave] = useState(() =>
    createResearchDraftAutosave({
      initial: draft.prompt,
      delayMs: SAVE_DELAY_MS,
      save: (prompt) => save(prompt, imagesRef.current),
      onError: setError,
    }),
  );

  /** Persists pending image changes with the current prompt text.
   * Returns null when no changes are pending. */
  const saveUnsavedImages = () => {
    const current = imagesRef.current;
    if (current === savedImagesRef.current || sendingRef.current || !valueRef.current.trim()) return null;
    const saving = save(valueRef.current, current);
    saving.catch((err: unknown) => {
      if (!sendingRef.current) setError(errorMessage(err));
    });
    return saving;
  };
  useEffect(() => autosave.edit(value), [autosave, value]);
  useEffect(
    () => () => {
      if (!autosave.flush()) void saveUnsavedImages()?.catch(() => {});
    },
    [autosave],
  );
  // Persist image changes with the current prompt; if prompt is empty,
  // persistence is deferred to text autosave.
  useEffect(() => {
    void saveUnsavedImages()?.catch(() => {});
    // Saves on image changes only; text edits go through autosave.
  }, [images]);

  async function send() {
    const prompt = value.trim();
    if (!prompt || sending) return;
    setSending(true);
    sendingRef.current = true;
    setError(null);
    autosave.finish();
    try {
      await onSend(prompt, images);
    } catch (err) {
      autosave.resume();
      sendingRef.current = false;
      setError(errorMessage(err));
      setSending(false);
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSaveShortcut(event)) return;
    // Prevent default browser save behavior even when no changes are pending.
    event.preventDefault();
    if (sendingRef.current) return;
    autosave
      .saveNow()
      .then(async (wrote) => {
        if (wrote) return true;
        const saving = saveUnsavedImages();
        if (!saving) return false;
        await saving;
        return true;
      })
      .then(
        (wrote) => {
          if (wrote) onToast?.("Draft saved.");
        },
        // Save errors are reported via onError.
        () => {},
      );
  };

  const title = draft.prompt.trim() || "Draft";
  return (
    <section
      className="research-pair-messages research-draft-view is-current"
      {...columnAttributes({ id: "T0", role: "draft", draftId: draft.id })}
      aria-label={`Draft: ${title}`}
      onKeyDown={onKeyDown}
    >
      <ResearchPairHeader title={title} />
      <div className="research-column-scroll">
        <div className="research-column-content research-reading-surface">
          <ResearchConversationComposer
            ref={composerRef}
            value={value}
            placeholder="Write the question"
            ariaLabel="Draft question"
            mode={{ label: <b>Draft</b> }}
            fullWidth
            disabled={sending}
            canSubmit={!sending}
            submitting={sending}
            note={error ? <span role="alert">{error}</span> : null}
            requireCmdEnter={requireCmdEnterToSend}
            images={images}
            onImagesChange={(update) => setImages((current) => update(current))}
            onChange={(next) => {
              setValue(next);
              setError(null);
            }}
            onSubmit={() => void send()}
          />
        </div>
      </div>
    </section>
  );
}
