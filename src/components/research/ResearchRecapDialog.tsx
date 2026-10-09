import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { createPortal } from "react-dom";
import { trapResearchDialogTab, useResearchDialogReturnFocus } from "./researchFocus";
import { LauncherSelect } from "../LauncherSelect";
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

function SuggestedModelInput({
  value,
  suggestions,
  disabled,
  onChange,
}: {
  value: string;
  suggestions: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const matchingSuggestions = useMemo(() => {
    const query = value.trim().toLowerCase();
    return suggestions.filter((suggestion) => !query || suggestion.toLowerCase().includes(query));
  }, [suggestions, value]);

  const openSuggestions = () => {
    if (disabled || suggestions.length === 0) {
      return;
    }
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    }
    setActiveIndex(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (!inputRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnReflow = () => setOpen(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const choose = (suggestion: string) => {
    onChange(suggestion);
    setOpen(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <>
      <input
        ref={inputRef}
        className="settings-input research-recap-control"
        value={value}
        placeholder="Agent default"
        maxLength={256}
        disabled={disabled}
        role="combobox"
        aria-label="Model"
        aria-expanded={open && matchingSuggestions.length > 0}
        aria-controls="research-recap-model-options"
        aria-autocomplete="list"
        onFocus={openSuggestions}
        onClick={openSuggestions}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          openSuggestions();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            return;
          }
          if (event.key === "Tab") {
            setOpen(false);
            return;
          }
          if (matchingSuggestions.length === 0) {
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              openSuggestions();
              return;
            }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex(
              (index) =>
                (index + delta + matchingSuggestions.length) % matchingSuggestions.length,
            );
            return;
          }
          if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(matchingSuggestions[activeIndex] ?? matchingSuggestions[0]);
          }
        }}
      />
      {open && anchor && matchingSuggestions.length > 0
        ? createPortal(
            <div
              ref={popoverRef}
              id="research-recap-model-options"
              className="popover-surface launcher-select-popover research-recap-model-suggestions"
              role="listbox"
              aria-label="Suggested models"
              style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
            >
              {matchingSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`menu-item launcher-select-item${
                    index === activeIndex ? " is-selected" : ""
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(suggestion)}
                >
                  <span className="launcher-select-item-label">{suggestion}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

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
  useResearchDialogReturnFocus(true);

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
        onKeyDown={trapResearchDialogTab}
      >
        <header className="research-recap-dialog-header">
          <h2 id="research-recap-dialog-title">Generate summary</h2>
          <button
            className="control-button"
            type="button"
            disabled={applying}
            onClick={onClose}
            aria-label="Close summary generation"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <label
          className="confirm-dialog-field-label research-recap-instructions-field"
          htmlFor="research-recap-instructions"
        >
          <span>Instructions</span>
          <textarea
            ref={textareaRef}
            id="research-recap-instructions"
            className="settings-input research-recap-instructions"
            value={instructions}
            maxLength={MAX_INSTRUCTIONS}
            disabled={loadingOptions || generating || applying}
            onChange={(event) => {
              setInstructions(event.currentTarget.value);
              clearCandidate();
            }}
          />
        </label>
        <div className="research-recap-dialog-controls">
          <label>
            <span>Agent</span>
            <LauncherSelect
              value={adapter}
              options={adapters.map((candidateAdapter) => ({
                value: candidateAdapter.id,
                label: candidateAdapter.label,
              }))}
              ariaLabel="Agent"
              disabled={loadingOptions || generating || applying || adapters.length === 0}
              onChange={(value) => {
                setAdapter(value);
                setModel("");
                clearCandidate();
              }}
            />
          </label>
          <label>
            <span>Model</span>
            <SuggestedModelInput
              value={model}
              suggestions={modelPresets}
              disabled={loadingOptions || generating || applying || !adapter}
              onChange={(value) => {
                setModel(value);
                clearCandidate();
              }}
            />
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

        <div className="confirm-dialog-actions research-recap-generation-actions">
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
        </div>

        <div className="research-recap-comparison">
          <hr className="research-recap-comparison-divider" />
          <section className={candidate ? "research-recap-candidate" : "is-empty"}>
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
              <p>Generate a new summary first.</p>
            )}
          </section>
          <section>
            <h3>Current</h3>
            <p>{baseline.recap?.text}</p>
          </section>
        </div>

        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        {candidate ? (
          <div className="confirm-dialog-actions">
            <button
              className="control-button primary"
              type="button"
              disabled={generating || applying}
              onClick={() => void apply()}
            >
              {applying ? "Applying…" : "Use this summary"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
