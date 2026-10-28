import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAdapterMetadata } from "../src/types";
import { resolveAppShortcut } from "@session/shared/lib/appShortcuts";
import { isSaveShortcut } from "../src/lib/editorShortcuts";
import {
  QUESTION_CHARACTER_LIMIT,
  editedMarkdownBlocks,
  markdownBlocks,
  researchQuestionLength,
} from "@session/shared/lib/researchEditor";
import { withWidgetDom } from "./widgetDom";

// Registered before the editor is imported: its model menu imports adapter
// SVG icons.
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
    supportsResearch: true,
    supportsRecapGeneration: true,
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
  };
}

const ADAPTERS = [adapter("claude"), adapter("codex")];

type EditorProps = Parameters<typeof ResearchEditorColumn>[0];

function editorProps(value: string, overrides: Partial<EditorProps> = {}): EditorProps {
  return {
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
      onSaveInPlace: () => {},
      onAskAsQuestion: () => {},
      ...overrides,
  };
}

function editor(value: string, overrides: Partial<EditorProps> = {}) {
  return renderToStaticMarkup(createElement(ResearchEditorColumn, editorProps(value, overrides)));
}

/** Mounts the editor column in a DOM; `run` gets the column and a key press
 * on an element in it, which returns whether the column took the key. */
