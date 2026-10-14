import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, screen } from "@testing-library/react";
import test from "ava";

import { useNavigationStore } from "../src/stores/navigation.js";
import { OVERLAY_PRIORITY, useOverlaysStore } from "../src/stores/overlays.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";
import { serverSettings, workspace } from "./phase6Fixtures.js";

// A band above the search bar, standing in for a Phase 6 non-library layer.
const ABOVE_SEARCH_BAR = OVERLAY_PRIORITY.searchBar + 100;

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}, target?: Element) {
  act(() => {
    (target ?? document.body).dispatchEvent(
      new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
    );
  });
}

test.beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS }, hydrated: true });
  useNavigationStore.setState({ sidebarCollapsed: false });
  useOverlaysStore.getState().clear();
  resetDocumentRoot();
});

test.afterEach(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("Cmd-K opens the command palette", async (t) => {
  await renderApp("/");
  t.is(screen.queryByRole("dialog", { name: "Command palette" }), null);

  press("k", { metaKey: true });

  t.truthy(await screen.findByRole("dialog", { name: "Command palette" }));
});

test.serial("Shift-Cmd-G toggles the sidebar", async (t) => {
  await renderApp("/");
  t.false(useNavigationStore.getState().sidebarCollapsed);

  press("g", { metaKey: true, shiftKey: true });
  t.true(useNavigationStore.getState().sidebarCollapsed);

  press("g", { metaKey: true, shiftKey: true });
  t.false(useNavigationStore.getState().sidebarCollapsed);
});

// Every chord in the table also works from a text field.
test.serial("app chords reach the app from a text field", async (t) => {
  await renderApp("/");
  const input = document.createElement("input");
  document.body.appendChild(input);

  press("g", { metaKey: true, shiftKey: true }, input);
  t.true(useNavigationStore.getState().sidebarCollapsed, "the sidebar chord still reaches the app");

  press("k", { metaKey: true }, input);
  t.truthy(
    await screen.findByRole("dialog", { name: "Command palette" }),
    "the palette opens from a composer",
  );

  input.remove();
});

// The desktop has no tab digits or tab cycling; those keys stay the browser's.
test.serial("web-only tab chords are gone", async (t) => {
  await renderApp("/");
  for (const [key, modifiers] of [
    ["2", { ctrlKey: true }],
    ["2", { metaKey: true }],
    ["Tab", { ctrlKey: true }],
    ["]", { metaKey: true, shiftKey: true }],
  ] as const) {
    const event = new window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    t.false(event.defaultPrevented, `${key} is left to the browser`);
  }
  t.is(screen.queryByRole("heading", { name: "Highlights" }), null);
});

test.serial("Shift-Cmd-H opens Home with the caret in its ask box", async (t) => {
  await renderApp("/settings", {
    responses: {
      "workspaces.list": [workspace()],
      "settings.get": serverSettings(),
      "research.listTrees": [],
      "folders.get": {
        folders: [],
        membership: {},
        collapsed: [],
        parents: {},
        collapsedGroups: [],
      },
      "drafts.list": [],
      "research.listTrash": [],
      "feed.recentQueriesForTrees": [],
    },
  });
  await screen.findByRole("heading", { name: "Settings" });
  press("h", { metaKey: true, shiftKey: true });
  const field = await screen.findByRole("textbox", { name: "New question" });
  await waitUntil(t, () => document.activeElement === field, "the ask box has focus");
});

test.serial("Cmd-, opens Settings", async (t) => {
  await renderApp("/");
  press(",", { metaKey: true });
  t.truthy(await screen.findByRole("heading", { name: "Settings" }));
});

test.serial("Escape goes to the top of the overlay stack", async (t) => {
  await renderApp("/");
  const dismissed: string[] = [];

  act(() => {
    useOverlaysStore
      .getState()
      .register("search", OVERLAY_PRIORITY.searchBar, () => dismissed.push("search"));
    useOverlaysStore
      .getState()
      .register("selection", ABOVE_SEARCH_BAR, () => dismissed.push("selection"));
  });

  press("Escape");
  t.deepEqual(dismissed, ["selection"]);

  act(() => useOverlaysStore.getState().unregister("selection"));
  press("Escape");
  t.deepEqual(dismissed, ["selection", "search"]);
});

test.serial(
  "an open modal dialog intercepts Escape before the application overlay stack",
  async (t) => {
    await renderApp("/");
    const dismissed: string[] = [];
    act(() => {
      useOverlaysStore
        .getState()
        .register("selection", ABOVE_SEARCH_BAR, () => dismissed.push("selection"));
    });

    press("k", { metaKey: true });
    const palette = await screen.findByRole("dialog", { name: "Command palette" });

    press("Escape", {}, palette);
    t.deepEqual(dismissed, [], "Base UI handles dismissal while its layer is open (07 §4.4)");
    await waitUntil(
      t,
      () => screen.queryByRole("dialog", { name: "Command palette" }) === null,
      "Base UI closes the palette on Escape",
    );

    // With the dialog gone the stack is the shell's again.
    press("Escape");
    t.deepEqual(dismissed, ["selection"]);
  },
);

test.serial("global application shortcuts are disabled while a modal dialog is open", async (t) => {
  await renderApp("/");
  press("k", { metaKey: true });
  await screen.findByRole("dialog", { name: "Command palette" });

  press("g", { metaKey: true, shiftKey: true });

  t.false(
    useNavigationStore.getState().sidebarCollapsed,
    "a chord fired inside a dialog must not act on the page behind it",
  );
});

test.serial(
  "Escape propagates to default browser behavior when the overlay stack is empty",
  async (t) => {
    await renderApp("/");
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    t.false(event.defaultPrevented);
  },
);

test.serial("unhandled shell shortcuts are dispatched to the active mounted view", async (t) => {
  await renderApp("/");
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  window.addEventListener("session:shortcut", listener);

  press("j", { metaKey: true });
  press("o", { metaKey: true });

  window.removeEventListener("session:shortcut", listener);
  t.deepEqual(seen, [{ type: "focusFollowups" }, { type: "openWorkspaceMenu" }]);
});
