import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import type { AgentAdapterMetadata } from "../../types";
import AgentSetupCommand from "../AgentSetupCommand";
import AgentDiagnostics from "../AgentDiagnostics";
import {
  agentResearchState,
  agentSetupStatusLabel,
  agentSignInUnverifiedText,
} from "../../lib/agentSetup";

/** What the sign-in repair panel needs from the app: the agents' last probed
 * readiness and a way to probe again. Provided around the thread page. */
export interface ResearchAgentRepair {
  adapters: readonly AgentAdapterMetadata[];
  /** Probes agent readiness again, bypassing the backend's probe cache, and
   * resolves to the probed agents. */
  verify: () => Promise<readonly AgentAdapterMetadata[]>;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
}

export const ResearchAgentRepairContext = createContext<ResearchAgentRepair | null>(null);

/** Research runs on this Mac, so a failed run's agent is the local instance
 * of the adapter the run used, whichever agent Home has selected. */
export function repairAgentFor(
  adapters: readonly AgentAdapterMetadata[],
  adapterId: string,
): AgentAdapterMetadata | null {
  return (
    adapters.find((adapter) => adapter.id === adapterId && adapter.target.kind === "local") ??
    null
  );
}

const ADAPTER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
};

interface SignInRepairOutcome {
  kind: "verified" | "unverified" | "signedOut" | "blocked" | "checkFailed";
  message: string;
  /** Whether Retry is available after a successful or inconclusive check. */
  canRetry: boolean;
}

/** Result of an explicit sign-in check. `adapter` is null if the probe no
 * longer reports the agent. Inconclusive checks allow a manual retry. */
export function signInRepairOutcome(
  label: string,
  adapter: AgentAdapterMetadata | null,
  probeError: string | null,
): SignInRepairOutcome {
  if (probeError) {
    return {
      kind: "checkFailed",
      message: `The status check failed: ${probeError}`,
      canRetry: false,
    };
  }
  if (!adapter) {
    return { kind: "blocked", message: `${label} is no longer configured.`, canRetry: false };
  }
  switch (agentResearchState(adapter)) {
    case "ready":
      return {
        kind: "verified",
        message: `${label} is signed in. Retry this question with ${label}.`,
        canRetry: true,
      };
    case "unverified":
      return {
        kind: "unverified",
        message: `${agentSignInUnverifiedText(adapter)} Retry this question to try connecting.`,
        canRetry: true,
      };
    case "needsAuth":
      return {
        kind: "signedOut",
        message: `${label} is still not signed in. Complete sign-in in Terminal, then verify again.`,
        canRetry: false,
      };
    default:
      return {
        kind: "blocked",
        message: [agentSetupStatusLabel(adapter), adapter.message].filter(Boolean).join(". "),
        canRetry: false,
      };
  }
}

