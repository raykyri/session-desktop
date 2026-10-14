// The Home ask box (`07-client-architecture.md` §6, `10-home-feed-journal.md`
// §1), ported from the desktop's `ResearchQueryComposer.tsx`: Ask and Note,
// the model and effort menu, Save draft, images, and the draft it keeps.

import type { ModelInfo, ResearchImageAttachment } from "@session/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import { askSwitchKeyTarget } from "../src/features/composer/AskNoteSwitch.js";
import {
  askLabelFor,
  effortOptionsFor,
  resolvedEffort,
} from "../src/features/composer/QuestionModelPicker.js";
import {
  askBoxCopy,
  composerModels,
  nextComposerModel,
} from "../src/features/composer/ResearchQueryComposer.js";
import {
  MAX_PROMPT_BYTES,
  MAX_PROMPT_WORDS,
  oversizeRefusal,
} from "../src/features/composer/limits.js";
import { ConversationComposer } from "../src/features/thread/ConversationComposer.js";
import { postFollowUpImageBlock } from "../src/features/thread/PostFollowUpField.js";
import {
  acceptResearchImageFiles,
  pasteAttachesImages,
  researchImageBlockReason,
  researchImageLabel,
  RESEARCH_IMAGE_COUNT_ERROR,
  RESEARCH_IMAGE_SIZE_ERROR,
  RESEARCH_IMAGE_TYPE_ERROR,
  RESEARCH_IMAGE_UNSCALED_SIZE_ERROR,
  RESEARCH_MESSAGE_IMAGE_SIZE_ERROR,
} from "../src/lib/researchImages.js";
import { homeDraftKey, useDraftsStore } from "../src/stores/drafts.js";
import { useNotificationsStore } from "../src/stores/notifications.js";

import { node, summary, tree } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";

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

/* -------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------- */

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
    "with nothing to launch, every model is listed so the menu explains itself",
  );
});

test("falls back to the model registry when the runtime config has no models", (t) => {
  t.true(composerModels(undefined, false).length > 0);
  t.true(composerModels([], false).every((entry) => entry.available));
});

test("⌃Tab steps to the next launchable model and wraps", (t) => {
  const models = [model({ id: "a" }), model({ id: "b", available: false }), model({ id: "c" })];
  t.is(nextComposerModel(models, "a"), "c", "an unavailable model is stepped over");
  t.is(nextComposerModel(models, "c"), "a", "and the list wraps");
  t.is(nextComposerModel([], "a"), "a");
});

test("each model offers its own efforts, and a leftover choice falls back", (t) => {
  t.deepEqual(
    effortOptionsFor("gemini-flash").map((option) => option.label),
    ["Default", "Low", "Medium", "High"],
  );
  t.deepEqual(
    effortOptionsFor("claude-fable").map((option) => option.value),
    ["", "low", "medium", "high", "xhigh", "max"],
  );
  t.is(resolvedEffort("claude-fable", "max"), "max");
  t.is(resolvedEffort("gemini-flash", "max"), null, "Gemini takes no max effort");
  t.is(resolvedEffort("gemini-flash", ""), null);
  t.is(askLabelFor(model(), "high"), "Ask with Gemini 3.8 Flash (High)");
  t.is(askLabelFor(model(), null), "Ask with Gemini 3.8 Flash");
});

test("Note mode saves a note, or a link when the text is one URL", (t) => {
  t.deepEqual(askBoxCopy("note", "Some thoughts", false, "Ask a question"), {
    placeholder: "Write a note, or paste a link to save",
    submitLabel: "Save note",
  });
  t.is(
    askBoxCopy("note", " https://example.com/a ", false, "Ask a question").submitLabel,
    "Save link",
  );
  t.is(askBoxCopy("note", "x", true, "Ask a question").submitLabel, "Saving…");
  t.deepEqual(askBoxCopy("ai", "x", false, "Ask a question"), {
    placeholder: "Ask a question",
    submitLabel: "Start research",
  });
});

test("the arrow keys move between Ask and Note, Home and End jump", (t) => {
  t.is(askSwitchKeyTarget("ArrowRight", "ai"), "note");
  t.is(askSwitchKeyTarget("ArrowLeft", "note"), "ai");
  t.is(askSwitchKeyTarget("Home", "note"), "ai");
  t.is(askSwitchKeyTarget("End", "ai"), "note");
  t.is(askSwitchKeyTarget("Enter", "ai"), null);
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
  );
  t.is(MAX_PROMPT_WORDS, 10_000);
  t.is(MAX_PROMPT_BYTES, 10 * 1024 * 1024);
});

