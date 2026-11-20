// The server's copy wins on initial load; local changes push after a debounce, and the tab's own echo of a push it just sent is dropped.

import { DEFAULT_USER_SETTINGS } from "@session/shared";
import { act, cleanup, render } from "@testing-library/react";
import test from "ava";

import { meResource } from "../src/api/account.js";
import { setFetch } from "../src/api/http.js";
import { SESSION_SETTINGS_SYNC_DEBOUNCE_MS, SessionBoot } from "../src/app/SessionBoot.js";
import { AppProviders } from "../src/app/providers.js";
import { useSettingsStore } from "../src/stores/settings.js";

import { createFetchStub, type Answer, type FetchStub } from "./fetchStub.js";
import { defaultRoutes, resetAccount, resetDocumentRoot, testUser, waitUntil } from "./helpers.js";

/** The server, with `settings.get` and `settings.update` at their plain
 * routes (phase 2b). */
function createTrpcStub(r: Record<string, Answer>) {
  const routes: Record<string, Answer> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "settings.get") routes["GET /api/me/preferences"] = v;
    else if (k === "settings.update") routes["POST /api/me/preferences"] = v;
    else routes[k] = v;
  }
  const stub = createFetchStub(routes);
  const view = {
    fetch: stub.fetch,
    get calls() {
      return stub.calls.map((c) => ({
        path: c.path === "/api/me/preferences" && c.method === "POST" ? "settings.update" : c.path,
        input: c.body,
      }));
    },
  };
  return view;
}
const defaultResponses = defaultRoutes;
type TrpcStub = Pick<FetchStub, "fetch">;

function serverSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_USER_SETTINGS,
    researchLaunchInstruction: null,
    ...overrides,
  };
}

function mount(stub: TrpcStub) {
  resetAccount();
  setFetch(stub.fetch);
  meResource.set(testUser());
  return render(
    <AppProviders>
      <SessionBoot />
    </AppProviders>,
  );
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
    "settings.get": serverSettings({ appearance: "light", textSize: 17 }),
  });

  mount(stub);

  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.appearance === "light",
    "the account's appearance setting was applied",
  );
  t.is(useSettingsStore.getState().settings.textSize, 17);
  t.false(
    stub.calls.some((call) => call.path === "settings.update"),
    "applying the server's own copy is not a change to push back",
  );
});

test.serial("a local change is pushed once, after the debounce", async (t) => {
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": serverSettings({ textSize: 15 }),
    "settings.update": serverSettings({ textSize: 18 }),
  });
  mount(stub);
  // A change made before the account's copy loads would be overwritten by it,
  // which is what "server wins on load" means; the test waits for the load.
  await waitUntil(
    t,
    () => useSettingsStore.getState().settings.textSize === 15,
    "the server's copy landed",
  );

  act(() => {
    // A slider drag: several changes inside one debounce window.
    useSettingsStore.getState().setTextSize(16);
    useSettingsStore.getState().setTextSize(17);
    useSettingsStore.getState().setTextSize(18);
  });

  await waitUntil(
    t,
    () => stub.calls.some((call) => call.path === "settings.update"),
    "the change reached the server",
  );
  await new Promise((resolve) => setTimeout(resolve, SESSION_SETTINGS_SYNC_DEBOUNCE_MS * 2));

  const updates = stub.calls.filter((call) => call.path === "settings.update");
  t.is(updates.length, 1, "three moves of the slider are one write");
  t.is((updates[0]?.input as { settings: { textSize: number } }).settings.textSize, 18);
});

test.serial("a push that fails does not stop the next one", async (t) => {
  // A failed push must not stop later ones from being sent.
  let calls = 0;
  const stub = createTrpcStub({
    ...defaultResponses(testUser()),
    "settings.get": serverSettings({ textSize: 15 }),
    "settings.update": () => {
      calls += 1;
      if (calls === 1) return new Response("offline", { status: 503 });
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