interface SignInRepairViewProps {
  label: string;
  loginCommand: string | null;
  /** The agent's last probed metadata, for the Details disclosure. */
  agent?: AgentAdapterMetadata | null;
  checking: boolean;
  outcome: SignInRepairOutcome | null;
  retrying: boolean;
  headingRef?: React.Ref<HTMLHeadingElement>;
  retryRef?: React.Ref<HTMLButtonElement>;
  verifyRef?: React.Ref<HTMLButtonElement>;
  onCopied: (message: string) => void;
  onError: (message: string) => void;
  onVerify: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/** Sign-in command, latest check result, and repair actions. */
export function SignInRepairView({
  label,
  loginCommand,
  agent = null,
  checking,
  outcome,
  retrying,
  headingRef,
  retryRef,
  verifyRef,
  onCopied,
  onError,
  onVerify,
  onRetry,
  onClose,
}: SignInRepairViewProps) {
  const headingId = useId();
  const verified = outcome?.kind === "verified";
  return (
    <section className="research-repair" aria-labelledby={headingId}>
      <h4 id={headingId} ref={headingRef} tabIndex={-1} className="research-repair-title">
        Sign in to {label}
      </h4>
      <p className="research-repair-text">
        {loginCommand
          ? "Run this command in Terminal, finish signing in, then verify here."
          : `Follow ${label}'s sign-in steps, then verify here.`}
      </p>
      {loginCommand ? (
        <AgentSetupCommand command={loginCommand} onCopied={onCopied} onError={onError} />
      ) : null}
      <p
        className={`research-repair-result${outcome && !checking ? ` is-${outcome.kind}` : ""}`}
        role="status"
      >
        {checking ? `Checking ${label}…` : (outcome?.message ?? "")}
      </p>
      {agent ? <AgentDiagnostics adapter={agent} /> : null}
      <div className="research-turn-actions">
        <button
          ref={verifyRef}
          className={`control-button research-turn-button${verified ? " is-ghost" : ""}`}
          type="button"
          // Not disabled while checking, so keyboard focus stays here.
          aria-disabled={checking || undefined}
          onClick={() => {
            if (!checking) onVerify();
          }}
        >
          {checking ? (
            <LoaderCircle className="research-spinner" size={13} aria-hidden="true" />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          <span>{outcome ? "Check again" : "Verify sign-in"}</span>
        </button>
        {outcome?.canRetry && !checking ? (
          <button
            ref={retryRef}
            className={`control-button research-turn-button${verified ? "" : " is-ghost"}`}
            type="button"
            aria-disabled={retrying || undefined}
            onClick={() => {
              if (!retrying) onRetry();
            }}
          >
            {retrying ? (
              <LoaderCircle className="research-spinner" size={13} aria-hidden="true" />
            ) : (
              <RotateCcw size={13} aria-hidden="true" />
            )}
            <span>{retrying ? "Retrying…" : "Retry this question"}</span>
          </button>
        ) : null}
        <button className="control-button research-turn-button is-ghost" type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/** Repairs the sign-in of the agent a failed run used, inline under the
 * run's error: the agent's sign-in command, an explicit verification (a
 * forced readiness probe), and then Retry this question, which uses the
 * thread's ordinary retry of the same node. Nothing retries on its own. */
export default function ResearchSignInRepair({
  adapterId,
  retrying,
  onRetry,
  onClose,
}: {
  /** The failed run's adapter. */
  adapterId: string;
  retrying: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const repair = useContext(ResearchAgentRepairContext);
  const known = repair ? repairAgentFor(repair.adapters, adapterId) : null;
  const label = known?.label ?? ADAPTER_LABELS[adapterId] ?? adapterId;
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<SignInRepairOutcome | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const verifyRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    headingRef.current?.focus({ preventScroll: false });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // After a verified sign-in, move focus from Verify to Retry.
  useEffect(() => {
    if (!checking && outcome?.kind === "verified" && document.activeElement === verifyRef.current) {
      retryRef.current?.focus({ preventScroll: true });
    }
  }, [checking, outcome]);

  function verify() {
    if (!repair) {
      setOutcome(signInRepairOutcome(label, null, "agent status is unavailable"));
      return;
    }
    setChecking(true);
    repair
      .verify()
      .then(
        (adapters) => {
          if (mountedRef.current) {
            setOutcome(signInRepairOutcome(label, repairAgentFor(adapters, adapterId), null));
          }
        },
        (err: unknown) => {
          if (mountedRef.current) {
            setOutcome(
              signInRepairOutcome(label, null, err instanceof Error ? err.message : String(err)),
            );
          }
        },
      )
      .finally(() => {
        if (mountedRef.current) setChecking(false);
      });
  }

  return (
    <SignInRepairView
      label={label}
      loginCommand={known?.loginCommand ?? null}
      agent={known}
      checking={checking}
      outcome={outcome}
      retrying={retrying}
      headingRef={headingRef}
      verifyRef={verifyRef}
      retryRef={retryRef}
      onCopied={repair?.onCopied ?? (() => undefined)}
      onError={repair?.onError ?? (() => undefined)}
      onVerify={verify}
      onRetry={onRetry}
      onClose={onClose}
    />
  );
}
