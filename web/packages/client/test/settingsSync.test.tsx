// Server settings take precedence on initial load; local modifications sync after debouncing, and server echo events are discarded.

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

test.serial("server settings override local cached settings on startup", async (t) => {
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
    "the account's appearance setting was applied",
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

test.serial("a push that fails does not stop the next one", async (t) => {
  // If the initial update request fails, synchronization must continue so subsequent preference changes can retry.
  let calls = 0;
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": serverSettings({ textSize: 15 }),
    "settings.update": () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return serverSettings({ textSize: 18 });
    },
  });
  mount(stub);
  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.textSize === 15,
    "the server's copy landed",
  );

  act(() => useSettingsStore.getState().setTextSize(17));
  await waitUntil(t, () => calls === 1, "the first push was attempted");

  act(() => useSettingsStore.getState().setTextSize(18));
  await waitUntil(t, () => calls === 2, "and a later change is still pushed");
});

test.serial("two tabs inside one debounce window do not overwrite each other", async (t) => {
  // A stand-in for the account's stored copy, merged field by field the way
  // `settings.update` does on the server.
  let stored = serverSettings({ appearance: "dark", textSize: 15 });
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": () => stored,
    "settings.update": (input: unknown) => {
      const patch = (input as { settings?: Record<string, unknown> }).settings ?? {};
      stored = { ...stored, ...patch };
      return stored;
    },
  });
  mount(stub);
  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.textSize === 15,
    "the server's copy landed",
  );

  // The other tab writes first. This tab has not seen the `settings.updated`
  // echo yet, so its idea of the account's copy is stale in exactly the field
  // the other tab changed.
  stored = { ...stored, appearance: "light" };

  act(() => useSettingsStore.getState().setTextSize(18));
  await waitUntil(
    t,
    () => stub.calls.some((call) => call.path === "settings.update"),
    "this tab pushes its own change",
  );

  const sent = (
    stub.calls.find((call) => call.path === "settings.update")?.input as {
      settings: Record<string, unknown>;
    }
  ).settings;
  t.deepEqual(sent, { textSize: 18 }, "the mutation includes only the field changed in this tab");
  t.is(stored.appearance, "light", "preserves the concurrent change from another tab");
  t.is(stored.textSize, 18, "applies the update from the current tab");
});
