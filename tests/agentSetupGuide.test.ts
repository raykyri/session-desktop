import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  adapterSetupIsComplete,
  agentCanAttemptResearch,
  agentResearchState,
  agentSetupIntro,
  agentSetupMenuDetail,
  agentSetupStatusLabel,
  agentSetupSteps,
  agentSetupSummary,
} from "../src/lib/agentSetup";
import type { AgentAdapterMetadata } from "../src/types";

// The guide reaches the adapter icons, which Node loads through this stub.
register("./svgStubLoader.mjs", import.meta.url);
const { default: AgentSetupGuide } = await import("../src/components/AgentSetupGuide");

function adapter(
  id: string,
  readiness: AgentAdapterMetadata["readiness"],
): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude Code" : "Codex",
    default: id === "claude",
    supportsFork: true,
    supportsResearch: true,
    supportsRecapGeneration: true,
    supportsForkAtMessage: true,
    supportsRemote: false,
    configuredBinary: id,
    resolvedBinary: readiness === "missing" ? null : `/bin/${id}`,
    readiness,
    researchReadiness: readiness,
    message: null,
    version: null,
    auth: "unknown",
    checkedAt: null,
    loginCommand: `${id} login`,
    installCommand: `install ${id}`,
    installUrl: `https://example.com/${id}`,
    updateCommand: `${id} update`,
    instanceId: `local:${id}`,
    target: { kind: "local", id: null, label: "This Mac" },
  };
}

test("missing agents get concrete setup steps and status actions", () => {
  const missing = adapter("claude", "missing");
  const intro = agentSetupIntro([missing, adapter("codex", "missing")]);
  const steps = agentSetupSteps(missing);

  assert.equal(intro.heading, "Set up an agent");
  assert.match(intro.body, /Research requires at least one supported agent CLI/);
  assert.doesNotMatch(intro.body, /Session runs research|Check again/);
  assert.deepEqual(
    steps.map(({ title, command }) => ({ title, command })),
    [
      { title: "Install the CLI", command: "install claude" },
      { title: "Sign in", command: null },
      { title: "Refresh status", command: null },
    ],
  );
});

test("a research-incompatible version is not reported as ready", () => {
  const oldClaude = adapter("claude", "ready");
  oldClaude.auth = "authenticated";
  oldClaude.researchReadiness = "unsupportedVersion";
  oldClaude.message = "Research requires a newer version.";

  const intro = agentSetupIntro([oldClaude]);
  const steps = agentSetupSteps(oldClaude);

  assert.equal(adapterSetupIsComplete(oldClaude), false);
  assert.equal(intro.heading, "Set up an agent");
  assert.equal(steps[0].title, "Update the CLI");
  assert.equal(steps[0].command, "claude update");
});

test("probe errors ask the user to resolve the reported issue", () => {
  const failed = adapter("claude", "error");
  failed.message = "The version check failed.";

  const steps = agentSetupSteps(failed);

  assert.equal(steps[1].title, "Resolve the reported issue");
  assert.equal(steps[1].hint, "The version check failed.");
  assert.equal(steps.some(({ title }) => title === "Sign in"), false);
});

test("an installed agent is not signed in until a probe has checked it", () => {
  const unchecked = adapter("claude", "ready");
  const steps = agentSetupSteps(unchecked);

  assert.equal(adapterSetupIsComplete(unchecked), false);
  assert.equal(agentSetupIntro([unchecked]).heading, "Set up an agent");
  assert.equal(agentSetupStatusLabel(unchecked), "Not checked");
  assert.deepEqual(steps[0], { title: "Install the CLI", done: true, command: null, hint: null });
  assert.equal(steps[1].title, "Sign in");
  assert.equal(steps[1].done, false);
  assert.equal(steps[1].command, null);
  assert.match(steps[1].hint ?? "", /Refresh status/);

  const checked = { ...unchecked, checkedAt: 1_700_000_000_000, auth: "authenticated" as const };
  assert.equal(adapterSetupIsComplete(checked), true);
  assert.equal(agentSetupStatusLabel(checked), "Signed in");
  assert.equal(agentSetupSteps(checked)[1].done, true);
  assert.equal(agentSetupSteps(checked)[2].done, true);
  assert.equal(agentSetupIntro([checked]).heading, "1 of 1 agents ready");
  assert.equal(
    agentSetupIntro([checked]).body,
    "One ready agent is enough for research. Set up others to make them available as alternatives.",
  );
});

