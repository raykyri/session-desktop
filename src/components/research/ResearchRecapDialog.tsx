import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import {
  applyResearchRecapCandidate,
  generateResearchRecapCandidate,
  getResearchRecapDefaultInstructions,
  probeAgentAdapters,
} from "../../lib/api";
import { modelPresetsFor } from "../../lib/launcherModels";
import type {
  AgentAdapterMetadata,
  ResearchNode,
  ResearchNodeContent,
  ResearchRecapCandidate,
} from "../../types";

const MAX_INSTRUCTIONS = 4_000;

interface ResearchRecapDialogProps {
  content: ResearchNodeContent;
  onClose: () => void;
  onApplied: (node: ResearchNode) => void;
}

export default function ResearchRecapDialog({
  content,
  onClose,
  onApplied,
}: ResearchRecapDialogProps) {
  const baselineRef = useRef({
    responseRevision: content.responseRevision ?? "",
    recap: content.node.recap ?? null,
  });
  const baseline = baselineRef.current;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [adapters, setAdapters] = useState<AgentAdapterMetadata[]>([]);
  const [adapter, setAdapter] = useState("");
  const [model, setModel] = useState(baseline.recap?.model?.trim() ?? "");
  const [instructions, setInstructions] = useState(
    baseline.recap?.instructions?.trim() ?? "",
  );
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [candidate, setCandidate] = useState<ResearchRecapCandidate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [probed, defaultInstructions] = await Promise.all([
          probeAgentAdapters({ force: true }),
          getResearchRecapDefaultInstructions(),
        ]);
        if (cancelled) {
          return;
        }
        const available = probed.filter(
          (candidateAdapter) =>
            candidateAdapter.supportsRecapGeneration &&
            candidateAdapter.researchReadiness === "ready",
        );
        setAdapters(available);
        const preferred =
          available.find((candidateAdapter) => candidateAdapter.id === baseline.recap?.adapter) ??
          available.find((candidateAdapter) => candidateAdapter.id === content.node.adapter) ??
          available.find((candidateAdapter) => candidateAdapter.default) ??
          available[0];
        setAdapter(preferred?.id ?? "");
        if (!baseline.recap?.instructions?.trim()) {
          setInstructions(defaultInstructions);
        }
        if (preferred?.id === baseline.recap?.adapter) {
          setModel(baseline.recap.model?.trim() ?? "");
        } else if (preferred?.id === content.node.adapter) {
          setModel(content.node.model?.trim() ?? "");
        } else {
          setModel("");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setLoadingOptions(false);
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    baseline.recap?.adapter,
    baseline.recap?.instructions,
    baseline.recap?.model,
    content.node.adapter,
    content.node.model,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !applying) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [applying, onClose]);

  const selectedAdapter = adapters.find((candidateAdapter) => candidateAdapter.id === adapter);
  const modelPresets = useMemo(
    () => modelPresetsFor(adapter).filter((preset) => preset !== "custom"),
    [adapter],
  );

  const clearCandidate = () => {
    setCandidate(null);
    setError(null);
  };

  const generate = async () => {
    if (!adapter || !instructions.trim() || !baseline.responseRevision) {
      return;
    }
    setGenerating(true);
    setCandidate(null);
    setError(null);
    try {
      setCandidate(
        await generateResearchRecapCandidate({
          nodeId: content.node.id,
          expectedResponseRevision: baseline.responseRevision,
          adapter,
          model: model.trim() || null,
          instructions: instructions.trim(),
        }),
      );
    } catch (generationError) {
      setError(
        generationError instanceof Error ? generationError.message : String(generationError),
      );
    } finally {
      setGenerating(false);
    }
  };

  const apply = async () => {
    if (!candidate) {
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const node = await applyResearchRecapCandidate({
        nodeId: content.node.id,
        expectedResponseRevision: baseline.responseRevision,
        expectedCurrentRecapId: baseline.recap?.id ?? null,
        candidate,
      });
      onApplied(node);
      onClose();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !applying) {
          onClose();
        }
      }}
    >
      <div
        className="confirm-dialog research-recap-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-recap-dialog-title"
      >
        <header className="research-recap-dialog-header">
          <div>
            <h2 id="research-recap-dialog-title">Regenerate summary</h2>
            <p>The current summary stays unchanged until you apply a candidate.</p>
          </div>
          <button
            className="control-button"
            type="button"
            disabled={applying}
            onClick={onClose}
            aria-label="Close summary regeneration"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <label className="confirm-dialog-field-label" htmlFor="research-recap-instructions">
          Instructions
        </label>
        <textarea
          ref={textareaRef}
          id="research-recap-instructions"
          className="research-recap-instructions"
          value={instructions}
          maxLength={MAX_INSTRUCTIONS}
          disabled={loadingOptions || generating || applying}
          onChange={(event) => {
            setInstructions(event.currentTarget.value);
            clearCandidate();
          }}
        />
        <div className="research-recap-dialog-controls">
          <label>
            <span>Agent</span>
            <select
              value={adapter}
              disabled={loadingOptions || generating || applying || adapters.length === 0}
              onChange={(event) => {
                setAdapter(event.currentTarget.value);
                setModel("");
                clearCandidate();
              }}
            >
              {adapters.map((candidateAdapter) => (
                <option key={candidateAdapter.instanceId} value={candidateAdapter.id}>
                  {candidateAdapter.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Model</span>
            <input
              value={model}
              list="research-recap-model-options"
              placeholder="Agent default"
              maxLength={256}
              disabled={loadingOptions || generating || applying || !adapter}
              onChange={(event) => {
                setModel(event.currentTarget.value);
                clearCandidate();
              }}
            />
            <datalist id="research-recap-model-options">
              {modelPresets.map((preset) => (
                <option key={preset} value={preset} />
              ))}
            </datalist>
          </label>
        </div>

        {loadingOptions ? (
          <p className="research-recap-dialog-status">
            <LoaderCircle className="confirm-dialog-action-spinner" size={14} aria-hidden="true" />
            Checking available agents…
          </p>
        ) : adapters.length === 0 ? (
          <p className="confirm-dialog-error" role="alert">
            No available agent supports summary generation.
          </p>
        ) : null}

        <div className="research-recap-comparison">
          <section>
            <h3>Current</h3>
            <p>{baseline.recap?.text}</p>
          </section>
          <section className={candidate ? "has-candidate" : "is-empty"}>
            <h3>Candidate</h3>
            {generating ? (
              <p className="research-recap-dialog-status">
                <LoaderCircle
                  className="confirm-dialog-action-spinner"
                  size={14}
                  aria-hidden="true"
                />
                Generating with {selectedAdapter?.label ?? "agent"}…
              </p>
            ) : candidate ? (
              <p>{candidate.text}</p>
            ) : (
              <p>Generate a candidate to compare it with the current summary.</p>
            )}
          </section>
        </div>

        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="confirm-dialog-actions">
          <button className="control-button" type="button" disabled={applying} onClick={onClose}>
            Cancel
          </button>
          <button
            className="control-button"
            type="button"
            disabled={
              loadingOptions || generating || applying || !adapter || !instructions.trim()
            }
            onClick={() => void generate()}
          >
            {generating ? "Generating…" : candidate ? "Generate again" : "Generate candidate"}
          </button>
          {candidate ? (
            <button
              className="control-button primary"
              type="button"
              disabled={generating || applying}
              onClick={() => void apply()}
            >
              {applying ? "Applying…" : "Use this summary"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
