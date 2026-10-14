import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import SessionWidget from "../src/components/SessionWidget";
import type { ResearchArtifactRevision } from "../src/lib/api";
import { artifactStateForUrl } from "../src/lib/sessionArtifactState";
import { WidgetAnswerContext } from "../src/lib/sessionWidgetActions";
import { rememberWidgetExecution } from "../src/lib/sessionWidgetExecution";
import { withWidgetDom } from "./widgetDom";

const SCRIPTED = "<p id='n'>0</p><script>n.textContent = 1</script>";

function urlsFor(digit: string, scripts = true) {
  const base = "http://127.0.0.1:1234/__session/widget/";
  return {
    staticUrl: `${base}${"a".repeat(64)}/${digit.repeat(64)}.html`,
    runUrl: scripts ? `${base}${"b".repeat(64)}/${digit.repeat(64)}.html` : null,
  };
}

function revisionFixture(treeId: string, revision: string, parentRevision: string | null, extra: Partial<ResearchArtifactRevision> = {}): ResearchArtifactRevision {
  return {
    artifactId: "chart", title: "Quarterly totals", treeId, nodeId: `node-${revision}`.padEnd(16, "0"), slot: "s",
    revision: revision.repeat(64), contentHash: "f".repeat(64), parentRevision: parentRevision?.repeat(64) ?? null,
    html: `<p>revision ${revision}</p>`, createdAt: 1, unresolvedParent: false, ...extra,
  };
}

interface Setup {
  /** Distinct per test: prepared URLs, execution choices and saved inputs
   * are cached by HTML, URL and tree. */
  id: string;
  html?: string;
  scripts?: boolean;
  prepareFails?: boolean;
  registered?: boolean;
  parent?: "resolved" | "none" | "unresolved";
  remembered?: boolean;
  execution?: "running" | "focus";
  /** The first history load fails. */
  historyFailsOnce?: boolean;
}

/** Mounts one widget with a mocked backend and runs `check` with helpers. */
async function withWidget(setup: Setup, check: (helpers: {
  figure: HTMLElement;
  opened: string[];
  calls: { command: string; args: Record<string, unknown> }[];
  openMenu: () => Promise<void>;
}) => Promise<void>) {
  await withWidgetDom(async (window) => {
    const treeId = `tree-${setup.id}`;
    const urls = urlsFor(setup.id, setup.scripts ?? true);
    const parent = setup.parent ?? "resolved";
    const current = revisionFixture(treeId, "c", parent === "none" ? null : "p", { unresolvedParent: parent === "unresolved" });
    const history = {
      revisions: [current, revisionFixture(treeId, "p", null), revisionFixture(treeId, "d", "e", { unresolvedParent: true })],
      unresolved: 1,
    };
    const calls: { command: string; args: Record<string, unknown> }[] = [];
    if (setup.execution) rememberWidgetExecution(urls.staticUrl, setup.execution);
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "research_widget_prepare") {
        if (setup.prepareFails) throw new Error("store unavailable");
        const html = args.html as string;
        return html.startsWith("<p>revision ") ? urlsFor("0", false) : urls;
      }
      if (command === "research_artifact_register") {
        if (setup.registered === false) return new Promise(() => undefined);
        return current;
      }
      if (command === "research_artifact_state_get") return { enabled: setup.remembered ?? false, value: null };
      if (command === "research_artifact_history") {
        if (setup.historyFailsOnce && calls.filter((call) => call.command === command).length === 1) throw new Error("offline");
        return history;
      }
      if (command === "research_artifact_state_update") return { enabled: args.action === "enable", value: null };
      throw new Error(`unexpected ${command}`);
    } } });
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const answer = { nodeId: "node-answer", treeId, messageKey: "m", answer: "Prose." };
    try {
      await act(async () => root.render(createElement(WidgetAnswerContext.Provider, { value: answer },
        createElement(SessionWidget, { html: setup.html ?? `${SCRIPTED}<!-- ${setup.id} -->`, onOpen: (url: string) => opened.push(url) }))));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const figure = container.querySelector<HTMLElement>("figure")!;
      const openMenu = async () => {
        await act(async () => figure.querySelector<HTMLButtonElement>('[aria-label="Widget actions"]')!.click());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      };
      await check({ figure, opened, calls, openMenu });
    } finally {
      await act(async () => root.unmount());
    }
  });
}

