import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResearchUnitMenuPlacement } from "../src/components/research/researchUnitMenu";
import type { AgentAdapterMetadata, ResearchImageAttachment, ResearchNode } from "../src/types";
import type { ResearchLaunchChoice } from "../src/components/research/ResearchQueryComposer";
import { researchNode, type NodeFixture } from "./researchNodeFixture";
import { withWidgetDom } from "./widgetDom";

// Registered before the thread is pulled in, since its composer shows
// adapter icons.
register("./svgStubLoader.mjs", import.meta.url);
const { default: ResearchPostThread, postThreadEntries } = await import(
  "../src/components/research/ResearchPostThread"
);
const {
  PostFollowUpField,
  postFollowUpAsk,
  postFollowUpAskLabel,
  postFollowUpCopy,
  postFollowUpDefault,
  postFollowUpImageBlock,
} = await import("../src/components/research/ResearchPostFollowUpField");

const noop = () => {};
const asyncNoop = async () => {};

const postFields = {
  id: "post", treeId: "tree", prompt: "Who ships component-model plugins?",
  adapter: "claude", model: "fable", groupId: "ws", type: "post", format: "text",
  status: "complete", createdAt: 100, highlights: [],} satisfies NodeFixture;
const post = researchNode(postFields);

const aboutFields = {
  ...postFields, id: "about", parentNodeId: "post", type: "exchange",
  prompt: "How large is the generated surface?", status: "running", createdAt: 130,} satisfies NodeFixture;
const about = researchNode(aboutFields);
const answeredFields = {
  ...postFields, id: "answered", parentNodeId: "post", type: "exchange",
  prompt: "Which runtimes support it?", status: "complete", createdAt: 160,} satisfies NodeFixture;
const answered = researchNode(answeredFields);
const noteFields = {
  ...postFields, id: "note", parentNodeId: "post", prompt: "Anyone measured wizer?", createdAt: 140,} satisfies NodeFixture;
const note = researchNode(noteFields);

function render(nodes: ResearchNode[], options: { openNodeId?: string | null; archived?: boolean } = {}) {
  return renderToStaticMarkup(createElement(ResearchPostThread, {
    nodes, post: nodes[0], archived: options.archived ?? false, requireCmdEnterToSend: true,
    openNodeId: options.openNodeId ?? null,
    actions: { onAskFollowUp: asyncNoop, onRetry: asyncNoop },
    onOpenFollowUp: noop,
    onOpenContextMenu: noop,
  }));
}

test("an empty follow-ups column has the composer and says it has no follow-ups", () => {
  const html = render([post]);
  assert.match(html, /<p class="post-thread-empty">No follow-ups yet\.<\/p>/);
  assert.doesNotMatch(html, /post-thread-rows|data-research-thread-row/);
  // The composer starts in Ask. Empty and unfocused, it is one line: the
  // Ask/Note switch and Send appear once it is focused.
  assert.match(html, /class="research-composer-wrap post-composer is-full-width"/);
  assert.match(html, /placeholder="Ask a follow-up"/);
  assert.doesNotMatch(html, /post-composer-row|new-research-switch|research-composer-send/);
  assert.ok(html.indexOf("post-composer") < html.indexOf("post-thread-empty"));
});

test("the composer comes first, then follow-ups as rows, oldest first", () => {
  const html = render([post, answered, about, note]);
  assert.ok(html.indexOf("post-composer") < html.indexOf("post-thread-rows"));
  assert.match(html, /<ol class="post-thread-list post-thread-rows" aria-label="Follow-ups">/);
  const order = [
    "How large is the generated surface?",
    "Anyone measured wizer?",
    "Which runtimes support it?",
  ].map((text) => html.indexOf(text));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || order[i - 1] < index)), String(order));
  assert.doesNotMatch(html, /Respond|Ask AI about this|Delete|post-avatar|data-type="reply"|is-nested/);
  assert.equal(html.match(/data-research-thread-row=""/g)?.length, 3);
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
  // Each row names its node, for ⌃Tab with focus kept in a text field.
  assert.deepEqual(
    [...html.matchAll(/data-thread-key="([^"]+)"/g)].map((match) => match[1]),
    ["about", "note", "answered"],
  );
  // The first row is the one in the tab order.
  assert.match(html, /data-thread-key="about" data-node-id="about"[^>]*tabindex="0"/);
});

