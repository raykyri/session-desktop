// Regenerating an answer's summary (`09-research-document-view.md` §2, §8).
//
// Instructions in, candidate out, apply on approval. The desktop's adapter and
// model pickers are gone: every metadata run is `gemini-flash`
// (`04-agent-runtime.md` §9), so the only thing left to choose is what to ask
// for.
//
// Both calls carry the response revision the dialog opened against, and apply
// also carries the recap id it is replacing, so a summary generated against an
// answer that has since been re-run is refused by the server rather than
// silently attached to different text.

import { MAX_RECAP_INSTRUCTIONS_CHARS } from "@session/shared";
import type { ResearchNode, ResearchNodeContent, ResearchRecapCandidate } from "@session/shared";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import {
  applyResearchRecapCandidate,
  generateResearchRecapCandidate,
  getResearchRecapDefaultInstructions,
} from "../../api/api.js";
import { ControlButton } from "../../ui/Button.js";
import { ConfirmDialogActionButton, Dialog } from "../../ui/Dialog.js";
import { Textarea } from "../../ui/Field.js";

export interface RecapDialogProps {
  content: ResearchNodeContent;
  open: boolean;
  onClose: () => void;
  onApplied: (node: ResearchNode) => void;
}

export function RecapDialog({ content, open, onClose, onApplied }: RecapDialogProps) {
  // Pinned when the dialog opens: the node keeps streaming events while it is
  // up, and a concurrency token that moved under the reader would turn every
  // apply into a refusal.
  const [baseline] = useState(() => ({
    responseRevision: content.responseRevision ?? "",
    recap: content.node.recap ?? null,
  }));

  const [instructions, setInstructions] = useState(baseline.recap?.instructions?.trim() ?? "");
  const [loadingDefaults, setLoadingDefaults] = useState(true);
  const [candidate, setCandidate] = useState<ResearchRecapCandidate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getResearchRecapDefaultInstructions()
      .then((defaults) => {
        if (cancelled) return;
        // Never clobber instructions the reader typed while the default was in
        // flight, or the ones the current recap was generated with.
        setInstructions((current) => current || defaults);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingDefaults(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const generate = () => {
    if (!instructions.trim() || !baseline.responseRevision) return;
    setGenerating(true);
    setCandidate(null);
    setError(null);
    generateResearchRecapCandidate({
      nodeId: content.node.id,
      expectedResponseRevision: baseline.responseRevision,
      instructions: instructions.trim(),
    })
      .then(setCandidate)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setGenerating(false));
  };

  const apply = () => {
    if (!candidate) return;
    setApplying(true);
    setError(null);
    applyResearchRecapCandidate({
      nodeId: content.node.id,
      expectedResponseRevision: baseline.responseRevision,
      expectedCurrentRecapId: baseline.recap?.id ?? null,
      candidate,
    })
      .then((node) => {
        onApplied(node);
        onClose();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setApplying(false));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying) onClose();
      }}
      title="Generate summary"
      className="w-[min(560px,calc(100vw-32px))]"
      footer={
        <>
          <ControlButton disabled={applying} onClick={onClose}>
            Cancel
          </ControlButton>
          <ControlButton
            disabled={loadingDefaults || generating || applying || !instructions.trim()}
            onClick={generate}
          >
            {generating ? "Generating…" : candidate ? "Generate again" : "Generate candidate"}
          </ControlButton>
          {candidate ? (
            <ConfirmDialogActionButton
              pending={applying}
              pendingLabel="Applying…"
              disabled={generating}
              onClick={apply}
            >
              Use this summary
            </ConfirmDialogActionButton>
          ) : null}
        </>
      }
    >
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="research-recap-instructions">
        <span className="text-fg-secondary">Instructions</span>
        <Textarea
          id="research-recap-instructions"
          value={instructions}
          maxLength={MAX_RECAP_INSTRUCTIONS_CHARS}
          rows={5}
          disabled={loadingDefaults || generating || applying}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
            setCandidate(null);
            setError(null);
          }}
        />
      </label>
      <section className="mt-4">
        <h3 className="text-fg-subtle m-0 text-xs font-semibold tracking-wide uppercase">
          Candidate
        </h3>
        {generating ? (
          <p className="text-fg-muted mt-1 flex items-center gap-2 text-sm">
            <LoaderCircle className="session-spin" size={14} aria-hidden="true" />
            Generating…
          </p>
        ) : (
          <p className="text-fg-primary mt-1 text-sm">
            {candidate?.text ?? "Generate a new summary first."}
          </p>
        )}
      </section>
      <section className="mt-3">
        <h3 className="text-fg-subtle m-0 text-xs font-semibold tracking-wide uppercase">
          Current
        </h3>
        <p className="text-fg-muted mt-1 text-sm">{baseline.recap?.text ?? "No summary yet."}</p>
      </section>
      {error ? (
        <p className="text-status-failed mt-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