test("an image is refused by type, by size for its type, and past eight", (t) => {
  const png = { type: "image/png", size: 1024 };
  t.deepEqual(acceptResearchImageFiles([png, { type: "text/plain", size: 1 }], 0), {
    accepted: [png],
    error: RESEARCH_IMAGE_TYPE_ERROR,
  });
  t.is(
    acceptResearchImageFiles([{ type: "image/jpeg", size: 21 * 1024 * 1024 }], 0).error,
    RESEARCH_IMAGE_SIZE_ERROR,
  );
  t.is(
    acceptResearchImageFiles([{ type: "image/gif", size: 6 * 1024 * 1024 }], 0).error,
    RESEARCH_IMAGE_UNSCALED_SIZE_ERROR,
    "GIF and WebP are not downscaled",
  );
  t.deepEqual(acceptResearchImageFiles([png, png], 7), {
    accepted: [png],
    error: RESEARCH_IMAGE_COUNT_ERROR,
  });
});

test("a paste attaches images only when it is an image and not text with a picture", (t) => {
  t.true(pasteAttachesImages("", ["shot.png"]));
  t.true(pasteAttachesImages("shot.png", ["shot.png"]));
  t.true(pasteAttachesImages("https://example.com/a.png", ["a.png"]));
  t.true(pasteAttachesImages("", [], '<img src="x">'));
  t.false(pasteAttachesImages("Some copied cells\nand more", ["image.png"]));
});

test("a model that can't read images, or too many bytes, blocks the send", (t) => {
  const image = (byteSize: number): ResearchImageAttachment => ({
    kind: "image",
    id: "i",
    mimeType: "image/png",
    byteSize,
  });
  t.is(researchImageBlockReason(model(), [image(1)]), null);
  t.is(
    researchImageBlockReason(model({ label: "DeepSeek", supportsImages: false }), [image(1)]),
    "DeepSeek can't read images.",
  );
  t.is(
    researchImageBlockReason(model(), [image(15 * 1024 * 1024), image(6 * 1024 * 1024)]),
    RESEARCH_MESSAGE_IMAGE_SIZE_ERROR,
  );
  t.is(researchImageLabel(1), "[Image]");
  t.is(researchImageLabel(3), "[3 images]");
  t.is(researchImageLabel(0), null);
});

test("a note follow-up's images are checked against the Ask model, and refused as a note", (t) => {
  const image: ResearchImageAttachment = {
    kind: "image",
    id: "i",
    mimeType: "image/png",
    byteSize: 1,
  };
  const models = [model(), model({ id: "deepseek", label: "DeepSeek", supportsImages: false })];
  t.is(
    postFollowUpImageBlock(false, models, { model: "gemini-flash", effort: null }, [image]),
    null,
  );
  t.is(
    postFollowUpImageBlock(false, models, { model: "deepseek", effort: null }, [image]),
    "DeepSeek can't read images.",
  );
  t.is(
    postFollowUpImageBlock(true, models, { model: "gemini-flash", effort: null }, [image]),
    "Notes can't include images. Switch to Ask to send them with a question.",
  );
  t.is(postFollowUpImageBlock(false, models, { model: "deepseek", effort: null }, []), null);
});

test.serial("a thread ask box keeps Send disabled and says why its images can't go", (t) => {
  const image: ResearchImageAttachment = {
    kind: "image",
    id: "i",
    mimeType: "image/png",
    byteSize: 1,
  };
  let sent = 0;
  const props = {
    value: "What is in this picture?",
    placeholder: "Ask a follow-up",
    disabled: false,
    canSubmit: true,
    submitting: false,
    onChange: () => {},
    onSubmit: () => {
      sent += 1;
    },
  };
  const view = render(
    <ConversationComposer
      {...props}
      images={[image]}
      imageBlockReason="DeepSeek can't read images."
    />,
  );
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
  t.true(send.disabled);
  t.truthy(screen.getByRole("alert"));
  t.is(screen.getByRole("alert").textContent, "DeepSeek can't read images.");
  fireEvent.keyDown(screen.getByRole("textbox"), {
    key: "Enter",
    metaKey: true,
    ctrlKey: true,
  });
  t.is(sent, 0, "⌘↵ does not send either");
  view.rerender(
    <ConversationComposer {...props} images={[]} imageBlockReason="DeepSeek can't read images." />,
  );
  t.false(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled);
  t.is(screen.queryByRole("alert"), null, "without images there is nothing to refuse");
  cleanup();
});

