import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, screen } from "@testing-library/react";
import test from "ava";

import { useNavigationStore } from "../src/stores/navigation.js";
import { OVERLAY_PRIORITY, useOverlaysStore } from "../src/stores/overlays.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { renderApp, resetDocumentRoot, waitUntil } from "./helpers.js";

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

// Which chords a text field swallows is the shared table's decision, not the
// dispatcher's (07 §5); what the shell owes is passing the flag through.
test.serial("a text field blocks only the chords that compete with typing", async (t) => {
  await renderApp("/");
  const input = document.createElement("input");
  document.body.appendChild(input);

  press("2", { ctrlKey: true }, input);
  t.is(
    screen.queryByRole("heading", { name: "Bookmarks" }),
    null,
    "a digit chord must not navigate away mid-sentence",
  );

  press("g", { metaKey: true, shiftKey: true }, input);
  t.true(useNavigationStore.getState().sidebarCollapsed, "the sidebar chord still reaches the app");

  press("k", { metaKey: true }, input);
  t.truthy(
    await screen.findByRole("dialog", { name: "Command palette" }),
    "the palette opens from a composer",
  );

  input.remove();
});

test.serial("a contenteditable target counts as a text field", async (t) => {
  await renderApp("/");
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  // jsdom parses the attribute but leaves `isContentEditable` unimplemented,
  // and that getter is what the dispatcher reads.
  Object.defineProperty(editable, "isContentEditable", { value: true });
  document.body.appendChild(editable);

  press("2", { ctrlKey: true }, editable);

  t.is(screen.queryByRole("heading", { name: "Bookmarks" }), null);
  editable.remove();
});

test.serial("Ctrl-1..9 reaches the tab routes the browser would eat as Cmd", async (t) => {
  const { container } = await renderApp("/");
  t.truthy(container);

  press("2", { ctrlKey: true });
  t.truthy(await screen.findByRole("heading", { name: "Bookmarks" }));

  press("1", { ctrlKey: true });
  t.truthy(await screen.findByRole("heading", { name: "Home" }));
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

test.serial("an open library layer takes Escape before the app's stack does", async (t) => {
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
  t.deepEqual(dismissed, [], "Base UI owns dismissal while its layer is open (07 §4.4)");
  await waitUntil(
    t,
    () => screen.queryByRole("dialog", { name: "Command palette" }) === null,
    "Base UI closes the palette on Escape",
  );

  // With the dialog gone the stack is the shell's again.
  press("Escape");
  t.deepEqual(dismissed, ["selection"]);
});

test.serial("app chords stand down while a library layer is open", async (t) => {
  await renderApp("/");
  press("k", { metaKey: true });
  await screen.findByRole("dialog", { name: "Command palette" });

  press("g", { metaKey: true, shiftKey: true });

  t.false(
    useNavigationStore.getState().sidebarCollapsed,
    "a chord fired inside a dialog must not act on the page behind it",
  );
});

test.serial("Escape with an empty stack is left to the page", async (t) => {
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
});

test.serial("shortcuts the shell does not own are re-dispatched to the mounted view", async (t) => {
  await renderApp("/");
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  window.addEventListener("session:shortcut", listener);

  press("j", { metaKey: true });
  press("e", { metaKey: true, shiftKey: true });

  window.removeEventListener("session:shortcut", listener);
  t.deepEqual(seen, [{ type: "focusFollowups" }, { type: "toggleArtifactPanel" }]);
});
