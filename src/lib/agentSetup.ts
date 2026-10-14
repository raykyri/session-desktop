import type { AgentAdapterMetadata } from "../types";
import { shortWhen } from "@session/shared/lib/shortTime";

interface AgentSetupStep {
  title: string;
  done: boolean;
  command: string | null;
  hint: string | null;
}

/**
 * An agent's readiness for research, from its probed metadata. One
 * classification serves the setup guide, the sidebar Agents module, Home and
 * the repair panel, so their counts, labels and actions agree.
 *
 * - `unchecked`: installed, but no probe has reported on it yet.
 * - `missing`: the configured binary was not found.
 * - `needsUpdate`: the CLI or its research runtime needs a newer version.
 * - `needsAuth`: the provider's status command reported it signed out.
 * - `error`: a probe failed (for example, the version check).
 * - `researchUnavailable`: the CLI works, but research cannot run through it
 *   (its research runtime reported an error, or the adapter has none).
 * - `unverified`: research can launch, but the sign-in status command gave no
 *   definitive answer. Not counted as ready; research can still be attempted.
 * - `ready`: sign-in verified and research ready.
 */
type AgentResearchState =
  | "unchecked"
  | "missing"
  | "needsUpdate"
  | "needsAuth"
  | "error"
  | "researchUnavailable"
  | "unverified"
  | "ready";

function adapterNeedsUpdate(adapter: AgentAdapterMetadata) {
  return (
    adapter.readiness === "unsupportedVersion" ||
    (adapter.supportsResearch && adapter.researchReadiness === "unsupportedVersion")
  );
}

/** Returns true if the adapter has been verified by a status probe. */
function adapterStatusChecked(adapter: AgentAdapterMetadata) {
  return adapter.checkedAt !== null;
}

export function agentResearchState(adapter: AgentAdapterMetadata): AgentResearchState {
  // Missing, outdated, signed-out and failed states come from the binary
  // lookup and the probe itself, so they apply even before checkedAt is read.
  if (adapter.readiness === "missing") {
    return "missing";
  }
  if (adapterNeedsUpdate(adapter)) {
    return "needsUpdate";
  }
  if (
    adapter.readiness === "needsAuth" ||
    adapter.researchReadiness === "needsAuth" ||
    adapter.auth === "unauthenticated"
  ) {
    return "needsAuth";
  }
  if (adapter.readiness === "error") {
    return "error";
  }
  // An installed CLI starts out "ready" with unknown sign-in until a probe
  // reports on it; that is not evidence of anything yet.
  if (!adapterStatusChecked(adapter)) {
    return "unchecked";
  }
  if (!adapter.supportsResearch || adapter.researchReadiness !== "ready") {
    return "researchUnavailable";
  }
  return adapter.auth === "authenticated" ? "ready" : "unverified";
}

/** Research setup is complete only with verified sign-in and research
 * readiness. An unverified agent can still launch research (see
 * `agentCanAttemptResearch`), but does not count as set up. */
export function adapterSetupIsComplete(adapter: AgentAdapterMetadata) {
  return agentResearchState(adapter) === "ready";
}

/** Research can be launched with this agent, verified or not. */
export function agentCanAttemptResearch(adapter: AgentAdapterMetadata) {
  const state = agentResearchState(adapter);
  return state === "ready" || state === "unverified";
}

const STATUS_LABELS: Record<AgentResearchState, string> = {
  unchecked: "Not checked",
  missing: "Not installed",
  needsUpdate: "Needs update",
  needsAuth: "Sign-in required",
  error: "Needs attention",
  researchUnavailable: "Research unavailable",
  unverified: "Sign-in unverified",
  ready: "Signed in",
};

export function agentSetupStatusLabel(adapter: AgentAdapterMetadata) {
  return STATUS_LABELS[agentResearchState(adapter)];
}

/** Why sign-in could not be verified, for an unverified agent. */
export function agentSignInUnverifiedText(adapter: AgentAdapterMetadata) {
  const detail = adapter.authDetail?.trim();
  return detail
    ? `Session could not verify sign-in. ${detail}`
    : "Session could not verify sign-in: the status check gave no definitive result.";
}

