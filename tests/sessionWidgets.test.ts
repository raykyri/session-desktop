import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TranscriptMarkdown, {
  transcriptMathPluginsReady,
} from "../src/components/TranscriptMarkdown";
import { SessionWidgetStreamingContext } from "../src/components/SessionWidget";
import {
  ResearchInlineWidgetsContext,
  ResearchMarkdown,
} from "../src/components/research/ResearchMessage";
import { buildSegmentView } from "../src/lib/researchSegmentView";
import {
  fencedBlockIsClosed,
  SESSION_WIDGET_FRAME_INITIAL,
  sessionWidgetFrameReducer,
  sessionWidgetFrameUrl,
  sessionWidgetFrameMessage,
  sessionWidgetPingTick,
  sessionWidgetRecordFocusTake,
  sessionWidgetTookFocus,
  sessionWidgetOpenUrl,
  isSessionWidgetInfo,
  MAX_SESSION_WIDGET_BYTES,
  SESSION_WIDGET_MAX_HEIGHT,
  SESSION_WIDGET_MIN_HEIGHT,
  sessionWidgetFrameHeight,
  sessionWidgetHasScripts,
  stripSessionWidgetBlocks,
} from "@session/shared/lib/sessionWidgets";
import { loadSettings } from "../src/lib/settings";
import type { Turn } from "../src/types";
import { researchNode } from "./researchNodeFixture";

await transcriptMathPluginsReady;

const WIDGET = "```session-html\n<div id=\"demo\">Demo</div>\n<script>demo.textContent = 'ran'</script>\n```";

function render(text: string, widgets = true, inline = false, streaming = false) {
  return renderToStaticMarkup(
    createElement(
      SessionWidgetStreamingContext.Provider,
      { value: streaming },
      createElement(TranscriptMarkdown, { text, widgets, inline }),
    ),
  );
}

function isFrame(html: string) {
  return /<figure[^>]*class="session-widget" data-state="loading"/.test(html);
}

test("a complete session-html block renders a widget frame, not its source", () => {
  const html = render(`Before.\n\n${WIDGET}\n\nAfter.`);
  assert.ok(isFrame(html), html);
  assert.ok(!html.includes("demo.textContent"), html);
  assert.ok(html.includes("Before.") && html.includes("After."), html);
});

test("with widgets off the block is an ordinary code block", () => {
  const html = render(`Before.\n\n${WIDGET}`, false);
  assert.ok(!html.includes("class=\"session-widget"), html);
  assert.ok(html.includes("turn-markdown-code-block"), html);
  assert.ok(html.includes("language-session-html"), html);
  assert.ok(html.includes("demo.textContent"), html);
});

test("a block still streaming shows a placeholder, not a frame", () => {
  const html = render("Answer so far.\n\n```session-html\n<div>half a wid", true, false, true);
  assert.ok(html.includes('data-state="pending"'), html);
  assert.ok(!isFrame(html), html);
  assert.ok(!html.includes("half a wid"), html);
  // A shorter run of backticks does not close a longer opening fence.
  const longer = render("````session-html\n<pre>```</pre>\n```", true, false, true);
  assert.ok(longer.includes('data-state="pending"'), longer);
  const closed = render("````session-html\n<pre>```</pre>\n````", true, false, true);
  assert.ok(isFrame(closed), closed);
});

test("an unclosed block in a settled answer shows its source with a notice", () => {
  for (const text of [
    "Answer.\n\n```session-html\n<div>cut off",
    // CommonMark does not accept a closing fence indented four spaces.
    "```session-html\n<p>x</p>\n    ```",
    // Nor one indented past its list item's content by four or more.
    "- item\n\n  ```session-html\n  <p>x</p>\n      ```\n",
  ]) {
    const html = render(text);
    assert.ok(!html.includes('data-state="pending"'), html);
    assert.ok(!isFrame(html), html);
    assert.match(html, /data-label="Widget incomplete: the block has no closing fence"/);
    assert.ok(html.includes("turn-markdown-code-block"), html);
  }
});

