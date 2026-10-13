import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ResearchDraft, ResearchImageAttachment } from "../../types";
import { createResearchDraftAutosave, createResearchDraftImageSave } from "../../lib/researchDraftAutosave";
import { researchImages } from "../../lib/researchImages";
import { columnAttributes } from "../../lib/researchColumns";
import { isSaveShortcut } from "../../lib/editorShortcuts";
import { ResearchPairHeader } from "./ResearchColumnChrome";
import ResearchConversationComposer, { type ResearchComposerHandle } from "./ResearchConversationComposer";

const SAVE_DELAY_MS = 500;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** An unsent draft, open beside the feed as a messages column: the
 * question as the header's title, then its ask box labelled "Draft", which
 * gives the text the full width with Send on its own row. Opening a draft
 * never focuses the box. Edits save as you type and when the view closes,
 * and an added or removed image saves at once when the draft has text
 * (otherwise with the next text edit); once a send starts nothing more is
 * saved. ⌘S (Ctrl+S) saves an edit not yet saved at once and shows
 * a toast; with nothing to save it does nothing. A failed send keeps the view
 * open with the error. Delete is in the draft's … menu in the feed. */
export default function ResearchDraftView({
  draft,
  requireCmdEnterToSend,
  onSave,
  onSend,
  onToast,
}: {
  draft: ResearchDraft;
  requireCmdEnterToSend: boolean;
  /** `images` replaces the draft's images; omitted, they are kept. */
  onSave: (prompt: string, images?: ResearchImageAttachment[]) => Promise<void>;
  onSend: (prompt: string, images: ResearchImageAttachment[]) => Promise<void>;
  /** Shows the toast after a ⌘S save. */
  onToast?: (message: string) => void;
}) {
  const [value, setValue] = useState(draft.prompt);
  const [images, setImages] = useState(() => researchImages(draft.attachments));
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<ResearchComposerHandle | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const sendingRef = useRef(false);
  const [save] = useState(() =>
    createResearchDraftImageSave(images, (prompt, changed) =>
      onSaveRef.current(prompt, changed ? [...changed] : undefined),
    ),
  );
  const [autosave] = useState(() =>
    createResearchDraftAutosave({
      initial: draft.prompt,
      delayMs: SAVE_DELAY_MS,
      save: (prompt) => save(prompt, imagesRef.current),
      onError: setError,
    }),
  );

  useEffect(() => autosave.edit(value), [autosave, value]);
  useEffect(() => () => autosave.flush(), [autosave]);
  // Images save with the current text; with no text, the next text edit
  // saves them.
  const shownImagesRef = useRef(images);
  useEffect(() => {
    if (images === shownImagesRef.current || sendingRef.current || !value.trim()) return;
    shownImagesRef.current = images;
    void save(value, images).catch((err: unknown) => {
      if (!sendingRef.current) setError(errorMessage(err));
    });
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
    // Handled even when there is nothing to save, so the webview's own ⌘S
    // does not run.
    event.preventDefault();
    if (sendingRef.current) return;
    autosave.saveNow().then(
      (wrote) => {
        if (wrote) onToast?.("Draft saved.");
      },
      // The autosave's onError shows the failure under the box.
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