test("a follow-up note's row shows its text; an AI follow-up's row its answer state", () => {
  const html = render([post, answered, about, note]);
  // A follow-up note: the note glyph and text, no status line or reply count.
  assert.match(html, /title="Open this note"/);
  assert.match(html, /lucide-sticky-note/);
  assert.match(html, /Anyone measured wizer\?<\/div><\/div>/);
  assert.doesNotMatch(html, /\d+ repl(y|ies)|lucide-globe|network/i);
  // An AI follow-up: answering, or answered (no preview of the answer).
  assert.match(html, /<span>asked Claude Fable<\/span>/);
  assert.match(html, />Answering</);
  assert.match(html, /Which runtimes support it\?<\/div><div class="post-thread-meta">Answered<\/div>/);
  assert.doesNotMatch(html, /Open answer|post-segment/);
});

test("the open follow-up's row is selected and in the tab order", () => {
  const html = render([post, answered, about, note], { openNodeId: "note" });
  assert.match(
    html,
    /<li class="post-thread-item post-thread-follow-up is-selected" data-type="follow-up"><button type="button" class="post-thread-hit" data-research-thread-row="" data-thread-key="note" data-node-id="note" aria-current="true"[^>]*tabindex="0"/,
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
  assert.equal(html.match(/aria-current="true"/g)?.length, 1);
});

test("an archived note has rows but no composer", () => {
  const html = render([post, answered], { archived: true });
  assert.doesNotMatch(html, /research-composer/);
  assert.match(html, /Which runtimes support it\?/);
});

test("a saved link's follow-ups column has the same composer as a note's", () => {
  const link = researchNode({ ...postFields, prompt: "https://example.com/page", format: "link" });
  const html = render([link]);
  assert.match(html, /placeholder="Ask a follow-up"/);
  // Collapsed while empty; the Ask/Note switch appears once it is focused.
  assert.doesNotMatch(html, /new-research-switch|Post to network/);
  assert.match(html, /No follow-ups yet\./);
});

test("follow-up rows skip documents and break time ties by id", () => {
  const documentFields = { ...postFields, id: "doc", parentNodeId: "post", type: "document", createdAt: 105 } satisfies NodeFixture;
  const document = researchNode(documentFields);
  const tieBFields = { ...aboutFields, id: "b", createdAt: 170 } satisfies NodeFixture;
  const tieB = researchNode(tieBFields);
  const tieAFields = { ...aboutFields, id: "a", createdAt: 170 } satisfies NodeFixture;
  const tieA = researchNode(tieAFields);
  assert.deepEqual(
    postThreadEntries([post, document, tieB, tieA], post).map((entry) => entry.id),
    ["a", "b"],
  );
});

test("an edited note's follow-ups column lists only its follow-ups", () => {
  const edited = researchNode({ ...postFields, prompt: "Who ships wit-bindgen 0.30 plugins?", editedAt: 135 });
  const nodes = [edited, about, answered];
  // The column header's count is the number of follow-ups.
  assert.deepEqual(
    postThreadEntries(nodes, edited).map((entry) => entry.id),
    ["about", "answered"],
  );
  const html = render(nodes);
  assert.equal(html.match(/data-research-thread-row=""/g)?.length, 2);
  assert.doesNotMatch(html, /[Cc]orrection|wit-bindgen 0\.30/);
});

test("the follow-up box uses Ask mode by default and adds a note in Note mode", () => {
  assert.deepEqual(postFollowUpCopy(false, "Ask a follow-up", "Ask Claude Fable"), {
    placeholder: "Ask a follow-up",
    sendName: "Ask",
    sendTitle: "Ask Claude Fable",
  });
  assert.deepEqual(postFollowUpCopy(true, "Ask a follow-up", "Ask Claude Fable"), {
    placeholder: "Add a note (not visible to agent)",
    sendName: "Add note",
    sendTitle: "Add note",
  });
});

test("each follow-up row opens its follow-up's menu as its context menu", async () => {
  await withWidgetDom(async (window) => {
    const MouseEvent = window.MouseEvent;
    const opened: { id: string; placement: ResearchUnitMenuPlacement }[] = [];
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(createElement(ResearchPostThread, {
        nodes: [post, answered, note], post: post, archived: true, requireCmdEnterToSend: true,
        openNodeId: null, actions: { onAskFollowUp: asyncNoop, onRetry: asyncNoop }, onOpenFollowUp: noop,
        onOpenContextMenu: (node, placement) => opened.push({ id: node.id, placement }),
      })),
    );
    const text = (content: string) =>
      [...container.querySelectorAll<HTMLElement>(".post-thread-question")].find((element) => element.textContent === content)!;
    // A right-click on a follow-up note's text, and on an AI follow-up's,
    // opens the menu at the pointer instead of the webview's menu.
    for (const [content, x] of [["Anyone measured wizer?", 40], ["Which runtimes support it?", 60]] as const) {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: 20 });
      await act(async () => { text(content).dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true);
    }
    assert.deepEqual(opened, [
      { id: "note", placement: { anchor: { left: 40, top: 20, right: 40, bottom: 20 }, align: "point" } },
      { id: "answered", placement: { anchor: { left: 60, top: 20, right: 60, bottom: 20 }, align: "point" } },
    ]);
    // Shift+F10 on a focused row opens the menu at the row, which has no …
    // button.
    const row = container.querySelector<HTMLElement>('[data-thread-key="note"]')!;
    const key = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true });
    await act(async () => { row.dispatchEvent(key); });
    assert.equal(key.defaultPrevented, true);
    assert.equal(opened.length, 3);
    assert.equal(opened[2].id, "note");
    assert.equal(opened[2].placement.align, "point");
    await act(async () => root.unmount());
  });
});

