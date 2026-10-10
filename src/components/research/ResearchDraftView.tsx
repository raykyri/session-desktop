import { useEffect, useRef, useState } from "react";
import type { ResearchDraft } from "../../types";
import { createResearchDraftAutosave } from "../../lib/researchDraftAutosave";
import { ResearchPairHeader } from "./ResearchDocumentChrome";
import ResearchConversationComposer, { type ResearchComposerHandle } from "./ResearchConversationComposer";

const SAVE_DELAY_MS = 500;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** An unsent draft, open beside the feed as a messages column: the
 * question as the header's title, then its ask box labelled "Draft", which
 * gives the text the full width with Send on its own row. Opening a draft
 * never focuses the box. Edits save as you type and when the view closes;
 * once a send starts nothing more is saved. A failed send keeps the view
 * open with the error. Delete is in the draft's … menu in the feed. */
export default function ResearchDraftView({
  draft,
  requireCmdEnterToSend,
  onSave,
  onSend,
}: {
  draft: ResearchDraft;
  requireCmdEnterToSend: boolean;
  onSave: (prompt: string) => Promise<void>;
  onSend: (prompt: string) => Promise<void>;
}) {
  const [value, setValue] = useState(draft.prompt);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const composerRef = useRef<ResearchComposerHandle | null>(null);
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

  useEffect(() => autosave.edit(value), [autosave, value]);
  useEffect(() => () => autosave.flush(), [autosave]);

  async function send() {
    const prompt = value.trim();
    if (!prompt || sending) return;
    setSending(true);
    setError(null);
    autosave.finish();
    try {
      await onSend(prompt);
    } catch (err) {
      autosave.resume();
      setError(errorMessage(err));
      setSending(false);
    }
  }

  const title = draft.prompt.trim() || "Draft";
  return (
    <section
      className="research-pair-turns research-draft-view is-current"
      data-research-column="T0"
      data-research-pair="turns"
      data-research-level={0}
      aria-label={`Draft: ${title}`}
    >
      <ResearchPairHeader
        title={title}
        onAsk={() => {
          composerRef.current?.focus();
          composerRef.current?.element()?.scrollIntoView({ block: "nearest" });
        }}
      />
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
