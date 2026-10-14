// The desktop's four settings on the web (`07-client-architecture.md` §3):
// "Require ⌘↵ to send", "Widgets in answers", "Show keyboard shortcut hints"
// and "Reduce motion", each with its behaviour, and the settings page that
// lists them. Also where toasts and notifications appear.

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import test from "ava";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { applyEventBatch } from "../src/api/events.js";
import { ThemeEffects } from "../src/app/ThemeEffects.js";
import { ResearchMarkdown } from "../src/features/markdown/ResearchMarkdown.js";
import { PostFollowUpField } from "../src/features/thread/PostFollowUpField.js";
import { prefersReducedMotion } from "../src/lib/motion.js";
import { pushToast } from "../src/lib/toast.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";
import { isComposerSubmitShortcut } from "../src/ui/ComposerSubmitShortcut.js";
import { NotificationStack } from "../src/ui/NotificationStack.js";

import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace } from "./phase6Fixtures.js";

const MODELS = [
  {
    id: "gemini-flash",
    label: "Gemini 3.8 Flash",
    provider: "vertex" as const,
    adminOnly: false,
    available: true,
    supportsFiles: true,
    supportsImages: true,
  },
];

test.beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS }, hydrated: true });
  useNotificationsStore.getState().clear();
  resetDocumentRoot();
});

test.afterEach.always(() => {
  cleanup();
  resetDocumentRoot();
});

function enter(modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) {
  return {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    ...modifiers,
  } as unknown as ReactKeyboardEvent;
}

test("without Require ⌘↵, a bare Enter sends and Shift+Enter does not", (t) => {
  t.true(isComposerSubmitShortcut(enter(), true, false));
  t.false(isComposerSubmitShortcut(enter({ shiftKey: true }), true, false));
  t.false(isComposerSubmitShortcut(enter({ metaKey: true }), true, false));
  t.false(isComposerSubmitShortcut(enter(), true, true), "with it, Enter is a newline");
  t.true(isComposerSubmitShortcut(enter({ metaKey: true }), true, true));
});

test.serial("a note's follow-up box sends on Enter when the setting is off", async (t) => {
  useSettingsStore.getState().patch({ requireCmdEnterToSend: false });
  const sent: string[] = [];
  render(
    <PostFollowUpField
      models={MODELS}
      defaultChoice={{ model: "gemini-flash", effort: null }}
      onSubmit={(input) => {
        sent.push(input.prompt);
        return Promise.resolve();
      }}
    />,
  );
  const field = screen.getByRole("textbox", { name: "Follow-up" });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: "Why?" } });
  // The shared Ask/Note switch, as in the Home ask box.
  const kinds = screen.getByRole("radiogroup", { name: "Ask or add a note" });
  t.truthy(within(kinds).getByRole("radio", { name: "Ask Gemini 3.8 Flash" }));
  t.is(
    screen.getByRole("button", { name: "Ask" }).getAttribute("title"),
    "Ask Gemini 3.8 Flash (↵)",
  );
  fireEvent.keyDown(field, { key: "Enter" });
  await waitUntil(t, () => sent.length === 1, "Enter sends");
  t.deepEqual(sent, ["Why?"]);
});

test.serial("Ask opens the model menu; Add a note changes the placeholder", (t) => {
  render(
    <PostFollowUpField
      models={MODELS}
      defaultChoice={{ model: "gemini-flash", effort: null }}
      onSubmit={() => Promise.resolve()}
    />,
  );
  const field = screen.getByRole("textbox", { name: "Follow-up" });
  fireEvent.focus(field);
  t.is(field.getAttribute("placeholder"), "Ask a follow-up");
  fireEvent.click(screen.getByRole("radio", { name: "Ask Gemini 3.8 Flash" }));
  t.truthy(screen.getByRole("menu"));
  fireEvent.click(screen.getByRole("radio", { name: "Add a note" }));
  t.is(field.getAttribute("placeholder"), "Add a note (not visible to agent)");
  t.is(
    screen.getByRole("button", { name: "Add note" }).getAttribute("title"),
    `Add note (${navigator.platform.includes("Mac") ? "⌘↵" : "Ctrl+↵"})`,
  );
});

