import { useEffect, useId, useRef, useState } from "react";
import AgentSetupCommand from "./AgentSetupCommand";
import AgentDiagnostics from "./AgentDiagnostics";
import { ArrowRight, Check, CircleCheck, ExternalLink, RefreshCw } from "lucide-react";
import type { AgentAdapterMetadata } from "../types";
import { ADAPTER_ICON_BY_ID, adapterIconClassName } from "../lib/adapterIcons";
import {
  adapterSetupIsComplete,
  agentResearchState,
  agentSetupIntro,
  agentSetupStatusLabel,
  agentSetupSteps,
} from "../lib/agentSetup";
import { openExternalUrl } from "../lib/api";

interface AgentSetupGuideProps {
  adapters: readonly AgentAdapterMetadata[];
  /** The agent instance selected when the guide mounts. Null, or an id no
   * longer in `adapters`, selects the first agent whose setup is incomplete.
   * The selection then stays put while statuses change, so an agent that
   * becomes ready keeps its completion state on screen. */
  initialInstanceId?: string | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
  /** Selects the agent in the research composer and moves focus there. When
   * set, a ready agent offers "Start research with …", and an agent whose
   * sign-in could not be verified offers "Try research with …". */
  onStartResearch?: (adapter: AgentAdapterMetadata) => void;
}

function firstIncompleteInstanceId(adapters: readonly AgentAdapterMetadata[]) {
  return (
    adapters.find((adapter) => !adapterSetupIsComplete(adapter)) ?? adapters[0] ?? null
  )?.instanceId ?? null;
}