function agentAdapter(
  id: string,
  overrides: Partial<AgentAdapterMetadata> = {},
): AgentAdapterMetadata {
  return {
    id,
    label: id === "claude" ? "Claude" : id === "codex" ? "Codex" : "Grok",
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
    instanceId: `local:${id}`,
    target: { kind: "local", id: null, label: "This Mac" },
    ...overrides,
  };
}

const claude = agentAdapter("claude");
const codex = agentAdapter("codex");
const unreadyGrok = agentAdapter("grok", { researchReadiness: "needsAuth" });

test("a note's follow-up runs on the note's agent and model unless that agent cannot do research", () => {
  assert.deepEqual(postFollowUpDefault(post, [claude, codex]), {
    adapter: "claude",
    model: "fable",
    effort: null,
  });
  // As the backend: an agent without research support falls back to the
  // default ready research agent, at its default model.
  const onGrok = researchNode({ ...postFields, adapter: "grok", model: "grok-5", effort: "high" });
  assert.deepEqual(postFollowUpDefault(onGrok, [claude, agentAdapter("grok", { supportsResearch: false })]), {
    adapter: "claude",
    model: null,
    effort: null,
  });
  assert.equal(postFollowUpDefault(post, []), null);
});

test("the follow-up box asks with its model menu choice, else the note's follow-up agent", () => {
  const fallback = postFollowUpDefault(post, [claude, codex]);
  // No choice: the box shows the note's agent and sends none, so the
  // backend's own pick applies.
  assert.deepEqual(postFollowUpAsk([claude, codex], fallback, null), {
    shown: fallback,
    agent: null,
    choice: { adapter: "claude", preset: "fable", customModel: "", effort: "" },
  });
  const onCodex = { adapter: "codex", preset: "gpt-6-astra", customModel: "", effort: "high" };
  assert.deepEqual(postFollowUpAsk([claude, codex], fallback, onCodex), {
    shown: { adapter: "codex", model: "gpt-6-astra", effort: "high" },
    agent: { adapter: "codex", model: "gpt-6-astra", effort: "high" },
    choice: onCodex,
  });
  // A chosen agent that is no longer ready falls back to the note's agent.
  const onGrok = { adapter: "grok", preset: "custom", customModel: "", effort: "" };
  assert.equal(postFollowUpAsk([claude, unreadyGrok], fallback, onGrok).agent, null);
  assert.deepEqual(postFollowUpAsk([claude, unreadyGrok], fallback, onGrok).shown, fallback);
  assert.deepEqual(postFollowUpAsk([], null, null), { shown: null, agent: null, choice: null });
});