test.serial("with Widgets in answers off, a widget block is code", (t) => {
  useSettingsStore.getState().patch({ researchInlineWidgets: false });
  const { container } = render(
    <ResearchMarkdown widgetNodeId="n1" markdown={"```session-html\n<p>x</p>\n```"} />,
  );
  t.is(container.querySelector("[data-research-widget]"), null);
  t.truthy(container.querySelector("pre"));
});

test.serial("Reduce motion marks the document and reduces scripted motion", (t) => {
  render(<ThemeEffects />);
  t.false(prefersReducedMotion());
  act(() => useSettingsStore.getState().patch({ reduceMotion: true }));
  t.true(document.documentElement.hasAttribute("data-reduce-motion"));
  t.true(prefersReducedMotion());
  act(() => useSettingsStore.getState().patch({ reduceMotion: false }));
  t.false(document.documentElement.hasAttribute("data-reduce-motion"));
});

test.serial("a toast is bottom centre, one at a time; a notification top right", (t) => {
  pushToast({ title: "Copied." });
  pushToast({ title: "Moved." });
  useNotificationsStore.getState().push({
    id: "server",
    title: "Answer ready",
    body: "",
    tone: "info",
    timeoutMs: 5_000,
    createdAt: 1,
  });
  const items = useNotificationsStore.getState().items;
  render(<NotificationStack notifications={items} onDismiss={() => {}} />);
  t.is(screen.queryByText("Copied."), null, "a new toast replaces the last");
  const toast = screen.getByText("Moved.").closest(".fixed") as HTMLElement;
  t.true(toast.className.includes("bottom-4"));
  const region = screen.getByRole("region", { name: "Notifications" });
  t.truthy(within(region).getByText("Answer ready"));
  t.true(region.className.includes("top-4"));
});

test.serial("Notifications off hides server notifications but not client toasts", (t) => {
  useSettingsStore.getState().patch({ showNotifications: false });
  pushToast({ title: "Couldn’t delete the draft", tone: "error" });
  applyEventBatch(
    [
      {
        type: "notification.requested",
        payload: {
          notification: {
            id: "server",
            title: "Answer ready",
            body: "",
            tone: "info",
            timeoutMs: 5_000,
            createdAt: 1,
          },
        },
        timestamp: 1,
      },
    ],
    testQueryClient(),
  );
  const titles = useNotificationsStore.getState().items.map((item) => item.title);
  t.deepEqual(titles, ["Couldn’t delete the draft"]);
});

test.serial("the settings page lists the desktop's settings", async (t) => {
  const app = await renderApp("/settings", {
    queryClient: testQueryClient(),
    responses: {
      "workspaces.list": [workspace()],
      "settings.get": serverSettings(),
      "usage.summary": null,
    },
  });
  await waitUntil(t, () => screen.queryByText("Widgets in answers") !== null, "the page");
  t.truthy(screen.getByText(/^Require (⌘↵|Ctrl\+↵) to send$/));
  t.truthy(screen.getByText("Show keyboard shortcut hints"));
  t.truthy(screen.getByText("Reduce motion"));
  t.truthy(screen.getAllByText("Color theme").length > 0);
  t.is(screen.queryByText("Show tool calls"), null);
  t.is(screen.queryByText("Show timestamps"), null);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reduce motion" }));
  t.true(useSettingsStore.getState().settings.reduceMotion);
  app.unmount();
});

test.serial("shortcut hints show while ⌘ is held, unless the setting is off", async (t) => {
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: { "workspaces.list": [workspace()], "settings.get": serverSettings() },
  });
  const home = await screen.findByRole("link", { name: /^Home/ });
  const hold = (down: boolean) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent(down ? "keydown" : "keyup", {
          key: navigator.platform.includes("Mac") ? "Meta" : "Control",
          metaKey: down,
          ctrlKey: down,
        }),
      );
    });
  t.false(/H$/.test(home.textContent ?? ""));
  hold(true);
  t.regex(home.textContent ?? "", /H$/, "the Home chord shows");
  hold(false);
  t.false(/H$/.test(home.textContent ?? ""));
  act(() => useSettingsStore.getState().patch({ showShortcutHints: false }));
  hold(true);
  t.false(/H$/.test(home.textContent ?? ""), "not with the setting off");
  hold(false);
  app.unmount();
});