test("widget blocks nested in lists and block quotes render; code samples of them do not", () => {
  const list = render("- Step one\n\n  ```session-html\n  <p>in a list</p>\n  ```\n");
  assert.ok(isFrame(list), list);
  const quote = render("> ```session-html\n> <p>quoted</p>\n> ```\n");
  assert.ok(isFrame(quote), quote);
  const sample = render("````markdown\n```session-html\n<p>sample</p>\n```\n````");
  assert.ok(!sample.includes("class=\"session-widget"), sample);
  assert.ok(sample.includes("&lt;p&gt;sample&lt;/p&gt;"), sample);
  const indented = render("Text.\n\n    ```session-html\n    <p>indented code</p>\n    ```\n");
  assert.ok(!indented.includes("class=\"session-widget"), indented);
  const otherLanguage = render("```session-htmlx\n<p>other</p>\n```");
  assert.ok(!otherLanguage.includes("class=\"session-widget"), otherLanguage);
});

test("an oversized block is shown as code with a notice", () => {
  const big = `<p>${"x".repeat(MAX_SESSION_WIDGET_BYTES)}</p>`;
  const html = render(`\`\`\`session-html\n${big}\n\`\`\``);
  assert.ok(!isFrame(html), "no frame");
  assert.ok(html.includes("session-widget-notice"), "notice");
  assert.match(html, /data-label="Widget not shown: 65 KB exceeds the 64 KB limit"/);
  assert.ok(html.includes("turn-markdown-code-block"), "code block");
  // The limit counts UTF-8 bytes, not UTF-16 code units.
  const multibyte = "é".repeat(MAX_SESSION_WIDGET_BYTES / 2 + 1);
  const wide = render(`\`\`\`session-html\n${multibyte}\n\`\`\``);
  assert.ok(wide.includes("session-widget-notice"));
});

test("inline previews drop widget HTML entirely", () => {
  const html = render(`Summary line.\n\n${WIDGET}\n\nMore.`, true, true);
  assert.ok(!html.includes("Demo") && !html.includes("demo.textContent"), html);
  assert.ok(html.includes("Summary line.") && html.includes("More."), html);
  // Other inline code still flattens to text.
  assert.ok(render("Use `npm test`.", true, true).includes("npm test"));
});

