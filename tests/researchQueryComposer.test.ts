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
  AskPostSwitch,
  askModeShowsAiControls,
  askSwitchKeyTarget,
  parseResearchModelChoice,
  researchEffortOptionsFor,
  researchModelChoiceValue,
  researchModelOptions,
} = await import("../src/components/research/ResearchQueryComposer");
const { noteBodyIsSingleUrl } = await import("../src/components/research/ResearchNote");
const { LauncherSelect } = await import("../src/components/LauncherSelect");

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
  // The row with the switcher and the send button shows once the field has
  // focus or text, and Save draft once it has text; at rest the box is only
  // the field.
  assert.doesNotMatch(
    html,
    /radiogroup|new-research-row|research-composer-send|launcher-select|Save draft/,
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

function renderSwitch(askMode: "ai" | "network") {
  return renderToStaticMarkup(
    createElement(AskPostSwitch, {
      askMode,
      askIcon: { value: "claude", label: "Claude Code", iconSrc: "claude.svg" },
      askLabel: "Ask with Claude Code Fable",
      menuOpen: false,
      askRef: { current: null },
      onModeChange: () => {},
      onMenuOpenChange: () => {},
    }),
  );
}

test("Ask and Post are two icon radios; only the selected one is a tab stop", () => {
  const ask = renderSwitch("ai");
  assert.match(ask, /<div class="new-research-switch" role="radiogroup" aria-label="Send to">/);
  // Ask: the agent's icon and, while selected, a chevron and the hint that
  // Enter opens the model menu.
  const askRadio = ask.match(/<button[^>]*aria-label="Ask with Claude Code Fable"[^>]*>(.*?)<\/button>/);
  assert.ok(askRadio);
  assert.match(askRadio[0], /role="radio" aria-checked="true" tabindex="0"/);
  assert.match(askRadio[0], /title="Ask with Claude Code Fable"/);
  assert.match(askRadio[1], /<img class="launcher-select-icon" src="claude.svg"/);
  assert.match(askRadio[1], /lucide-chevron-down/);
  const describedBy = askRadio[0].match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy);
  assert.match(ask, new RegExp(`<span id="${describedBy}" hidden="">Press Enter to choose a model</span>`));
  assert.match(
    ask,
    /<button type="button" role="radio" aria-checked="false" tabindex="-1" class="new-research-switch-option" aria-label="Post to network" title="Post to network"><svg[^>]*lucide-users/,
  );

  const post = renderSwitch("network");
  assert.match(post, /role="radio" aria-checked="false" tabindex="-1"[^>]*aria-label="Ask with Claude Code Fable"/);
  assert.match(post, /role="radio" aria-checked="true" tabindex="0"[^>]*aria-label="Post to network"/);
  // In Post the Ask segment opens no menu, so it has no chevron or hint.
  assert.doesNotMatch(post, /lucide-chevron-down|aria-describedby/);
});

test("arrow keys switch the mode; Home is Ask and End is Post", () => {
  assert.equal(askSwitchKeyTarget("ArrowRight", "ai"), "network");
  assert.equal(askSwitchKeyTarget("ArrowLeft", "ai"), "network");
  assert.equal(askSwitchKeyTarget("ArrowRight", "network"), "ai");
  assert.equal(askSwitchKeyTarget("ArrowLeft", "network"), "ai");
  assert.equal(askSwitchKeyTarget("Home", "network"), "ai");
  assert.equal(askSwitchKeyTarget("End", "ai"), "network");
  // ↓ opens the menu from Ask instead; Enter and Space click.
  assert.equal(askSwitchKeyTarget("ArrowDown", "ai"), null);
  assert.equal(askSwitchKeyTarget("Enter", "ai"), null);
});

test("a LauncherSelect opened from another control renders no trigger of its own", () => {
  const props = {
    value: "a",
    options: [{ value: "a", label: "A" }],
    onChange: () => {},
    ariaLabel: "Model",
  };
  const own = renderToStaticMarkup(createElement(LauncherSelect, props));
  assert.match(
    own,
    /<div class="launcher-select"><button type="button" class="control-button launcher-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="Model">/,
  );
  const anchored = renderToStaticMarkup(
    createElement(LauncherSelect, { ...props, anchorRef: { current: null }, open: false, onOpenChange: () => {} }),
  );
  assert.equal(anchored, "");
});