test("the follow-up box's images are checked against the agent the follow-up runs on", () => {
  const shot: ResearchImageAttachment = { kind: "image", id: "img", mimeType: "image/png", byteSize: 10 };
  const grok = agentAdapter("grok");
  assert.equal(postFollowUpImageBlock(false, "claude", [claude, grok], [shot]), null);
  assert.equal(postFollowUpImageBlock(false, "grok", [claude, grok], [shot]), "Grok can't read images.");
  assert.equal(postFollowUpImageBlock(false, "grok", [claude, grok], []), null);
  assert.match(postFollowUpImageBlock(true, "claude", [claude], [shot]) ?? "", /Notes can't include images/);
});

test("the Ask segment is named for the agent and model the follow-up runs on", () => {
  assert.equal(postFollowUpAskLabel({ adapter: "claude", model: "fable", effort: null }), "Ask Claude Fable");
  assert.equal(
    postFollowUpAskLabel({ adapter: "codex", model: "gpt-6-astra", effort: "high" }),
    "Ask Codex gpt-6-astra",
  );
  assert.equal(postFollowUpAskLabel({ adapter: "claude", model: "my-model", effort: null }), "Ask Claude my-model");
  assert.equal(postFollowUpAskLabel({ adapter: "grok", model: null, effort: null }), "Ask Grok");
  assert.equal(postFollowUpAskLabel(null), "Ask AI");
});

test("the follow-up box's Ask segment shows the agent's icon and opens the model menu", async () => {
  await withWidgetDom(async (window) => {
    // The model menu places itself from computed styles.
    Object.defineProperty(globalThis, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      configurable: true,
      writable: true,
    });
    // React DOM was loaded before this DOM existed, so it watches text
    // fields with its fallback for browsers without input events, which
    // listens through attachEvent and reads changes on keyup.
    Object.assign(window.HTMLElement.prototype, { attachEvent: () => {}, detachEvent: () => {} });
    const sent: {
      prompt: string;
      asNote: boolean;
      images: ResearchImageAttachment[];
      agent: ResearchLaunchChoice | null;
    }[] = [];
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(PostFollowUpField, {
          post,
          adapters: [claude, codex, unreadyGrok],
          requireCmdEnter: true,
          onSubmit: async (prompt, asNote, images, agent) => {
            sent.push({ prompt, asNote, images, agent });
          },
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () => textarea.focus());
    const askSegment = () => container.querySelector<HTMLButtonElement>('.new-research-switch-option[role="radio"]')!;
    // The note's agent and model, as the agent's icon instead of a sparkle.
    assert.equal(askSegment().getAttribute("aria-label"), "Ask Claude Fable");
    assert.equal(askSegment().getAttribute("title"), "Ask Claude Fable");
    assert.ok(askSegment().querySelector("img.launcher-select-icon"));
    assert.equal(askSegment().querySelector(".lucide-sparkles"), null);
    assert.ok(askSegment().querySelector(".new-research-switch-chevron"));

    // A press on the selected Ask segment opens the Home ask box's model menu.
    await act(async () => askSegment().click());
    const listbox = window.document.querySelector('[role="listbox"][aria-label="Model"]');
    assert.ok(listbox);
    const option = (label: string) =>
      [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
        (item) => item.querySelector(".launcher-select-item-label")?.textContent === label,
      )!;
    assert.equal(option("Fable").getAttribute("aria-selected"), "true");
    // An agent that is not ready is listed but cannot be chosen.
    assert.equal(option("Grok").disabled, true);
    await act(async () => option("gpt-6-astra").click());
    assert.equal(window.document.querySelector('[role="listbox"][aria-label="Model"]'), null);
    assert.equal(askSegment().getAttribute("aria-label"), "Ask Codex gpt-6-astra");
    assert.ok(askSegment().querySelector("img.launcher-select-icon.is-mono-light"));

    // The follow-up is sent with the chosen agent and model.
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      textarea.focus();
      setValue.call(textarea, "Which runtimes?");
      textarea.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".research-composer-send")!.click());
    assert.deepEqual(sent, [
      {
        prompt: "Which runtimes?",
        asNote: false,
        images: [],
        agent: { adapter: "codex", model: "gpt-6-astra", effort: null },
      },
    ]);
    await act(async () => root.unmount());
    Reflect.deleteProperty(globalThis, "getComputedStyle");
  });
});