test("widget chrome stays out of the projection, find and copy, and shows the generated title as plain text", async () => {
  const { withWidgetDom } = await import("./widgetDom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WidgetAnswerContext } = await import("../src/lib/sessionWidgetActions");
  const { isSearchableText } = await import("../src/lib/transcriptSearch");
  const { researchTextProjection } = await import("../src/components/research/researchTextRanges");
  await withWidgetDom(async (window) => {
    const agentTitle = "Settings\nSaved ✓ Your session expired, sign in again";
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { input?: { title?: string } }) => {
      if (command === "research_widget_prepare") return { staticUrl: "http://127.0.0.1:1234/w", runUrl: "http://127.0.0.1:1234/r" };
      if (command === "research_artifact_register") return {
        artifactId: "chart", title: "Settings Saved ✓ Your session expired, sign in again", treeId: "t", nodeId: "n", slot: "s",
        revision: "a".repeat(64), contentHash: "b".repeat(64), parentRevision: null, html: "", createdAt: 1, unresolvedParent: false,
        echoed: args.input?.title,
      };
      if (command === "research_artifact_state_get") return { enabled: false, value: null };
      throw new Error(`unexpected ${command}`);
    } } });
    const markdown = `Before.\n\n\`\`\`session-html id=chart title=${JSON.stringify(agentTitle)}\n${WIDGET.split("\n").slice(1, -1).join("\n")}\n\`\`\`\n\nAfter.`;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(WidgetAnswerContext.Provider, { value: { nodeId: "n", treeId: "t", messageKey: "m", answer: markdown } },
        createElement(TranscriptMarkdown, { text: markdown, widgets: true }))));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const figure = container.querySelector(".session-widget")!;
      const heading = figure.querySelector(".session-widget-title")!;
      assert.equal(heading.textContent, "Settings Saved ✓ Your session expired, sign in again");
      assert.equal(heading.getAttribute("title"), "Settings Saved ✓ Your session expired, sign in again");
      assert.equal(heading.children.length, 0, "the title is one text node");
      assert.equal(figure.textContent!.includes("Widget:"), false);
      // Every text node of the widget is chrome; the answer's prose is not.
      const walker = document.createTreeWalker(figure, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
      assert.ok(texts.some((node) => node.data.includes("Settings Saved")) && texts.some((node) => node.data === "Preview"));
      for (const node of texts) {
        assert.ok(node.parentElement!.closest("[data-widget-chrome]"), `chrome text ${JSON.stringify(node.data)}`);
        assert.equal(isSearchableText(node), false, node.data);
      }
      const prose = [...container.querySelectorAll("p")].find((p) => p.textContent === "After.")!.firstChild!;
      assert.equal(isSearchableText(prose), true);
      assert.equal(researchTextProjection(container).includes("Settings Saved"), false);
      // The Source view is answer content (searchable) but joins a copied
      // selection only when the selection starts inside it.
      const sourceButton = [...figure.querySelectorAll("button")].find((button) => button.textContent === "Source")!;
      await act(async () => sourceButton.click());
      const source = figure.querySelector<HTMLElement>(".session-widget-source")!;
      assert.equal(isSearchableText(source.querySelector("code")!.firstChild!), true);
      assert.equal(source.dataset.selectable, undefined);
      await act(async () => { source.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
      assert.equal(source.dataset.selectable, "");
      await act(async () => { document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
      assert.equal(source.dataset.selectable, undefined);
      const css = readFileSync(new URL("../src/styles/features/transcript.css", import.meta.url), "utf8");
      assert.match(css, /\.session-widget \[data-widget-chrome\] \{[^}]*user-select: none/);
      assert.match(css, /\.session-widget-source:not\(\[data-selectable\]\) \{[^}]*user-select: none/);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("ResearchMarkdown shows widgets only for opted-in body text with the setting on", () => {
  const view = (enabled: boolean, props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(
        ResearchInlineWidgetsContext.Provider,
        { value: enabled },
        createElement(ResearchMarkdown, { text: WIDGET, ...props }),
      ),
    );
  assert.ok(isFrame(view(true, { widgets: true })));
  assert.ok(!view(false, { widgets: true }).includes("class=\"session-widget"));
  assert.ok(!view(true, {}).includes("class=\"session-widget"), "prompts and notes do not opt in");
  assert.ok(!view(true, { widgets: true, variant: "compact" }).includes("class=\"session-widget"));
  assert.ok(!renderToStaticMarkup(createElement(ResearchMarkdown, { text: WIDGET, widgets: true })).includes("class=\"session-widget"));
});

test("stripSessionWidgetBlocks removes widget blocks and keeps everything else", () => {
  const markdown = [
    "Intro.",
    "",
    "```session-html",
    "<p>one</p>",
    "```",
    "",
    "- item",
    "",
    "  ~~~~session-html title",
    "  <p>two</p>",
    "  ~~~~",
    "",
    "> ```session-html",
    "> <p>three</p>",
    "> ```",
    "",
    "````markdown",
    "```session-html",
    "<p>sample</p>",
    "```",
    "````",
    "",
    "End.",
  ].join("\n");
  const stripped = stripSessionWidgetBlocks(markdown);
  for (const gone of ["<p>one</p>", "<p>two</p>", "<p>three</p>"]) {
    assert.ok(!stripped.includes(gone), stripped);
  }
  for (const kept of ["Intro.", "- item", "<p>sample</p>", "````markdown", "End."]) {
    assert.ok(stripped.includes(kept), stripped);
  }
  assert.equal(stripSessionWidgetBlocks("No widgets."), "No widgets.");
  assert.equal(stripSessionWidgetBlocks("Text.\n\n```session-html\n<p>par").trim(), "Text.");
});

test("word counts parse list-leading fences and preserve code examples and following prose", () => {
  for (const marker of ["-", "1.", "> -"]) {
    const indent = marker.startsWith(">") ? ">   " : "    ";
    const markdown = `${marker} \`\`\`session-html\n${indent}<p>widget source</p>\n${indent}\`\`\`\n\nAfter.`;
    assert.ok(!stripSessionWidgetBlocks(markdown).includes("widget source"), marker);
    assert.ok(stripSessionWidgetBlocks(markdown).includes("After."), marker);
  }
  const indented = "Example:\n\n    ```session-html\n    <p>code sample</p>\n    ```";
  assert.equal(stripSessionWidgetBlocks(indented), indented);
  assert.ok(stripSessionWidgetBlocks("> ```session-html\n> <p>unfinished</p>\n\nOutside the quote.").includes("Outside the quote."));
});

test("fence completion follows the parser's code text", () => {
  // Closed: opening fence, the value's lines, a closing fence.
  assert.equal(fencedBlockIsClosed("```session-html\n<p>x</p>\n```", "<p>x</p>"), true);
  assert.equal(fencedBlockIsClosed("```session-html\n<p>x</p>\n  ```  ", "<p>x</p>"), true);
  assert.equal(fencedBlockIsClosed("```session-html\n```", ""), true);
  assert.equal(fencedBlockIsClosed("```session-html\n  x\n  ```", "x"), true);
  assert.equal(fencedBlockIsClosed("```session-html\n> x\n> ```", "x"), true);
  assert.equal(fencedBlockIsClosed("```session-html\r\nx\r\n```", "x"), true);
  // Unclosed: the last line is code text (here a fence indented four spaces).
  assert.equal(fencedBlockIsClosed("```session-html\nx\n    ```", "x\n    ```"), false);
  assert.equal(fencedBlockIsClosed("~~~session-html\n<p>x</p>\n```", "<p>x</p>\n```"), false);
  assert.equal(fencedBlockIsClosed("```session-html\n<p>x</p>", "<p>x</p>"), false);
  assert.equal(fencedBlockIsClosed("```session-html", ""), false);
  assert.equal(fencedBlockIsClosed("```session-html\n", ""), false);
});

test("the frame state machine runs only on request and drops a frame that navigates", () => {
  const urls = { staticUrl: "http://127.0.0.1:1/__session/widget/s/h.html", runUrl: "http://127.0.0.1:1/__session/widget/r/h.html" };
  let state = sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "prepare" });
  assert.equal(state.phase, "loading");
  assert.equal(sessionWidgetFrameUrl(state), null);
  state = sessionWidgetFrameReducer(state, { type: "prepared", urls, running: false });
  assert.equal(sessionWidgetFrameUrl(state), urls.staticUrl);
  assert.equal(sessionWidgetOpenUrl(state), urls.staticUrl, "open in browser does not run scripts");
  state = sessionWidgetFrameReducer(state, { type: "load" });
  assert.equal(state.phase, "ready");
  const beforeRun = state.generation;
  state = sessionWidgetFrameReducer(state, { type: "run" });
  assert.equal(state.running, true);
  assert.equal(state.loads, 0);
  assert.ok(state.generation > beforeRun, "a new frame for the run page");
  assert.equal(sessionWidgetFrameUrl(state), urls.runUrl);
  assert.equal(sessionWidgetOpenUrl(state), urls.runUrl);
  state = sessionWidgetFrameReducer(state, { type: "load" });
  assert.equal(state.phase, "ready");
  state = sessionWidgetFrameReducer(state, { type: "load" });
  assert.equal(state.phase, "navigated", "a second load is a self-navigation");
  assert.equal(sessionWidgetFrameUrl(state), null);
  assert.equal(sessionWidgetFrameReducer(state, { type: "load" }).phase, "navigated");
  state = sessionWidgetFrameReducer(state, { type: "reload" });
  assert.equal(state.phase, "ready");
  assert.equal(state.loads, 0);
  assert.equal(sessionWidgetFrameUrl(state), urls.runUrl, "reload keeps the reader's run choice");
  // Without a run URL (scripts not allowed) Run is a no-op, even if the
  // widget had been run before.
  const noRun = { staticUrl: urls.staticUrl, runUrl: null };
  let off = sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "prepared", urls: noRun, running: true });
  assert.equal(off.running, false);
  off = sessionWidgetFrameReducer(off, { type: "run" });
  assert.equal(off.running, false);
  assert.equal(sessionWidgetFrameUrl(off), urls.staticUrl);
  // A failed prepare shows no frame and ignores loads.
  const failed = sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "failed" });
  assert.equal(sessionWidgetFrameReducer(failed, { type: "load" }).phase, "failed");
});

