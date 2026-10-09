import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchConversationComposer, {
  researchComposerEnterAction,
} from "../src/components/research/ResearchConversationComposer";

function key(
  keyName: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
  isComposing = false,
) {
  return {
    key: keyName,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
    nativeEvent: { isComposing },
  } as unknown as Parameters<typeof researchComposerEnterAction>[0];
}

test("with Require ⌘↵ to send on, only ⌘↵ sends from a column composer", () => {
  assert.equal(researchComposerEnterAction(key("Enter"), true), null);
  assert.equal(researchComposerEnterAction(key("Enter", { shiftKey: true }), true), null);
  assert.equal(researchComposerEnterAction(key("Enter", { metaKey: true }), true), "send");
});

test("with Require ⌘↵ to send off, a bare ↵ sends and ⇧↵ adds a line", () => {
  assert.equal(researchComposerEnterAction(key("Enter"), false), "send");
  assert.equal(researchComposerEnterAction(key("Enter", { shiftKey: true }), false), null);
  assert.equal(researchComposerEnterAction(key("Enter", { metaKey: true }), false), null);
});

test("⇧⌘↵ starts a branch whatever the send setting", () => {
  for (const requireCmdEnter of [true, false]) {
    assert.equal(
      researchComposerEnterAction(key("Enter", { shiftKey: true, metaKey: true }), requireCmdEnter),
      "branch",
    );
  }
});

test("IME composition and other keys never send", () => {
  assert.equal(researchComposerEnterAction(key("Enter", {}, true), false), null);
  assert.equal(researchComposerEnterAction(key("Enter", { metaKey: true }, true), true), null);
  assert.equal(researchComposerEnterAction(key("a"), false), null);
});

test("the send button's glyph and title follow the setting", () => {
  const render = (requireCmdEnter: boolean) =>
    renderToStaticMarkup(
      createElement(ResearchConversationComposer, {
        value: "Why?",
        placeholder: "Ask a follow-up",
        disabled: false,
        canSubmit: true,
        submitting: false,
        requireCmdEnter,
        onChange: () => {},
        onSubmit: () => {},
      }),
    );
  const strict = render(true);
  assert.match(strict, /title="Send \(⌘↵\)"/);
  assert.match(strict, /class="research-composer-enter"[^>]*>⌘<span class="enter-glyph"/);
  const loose = render(false);
  assert.match(loose, /title="Send \(↵\)"/);
  assert.doesNotMatch(loose, /⌘/);
});
