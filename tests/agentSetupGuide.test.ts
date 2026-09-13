import assert from "node:assert/strict";
import test from "node:test";
import {
  adapterSetupIsComplete,
  agentSetupIntro,
  agentSetupSteps,
} from "../src/lib/agentSetup";
import type { AgentAdapterMetadata } from "../src/types";

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
