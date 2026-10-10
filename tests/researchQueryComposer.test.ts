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
  parseResearchModelChoice,
  researchEffortOptionsFor,
  researchModelChoiceValue,
  researchModelOptions,
} = await import("../src/components/research/ResearchQueryComposer");
const { noteBodyIsSingleUrl } = await import("../src/components/research/ResearchNote");

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
      onPost: async () => {},
    }),
  );
}

test("the composer starts as one Ask a question line without its controls", () => {
  const html = renderComposer();
  assert.match(html, /<textarea[^>]*rows="1"[^>]*placeholder="Ask a question"[^>]*aria-label="New question"/);
  // The picker shows once the field has focus or text, and Save draft once
  // it has text; at rest the box is the field and a disabled arrow send
  // button with no label or shortcut text.
  assert.doesNotMatch(html, /aria-label="Recipient"|new-research-model-controls|Save draft|research-feed-enter/);
  assert.match(
    html,
    /<button type="submit" class="control-button research-composer-send" disabled="" aria-label="Start research" title="Start research \(↵\)"><svg[^>]*lucide-arrow-up/,
  );
  const inFolder = renderToStaticMarkup(
    createElement(ResearchQueryComposer, {
      adapters: [adapter("claude")],
      requireCmdEnterToSend: false,
      workspaceId: "workspace",
      placeholder: "Ask a question in Reading list",
      onOpenAgentSettings: () => {},
      onCreate: async () => {},
      onPost: async () => {},
      onSaveDraft: async () => {},
    }),
  );
  assert.match(inFolder, /placeholder="Ask a question in Reading list"/);
});

test("a single URL is saved as a link; anything else is asked", () => {
  assert.equal(noteBodyIsSingleUrl(" https://example.com/page "), true);
  assert.equal(noteBodyIsSingleUrl("https://x.com/jack/status/20"), true);
  assert.equal(noteBodyIsSingleUrl("Is this right? https://example.com"), false);
  assert.equal(noteBodyIsSingleUrl("ftp://example.com"), false);
  assert.equal(noteBodyIsSingleUrl("example.com"), false);
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

test("the Ask picker lists each ready agent's models and one row per unready agent", () => {
  const unready = { ...adapter("codex"), researchReadiness: "missing" as const };
  const options = researchModelOptions([adapter("claude"), unready]);

  assert.deepEqual(
    options.map((option) => [option.value, option.label, Boolean(option.disabled)]),
    [
      ["claude:fable", "Fable", false],
      ["claude:opus", "Opus", false],
      ["claude:sonnet", "Sonnet", false],
      ["claude:custom", "Custom", false],
      ["codex:", "codex", true],
    ],
  );
  // Agents are separated, and every row carries its agent's icon.
  assert.equal(options[4].dividerBefore, true);
  assert.ok(options.every((option) => option.iconSrc !== undefined));
});

test("a model choice value round-trips to its agent and preset", () => {
  assert.deepEqual(parseResearchModelChoice(researchModelChoiceValue("codex", "gpt-5.6-sol")), {
    adapter: "codex",
    preset: "gpt-5.6-sol",
  });
  assert.deepEqual(parseResearchModelChoice("codex:"), { adapter: "codex", preset: "" });
});

test("network mode hides AI controls", () => {
  assert.equal(askModeShowsAiControls("ai"), true);
  assert.equal(askModeShowsAiControls("network"), false);
});
