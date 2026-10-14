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
  askBoxCopy,
  applyComposerFocusRequest,
  askModeShowsAiControls,
  homeComposerDraftToStore,
  insideComposer,
  parseResearchModelChoice,
  researchEffortOptionsFor,
  researchModelChoiceValue,
  researchModelOptions,
} = await import("../src/components/research/ResearchQueryComposer");
const { AskNoteSwitch, askSwitchKeyTarget } = await import("../src/components/research/AskNoteSwitch");
const { postFormatOf } = await import("@session/shared/lib/researchNodeTypes");
const { ResearchModelNameDialog } = await import("../src/components/research/ResearchModelNameDialog");
const { withWidgetDom } = await import("./widgetDom");
const { LauncherSelect, OptionIcon: LauncherSelectIcon } = await import("../src/components/LauncherSelect");

function adapter(id: string): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude Code" : id,
    default: id === "claude",
    supportsResearch: true,
    supportsRecapGeneration: true,
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
  // focus or text, and the … button with Save draft once it has text; at
  // rest the box is only the field.
  assert.doesNotMatch(
    html,
    /radiogroup|new-research-row|research-composer-send|launcher-select|new-research-more|Save draft/,
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
  assert.equal(postFormatOf(" https://example.com/page "), "link");
  assert.equal(postFormatOf("https://x.com/jack/status/20"), "link");
  assert.equal(postFormatOf("Is this right? https://example.com"), "text");
  assert.equal(postFormatOf("ftp://example.com"), "text");
  assert.equal(postFormatOf("example.com"), "text");
  assert.equal(postFormatOf(""), "text");
});

