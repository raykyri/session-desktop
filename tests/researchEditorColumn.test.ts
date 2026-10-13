import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata } from "../src/types";
import {
  QUESTION_CHARACTER_LIMIT,
  editedMarkdownBlocks,
  markdownBlocks,
  researchQuestionLength,
} from "../src/lib/researchEditor";

// Registered before the editor is pulled in: its model menu reaches adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const { ResearchEditorColumn, ResearchEditPreview } = await import(
  "../src/components/research/ResearchEditorColumn"
);
const { researchQuestionChoiceFrom, researchQuestionLaunch, researchQuestionModelOptions } = await import(
  "../src/components/research/ResearchQuestionModelPicker"
);

function adapter(id: string, researchReadiness: AgentAdapterMetadata["researchReadiness"] = "ready"): AgentAdapterMetadata {
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
    researchReadiness,
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

const ADAPTERS = [adapter("claude"), adapter("codex")];

function editor(value: string, overrides: Partial<Parameters<typeof ResearchEditorColumn>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ResearchEditorColumn, {
      column: { id: "E0", role: "editor", levelIndex: 0, nodeId: "post" },
      current: true,
      kind: "post",
      value,
      onChange: () => {},
      dirty: false,
      canSave: false,
      saving: false,
      notices: null,
      error: null,
      questionAdapters: ADAPTERS,
      questionDefault: { adapter: "claude", model: "opus", effort: null },
      asking: false,
      textareaRef: null,
      onCancel: () => {},
      onSave: () => {},
      onAskAsQuestion: () => {},
      ...overrides,
    }),
  );
}

test("a question is up to 500 characters after trimming", () => {
  assert.equal(QUESTION_CHARACTER_LIMIT, 500);
  assert.deepEqual(researchQuestionLength(`  ${"a".repeat(500)}\n`), { count: 500, allowed: true });
  assert.deepEqual(researchQuestionLength("a".repeat(501)), { count: 501, allowed: false });
  assert.deepEqual(researchQuestionLength("   "), { count: 0, allowed: false });
  // Characters are code points: an emoji counts once.
  assert.deepEqual(researchQuestionLength("😀".repeat(500)), { count: 500, allowed: true });
});

test("Ask as a question is enabled within the limit, with the model menu showing the Home selection", () => {
  const html = editor("How do mods work?");
  assert.match(html, /Ask as a question/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.doesNotMatch(html, /Asks /);
  assert.match(html, /aria-label="Model"[^>]*>.*<span class="launcher-select-value">Opus<\/span>/);
  assert.match(html, /aria-label="Edit note"/);
  assert.match(html, />Save</);
});

test("over the limit, Ask as a question stays visible but disabled with the count as its description", () => {
  const html = editor("x".repeat(612));
  const button = /<button[^>]*research-editor-ask[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(button, /aria-disabled="true"/);
  const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
  assert.ok(describedBy);
  assert.match(html, new RegExp(`id="${describedBy}"[^>]*>612 / 500 characters<`));
});

test("the note editor is titled Edit note, saves with Save and has no correction mode", () => {
  const html = editor("New text", { dirty: true, canSave: true });
  assert.match(html, /aria-label="Edit note"/);
  assert.match(html, /aria-label="Note text"/);
  assert.doesNotMatch(html, /[Pp]ost/);
  assert.match(html, /<span>Save<\/span>/);
  assert.doesNotMatch(html, /[Cc]orrect/);
});

test("Markdown splits into blocks at blank lines outside code fences", () => {
  assert.deepEqual(markdownBlocks("# Title\n\nOne\ntwo\n\n\n```\na\n\nb\n```\n\nEnd"), [
    "# Title",
    "One\ntwo",
    "```\na\n\nb\n```",
    "End",
  ]);
});

test("the preview marks blocks that are not in the saved text", () => {
  assert.deepEqual(editedMarkdownBlocks("A\n\nB\n\nB", "A\n\nB changed\n\nB\n\nNew"), [
    { text: "A", changed: false },
    { text: "B changed", changed: true },
    { text: "B", changed: false },
    { text: "New", changed: true },
  ]);
  const html = renderToStaticMarkup(
    createElement(ResearchEditPreview, { original: "Same\n\nOld", next: "Same\n\nNew", label: "Preview" }),
  );
  assert.match(html, /Preview · 1 paragraph changed/);
  assert.equal(html.match(/research-edit-block is-changed/g)?.length, 1);
});

test("over the limit, the count stays visible beside the model menu", () => {
  const html = editor("x".repeat(601));
  assert.match(html, /launcher-select-value">Opus</);
  assert.match(html, />601 \/ 500 characters</);
});

test("without a ready agent there is no model menu, and the note says so", () => {
  const html = editor("A question", { questionDefault: null });
  assert.doesNotMatch(html, /aria-label="Model"/);
  assert.match(html, />No research agent is ready</);
  const button = /<button[^>]*research-editor-ask[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(button, /aria-disabled="true"/);
});

test("a launch choice maps to the model menu's preset, Custom name and effort, and back", () => {
  const preset = researchQuestionChoiceFrom({ adapter: "claude", model: "sonnet", effort: "high" });
  assert.deepEqual(preset, { adapter: "claude", preset: "sonnet", customModel: "", effort: "high" });
  assert.deepEqual(researchQuestionLaunch(ADAPTERS, preset), { adapter: "claude", model: "sonnet", effort: "high" });

  const custom = researchQuestionChoiceFrom({ adapter: "claude", model: "my-model", effort: null });
  assert.deepEqual(custom, { adapter: "claude", preset: "custom", customModel: "my-model", effort: "" });
  assert.deepEqual(researchQuestionLaunch(ADAPTERS, custom), { adapter: "claude", model: "my-model", effort: null });

  // A model named like the Custom option is a custom name, not the option.
  const literal = researchQuestionChoiceFrom({ adapter: "claude", model: "custom", effort: null });
  assert.equal(literal.preset, "custom");
  assert.equal(researchQuestionLaunch(ADAPTERS, literal)?.model, "custom");

  // No model selects the agent's first preset.
  assert.equal(researchQuestionChoiceFrom({ adapter: "claude", model: null, effort: null }).preset, "fable");
});

test("the launch drops an effort the agent does not offer and needs a ready agent", () => {
  assert.equal(
    researchQuestionLaunch(ADAPTERS, { adapter: "claude", preset: "opus", customModel: "", effort: "nonsense" })?.effort,
    null,
  );
  // Custom without a name launches the agent's default model.
  assert.equal(
    researchQuestionLaunch(ADAPTERS, { adapter: "claude", preset: "custom", customModel: "  ", effort: "" })?.model,
    null,
  );
  const choice = { adapter: "codex", preset: "gpt-6-astra", customModel: "", effort: "" };
  assert.equal(researchQuestionLaunch([adapter("claude"), adapter("codex", "missing")], choice), null);
  assert.equal(researchQuestionLaunch([adapter("claude")], choice), null);
});

test("a named Custom option is labelled with its name, so the menu's trigger shows it", () => {
  const options = researchQuestionModelOptions(ADAPTERS, {
    adapter: "claude",
    preset: "custom",
    customModel: "my-model",
    effort: "",
  });
  const custom = options.find((option) => option.value === "claude:custom");
  assert.equal(custom?.label, "my-model");
  assert.equal(custom?.detail, "Custom");
  // Another agent's Custom option keeps its label.
  assert.equal(options.find((option) => option.value === "codex:custom")?.label, "Custom");
});
