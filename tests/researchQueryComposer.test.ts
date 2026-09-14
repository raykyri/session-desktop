import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata } from "../src/types";

// Registered before the composer is pulled in, since it reaches adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const {
  default: ResearchQueryComposer,
  askModeShowsAiControls,
  researchEffortOptionsFor,
} = await import("../src/components/research/ResearchQueryComposer");

function adapter(id: string): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude Code" : id,
    default: id === "claude",
    supportsFork: true,
    supportsResearch: true,
    supportsRecapGeneration: true,
    supportsForkAtMessage: true,
    supportsRemote: false,
    configuredBinary: id,
    resolvedBinary: `/bin/${id}`,
    readiness: "ready",
    researchReadiness: "ready",
    message: null,
    version: null,
    auth: "authenticated",
    checkedAt: 1_700_000_000_000,
    loginCommand: null,
    installCommand: null,
    installUrl: null,
    updateCommand: null,
    instanceId: `local:${id}`,
    target: { kind: "local", id: null, label: "This Mac" },
  };
}

function renderComposer() {
  return renderToStaticMarkup(
    createElement(ResearchQueryComposer, {
      adapters: [adapter("claude")],
      requireCmdEnterToSend: false,
      workspaceId: "workspace",
      onOpenAgentSettings: () => {},
      onCreate: async () => {},
    }),
  );
}

test("the composer offers both recipients and opens on Ask network", () => {
  const html = renderComposer();

  assert.match(html, /aria-label="Ask"/);
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>Ask network<\/button>/);
  assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>Ask AI<\/button>/);
  assert.ok(html.indexOf("Ask network") < html.indexOf("Ask AI"));
  assert.doesNotMatch(html, /new-research-model-controls/);
  assert.doesNotMatch(html, /command-launcher-adapter-select/);
});

test("Claude reasoning options omit the word effort", () => {
  const options = researchEffortOptionsFor("claude", "fable");
  assert.deepEqual(options?.map((option) => option.label), [
    "Default",
    "Low",
    "Medium",
    "High",
    "Extra",
    "Max",
    "Ultracode",
  ]);
});

test("network mode hides AI controls", () => {
  assert.equal(askModeShowsAiControls("ai"), true);
  assert.equal(askModeShowsAiControls("network"), false);
});