export default function AgentSetupGuide({
  adapters,
  initialInstanceId = null,
  loading,
  error,
  onRefresh,
  onCopied,
  onError,
  onStartResearch,
}: AgentSetupGuideProps) {
  const tabsId = useId();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(() =>
    initialInstanceId && adapters.some((adapter) => adapter.instanceId === initialInstanceId)
      ? initialInstanceId
      : firstIncompleteInstanceId(adapters),
  );
  const intro = agentSetupIntro(adapters);
  const selected =
    adapters.find((adapter) => adapter.instanceId === selectedInstanceId) ??
    adapters.find((adapter) => adapter.instanceId === firstIncompleteInstanceId(adapters)) ??
    null;
  // Keep the shown agent selected: without this, an agent that became ready
  // would hand the panel to the next incomplete one and hide its completion.
  useEffect(() => {
    if (selected && selected.instanceId !== selectedInstanceId) {
      setSelectedInstanceId(selected.instanceId);
    }
  }, [selected, selectedInstanceId]);

  function selectNextAgent() {
    if (!selected || adapters.length < 2) {
      return;
    }
    const index = adapters.findIndex((adapter) => adapter.instanceId === selected.instanceId);
    setSelectedInstanceId(adapters[(index + 1) % adapters.length].instanceId);
  }

  const state = selected ? agentResearchState(selected) : null;
  const steps = selected ? agentSetupSteps(selected) : [];
  const activeIndex = steps.findIndex((step) => !step.done);
  const selectedIndex = selected
    ? adapters.findIndex((adapter) => adapter.instanceId === selected.instanceId)
    : -1;
  const panelId = `${tabsId}-panel`;
  const startAction =
    selected && onStartResearch && (state === "ready" || state === "unverified")
      ? state === "ready"
        ? `Start research with ${selected.label}`
        : `Try research with ${selected.label}`
      : null;

  const refresh = () => {
    if (!loading) onRefresh();
  };
  // When a refresh shows the selected agent ready, move focus from the
  // refresh button to the start action that replaced it as the next step.
  const refreshCurrentRef = useRef<HTMLButtonElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const previousStateRef = useRef(state);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (
      state === "ready" &&
      previous !== "ready" &&
      document.activeElement === refreshCurrentRef.current
    ) {
      startRef.current?.focus({ preventScroll: true });
    }
  }, [state]);

  return (
    <div className="agent-setup">
      <div className="agent-setup-head">
        <div className="agent-setup-intro">
          <h3>{intro.heading}</h3>
          <p>{intro.body}</p>
        </div>
      </div>
      {error ? (
        <p className="agent-setup-error" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <>
          <div className="agent-setup-tabs-row">
            <div className="agent-setup-tabs" role="tablist" aria-label="Agents">
              {adapters.map((adapter, index) => (
                <button
                  key={adapter.instanceId}
                  id={`${tabsId}-tab-${index}`}
                  type="button"
                  role="tab"
                  className="agent-setup-tab"
                  aria-selected={adapter.instanceId === selected.instanceId}
                  aria-controls={panelId}
                  onClick={() => setSelectedInstanceId(adapter.instanceId)}
                >
                  <span
                    className={`agent-setup-dot${adapterSetupIsComplete(adapter) ? " is-ready" : ""}`}
                    aria-hidden="true"
                  />
                  {adapter.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="control-button agent-setup-refresh"
              // Not disabled while checking: a disabled button would drop
              // keyboard focus to the page.
              aria-disabled={loading || undefined}
              aria-label={loading ? "Checking all agent statuses" : "Refresh all agent statuses"}
              title={loading ? "Checking all agent statuses" : "Refresh all agent statuses"}
              onClick={refresh}
            >
              <RefreshCw
                size={13}
                className={loading ? "is-spinning" : undefined}
                aria-hidden="true"
              />
            </button>
          </div>
          <div
            id={panelId}
            className="agent-setup-panel"
            role="tabpanel"
            aria-labelledby={`${tabsId}-tab-${selectedIndex}`}
          >
            <div className="agent-setup-panel-head">
              <img
                src={ADAPTER_ICON_BY_ID[selected.id]}
                className={`agent-setup-icon ${adapterIconClassName(selected.id) ?? ""}`}
                alt=""
                aria-hidden="true"
              />
              <h4>{selected.label}</h4>
              <span className={`agent-setup-status is-${state}`}>
                {agentSetupStatusLabel(selected)}
              </span>
            </div>
            <ol className="agent-setup-steps">
              {steps.map((step, index) => {
                const stepState = step.done ? "is-done" : index === activeIndex ? "is-active" : "";
                return (
                  <li key={step.title} className={`agent-setup-step ${stepState}`}>
                    <span className="agent-setup-step-number" aria-hidden="true">
                      {step.done ? <Check size={12} /> : index + 1}
                    </span>
                    <div className="agent-setup-step-body">
                      <span className="agent-setup-step-title">{step.title}</span>
                      {step.command && index === activeIndex ? (
                        <AgentSetupCommand
                          command={step.command}
                          onCopied={onCopied}
                          onError={onError}
                        />
                      ) : null}
                      {step.hint && index === activeIndex ? (
                        <span className="agent-setup-hint">{step.hint}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            {state === "ready" ? (
              <div className="agent-setup-complete" role="status">
                <CircleCheck size={16} aria-hidden="true" />
                <div>
                  <p className="agent-setup-complete-title">
                    {selected.label} is ready for research.
                  </p>
                  <p className="agent-setup-hint">
                    One ready agent is enough. Setting up other agents is optional.
                  </p>
                </div>
              </div>
            ) : null}
            {state !== "ready" && state !== "unchecked" ? (
              <AgentDiagnostics adapter={selected} />
            ) : null}
            <div className="agent-setup-foot">
              {selected.installUrl ? (
                <button
                  type="button"
                  className="control-button"
                  onClick={() => {
                    void openExternalUrl(selected.installUrl ?? "").catch((err) => {
                      onError(err instanceof Error ? err.message : String(err));
                    });
                  }}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>Setup guide</span>
                </button>
              ) : (
                <span />
              )}
              <div className="agent-setup-foot-actions">
                {adapters.length > 1 && state !== "ready" ? (
                  <button type="button" className="control-button" onClick={selectNextAgent}>
                    Next agent
                  </button>
                ) : null}
                <button
                  ref={refreshCurrentRef}
                  type="button"
                  className={`control-button agent-setup-refresh-current${
                    state === "ready" ? "" : " is-primary"
                  }`}
                  aria-disabled={loading || undefined}
                  aria-label={loading ? "Checking agent status" : "Refresh agent status"}
                  title={loading ? "Checking agent status" : "Refresh agent status"}
                  onClick={refresh}
                >
                  <RefreshCw
                    size={13}
                    className={loading ? "is-spinning" : undefined}
                    aria-hidden="true"
                  />
                </button>
                {startAction ? (
                  <button
                    ref={startRef}
                    type="button"
                    className={`control-button agent-setup-start${
                      state === "ready" ? " is-primary" : ""
                    }`}
                    onClick={() => onStartResearch?.(selected)}
                  >
                    <span>{startAction}</span>
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="agent-setup-hint">No agent CLIs are configured.</p>
      )}
    </div>
  );
}
