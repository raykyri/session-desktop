// The settings kept from the earlier client (02 §1; not linked at launch,
// P23): "Reduce motion" with its behaviour, and the settings page that lists
// what remains. Also where toasts and notifications appear.

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import test from "ava";

import { ThemeEffects } from "../src/app/ThemeEffects.js";
import { prefersReducedMotion } from "../src/lib/motion.js";
import { pushToast } from "../src/lib/toast.js";
import { useNotificationsStore } from "../src/stores/notifications.js";
import { useSettingsStore } from "../src/stores/settings.js";
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
  t.truthy(screen.getAllByText("Color theme").length > 0);
  t.is(screen.queryByRole("checkbox", { name: /^Notifications/ }), null, "Notifications");
  // The research client's rows are gone (02 §1, §11, P21).
  for (const gone of [
    "Widgets in answers",
    "Research instructions",
    "Default model",
    "Body font",
  ]) {
    t.is(screen.queryByText(gone), null, gone);
  }
  // So are the rows that changed nothing: every composer sends on ⌘↵ with
  // Enter as a newline (02 §5), and there are no shortcut hints to show.
  t.is(screen.queryByText(/^Require .* to send$/), null, "Require ⌘↵ to send");
  t.is(screen.queryByText("Show keyboard shortcut hints"), null);
  fireEvent.click(screen.getByRole("checkbox", { name: "Reduce motion" }));
  t.true(useSettingsStore.getState().settings.reduceMotion);
  app.unmount();
});

test.serial(
  "the appearance setting offers System, Dark and Light, and System follows the device",
  async (t) => {
    const app = await renderApp("/settings");
    const pick = async (keyName: "Home" | "End") => {
      fireEvent.click(screen.getByRole("combobox", { name: "Appearance" }));
      const list = await screen.findByRole("listbox");
      // Base UI commits on the keyboard in jsdom (see ui.primitives.test.tsx).
      fireEvent.keyDown(list, { key: keyName });
      fireEvent.keyDown(document.activeElement ?? list, { key: "Enter" });
    };
    // the default is System
    const select = await screen.findByRole("combobox", { name: "Appearance" });
    t.regex(select.textContent ?? "", /System/);
    fireEvent.click(select);
    await screen.findByRole("listbox");
    t.deepEqual(
      screen.getAllByRole("option").map((o) => o.textContent?.trim()),
      ["System", "Dark", "Light"],
    );
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    await pick("End");
    await waitUntil(t, () => useSettingsStore.getState().settings.appearance === "light", "Light");
    await pick("Home");
    await waitUntil(
      t,
      () => useSettingsStore.getState().settings.appearance === "system",
      "System",
    );
    t.regex(screen.getByRole("combobox", { name: "Appearance" }).textContent ?? "", /System/);
    app.unmount();
  },
);