/** The open menu in order: "[Section]" for a section label, "(text)" for a
 * text row, "|" for a separator, and each item's label and trailing text,
 * with "✓ " before a checked or current item and " (disabled)" after a
 * disabled one. */
function menuOutline(): string[] {
  const menu = document.querySelector("[role='menu']");
  if (!menu) return [];
  return [...menu.querySelectorAll("[role^='menuitem'], [role='separator'], .session-widget-menu-section, .session-widget-menu-note")].map((row) => {
    if (row.getAttribute("role") === "separator") return "|";
    if (row.classList.contains("session-widget-menu-section")) return `[${row.textContent}]`;
    if (row.classList.contains("session-widget-menu-note")) return `(${row.textContent})`;
    const marked = row.getAttribute("aria-checked") === "true" || row.getAttribute("aria-current") === "true";
    const label = row.querySelector(".research-menu-label")?.textContent ?? "";
    const trailing = row.querySelector(".session-widget-menu-lineage")?.textContent;
    return `${marked ? "✓ " : ""}${label}${trailing ? ` ${trailing}` : ""}${row.hasAttribute("disabled") ? " (disabled)" : ""}`;
  });
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>("[role='menu'] [role^='menuitem']")]
    .find((row) => row.querySelector(".research-menu-label")?.textContent === label);
  assert.ok(item, `menu item ${label}`);
  return item;
}

