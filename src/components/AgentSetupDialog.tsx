import { useEffect } from "react";
import { X } from "lucide-react";
import AgentSetupGuide from "./AgentSetupGuide";
import type { AgentAdapterMetadata } from "../types";

interface AgentSetupDialogProps {
  adapters: AgentAdapterMetadata[];
  /** The agent instance the guide opens on; null selects the first agent
   * whose setup is incomplete. */
  initialInstanceId: string | null;
  loading: boolean;
  error: string | null;
  /** Probes agent readiness; called when the dialog opens. */
  onProbe: () => Promise<unknown>;
  onRefresh: () => void;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
  /** "Start research with …": closes the dialog and returns to the research
   * composer with the agent selected. */
  onStartResearch: (adapter: AgentAdapterMetadata) => void;
  onClose: () => void;
}

/** The Agent Setup dialog. Mounted while open; opening it re-probes readiness. */
export default function AgentSetupDialog({
  adapters,
  initialInstanceId,
  loading,
  error,
  onProbe,
  onRefresh,
  onCopied,
  onError,
  onStartResearch,
  onClose,
}: AgentSetupDialogProps) {
  useEffect(() => {
    void onProbe().catch(() => undefined);
  }, [onProbe]);

  return (
    <div
      className="settings-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agents-title"
      >
        <div className="settings-header">
          <h2 id="agents-title">Agent Setup</h2>
          <button
            type="button"
            className="control-button settings-close"
            aria-label="Close agent setup"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="settings-content">
          <AgentSetupGuide
            adapters={adapters}
            initialInstanceId={initialInstanceId}
            loading={loading}
            error={error}
            onRefresh={onRefresh}
            onCopied={onCopied}
            onError={onError}
            onStartResearch={onStartResearch}
          />
        </div>
      </div>
    </div>
  );
}
