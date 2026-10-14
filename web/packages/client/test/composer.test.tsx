// The Home composer (`07-client-architecture.md` §6,
// `10-home-feed-journal.md` §1, §2).

import type { ModelInfo } from "@session/shared";
import { act, fireEvent, screen } from "@testing-library/react";
import test from "ava";

import {
  composerModels,
  nextComposerModel,
} from "../src/features/composer/ResearchQueryComposer.js";
import {
  MAX_PROMPT_BYTES,
  MAX_PROMPT_WORDS,
  oversizeRefusal,
} from "../src/features/composer/limits.js";
import { homeDraftKey, useDraftsStore } from "../src/stores/drafts.js";

import { summary } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import {
  activityPage,
  serverSettings,
  testQueryClient,
  workspace,
  WORKSPACE_ID,
} from "./phase6Fixtures.js";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "gemini-flash",
    label: "Gemini 3.8 Flash",
    provider: "vertex",
    adminOnly: false,
    available: true,
    supportsFiles: true,
    supportsImages: true,
    ...overrides,
  };
}

test("the model list hides admin-only models from everyone else", (t) => {
  const models = [model(), model({ id: "claude-fable", label: "Claude", adminOnly: true })];
  t.deepEqual(
    composerModels(models, false).map((entry) => entry.id),
    ["gemini-flash"],
  );
  t.deepEqual(
    composerModels(models, true).map((entry) => entry.id),
    ["gemini-flash", "claude-fable"],
  );
});

test("the model list hides unavailable models unless none is available", (t) => {
  const mixed = [model(), model({ id: "gpt", label: "GPT", available: false })];
  t.deepEqual(
    composerModels(mixed, false).map((entry) => entry.id),
    ["gemini-flash"],
  );
  const none = [model({ available: false }), model({ id: "gpt", label: "GPT", available: false })];
  t.deepEqual(
    composerModels(none, false).map((entry) => entry.id),
    ["gemini-flash", "gpt"],
    "with nothing to launch, every model is listed so the picker explains itself",
  );
});

test("falls back to default model registry when server runtime config is empty", (t) => {
  t.true(composerModels(undefined, false).length > 0);
  t.true(composerModels([], false).every((entry) => entry.available));
});

test("Tab steps to the next launchable model and wraps", (t) => {
  const models = [model({ id: "a" }), model({ id: "b", available: false }), model({ id: "c" })];
  t.is(nextComposerModel(models, "a"), "c", "an unavailable model is stepped over");
  t.is(nextComposerModel(models, "c"), "a", "and the list wraps");
  t.is(
    nextComposerModel([], "a"),
    "a",
    "model selection remains unchanged when no models are available",
  );
});

test("prompts exceeding word or byte limits return standardized validation errors", (t) => {
  t.is(oversizeRefusal("a short question", "question"), null);
  t.is(
    oversizeRefusal(`${"word ".repeat(10_001)}`, "question"),
    "The question is 10,001 words, which exceeds the 10,000-word limit.",
  );
  t.is(
    oversizeRefusal("x", "report", 11 * 1024 * 1024),
    "The report exceeds the 10 MiB size limit.",
    "the byte ceiling is checked against the size already available to the caller",
  );
  // Same numbers on both surfaces: the import dialog documents them as "the
  // same limits the composer applies".
  t.is(MAX_PROMPT_WORDS, 10_000);
  t.is(MAX_PROMPT_BYTES, 10 * 1024 * 1024);
});

const homeResponses = {
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
  "folders.get": { folders: [], membership: {}, collapsed: [] },
  "feed.recentActivity": activityPage([]),
  "highlights.listFeed": [],
};

const PROMPT_LABEL = "What do you want to investigate?";

test.serial("disables the submit button when the composer is empty", async (t) => {
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", { responses: homeResponses });
  await waitUntil(
    t,
    () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0,
    "the composer is on Home",
  );

  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Start research" });
  t.true(send.disabled);

  fireEvent.change(screen.getByLabelText(PROMPT_LABEL), {
    target: { value: "What is collective memory?" },
  });
  await waitUntil(
    t,
    () => !screen.getByRole<HTMLButtonElement>("button", { name: "Start research" }).disabled,
    "a question enables it",
  );
  app.unmount();
});