test("the header bar shows the title, the controls and no Widget: label", async () => {
  await withWidget({ id: "1" }, async ({ figure }) => {
    const bar = figure.querySelector(".session-widget-bar")!;
    const title = bar.querySelector(".session-widget-title")!;
    assert.equal(title.textContent, "Quarterly totals");
    assert.equal(title.getAttribute("title"), "Quarterly totals");
    assert.equal(title.hasAttribute("data-placeholder"), false);
    assert.equal(bar.textContent!.includes("Widget:"), false);
    assert.equal(bar.querySelector(".session-widget-status"), null, "no status before scripts run");
    assert.equal(figure.querySelector(".session-artifact-details, .session-artifact-state"), null);
    const controls = [...bar.querySelectorAll(".session-widget-controls button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    assert.deepEqual(controls, ["Preview", "Source", "Run the widget's scripts", "Widget actions"]);
    const more = bar.querySelector('[aria-label="Widget actions"]')!;
    assert.equal(more.getAttribute("aria-haspopup"), "menu");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.equal(bar.querySelector(".session-widget-run")!.textContent, "Run scripts");
    assert.ok(bar.closest("[data-widget-chrome]"));
  });
});

test("before the revision is saved the title is the word Widget", async () => {
  await withWidget({ id: "2", registered: false }, async ({ figure }) => {
    const title = figure.querySelector(".session-widget-title")!;
    assert.equal(title.textContent, "Widget");
    assert.equal(title.hasAttribute("data-placeholder"), true);
  });
});

test("the script status names running, stopped and unavailable scripts", async () => {
  const status = (figure: HTMLElement) => {
    const element = figure.querySelector(".session-widget-status");
    return element ? { word: element.textContent, key: element.getAttribute("data-status"), title: element.getAttribute("title") } : null;
  };
  await withWidget({ id: "3", execution: "running" }, async ({ figure }) => {
    assert.equal(status(figure)?.word, "Running");
    assert.equal(status(figure)?.key, "running");
    assert.equal(figure.dataset.running, "true");
    assert.ok(figure.querySelector('[aria-label="Reload widget"]'));
    assert.equal(figure.querySelector('[aria-label="Run the widget\'s scripts"]'), null);
  });
  await withWidget({ id: "4", execution: "focus" }, async ({ figure }) => {
    assert.deepEqual(status(figure), { word: "Stopped", key: "stopped", title: "Scripts stopped: the widget kept taking keyboard focus" });
    assert.equal(figure.dataset.scripts, "stopped");
  });
  await withWidget({ id: "5", scripts: false }, async ({ figure }) => {
    assert.equal(status(figure)?.word, "Scripts off");
    assert.match(status(figure)!.title!, /^Widget scripts (run only on macOS|can.t run in this app.s web view)\.$/);
    assert.equal(figure.dataset.scripts, "unavailable");
    assert.equal(figure.querySelector('[aria-label="Run the widget\'s scripts"]'), null);
  });
});

test("the actions menu lists exports, revisions and saved inputs", async () => {
  await withWidget({ id: "6" }, async ({ figure, openMenu, calls }) => {
    await openMenu();
    assert.equal(figure.querySelector('[aria-label="Widget actions"]')!.getAttribute("aria-expanded"), "true");
    assert.equal(calls.filter((call) => call.command === "research_artifact_history").length, 1);
    assert.deepEqual(menuOutline(), [
      "Copy HTML", "Download HTML", "Open in browser",
      "|", "[Revisions]",
      "✓ cccccccc from pppppppp",
      "pppppppp original",
      "dddddddd original (declared parent not found)",
      "(1 source revision(s) could not be stored. Their source exceeds the size limit or could not be saved.)",
      "|", "[Saved inputs]",
      "Remember inputs",
    ]);
    assert.equal(menuItem("Remember inputs").getAttribute("role"), "menuitemcheckbox");
    assert.equal(menuItem("Remember inputs").getAttribute("aria-checked"), "false");
    assert.equal(document.activeElement, menuItem("Copy HTML"), "focus starts on the first item");
    assert.equal(menuItem("pppppppp").title, "Preview revision pppppppp from answer node-p00");
    const title = document.querySelector(".session-widget-menu-section")!;
    assert.equal(title.textContent, "Revisions", "section labels are sentence case");
    // The history is kept: reopening does not load it again.
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector("[role='menu']"), null);
    await openMenu();
    assert.equal(calls.filter((call) => call.command === "research_artifact_history").length, 1);
  });
});

test("remembered inputs show Reset and Copy inputs only with a resolved parent", async () => {
  await withWidget({ id: "7", remembered: true }, async ({ openMenu }) => {
    await openMenu();
    assert.deepEqual(menuOutline().slice(-4), ["[Saved inputs]", "✓ Remember inputs", "Reset inputs", "Copy inputs from pppppppp"]);
    assert.match(menuItem("Copy inputs from pppppppp").title, /same input format/);
  });
  await withWidget({ id: "8", remembered: true, parent: "none" }, async ({ openMenu }) => {
    await openMenu();
    assert.deepEqual(menuOutline().slice(-3), ["[Saved inputs]", "✓ Remember inputs", "Reset inputs"]);
  });
  await withWidget({ id: "9", remembered: true, parent: "unresolved" }, async ({ openMenu }) => {
    await openMenu();
    assert.deepEqual(menuOutline().slice(-3), ["[Saved inputs]", "✓ Remember inputs", "Reset inputs"]);
  });
});

test("Remember inputs toggles in place and reveals the input actions", async () => {
  await withWidget({ id: "a" }, async ({ openMenu, calls }) => {
    await openMenu();
    await act(async () => menuItem("Remember inputs").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.ok(document.querySelector("[role='menu']"), "the menu stays open");
    assert.equal(calls.find((call) => call.command === "research_artifact_state_update")?.args.action, "enable");
    assert.deepEqual(menuOutline().slice(-4), ["[Saved inputs]", "✓ Remember inputs", "Reset inputs", "Copy inputs from pppppppp"]);
  });
});

test("widgets without scripts or a page omit Saved inputs and Open in browser", async () => {
  await withWidget({ id: "b", html: "<p>static only</p>" }, async ({ openMenu }) => {
    await openMenu();
    const outline = menuOutline();
    assert.ok(outline.includes("[Revisions]"));
    assert.equal(outline.includes("[Saved inputs]"), false);
  });
  await withWidget({ id: "c", prepareFails: true }, async ({ figure, openMenu }) => {
    assert.ok(figure.querySelector('[aria-label="Retry loading widget"]'));
    await openMenu();
    assert.deepEqual(menuOutline().slice(0, 3), ["Copy HTML", "Download HTML", "|"]);
  });
  await withWidget({ id: "d", registered: false }, async ({ openMenu, calls }) => {
    await openMenu();
    assert.deepEqual(menuOutline(), ["Copy HTML", "Download HTML", "Open in browser"]);
    assert.equal(calls.some((call) => call.command === "research_artifact_history"), false);
  });
});

test("selecting a revision previews it and closes the menu", async () => {
  await withWidget({ id: "e" }, async ({ openMenu, opened, calls }) => {
    await openMenu();
    await act(async () => menuItem("pppppppp").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(document.querySelector("[role='menu']"), null);
    assert.equal(calls[calls.length - 1]?.command, "research_widget_prepare");
    assert.equal(calls[calls.length - 1]?.args.html, "<p>revision p</p>");
    assert.equal(opened.length, 1);
    assert.ok(opened[0].startsWith(urlsFor("0").staticUrl));
    assert.equal(artifactStateForUrl(opened[0])?.revision, "p".repeat(64));
  });
});

test("a failed history load offers Try again and loads again on the next open", async () => {
  await withWidget({ id: "f", historyFailsOnce: true }, async ({ openMenu }) => {
    await openMenu();
    assert.deepEqual(menuOutline().slice(3, 7), ["|", "[Revisions]", "(Revision history unavailable)", "Try again"]);
    await act(async () => menuItem("Try again").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.ok(menuOutline().includes("✓ cccccccc from pppppppp"));
    assert.equal(document.activeElement?.closest("[role='menu']") !== null, true, "focus stays in the menu");
  });
  await withWidget({ id: "1", html: `${SCRIPTED}<!-- reopen -->`, historyFailsOnce: true }, async ({ openMenu, calls }) => {
    await openMenu();
    assert.ok(menuOutline().includes("(Revision history unavailable)"));
    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await openMenu();
    assert.ok(menuOutline().includes("✓ cccccccc from pppppppp"));
    assert.equal(calls.filter((call) => call.command === "research_artifact_history").length, 2);
  });
});

test("saved-input errors appear under the bar with their retry action", async () => {
  await withWidgetDom(async (window) => {
    const urls = urlsFor("9");
    const current = revisionFixture("tree-errors", "c", null);
    let stateCalls = 0;
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string) => {
      if (command === "research_widget_prepare") return urls;
      if (command === "research_artifact_register") return current;
      if (command === "research_artifact_state_get") { stateCalls++; if (stateCalls === 1) throw new Error("offline"); return { enabled: false, value: null }; }
      throw new Error(`unexpected ${command}`);
    } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(WidgetAnswerContext.Provider, { value: { nodeId: "n", treeId: "tree-errors", messageKey: "m", answer: "" } },
        createElement(SessionWidget, { html: `${SCRIPTED}<!-- errors -->`, onOpen: () => undefined }))));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const feedback = container.querySelector<HTMLElement>(".session-widget-bar + .session-widget-feedback")!;
      assert.equal(feedback.getAttribute("role"), "status");
      assert.equal(feedback.textContent, "Saved inputs unavailable. Retry to load them. Retry");
      await act(async () => feedback.querySelector("button")!.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      assert.equal(stateCalls, 2);
      assert.equal(container.querySelector(".session-widget-feedback"), null);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
