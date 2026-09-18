// The Home composer (`07-client-architecture.md` §6,
// `10-home-feed-journal-encyclopedia.md` §1, §2).

import type { ModelInfo } from "@session/shared";
import { fireEvent, screen } from "@testing-library/react";
import test from "ava";

import {
  bareUrl,
  composerModels,
  formatByteSize,
  nextComposerModel,
} from "../src/features/composer/ResearchQueryComposer.js";
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

test("a prompt that is one web URL is a link, and anything else is a question", (t) => {
  t.is(bareUrl("https://example.com/a"), "https://example.com/a");
  t.is(bareUrl("  https://example.com/a  "), "https://example.com/a");
  t.is(bareUrl("https://example.com/a what is this"), null);
  t.is(bareUrl("javascript:alert(1)"), null);
  t.is(bareUrl("collective memory"), null);
  t.is(bareUrl(""), null);
});

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

test("the model list falls back to the registry when the deployment says nothing", (t) => {
  t.true(composerModels(undefined, false).length > 0);
  t.true(composerModels([], false).every((entry) => entry.available));
});

test("Tab steps to the next launchable model and wraps", (t) => {
  const models = [model({ id: "a" }), model({ id: "b", available: false }), model({ id: "c" })];
  t.is(nextComposerModel(models, "a"), "c", "an unavailable model is stepped over");
  t.is(nextComposerModel(models, "c"), "a", "and the list wraps");
  t.is(nextComposerModel([], "a"), "a", "with nothing to step to, nothing moves");
});

test("attachment sizes read in the unit that fits", (t) => {
  t.is(formatByteSize(512), "512 B");
  t.is(formatByteSize(2048), "2 KB");
  t.is(formatByteSize(5 * 1024 * 1024), "5.0 MB");
});

const homeResponses = {
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
  "folders.get": { folders: [], membership: {}, starred: [], collapsed: [] },
  "feed.recentActivity": activityPage([]),
  "highlights.listFeed": [],
  "documents.list": [],
};

const PROMPT_LABEL = "What would you like to investigate?";

test.serial("the send control is off until there is something to send", async (t) => {
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

test.serial("the draft keeps the prompt, the model and the attached document ids", async (t) => {
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
  t.deepEqual(draft?.documentIds, [], "the ids are part of the draft, empty or not");
  app.unmount();
});

test.serial("a bare URL is saved to the journal instead of launching a run", async (t) => {
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    responses: {
      ...homeResponses,
      "journal.add": {
        id: "j1",
        kind: "link",
        url: "https://example.com/a",
        createdAt: new Date().toISOString(),
      },
    },
  });
  await waitUntil(
    t,
    () => screen.queryAllByLabelText(PROMPT_LABEL).length > 0,
    "the composer is on Home",
  );

  const field = screen.getByLabelText(PROMPT_LABEL);
  fireEvent.change(field, { target: { value: "https://example.com/a" } });
  fireEvent.keyDown(field, { key: "Enter" });

  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "journal.add"),
    "the URL becomes a journal entry",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "journal.add")?.input, {
    url: "https://example.com/a",
  });
  t.false(
    app.trpc.calls.some((call) => call.path === "research.createTree"),
    "and no run is launched",
  );
  await waitUntil(
    t,
    () => useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID)) === undefined,
    "a submitted composer is not still a draft",
  );
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
  fireEvent.keyDown(field, { key: "Enter" });

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