function checked(id: string, readiness: AgentAdapterMetadata["readiness"]): AgentAdapterMetadata {
  return { ...adapter(id, readiness), checkedAt: 1_700_000_000_000, auth: "authenticated" };
}


test("the sidebar summary reports loading, empty, checking and failed probes", () => {
  assert.deepEqual(agentSetupSummary(null, null), { text: "Loading…", tone: "neutral" });
  assert.deepEqual(agentSetupSummary([], null), { text: "None configured", tone: "neutral" });
  // No agent has been probed yet.
  assert.deepEqual(
    agentSetupSummary([adapter("claude", "ready"), adapter("codex", "missing")], null),
    { text: "Checking…", tone: "neutral" },
  );
  assert.deepEqual(agentSetupSummary([checked("claude", "ready")], "probe failed"), {
    text: "Status check failed",
    tone: "failed",
  });
});

test("the sidebar summary counts agents the way the setup dialog does", () => {
  const ready = checked("claude", "ready");
  const missing = checked("codex", "missing");
  const outdated = checked("grok", "unsupportedVersion");

  assert.deepEqual(agentSetupSummary([missing, outdated], null), {
    text: "Set up an agent",
    tone: "attention",
  });
  assert.deepEqual(agentSetupSummary([ready, missing, outdated], null), {
    text: "1 of 3 · 1 needs update",
    tone: "attention",
  });
  assert.deepEqual(agentSetupSummary([ready, { ...ready, instanceId: "local:b" }, missing], null), {
    text: "2 of 3",
    tone: "ready",
  });
  const outdatedPair = [
    { ...outdated, instanceId: "a" },
    { ...outdated, instanceId: "b" },
  ];
  assert.equal(agentSetupSummary([ready, ...outdatedPair], null).text, "1 of 3 · 2 need update");
  assert.deepEqual(
    agentSetupSummary([ready, { ...ready, instanceId: "b" }, { ...ready, instanceId: "c" }], null),
    { text: "All 3 ready", tone: "ready" },
  );
  assert.deepEqual(agentSetupSummary([ready], null), { text: "Ready", tone: "ready" });
  // An installed agent that no probe has checked is not counted as ready.
  assert.equal(
    agentSetupSummary([adapter("claude", "ready"), missing], null).text,
    "Set up an agent",
  );
});

test("a remote agent's menu detail names its host", () => {
  const local = checked("claude", "ready");
  // A remote probe reports the CLI itself but never research readiness:
  // research runs locally.
  const remote: AgentAdapterMetadata = {
    ...local,
    researchReadiness: "error",
    message: "Remote terminal ready; Research remains local-only.",
    instanceId: "remote:devbox:claude",
    target: { kind: "remote", id: "devbox", label: "devbox" },
  };

  assert.equal(agentSetupMenuDetail(local), "Signed in");
  assert.equal(agentSetupMenuDetail(remote), "Research unavailable · devbox");
});

// The research-readiness matrix: sign-in evidence, general CLI readiness and
// research readiness are separate inputs, and only verified sign-in with
// research readiness counts as set up.
test("verified sign-in with research readiness completes setup", () => {
  const ready = checked("codex", "ready");
  assert.equal(agentResearchState(ready), "ready");
  assert.equal(adapterSetupIsComplete(ready), true);
  assert.equal(agentCanAttemptResearch(ready), true);
  assert.equal(agentSetupStatusLabel(ready), "Signed in");
  assert.deepEqual(
    agentSetupSteps(ready).map((step) => step.done),
    [true, true, true],
  );
});