async function withMountedEditor(
  props: EditorProps,
  run: (editor: {
    column: HTMLElement;
    field: HTMLTextAreaElement;
    press: (target: Element, key: string, modifiers?: KeyboardEventInit) => Promise<boolean>;
  }) => Promise<void>,
) {
  await withWidgetDom(async (window) => {
    // Imported once the DOM is installed: React DOM decides at load whether
    // the browser fires input events, and keys in a field need it to.
    const { createRoot } = await import("react-dom/client");
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ResearchEditorColumn, props)));
    const column = container.querySelector<HTMLElement>("section.research-pair-editor")!;
    const press = async (target: Element, key: string, modifiers: KeyboardEventInit = {}) => {
      const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
      await act(async () => {
        target.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    try {
      await run({ column, field: column.querySelector("textarea")!, press });
    } finally {
      await act(async () => root.unmount());
    }
  });
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
  const model = /<button[^>]*aria-label="Model"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(model, /\sdisabled/);
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

test("over the limit, the count stays visible beside the model menu and the menu is disabled", () => {
  const html = editor("x".repeat(601));
  assert.match(html, /launcher-select-value">Opus</);
  assert.match(html, />601 \/ 500 characters</);
  assert.match(html, /class="research-editor-count is-over"/);
  const model = /<button[^>]*aria-label="Model"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(model, /\sdisabled/);
});

test("an empty question leaves the model menu enabled", () => {
  const html = editor("   ");
  assert.match(html, />Write the question first</);
  const model = /<button[^>]*aria-label="Model"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(model, /\sdisabled/);
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

test("a note's field is set in the reading scale and a document's in the source face", () => {
  const note = editor("A note");
  assert.match(note, /class="research-editor research-reading-surface"/);
  assert.match(note, /class="research-editor-field is-note"/);
  const document = editor("# Doc", { kind: "document" });
  assert.match(document, /class="research-editor"/);
  assert.match(document, /class="research-editor-field is-source"/);
});

test("⌘S or Ctrl+S is the save shortcut, and no app shortcut uses it", () => {
  const key = { key: "s", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(isSaveShortcut({ ...key, metaKey: true }), true);
  assert.equal(isSaveShortcut({ ...key, ctrlKey: true }), true);
  // Caps Lock reports an upper-case key.
  assert.equal(isSaveShortcut({ ...key, key: "S", metaKey: true }), true);
  assert.equal(isSaveShortcut(key), false);
  assert.equal(isSaveShortcut({ ...key, metaKey: true, ctrlKey: true }), false);
  assert.equal(isSaveShortcut({ ...key, metaKey: true, shiftKey: true }), false);
  assert.equal(isSaveShortcut({ ...key, metaKey: true, altKey: true }), false);
  assert.equal(isSaveShortcut({ ...key, key: "Enter", metaKey: true }), false);
  assert.equal(isSaveShortcut({ ...key, metaKey: true, nativeEvent: { isComposing: true } }), false);
  assert.equal(resolveAppShortcut({ ...key, metaKey: true }), null);
  assert.equal(resolveAppShortcut({ ...key, ctrlKey: true }), null);
});

test("the Save button's tooltip names both save shortcuts", () => {
  const html = editor("New text", { dirty: true, canSave: true });
  assert.match(html, /<button[^>]*research-editor-save[^>]*title="Save and close \(⌘↵\) · Save and keep editing \(⌘S\)"/);
});

test("⌘S in the field saves in place; ⌘↵ saves and closes", async () => {
  const calls: string[] = [];
  const props = editorProps("New text", {
    dirty: true,
    canSave: true,
    onSave: () => calls.push("save"),
    onSaveInPlace: () => calls.push("save in place"),
    onCancel: () => calls.push("cancel"),
  });
  await withMountedEditor(props, async ({ column, field, press }) => {
    assert.equal(await press(field, "s", { metaKey: true }), true);
    assert.deepEqual(calls, ["save in place"]);
    assert.equal(await press(field, "s", { ctrlKey: true }), true);
    assert.deepEqual(calls, ["save in place", "save in place"]);
    // From a footer button too: the key works anywhere in the column.
    assert.equal(await press(column.querySelector(".research-editor-save")!, "s", { metaKey: true }), true);
    assert.equal(calls.length, 3);
    // ⌘⇧S is not the shortcut, and the webview keeps it.
    assert.equal(await press(field, "s", { metaKey: true, shiftKey: true }), false);
    assert.equal(calls.length, 3);
    assert.equal(await press(field, "Enter", { metaKey: true }), true);
    assert.deepEqual(calls.slice(3), ["save"]);
  });
});

test("⌘S does nothing while Save is disabled or saving, and still keeps the webview's ⌘S from running", async () => {
  for (const overrides of [
    { dirty: false, canSave: false },
    // An empty note, or a document over a limit, with changes.
    { dirty: true, canSave: false },
    { dirty: true, canSave: true, saving: true },
  ]) {
    const calls: string[] = [];
    const props = editorProps("", {
      ...overrides,
      onSave: () => calls.push("save"),
      onSaveInPlace: () => calls.push("save in place"),
    });
    await withMountedEditor(props, async ({ field, press }) => {
      assert.equal(await press(field, "s", { metaKey: true }), true);
      assert.deepEqual(calls, [], JSON.stringify(overrides));
    });
  }
});

test("⌘S in the discard dialog saves and closes the dialog", async () => {
  const calls: string[] = [];
  const props = editorProps("New text", {
    dirty: true,
    canSave: true,
    onSaveInPlace: () => calls.push("save in place"),
    onCancel: () => calls.push("cancel"),
  });
  await withMountedEditor(props, async ({ column, field, press }) => {
    await press(field, "Escape");
    assert.ok(column.ownerDocument.querySelector("[role='alertdialog']"));
    assert.equal(await press(column.ownerDocument.querySelector("[role='alertdialog'] button")!, "s", { metaKey: true }), true);
    assert.deepEqual(calls, ["save in place"]);
    assert.equal(column.ownerDocument.querySelector("[role='alertdialog']"), null);
  });
});

test("the note field cancels a smart-dash replacement of a line of hyphens and lets prose dashes through", async () => {
  await withMountedEditor(editorProps("Title\n---\nA -- B"), async ({ field }) => {
    const window = field.ownerDocument.defaultView!;
    const replace = (data: string) => {
      const event = new window.InputEvent("beforeinput", {
        inputType: "insertReplacementText",
        data,
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    };
    // The caret at the end of "---", and at the end of "A -- B".
    field.setSelectionRange(9, 9);
    assert.equal(replace("—"), true);
    field.setSelectionRange(16, 16);
    assert.equal(replace("—"), false);
  });
});

test("the note field restores hyphens a substitution replaced and stores them through onChange", async () => {
  await withWidgetDom(async (window) => {
    const { createRoot } = await import("react-dom/client");
    const { useState } = await import("react");
    const changes: string[] = [];
    function Editor() {
      const [value, setValue] = useState("Title\n---");
      return createElement(
        ResearchEditorColumn,
        editorProps(value, {
          onChange: (next) => {
            changes.push(next);
            setValue(next);
          },
        }),
      );
    }
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(Editor)));
    const field = container.querySelector("textarea")!;
    try {
      await act(async () => {
        field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      // The text WebKit leaves when the substitution and Enter's newline
      // arrive in one input event, set without going through React.
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Title\n—\n");
      field.setSelectionRange(8, 8);
      await act(async () => {
        field.dispatchEvent(new window.InputEvent("input", { inputType: "insertParagraph", bubbles: true }));
      });
      assert.deepEqual(changes, ["Title\n---\n"]);
      assert.equal(field.value, "Title\n---\n");
      assert.equal(field.selectionStart, 10);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("a cancelled smart dash keeps the caret on Enter's new line after WebKit adjusts it", async () => {
  await withMountedEditor(editorProps("---\n"), async ({ field }) => {
    const window = field.ownerDocument.defaultView!;
    field.focus();
    field.setSelectionRange(4, 4);
    const event = new window.InputEvent("beforeinput", {
      inputType: "insertReplacementText",
      data: "—",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      field.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      // WebKit's text checker applies the planned replacement's length
      // adjustment even though beforeinput cancelled the replacement.
      field.setSelectionRange(3, 3);
      // Enter's enclosing edit can still report input with unchanged text.
      field.dispatchEvent(new window.InputEvent("input", { inputType: "insertLineBreak", bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    assert.equal(field.value, "---\n");
    assert.equal(field.selectionStart, 4);
    assert.equal(field.selectionEnd, 4);
  });
});

test("a deferred smart-dash caret restore yields to later typing, navigation, clicks and blur", async () => {
  for (const action of ["typing", "navigation", "click", "blur"]) {
    await withMountedEditor(editorProps("---\n"), async ({ field }) => {
      const window = field.ownerDocument.defaultView!;
      field.focus();
      field.setSelectionRange(4, 4);
      await act(async () => {
        field.dispatchEvent(new window.InputEvent("beforeinput", {
          inputType: "insertReplacementText",
          data: "—",
          bubbles: true,
          cancelable: true,
        }));
        if (action === "typing") {
          field.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true }));
        } else if (action === "navigation") {
          field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        } else if (action === "click") {
          field.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
        } else {
          field.blur();
        }
        field.setSelectionRange(1, 1);
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
      assert.equal(field.selectionStart, 1, action);
      assert.equal(field.selectionEnd, 1, action);
    });
  }
});

test("repeated cancelled smart dashes preserve the caret from before the native checking pass", async () => {
  await withMountedEditor(editorProps("------\n"), async ({ field }) => {
    const window = field.ownerDocument.defaultView!;
    field.focus();
    field.setSelectionRange(7, 7);
    await act(async () => {
      for (const caret of [6, 5]) {
        const event = new window.InputEvent("beforeinput", {
          inputType: "insertReplacementText",
          data: "—",
          bubbles: true,
          cancelable: true,
        });
        field.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        field.setSelectionRange(caret, caret);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    assert.equal(field.value, "------\n");
    assert.equal(field.selectionStart, 7);
    assert.equal(field.selectionEnd, 7);
  });
});

test("closing a dirty editor requires Discard; Escape keeps editing", async () => {
  let closed = 0;
  await withMountedEditor(editorProps("Unsaved", { dirty: true, onCancel: () => closed++ }), async ({ column, field, press }) => {
    await press(field, "Escape");
    const doc = column.ownerDocument;
    let dialog = doc.querySelector<HTMLElement>("[role='alertdialog']")!;
    assert.ok(dialog);
    assert.equal(closed, 0);
    await press(dialog.querySelector("button")!, "Escape");
    assert.equal(doc.querySelector("[role='alertdialog']"), null);
    assert.equal(closed, 0);
    await press(field, "Escape");
    dialog = doc.querySelector<HTMLElement>("[role='alertdialog']")!;
    await act(async () => dialog.querySelector<HTMLButtonElement>("button.danger")!.click());
    assert.equal(closed, 1);
  });
});