/* -------------------------------------------------------------------------
 * The ask box on Home
 * ---------------------------------------------------------------------- */

const homeResponses: Record<string, unknown> = {
  "workspaces.list": [workspace()],
  "settings.get": serverSettings(),
  "research.listTrees": [summary({ workspaceId: WORKSPACE_ID })],
  "folders.get": { folders: [], membership: {}, collapsed: [], parents: {}, collapsedGroups: [] },
  "drafts.list": [],
  "research.listTrash": [],
  "feed.recentQueriesForTrees": [],
  "highlights.listFeed": [],
};

const FIELD = "New question";

async function openHome(t: ExecutionContext, responses = {}) {
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: { ...homeResponses, ...responses },
  });
  await waitUntil(t, () => screen.queryByRole("textbox", { name: FIELD }) !== null, "the ask box");
  return app;
}

/** Focuses the box, which shows its row, and types. */
function type(text: string): HTMLTextAreaElement {
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD });
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: text } });
  return field;
}

test.serial("the send button waits for text", async (t) => {
  const app = await openHome(t);
  const field = screen.getByRole("textbox", { name: FIELD });
  fireEvent.focus(field);
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Start research" }) !== null,
    "the row opens on focus",
  );
  t.true(screen.getByRole<HTMLButtonElement>("button", { name: "Start research" }).disabled);
  type("What is collective memory?");
  t.false(screen.getByRole<HTMLButtonElement>("button", { name: "Start research" }).disabled);
  app.unmount();
});

test.serial("⌘↵ starts research with the model and effort of the box", async (t) => {
  const detail = { tree: tree({ id: "t9" }), nodes: [node({ id: "n9", treeId: "t9" })] };
  const app = await openHome(t, { "research.createTree": detail });
  act(() =>
    useDraftsStore
      .getState()
      .setDraft(homeDraftKey(WORKSPACE_ID), { text: "", model: "gemini-flash", effort: "high" }),
  );
  app.unmount();
  const second = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: { ...homeResponses, "research.createTree": detail },
  });
  await waitUntil(t, () => screen.queryByRole("textbox", { name: FIELD }) !== null, "the box");
  const field = type("What is collective memory?");
  fireEvent.keyDown(field, { key: "Enter" });
  t.false(
    second.trpc.calls.some((call) => call.path === "research.createTree"),
    "Enter alone adds a line",
  );
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true });
  await waitUntil(
    t,
    () => second.trpc.calls.some((call) => call.path === "research.createTree"),
    "sent",
  );
  t.deepEqual(second.trpc.calls.find((call) => call.path === "research.createTree")?.input, {
    prompt: "What is collective memory?",
    model: "gemini-flash",
    effort: "high",
    workspaceId: WORKSPACE_ID,
  });
  second.unmount();
});

test.serial("Note saves a note with the box's model as its follow-up default", async (t) => {
  const detail = {
    tree: tree({ id: "t8" }),
    nodes: [
      {
        ...node({ id: "n8", treeId: "t8" }),
        type: "post",
        format: "text",
        message: { text: "A thought" },
      },
    ],
  };
  const app = await openHome(t, { "research.createPost": detail });
  type("A thought");
  fireEvent.click(screen.getByRole("radio", { name: "Save as note" }));
  t.is(
    screen.getByRole("textbox", { name: FIELD }).getAttribute("placeholder"),
    "Write a note, or paste a link to save",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "research.createPost"),
    "the note is saved",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.createPost")?.input, {
    body: "A thought",
    workspaceId: WORKSPACE_ID,
    model: "gemini-flash",
    effort: null,
  });
  await waitUntil(
    t,
    () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value === "",
    "the box clears and Home stays",
  );
  t.truthy(screen.getByRole("heading", { name: "Home", level: 1 }));
  app.unmount();
});