test("frame messages count only from the widget's own frame", () => {
  const frameWindow = {};
  const report = { type: "session-widget-height", height: 300 };
  const unload = { type: "session-widget-unload" };
  assert.deepEqual(sessionWidgetFrameMessage({ source: frameWindow, data: report }, frameWindow), { type: "height", height: 300 });
  assert.deepEqual(sessionWidgetFrameMessage({ source: frameWindow, data: unload }, frameWindow), { type: "unload" });
  assert.equal(sessionWidgetFrameMessage({ source: {}, data: report }, frameWindow), null);
  assert.equal(sessionWidgetFrameMessage({ source: {}, data: unload }, frameWindow), null);
  assert.equal(sessionWidgetFrameMessage({ source: null, data: report }, null), null);
  assert.equal(sessionWidgetFrameMessage({ source: frameWindow, data: { type: "x", height: 3 } }, frameWindow), null);
  assert.deepEqual(sessionWidgetFrameMessage({ source: frameWindow, data: { type: "session-widget-pong", id: 3 } }, frameWindow), { type: "pong" });
  assert.equal(sessionWidgetFrameMessage({ source: {}, data: { type: "session-widget-pong" } }, frameWindow), null);
});

test("five unanswered pings in a row mean the widget page is gone", () => {
  let unanswered = 0;
  const gone: boolean[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const result = sessionWidgetPingTick(unanswered);
    unanswered = result.unanswered;
    gone.push(result.gone);
  }
  assert.deepEqual(gone, [false, false, false, false, true]);
  // An answer resets the count (the caller sets it back to zero).
  assert.equal(sessionWidgetPingTick(0).gone, false);
});

