// The settings kept from the earlier client (02 §1; not linked at launch,
// P23): "Require ⌘↵ to send" and "Reduce motion" with their behaviour, and
// the settings page that lists them. Also where toasts and notifications
// appear.

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import test from "ava";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { ThemeEffects } from "../src/app/ThemeEffects.js";
import { prefersReducedMotion } from "../src/lib/motion.js";
import { pushToast } from "../src/lib/toast.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";
import { isComposerSubmitShortcut } from "../src/ui/ComposerSubmitShortcut.js";
import { NotificationStack } from "../src/ui/NotificationStack.js";

import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";

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

test.serial("the settings page lists the settings that remain", async (t) => {
  const app = await renderApp("/settings");
  await waitUntil(t, () => screen.queryByText("Reduce motion") !== null, "the page");
  t.truthy(screen.getByText(/^Require (⌘↵|Ctrl\+↵) to send$/));
  t.truthy(screen.getByText("Show keyboard shortcut hints"));
  t.truthy(screen.getAllByText("Color theme").length > 0);
  t.truthy(screen.getByRole("checkbox", { name: /^Notifications/ }));
  // The research client's rows are gone (02 §1, §11, P21).
  for (const gone of [
    "Widgets in answers",
    "Research instructions",
    "Default model",
    "Body font",
  ]) {
    t.is(screen.queryByText(gone), null, gone);
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Reduce motion" }));
  t.true(useSettingsStore.getState().settings.reduceMotion);
  app.unmount();
});