export function agentSetupSteps(adapter: AgentAdapterMetadata): AgentSetupStep[] {
  const state = agentResearchState(adapter);
  const installed = state !== "missing";
  const ready = state === "ready";
  const installStep: AgentSetupStep =
    state === "needsUpdate"
      ? {
          title: "Update the CLI",
          done: false,
          command: adapter.updateCommand,
          hint:
            adapter.message ??
            (adapter.updateCommand
              ? null
              : `Update ${adapter.label} with the method you used to install it, then refresh status.`),
        }
      : {
          title: "Install the CLI",
          done: installed,
          command: installed ? null : adapter.installCommand,
          hint: installed ? null : adapter.message,
        };
  let signInStep: AgentSetupStep;
  switch (state) {
    case "error":
      signInStep = {
        title: "Resolve the reported issue",
        done: false,
        command: null,
        hint: adapter.message,
      };
      break;
    case "unchecked":
      signInStep = {
        title: "Sign in",
        done: false,
        command: null,
        hint: "Sign-in has not been checked yet. Refresh status to verify it.",
      };
      break;
    case "needsAuth":
      signInStep = {
        title: "Sign in",
        done: false,
        command: adapter.loginCommand,
        hint: adapter.loginCommand
          ? "Run this command in Terminal and complete sign-in, then refresh status."
          : adapter.message,
      };
      break;
    case "unverified":
      signInStep = {
        title: "Verify sign-in",
        done: false,
        command: adapter.loginCommand,
        hint: `${agentSignInUnverifiedText(adapter)} If ${adapter.label} is not signed in, run this command in Terminal, then refresh status.`,
      };
      break;
    case "researchUnavailable":
      signInStep = {
        title: "Sign in",
        done: adapter.auth === "authenticated",
        command: null,
        hint: null,
      };
      break;
    default:
      // An outdated CLI can still report a verified sign-in.
      signInStep = {
        title: "Sign in",
        done: ready || (state === "needsUpdate" && adapter.auth === "authenticated"),
        command: null,
        hint: null,
      };
  }
  const checkStep: AgentSetupStep =
    state === "researchUnavailable"
      ? {
          title: "Research support",
          done: false,
          command: null,
          hint: adapter.message ?? `${adapter.label} cannot run research here.`,
        }
      : { title: "Refresh status", done: ready, command: null, hint: null };
  return [installStep, signInStep, checkStep];
}

export function agentSetupIntro(adapters: readonly AgentAdapterMetadata[]) {
  const readyCount = adapters.filter(adapterSetupIsComplete).length;
  return {
    readyCount,
    heading:
      readyCount === 0
        ? "Set up an agent"
        : `${readyCount} of ${adapters.length} agents ready`,
    body:
      readyCount === 0
        ? "Research requires at least one supported agent CLI installed and signed in on this Mac. Complete the steps for an agent, then refresh its status."
        : "One ready agent is enough for research. Set up others to make them available as alternatives.",
  };
}

type AgentSetupSummaryTone = "ready" | "attention" | "failed" | "neutral";

/** Returns the readiness summary shown under Agents in the sidebar.
 * `adapters` is null while runtime config loads. Agents without `checkedAt`
 * have not been probed. The ready count uses the same rule as Agent Setup. */
export function agentSetupSummary(
  adapters: readonly AgentAdapterMetadata[] | null,
  probeError: string | null,
): { text: string; tone: AgentSetupSummaryTone } {
  if (!adapters) {
    return { text: "Loading…", tone: "neutral" };
  }
  if (adapters.length === 0) {
    return { text: "None configured", tone: "neutral" };
  }
  if (probeError) {
    return { text: "Status check failed", tone: "failed" };
  }
  if (!adapters.some(adapterStatusChecked)) {
    return { text: "Checking…", tone: "neutral" };
  }
  const total = adapters.length;
  const states = adapters.map(agentResearchState);
  const readyCount = states.filter((state) => state === "ready").length;
  const unverifiedCount = states.filter((state) => state === "unverified").length;
  const updateCount = states.filter((state) => state === "needsUpdate").length;
  if (readyCount === 0) {
    return unverifiedCount > 0
      ? { text: "Sign-in unverified", tone: "attention" }
      : { text: "Set up an agent", tone: "attention" };
  }
  if (readyCount === total) {
    return { text: total === 1 ? "Ready" : `All ${total} ready`, tone: "ready" };
  }
  const unverified = unverifiedCount === 0 ? "" : ` · ${unverifiedCount} unverified`;
  const updates =
    updateCount === 0 ? "" : ` · ${updateCount} ${updateCount === 1 ? "needs" : "need"} update`;
  return {
    text: `${readyCount} of ${total}${unverified}${updates}`,
    tone: updateCount === 0 && unverifiedCount === 0 ? "ready" : "attention",
  };
}

/** Returns available probe details for setup and repair panels. */
export function agentDiagnosticRows(adapter: AgentAdapterMetadata, now = Date.now()) {
  const rows: { label: string; value: string }[] = [
    { label: "Runs on", value: adapter.target.label },
    {
      label: "Executable",
      value: adapter.resolvedBinary ?? `${adapter.configuredBinary} (not found)`,
    },
  ];
  if (adapter.version) rows.push({ label: "Version", value: adapter.version });
  if (adapter.checkedAt !== null) {
    const when = shortWhen(adapter.checkedAt, now);
    rows.push({ label: "Last checked", value: /^\d/.test(when) ? `${when} ago` : when });
  }
  if (adapter.message) rows.push({ label: "Reported", value: adapter.message });
  if (adapter.auth === "unknown" && adapter.authDetail) {
    rows.push({ label: "Sign-in check", value: adapter.authDetail });
  }
  return rows;
}
