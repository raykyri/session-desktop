// The settings mirror against the server (`06-auth-and-users.md` §6): the
// account's copy wins when it lands, a local change is pushed once the typing
// or dragging stops, and an echo of what the server just sent is not pushed
// back at it.

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import test from "ava";

import { queryClientDefaults } from "../src/api/queries.js";
import { setTrpcClient } from "../src/api/trpc.js";
import { SESSION_SETTINGS_SYNC_DEBOUNCE_MS, SessionBoot } from "../src/app/SessionBoot.js";
import { AppProviders } from "../src/app/providers.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { defaultResponses, resetDocumentRoot, testUser, waitUntil } from "./helpers.js";
import { createTrpcStub, type TrpcStub } from "./trpcStub.js";

function serverSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_USER_SETTINGS,
    researchLaunchInstruction: null,
    defaultWorkspaceId: null,
    ...overrides,
  };
}

function mount(stub: TrpcStub) {
  setTrpcClient(stub.client);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { ...queryClientDefaults.queries, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const result = render(
    <AppProviders queryClient={queryClient}>
      <SessionBoot />
    </AppProviders>,
  );
  return { ...result, queryClient };
}

test.beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ settings: { ...DEFAULT_USER_SETTINGS }, hydrated: true });
});

test.afterEach(() => {
  cleanup();
  resetDocumentRoot();
});

test.serial("the server's copy replaces the local mirror on load", async (t) => {
  useSettingsStore.getState().set("appearance", "dark");
  useSettingsStore.getState().set("textSize", 14);
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": serverSettings({ appearance: "light", textSize: 20 }),
  });

  mount(stub);

  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.appearance === "light",
    "the account's appearance won",
  );
  t.is(useSettingsStore.getState().settings.textSize, 20);
  t.false(
    stub.calls.some((call) => call.path === "settings.update"),
    "applying the server's own copy is not a change to push back",
  );
});

test.serial("a local change is pushed once, after the debounce", async (t) => {
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": serverSettings({ textSize: 15 }),
    "settings.update": serverSettings({ textSize: 19 }),
  });
  mount(stub);
  // A change made before the account's copy lands would be overwritten by it,
  // which is what "server wins on load" means; the test waits for the load.
  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.textSize === 15,
    "the server's copy landed",
  );

  act(() => {
    // A slider drag: several changes inside one debounce window.
    useSettingsStore.getState().setTextSize(17);
    useSettingsStore.getState().setTextSize(18);
    useSettingsStore.getState().setTextSize(19);
  });

  await waitUntil(
    t,
    () => stub.calls.some((call) => call.path === "settings.update"),
    "the change reached the server",
  );
  await new Promise((resolve) => setTimeout(resolve, SESSION_SETTINGS_SYNC_DEBOUNCE_MS * 2));

  const updates = stub.calls.filter((call) => call.path === "settings.update");
  t.is(updates.length, 1, "three moves of the slider are one write");
  t.is((updates[0]?.input as { settings: { textSize: number } }).settings.textSize, 19);
});