test("an unload notice drops the frame like a second load", () => {
  const urls = { staticUrl: "http://127.0.0.1:1/__session/widget/s/h.html", runUrl: "http://127.0.0.1:1/__session/widget/r/h.html" };
  let state = sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "prepared", urls, running: false });
  state = sessionWidgetFrameReducer(state, { type: "load" });
  state = sessionWidgetFrameReducer(state, { type: "unload" });
  assert.equal(state.phase, "navigated");
  assert.equal(sessionWidgetFrameUrl(state), null);
  assert.equal(sessionWidgetFrameReducer(state, { type: "reload" }).phase, "ready");
  // Before prepare finishes there is no frame to drop.
  assert.equal(sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "unload" }).phase, "loading");
});

test("a widget that keeps taking focus is stopped and returns to its static page", () => {
  const urls = { staticUrl: "http://127.0.0.1:1/__session/widget/s/h.html", runUrl: "http://127.0.0.1:1/__session/widget/r/h.html" };
  let state = sessionWidgetFrameReducer(SESSION_WIDGET_FRAME_INITIAL, { type: "prepared", urls, running: false });
  state = sessionWidgetFrameReducer(state, { type: "run" });
  const generation = state.generation;
  state = sessionWidgetFrameReducer(state, { type: "stop", reason: "focus" });
  assert.equal(state.running, false);
  assert.equal(state.stopped, "focus");
  assert.ok(state.generation > generation, "a new frame for the static page");
  assert.equal(sessionWidgetFrameUrl(state), urls.staticUrl);
  // Running it again clears the notice.
  state = sessionWidgetFrameReducer(state, { type: "run" });
  assert.equal(state.stopped, null);
  assert.equal(sessionWidgetFrameReducer(sessionWidgetFrameReducer(state, { type: "stop", reason: "focus" }), { type: "stop", reason: "focus" }).running, false);

  // Focus moved by Session (Run/Reload), by a click on the frame, or with no
  // recent app interaction is not taken.
  const base = { now: 10_000, programmaticUntil: 0, lastAppInteraction: 9_800, pointerOverFrame: false };
  assert.equal(sessionWidgetTookFocus(base), true);
  assert.equal(sessionWidgetTookFocus({ ...base, programmaticUntil: 10_500 }), false);
  assert.equal(sessionWidgetTookFocus({ ...base, pointerOverFrame: true }), false);
  assert.equal(sessionWidgetTookFocus({ ...base, lastAppInteraction: 5_000 }), false);
  // Three takes within ten seconds stop it; old takes age out.
  let takes: number[] = [];
  for (const [at, stop] of [[0, false], [100, false], [20_000, false], [20_100, false], [20_200, true]] as const) {
    const record = sessionWidgetRecordFocusTake(takes, at);
    takes = record.takes;
    assert.equal(record.stop, stop, `take at ${at}`);
  }
});