test("unknown sign-in after a completed probe is not reported as signed in", () => {
  const unknown: AgentAdapterMetadata = {
    ...checked("codex", "ready"),
    auth: "unknown",
    authDetail: "`codex login status` returned a result Session does not recognize.",
  };
  assert.equal(agentResearchState(unknown), "unverified");
  assert.equal(adapterSetupIsComplete(unknown), false);
  // Research can still be attempted through the ordinary launch path.
  assert.equal(agentCanAttemptResearch(unknown), true);
  assert.equal(agentSetupStatusLabel(unknown), "Sign-in unverified");
  assert.notEqual(agentSetupStatusLabel(unknown), "Signed in");
  const steps = agentSetupSteps(unknown);
  assert.equal(steps[1].title, "Verify sign-in");
  assert.equal(steps[1].done, false);
  assert.equal(steps[1].command, "codex login");
  assert.match(steps[1].hint ?? "", /could not verify sign-in\. `codex login status` returned/);
  assert.equal(steps[2].done, false);
  assert.equal(agentSetupIntro([unknown]).heading, "Set up an agent");
  assert.deepEqual(agentSetupSummary([unknown], null), {
    text: "Sign-in unverified",
    tone: "attention",
  });
  assert.equal(
    agentSetupSummary([checked("claude", "ready"), unknown], null).text,
    "1 of 2 · 1 unverified",
  );
});

test("a definitive sign-out asks for the provider's sign-in command", () => {
  const signedOut: AgentAdapterMetadata = {
    ...checked("codex", "needsAuth"),
    auth: "unauthenticated",
    message: "Codex is not signed in. Run `codex login` and check again.",
  };
  assert.equal(agentResearchState(signedOut), "needsAuth");
  assert.equal(agentCanAttemptResearch(signedOut), false);
  assert.equal(agentSetupStatusLabel(signedOut), "Sign-in required");
  const steps = agentSetupSteps(signedOut);
  assert.equal(steps[1].title, "Sign in");
  assert.equal(steps[1].command, "codex login");
  assert.match(steps[1].hint ?? "", /in Terminal/);
  assert.doesNotMatch(steps[1].hint ?? "", /terminal tab/i);
});

test("an unsupported research version stays an update, even when signed in", () => {
  const outdated: AgentAdapterMetadata = {
    ...checked("claude", "ready"),
    researchReadiness: "unsupportedVersion",
    message: "Claude Code 2.0.5 is installed, but Research requires 2.1.0 or newer.",
  };
  assert.equal(agentResearchState(outdated), "needsUpdate");
  assert.equal(adapterSetupIsComplete(outdated), false);
  assert.equal(agentSetupStatusLabel(outdated), "Needs update");
  assert.equal(agentSetupSteps(outdated)[0].title, "Update the CLI");
});

test("an agent that cannot run research never counts as ready for research", () => {
  for (const auth of ["authenticated", "unknown"] as const) {
    const remote: AgentAdapterMetadata = {
      ...checked("codex", "ready"),
      auth,
      researchReadiness: "error",
      message: "Remote terminal ready; Research remains local-only.",
      instanceId: "remote:devbox:codex",
      target: { kind: "remote", id: "devbox", label: "devbox" },
    };
    assert.equal(agentResearchState(remote), "researchUnavailable");
    assert.equal(adapterSetupIsComplete(remote), false);
    assert.equal(agentCanAttemptResearch(remote), false);
    assert.equal(agentSetupStatusLabel(remote), "Research unavailable");
    assert.equal(agentSetupIntro([remote]).readyCount, 0);
    assert.equal(agentSetupSummary([remote], null).text, "Set up an agent");
    const steps = agentSetupSteps(remote);
    assert.equal(steps[2].title, "Research support");
    assert.equal(steps[2].done, false);
    assert.equal(steps[2].hint, "Remote terminal ready; Research remains local-only.");
  }
  const noRuntime = { ...checked("codex", "ready"), supportsResearch: false };
  assert.equal(agentResearchState(noRuntime), "researchUnavailable");
});