test.serial("Shift-Tab leaves the Home composer instead of cycling models", async (t) => {
  // With more than one model Tab is the model cycle and the composer takes the
  // key. Taking Shift-Tab as well traps focus in the prompt textarea: nothing
  // moves it backwards and a keyboard-only user is stuck (WCAG 2.1.2).
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    responses: {
      ...homeResponses,
      "system.runtimeConfig": {
        version: "0.0.0",
        models: [model(), model({ id: "gpt-luna", label: "GPT-5.6 Luna", provider: "openrouter" })],
        limits: {},
        features: {},
      },
    },
  });
  await waitUntil(
    t,
    () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0,
    "the composer is on Home",
  );
  const field = screen.getByLabelText(PROMPT_LABEL);

  t.false(fireEvent.keyDown(field, { key: "Tab" }), "Tab is taken as the model cycle");
  t.true(
    fireEvent.keyDown(field, { key: "Tab", shiftKey: true }),
    "Shift-Tab reaches the browser, so focus can move backwards out of the field",
  );
  app.unmount();
});

test.serial("the draft keeps the prompt and the model", async (t) => {
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", { responses: homeResponses });
  await waitUntil(
    t,
    () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0,
    "the composer is on Home",
  );

  fireEvent.change(screen.getByLabelText(PROMPT_LABEL), { target: { value: "half a question" } });
  await waitUntil(
    t,
    () => useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.text === "half a question",
    "typing writes the draft",
  );
  const draft = useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID));
  t.is(draft?.model, "gemini-flash");
  app.unmount();
});

test.serial("a launch that is refused keeps every field for the retry", async (t) => {
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses,
      "research.createTree": () => {
        throw new Error("the daily run limit is reached");
      },
    },
  });
  await waitUntil(
    t,
    () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0,
    "the composer is on Home",
  );

  const field = screen.getByLabelText(PROMPT_LABEL);
  fireEvent.change(field, { target: { value: "What is collective memory?" } });
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true });

  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.createTree"),
    "the question reaches the server with the chosen model",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.createTree")?.input, {
    prompt: "What is collective memory?",
    model: "gemini-flash",
    workspaceId: WORKSPACE_ID,
  });
  await waitUntil(
    t,
    () =>
      screen.queryAllByRole("alert").some((node) => node.textContent?.includes("daily run limit")),
    "the refusal is shown beside the composer",
  );
  t.is(
    useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.text,
    "What is collective memory?",
    "and the question is still a draft",
  );
  app.unmount();
});

test.serial("Home restores a draft from the server in a fresh scope", async (t) => {
  const workspaceId = "remote-home";
  const draft = {
    text: "saved on another device",
    model: "gemini-flash",
    updatedAt: Date.now(),
  };
  const app = await renderApp("/", {
    responses: {
      ...homeResponses,
      "workspaces.list": [workspace({ id: workspaceId })],
      "settings.get": serverSettings({ defaultWorkspaceId: workspaceId }),
      "drafts.get": { key: homeDraftKey(workspaceId), value: JSON.stringify(draft) },
    },
  });
  t.teardown(() => app.unmount());
  await waitUntil(
    t,
    () => screen.queryByLabelText<HTMLTextAreaElement>(PROMPT_LABEL)?.value === draft.text,
    "server draft restored into composer",
  );
  t.deepEqual(useDraftsStore.getState().get(homeDraftKey(workspaceId)), draft);
});

test.serial("a delayed server draft does not replace typing in the composer", async (t) => {
  const workspaceId = "remote-editing";
  let resolveDraft: (value: { key: string; value: string }) => void = () => {
    throw new Error("read did not start");
  };
  const response = new Promise<{ key: string; value: string }>((resolve) => {
    resolveDraft = resolve;
  });
  const app = await renderApp("/", {
    responses: {
      ...homeResponses,
      "workspaces.list": [workspace({ id: workspaceId })],
      "settings.get": serverSettings({ defaultWorkspaceId: workspaceId }),
      "drafts.get": () => response,
    },
  });
  t.teardown(() => app.unmount());
  await waitUntil(t, () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0, "composer loaded");
  fireEvent.change(screen.getByLabelText(PROMPT_LABEL), { target: { value: "typed here" } });
  await act(async () => {
    resolveDraft({
      key: homeDraftKey(workspaceId),
      value: JSON.stringify({ text: "stale remote", updatedAt: Date.now() + 1000 }),
    });
    await response;
  });
  t.is(screen.getByLabelText<HTMLTextAreaElement>(PROMPT_LABEL).value, "typed here");
});