test("Claude reasoning options omit the word effort", () => {
  const options = researchEffortOptionsFor("claude");
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
  // Agents are separated, and every row includes its agent's icon.
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

test("note mode hides AI controls", () => {
  assert.equal(askModeShowsAiControls("ai"), true);
  assert.equal(askModeShowsAiControls("note"), false);
});

test("note mode saves a note, or a link when the text is one URL", () => {
  assert.deepEqual(askBoxCopy("note", "Read the spec first", false, "Ask a question"), {
    placeholder: "Write a note, or paste a link to save",
    submitLabel: "Save note",
  });
  assert.equal(askBoxCopy("note", " https://example.com/page ", false, "Ask a question").submitLabel, "Save link");
  assert.equal(askBoxCopy("note", "Read the spec first", true, "Ask a question").submitLabel, "Saving…");
  assert.deepEqual(askBoxCopy("ai", "https://example.com/page", false, "Ask a question"), {
    placeholder: "Ask a question",
    submitLabel: "Start research",
  });
});

function renderSwitch(askMode: "ai" | "note") {
  return renderToStaticMarkup(
    createElement(AskNoteSwitch, {
      askMode,
      askIcon: createElement(LauncherSelectIcon, {
        option: { value: "claude", label: "Claude Code", iconSrc: "claude.svg" },
      }),
      askLabel: "Ask with Claude Code Fable",
      noteLabel: "Save as note",
      menuOpen: false,
      askRef: { current: null },
      onModeChange: () => {},
      onMenuOpenChange: () => {},
    }),
  );
}

test("Ask and Note are two icon radios; only the selected one is a tab stop", () => {
  const ask = renderSwitch("ai");
  assert.match(ask, /<div class="new-research-switch" role="radiogroup" aria-label="Ask or save as note">/);
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
    /<button type="button" role="radio" aria-checked="false" tabindex="-1" class="new-research-switch-option" aria-label="Save as note" title="Save as note"><svg[^>]*lucide-sticky-note/,
  );
  assert.doesNotMatch(ask, /network|lucide-users|lucide-globe/i);

  const note = renderSwitch("note");
  assert.match(note, /role="radio" aria-checked="false" tabindex="-1"[^>]*aria-label="Ask with Claude Code Fable"/);
  assert.match(note, /role="radio" aria-checked="true" tabindex="0"[^>]*aria-label="Save as note"/);
  // In Note the Ask segment opens no menu, so it has no chevron or hint.
  assert.doesNotMatch(note, /lucide-chevron-down|aria-describedby/);
});

test("a switch with no model menu shows no chevron or menu hint on Ask", () => {
  // A note's follow-up box: Ask uses the note's model.
  const html = renderToStaticMarkup(
    createElement(AskNoteSwitch, {
      askMode: "ai",
      askIcon: null,
      askLabel: "Ask Claude Fable",
      noteLabel: "Add a note",
      onModeChange: () => {},
    }),
  );
  assert.match(html, /role="radiogroup" aria-label="Ask or add a note"/);
  assert.match(html, /role="radio" aria-checked="true" tabindex="0"[^>]*aria-label="Ask Claude Fable"/);
  assert.match(html, /aria-label="Add a note" title="Add a note"/);
  assert.doesNotMatch(html, /lucide-chevron-down|aria-describedby|Press Enter to choose a model/);
});

test("arrow keys switch the mode; Home is Ask and End is Note", () => {
  assert.equal(askSwitchKeyTarget("ArrowRight", "ai"), "note");
  assert.equal(askSwitchKeyTarget("ArrowLeft", "ai"), "note");
  assert.equal(askSwitchKeyTarget("ArrowRight", "note"), "ai");
  assert.equal(askSwitchKeyTarget("ArrowLeft", "note"), "ai");
  assert.equal(askSwitchKeyTarget("Home", "note"), "ai");
  assert.equal(askSwitchKeyTarget("End", "ai"), "note");
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

test("the Home ask box keeps a non-default agent, model, or effort after its text is cleared", () => {
  const fresh = { prompt: "", adapter: "claude", modelChoice: null, customModel: "", effortChoice: "" };
  assert.equal(homeComposerDraftToStore(fresh, "claude"), null);
  // A send clears only the text; each kind of choice keeps the draft stored.
  const codex = { ...fresh, adapter: "codex" };
  assert.deepEqual(homeComposerDraftToStore(codex, "claude"), codex);
  const model = { ...fresh, modelChoice: "opus" };
  assert.deepEqual(homeComposerDraftToStore(model, "claude"), model);
  const effort = { ...fresh, effortChoice: "high" };
  assert.deepEqual(homeComposerDraftToStore(effort, "claude"), effort);
  // Drafts stored before effort was kept have no effortChoice.
  const { effortChoice: _omitted, ...older } = fresh;
  assert.equal(homeComposerDraftToStore(older, "claude"), null);
});

test("returning from Agent Setup selects the agent and keeps the question", () => {
  const draft = {
    prompt: "What changed in grid storage costs?",
    adapter: "claude",
    modelChoice: "opus",
    customModel: "",
    effortChoice: "high",
  };
  const codex = adapter("codex");
  const missing = { ...adapter("grok"), readiness: "missing" as const, researchReadiness: "missing" as const };
  const adapters = [adapter("claude"), codex, missing];

  // The chosen agent is selected; text and options are untouched (a model or
  // effort that does not apply falls back when the box resolves the launch).
  assert.deepEqual(applyComposerFocusRequest(draft, { seq: 1, adapterId: "codex" }, adapters), {
    ...draft,
    adapter: "codex",
  });
  // An agent that cannot launch research is not selected.
  assert.equal(applyComposerFocusRequest(draft, { seq: 2, adapterId: "grok" }, adapters), draft);
  // A plain focus request (closing setup opened from the composer) changes nothing.
  assert.equal(applyComposerFocusRequest(draft, { seq: 3, adapterId: null }, adapters), draft);
});

test("a composer without a research-ready agent links to Agent Setup", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchQueryComposer, {
      adapters: [{ ...adapter("claude"), readiness: "needsAuth", researchReadiness: "needsAuth" }],
      requireCmdEnterToSend: false,
      workspaceId: "workspace",
      onOpenAgentSettings: () => {},
      onCreate: async () => {},
      onPost: async () => {},
    }),
  );
  assert.match(html, /Review agents/);
});

test("focus in the Custom model dialog counts as inside the composer", async () => {
  await withWidgetDom(async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ResearchModelNameDialog, {
          agentLabel: "Claude Code",
          initialName: "",
          onSubmit: () => {},
          onClose: () => {},
        }),
      );
    });
    const composer = document.createElement("div");
    document.body.append(composer);
    const field = document.querySelector('input[aria-label="Model name"]');
    assert.ok(field);
    assert.equal(insideComposer(composer, field), true);
    assert.equal(insideComposer(composer, document.body), false);
    await act(async () => root.unmount());
  });
});
