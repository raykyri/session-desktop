import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata } from "../src/types";

// Registered before the composer is pulled in, since it reaches adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const { default: ResearchQueryComposer } = await import(
  "../src/components/research/ResearchQueryComposer"
);

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

test("the composer offers both recipients and opens on Ask AI", () => {
  const html = renderComposer();

  assert.match(html, /aria-label="Ask"/);
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*>Ask AI<\/button>/);
  assert.match(html, /<button[^>]*aria-pressed="false"[^>]*>Ask your network<\/button>/);
});

test("the ask toggle sits left of the model selector", () => {
  const html = renderComposer();

  const toggle = html.indexOf("new-research-ask-mode");
  const modelControls = html.indexOf("new-research-model-controls");
  assert.ok(toggle >= 0 && modelControls >= 0, "both controls render");
  assert.ok(
    toggle < modelControls,
    "the recipient toggle precedes the model controls in the overlay row",
  );
});