test("fence helpers classify info strings, closing fences and scripts", () => {
  assert.equal(isSessionWidgetInfo("session-html"), true);
  assert.equal(isSessionWidgetInfo(" session-html title=x"), true);
  assert.equal(isSessionWidgetInfo("session-htmlx"), false);
  assert.equal(isSessionWidgetInfo("html"), false);
  assert.equal(sessionWidgetHasScripts("<p>static</p><style>p{}</style>"), false);
  assert.equal(sessionWidgetHasScripts("<script>x()</script>"), true);
  assert.equal(sessionWidgetHasScripts('<button onclick="x()">'), true);
  assert.equal(sessionWidgetHasScripts('<a href="javascript:x()">'), true);
});

test("frame heights come only from well-formed reports and are bounded", () => {
  assert.equal(sessionWidgetFrameHeight({ type: "session-widget-height", height: 321.2 }), 322);
  assert.equal(sessionWidgetFrameHeight({ type: "session-widget-height", height: 1 }), SESSION_WIDGET_MIN_HEIGHT);
  assert.equal(sessionWidgetFrameHeight({ type: "session-widget-height", height: 1e9 }), SESSION_WIDGET_MAX_HEIGHT);
  assert.equal(sessionWidgetFrameHeight({ type: "session-widget-height", height: Number.NaN }), null);
  assert.equal(sessionWidgetFrameHeight({ type: "session-preview-scroll", height: 10 }), null);
  assert.equal(sessionWidgetFrameHeight("session-widget-height"), null);
});

test("copied answers keep widget blocks verbatim; the word count skips them", () => {
  const answer = `Compound interest grows faster.\n\n${WIDGET}\n\nSee above.`;
  const turns: Turn[] = [
    { id: "u", agentId: "a", role: "user", blocks: [{ type: "text", text: "Q" }], sourceIndex: 0 },
    { id: "a", agentId: "a", role: "assistant", blocks: [{ type: "text", text: answer }], sourceIndex: 1 },
  ];
  const node = researchNode({ id: "n", prompt: "Q", status: "complete", sessionReady: true });
  const view = buildSegmentView(node, { node, turns }, false, false);
  assert.ok(view.rawAnswer.includes(WIDGET), view.rawAnswer);
  assert.equal(view.answerWordCount, 6);
});

test("the setting defaults on and keeps an explicit choice", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
  assert.equal(loadSettings().researchInlineWidgets, true);
  store.set("session.settings.v1", JSON.stringify({ researchInlineWidgets: false }));
  assert.equal(loadSettings().researchInlineWidgets, false);
  store.set("session.settings.v1", JSON.stringify({ researchInlineWidgets: "no" }));
  assert.equal(loadSettings().researchInlineWidgets, true);
});

