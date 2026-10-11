import { adapterIsReady, adapterReadinessLabel } from "./adapterReadiness";
import type { AgentAdapterMetadata } from "../types";

interface AgentSetupStep {
  title: string;
  done: boolean;
  command: string | null;
  hint: string | null;
}

export function adapterNeedsUpdate(adapter: AgentAdapterMetadata) {
  return (
    adapter.readiness === "unsupportedVersion" ||
    (adapter.supportsResearch && adapter.researchReadiness === "unsupportedVersion")
  );
}

/** Returns true if the adapter has been verified by a status probe. */
export function adapterStatusChecked(adapter: AgentAdapterMetadata) {
  return adapter.checkedAt !== null;
}

export function adapterSetupIsComplete(adapter: AgentAdapterMetadata) {
  return adapterStatusChecked(adapter) && adapterIsReady(adapter) && !adapterNeedsUpdate(adapter);
}

export function agentSetupStatusLabel(adapter: AgentAdapterMetadata) {
  if (adapterNeedsUpdate(adapter)) {
    return "Needs update";
  }
  if (adapterIsReady(adapter) && !adapterStatusChecked(adapter)) {
    return "Not checked";
  }
  return adapterReadinessLabel(adapter);
}

export function agentSetupSteps(adapter: AgentAdapterMetadata): AgentSetupStep[] {
  const installed = adapter.readiness !== "missing";
  const needsUpdate = adapterNeedsUpdate(adapter);
  const ready = adapterSetupIsComplete(adapter);
  const unchecked = installed && !needsUpdate && adapterIsReady(adapter) && !ready;
  const installStep: AgentSetupStep =
    installed && needsUpdate
      ? {
          title: "Update the CLI",
          done: false,
          command: adapter.updateCommand,
          hint: adapter.message,
        }
      : {
          title: "Install the CLI",
          done: installed,
          command: installed ? null : adapter.installCommand,
          hint: installed ? null : adapter.message,
        };
  const signInStep: AgentSetupStep =
    adapter.readiness === "error"
      ? {
          title: "Resolve the reported issue",
          done: false,
          command: null,
          hint: adapter.message,
        }
      : unchecked
        ? {
            title: "Sign in",
            done: false,
            command: null,
            hint: "Sign-in has not been checked yet. Refresh status to verify it.",
          }
        : {
            title: "Sign in",
            done: ready,
            command: installed && !needsUpdate && !ready ? adapter.loginCommand : null,
            hint:
              installed && !needsUpdate && !ready && adapter.readiness !== "needsAuth"
                ? adapter.message
                : null,
          };
  const checkStep: AgentSetupStep = {
    title: "Refresh status",
    done: ready,
    command: null,
    hint: ready
      ? `${adapter.label} is ready for research. Select it from the agent menu on Home.`
      : null,
  };
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
        : "Set up agents to make them available for research.",
  };
}

type AgentSetupSummaryTone = "ready" | "attention" | "failed" | "neutral";

/** The one-line readiness summary under "Agents" in the sidebar module.
 * `adapters` is null until the runtime config has loaded, and `probeError` is
 * the last readiness probe's error. Every probe sets checkedAt on the agents it
 * reports, so agents with none set are still waiting for the first probe.
 * Readiness counts use adapterSetupIsComplete, as the Agent Setup dialog's
 * heading does, so the sidebar and the dialog agree. */
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
  const readyCount = adapters.filter(adapterSetupIsComplete).length;
  const updateCount = adapters.filter(adapterNeedsUpdate).length;
  if (readyCount === 0) {
    return { text: "Set up an agent", tone: "attention" };
  }
  if (readyCount === total) {
    return { text: total === 1 ? "Ready" : `All ${total} ready`, tone: "ready" };
  }
  const updates =
    updateCount === 0 ? "" : ` · ${updateCount} ${updateCount === 1 ? "needs" : "need"} update`;
  return {
    text: `${readyCount} of ${total}${updates}`,
    tone: updateCount === 0 ? "ready" : "attention",
  };
}

/** An agent's status line in the sidebar menu, naming the host for an agent
 * on a remote target, since local and remote instances share a label. */
export function agentSetupMenuDetail(adapter: AgentAdapterMetadata) {
  const status = agentSetupStatusLabel(adapter);
  return adapter.target.kind === "remote" ? `${status} · ${adapter.target.label}` : status;
}