test.serial("Save draft keeps the question in Drafts and clears the box", async (t) => {
  const app = await openHome(t, {
    "drafts.save": {
      id: "d1",
      workspaceId: WORKSPACE_ID,
      prompt: "Later",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  type("Later");
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save draft" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "drafts.save"),
    "the draft is saved",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "drafts.save")?.input, {
    workspaceId: WORKSPACE_ID,
    prompt: "Later",
  });
  await waitUntil(
    t,
    () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value === "",
    "the box clears",
  );
  t.true(
    useNotificationsStore.getState().items.some((item) => item.title === "Saved to Drafts."),
    "the desktop's toast",
  );
  app.unmount();
});

test.serial("the selected Ask segment opens the model menu", async (t) => {
  const app = await openHome(t, {
    "system.runtimeConfig": {
      version: "0.0.0",
      models: [model(), model({ id: "gpt-luna", label: "GPT-5.6 Luna", provider: "openrouter" })],
      limits: {},
      features: {},
    },
  });
  type("x");
  fireEvent.click(screen.getByRole("radio", { name: "Ask with Gemini 3.8 Flash" }));
  const menu = await screen.findByRole("menu", { name: "Model" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "GPT-5.6 Luna" }));
  await waitUntil(
    t,
    () => screen.queryByRole("radio", { name: "Ask with GPT-5.6 Luna" }) !== null,
    "the Ask segment names the new model",
  );
  t.is(useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.model, "gpt-luna");
  app.unmount();
});

test.serial("the Effort submenu opens beside the model menu and sets the effort", async (t) => {
  const app = await openHome(t);
  type("x");
  fireEvent.click(screen.getByRole("radio", { name: "Ask with Gemini 3.8 Flash" }));
  const menu = await screen.findByRole("menu", { name: "Model" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: /^Effort/ }));
  const high = await screen.findByRole("menuitem", { name: "High" });
  t.truthy(screen.queryByRole("menu", { name: "Model" }), "the model menu stays open");
  fireEvent.click(high);
  await waitUntil(
    t,
    () => useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.effort === "high",
    "the draft keeps the effort",
  );
  app.unmount();
});

test.serial("a refused launch keeps every field for the retry", async (t) => {
  const app = await openHome(t, {
    "research.createTree": () => {
      throw new Error("the daily run limit is reached");
    },
  });
  const field = type("What is collective memory?");
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true });
  await waitUntil(
    t,
    () =>
      screen
        .queryAllByRole("alert")
        .some((alert) => alert.textContent?.includes("daily run limit")),
    "the refusal shows beside the box",
  );
  t.is(field.value, "What is collective memory?");
  t.is(
    useDraftsStore.getState().get(homeDraftKey(WORKSPACE_ID))?.text,
    "What is collective memory?",
  );
  app.unmount();
});

test.serial("Home restores a draft from the server in a fresh scope", async (t) => {
  const workspaceId = "remote-home";
  const draft = { text: "saved on another device", model: "gemini-flash", updatedAt: Date.now() };
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses,
      "workspaces.list": [workspace({ id: workspaceId })],
      "settings.get": serverSettings({ defaultWorkspaceId: workspaceId }),
      "interfaceDrafts.get": { key: homeDraftKey(workspaceId), value: JSON.stringify(draft) },
    },
  });
  t.teardown(() => app.unmount());
  await waitUntil(
    t,
    () => screen.queryByRole<HTMLTextAreaElement>("textbox", { name: FIELD })?.value === draft.text,
    "the server's draft is restored into the box",
  );
});

test.serial("a delayed server draft does not replace typing in the box", async (t) => {
  const workspaceId = "remote-editing";
  let resolveDraft: (value: { key: string; value: string }) => void = () => {
    throw new Error("read did not start");
  };
  const response = new Promise<{ key: string; value: string }>((resolve) => {
    resolveDraft = resolve;
  });
  useDraftsStore.setState({ byKey: {} });
  const app = await renderApp("/", {
    queryClient: testQueryClient(),
    responses: {
      ...homeResponses,
      "workspaces.list": [workspace({ id: workspaceId })],
      "settings.get": serverSettings({ defaultWorkspaceId: workspaceId }),
      "interfaceDrafts.get": () => response,
    },
  });
  t.teardown(() => app.unmount());
  await waitUntil(t, () => screen.queryByRole("textbox", { name: FIELD }) !== null, "the box");
  type("typed here");
  await act(async () => {
    resolveDraft({
      key: homeDraftKey(workspaceId),
      value: JSON.stringify({ text: "stale remote", updatedAt: Date.now() + 1000 }),
    });
    await response;
  });
  t.is(screen.getByRole<HTMLTextAreaElement>("textbox", { name: FIELD }).value, "typed here");
});