test("a failed sign-in probe reports uncertainty, not success", () => {
  const probeFailed: AgentAdapterMetadata = {
    ...checked("codex", "ready"),
    auth: "unknown",
    authDetail: "The sign-in status check failed: `codex login status` timed out.",
  };
  assert.equal(agentResearchState(probeFailed), "unverified");
  assert.equal(adapterSetupIsComplete(probeFailed), false);
  assert.match(agentSetupSteps(probeFailed)[1].hint ?? "", /timed out/);

  // A failed version probe is an error with the reported message.
  const versionFailed: AgentAdapterMetadata = {
    ...checked("codex", "error"),
    auth: "unknown",
    message: "`codex --version` timed out",
  };
  assert.equal(agentResearchState(versionFailed), "error");
  assert.equal(agentSetupStatusLabel(versionFailed), "Needs attention");
  assert.equal(agentSetupSteps(versionFailed)[1].hint, "`codex --version` timed out");
});

function renderGuide(
  adapters: AgentAdapterMetadata[],
  options: { initialInstanceId?: string | null; onStartResearch?: (adapter: AgentAdapterMetadata) => void } = {},
) {
  return renderToStaticMarkup(
    createElement(AgentSetupGuide, {
      adapters,
      initialInstanceId: options.initialInstanceId ?? null,
      loading: false,
      error: null,
      onRefresh: () => {},
      onCopied: () => {},
      onError: () => {},
      onStartResearch: options.onStartResearch,
    }),
  );
}

function threeAgents(codex: AgentAdapterMetadata) {
  return [checked("claude", "missing"), codex, { ...checked("grok", "missing"), label: "Grok" }];
}

test("a ready agent shows its completed state and a start action", () => {
  const html = renderGuide(threeAgents(checked("codex", "ready")), {
    initialInstanceId: "local:codex",
    onStartResearch: () => {},
  });
  // The completion is rendered by the guide itself, not left to a step hint
  // that only shows for an incomplete step.
  assert.match(html, /role="status"[^>]*>.*Codex is ready for research\./);
  assert.match(html, /One ready agent is enough\. Setting up other agents is optional\./);
  assert.match(html, /<button[^>]*class="control-button agent-setup-start is-primary"[^>]*><span>Start research with Codex<\/span>/);
  // The other agents stay available as tabs, but nothing presents them as
  // unfinished required work.
  assert.match(html, /1 of 3 agents ready/);
  assert.match(html, /One ready agent is enough for research/);
  assert.doesNotMatch(html, /Next agent/);
  assert.match(html, /role="tab"[^>]*>.*Claude Code/);
});

test("the start action is offered only where the guide can return to research", () => {
  const html = renderGuide(threeAgents(checked("codex", "ready")), { initialInstanceId: "local:codex" });
  assert.match(html, /Codex is ready for research\./);
  assert.doesNotMatch(html, /Start research with/);
});

test("an unverified agent offers an explicit attempt, not a completed state", () => {
  const unverified: AgentAdapterMetadata = {
    ...checked("codex", "ready"),
    auth: "unknown",
    authDetail: "`codex login status` returned a result Session does not recognize.",
  };
  const html = renderGuide(threeAgents(unverified), {
    initialInstanceId: "local:codex",
    onStartResearch: () => {},
  });
  assert.match(html, /Sign-in unverified/);
  assert.match(html, /Try research with Codex/);
  assert.doesNotMatch(html, /is ready for research|Start research with|Signed in/);
  assert.match(html, /Set up an agent/);
});

test("an agent that cannot run research offers no research action", () => {
  const remote: AgentAdapterMetadata = {
    ...checked("codex", "ready"),
    researchReadiness: "error",
    message: "Remote terminal ready; Research remains local-only.",
  };
  const html = renderGuide([remote], { onStartResearch: () => {} });
  assert.match(html, /Research unavailable/);
  assert.doesNotMatch(html, /Start research with|Try research with|ready for research/);
});

test("without a chosen agent the guide opens on the first incomplete one", () => {
  const html = renderGuide(threeAgents(checked("codex", "ready")), { onStartResearch: () => {} });
  assert.match(html, /<h4>Claude Code<\/h4>/);
  assert.match(html, /Next agent/);
  assert.doesNotMatch(html, /Start research with/);
});