test("frames share one native shortcut-fallback claim", async () => {
  const { createShortcutFallbackRegistry } = await import("../src/lib/iframeShortcutFallback");
  let active: unknown = null;
  const reports: boolean[] = [];
  const listeners = new Map<string, () => void>();
  const frames: (() => void)[] = [];
  const flush = () => frames.splice(0).forEach((callback) => callback());
  const fire = (type: string) => {
    listeners.get(type)?.();
    flush();
  };
  const registry = createShortcutFallbackRegistry({
    activeElement: () => active,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => undefined,
    listen: (type, listener) => listeners.set(type, listener),
    unlisten: (type) => listeners.delete(type),
    report: (value) => reports.push(value),
  });
  const overlay = {};
  const widget = {};
  const releaseOverlay = registry.register(overlay);
  const releaseWidget = registry.register(widget);
  flush();
  assert.equal(listeners.size, 3);
  active = widget;
  fire("blur");
  active = overlay;
  fire("focus");
  // Releasing the widget while the overlay holds focus keeps the claim.
  releaseWidget();
  flush();
  assert.deepEqual(reports, [true]);
  active = null;
  fire("focusin");
  assert.deepEqual(reports, [true, false]);
  active = overlay;
  fire("blur");
  releaseOverlay();
  assert.deepEqual(reports, [true, false, true, false], "the last release clears the claim");
  assert.equal(listeners.size, 0);
});

test("artifact metadata is optional, bounded, and carried through the fence", async () => {
  const { sessionWidgetMetadata } = await import('@session/shared/lib/sessionWidgets');
  assert.deepEqual(sessionWidgetMetadata('id="chart" title="Growth chart" parent="' + 'a'.repeat(64) + '"'), { artifactId: 'chart', title: 'Growth chart', parentRevision: 'a'.repeat(64) });
  assert.equal(sessionWidgetMetadata('id="../../x" parent=latest').artifactId, undefined);
  // A malformed parent is passed on as declared; the store records it as an
  // unresolved parent and treats the revision as a root, like the Rust indexer.
  assert.equal(sessionWidgetMetadata('id="../../x" parent=latest').parentRevision, 'latest');
  assert.equal(sessionWidgetMetadata('').artifactId, undefined);
  // Titles are one line of at most 120 characters, as in research_artifacts.rs.
  const title = sessionWidgetMetadata('title=' + JSON.stringify('Settings\n\u0007 Saved ' + 'x'.repeat(200))).title!;
  assert.match(title, /^Settings Saved x+$/);
  assert.equal([...title].length, 120);
  assert.equal(sessionWidgetMetadata('title="  "').title, undefined);
});

test("quoted artifact titles round-trip in revision prompts", async () => {
  const { sessionWidgetMetadata } = await import('@session/shared/lib/sessionWidgets');
  const title = 'A "quoted" chart \\ legend';
  assert.equal(sessionWidgetMetadata(`title=${JSON.stringify(title)}`).title, title);
});

test("fence metadata remains after CommonMark escape processing", async () => {
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const { remarkSessionWidgetFences, sessionWidgetMetadata } = await import('@session/shared/lib/sessionWidgets');
  const title = 'A "quoted" chart \\ legend';
  const markdown = '```session-html id=chart title=' + JSON.stringify(title) + '\n<p>hello</p>\n```';
  const tree = fromMarkdown(markdown);
  remarkSessionWidgetFences()(tree, { value: markdown });
  const properties = tree.children[0].data?.hProperties;
  assert.equal(sessionWidgetMetadata(String(properties?.dataSessionWidgetMeta)).title, title);
});

test("desktop executes the shared web fence contract", async () => {
  const { sessionWidgetFixtures } = await import('@session/shared-test/sessionWidgetFixtures');
  const { fromMarkdown } = await import('mdast-util-from-markdown');
  const { remarkSessionWidgetFences, sessionWidgetMetadata } = await import('@session/shared/lib/sessionWidgets');
  type Node = Parameters<ReturnType<typeof remarkSessionWidgetFences>>[0];
  for (const fixture of sessionWidgetFixtures) {
    const tree = fromMarkdown(fixture.markdown);
    remarkSessionWidgetFences()(tree, { value: fixture.markdown });
    const states: unknown[] = []; const titles: unknown[] = [];
    const visit = (node: Node) => { const props = node.data?.hProperties; if (props?.dataSessionWidget) { states.push(props.dataSessionWidget); titles.push(sessionWidgetMetadata(String(props.dataSessionWidgetMeta)).title); } node.children?.forEach(visit); };
    visit(tree);
    assert.deepEqual(states, fixture.states, fixture.name);
    assert.deepEqual(titles, fixture.titles, fixture.name);
  }
});
