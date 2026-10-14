// Saved drafts (`10-home-feed-journal.md` §1), ported from the desktop's
// `ResearchDraftView.tsx` and `researchDraftAutosave.ts`: the Drafts place,
// the draft's own view with its autosave and ⌘S, and sending it.

import type { ResearchDraft } from "@session/shared";
import { fireEvent, screen } from "@testing-library/react";
import test from "ava";

import {
  createResearchDraftAutosave,
  createResearchDraftImageSave,
} from "../src/lib/researchDraftAutosave.js";
import { useNotificationsStore } from "../src/stores/notifications.js";

import { node, tree } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";

/** An autosave on a hand-driven clock. */
function autosaveHarness(initial = "Draft") {
  const saves: string[] = [];
  const errors: string[] = [];
  let failNext: string | null = null;
  const timers: (() => void)[] = [];
  const autosave = createResearchDraftAutosave({
    initial,
    delayMs: 500,
    save: (prompt) => {
      saves.push(prompt);
      if (failNext) {
        const message = failNext;
        failNext = null;
        return Promise.reject(new Error(message));
      }
      return Promise.resolve();
    },
    onError: (message) => errors.push(message),
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer: (timer) => {
      timers[timer as number] = () => {};
    },
  });
  return {
    autosave,
    saves,
    errors,
    fail: (message: string) => {
      failNext = message;
    },
    tick: () => {
      const pending = timers.splice(0);
      for (const run of pending) run();
    },
  };
}

test("draft edits save after a pause, skipping empty and unchanged text", (t) => {
  const { autosave, saves, tick } = autosaveHarness();
  autosave.edit("Draft");
  tick();
  autosave.edit("   ");
  tick();
  t.deepEqual(saves, [], "nothing changed, then nothing to keep");
  autosave.edit("Draft, longer");
  tick();
  t.deepEqual(saves, ["Draft, longer"]);
});

test("closing the draft flushes a pending edit at once", (t) => {
  const { autosave, saves } = autosaveHarness();
  autosave.edit("Edited");
  autosave.flush();
  t.deepEqual(saves, ["Edited"]);
});

test("⌘S saves a pending edit and resolves whether it saved", async (t) => {
  const { autosave, saves } = autosaveHarness();
  t.false(await autosave.saveNow(), "nothing to save");
  autosave.edit("Edited");
  t.true(await autosave.saveNow());
  t.deepEqual(saves, ["Edited"]);
});

test("sending stops the autosave and its errors; a failed send resumes it", async (t) => {
  const { autosave, saves, errors, fail, tick } = autosaveHarness();
  fail("offline");
  autosave.edit("Edited");
  tick();
  autosave.finish();
  await Promise.resolve();
  await Promise.resolve();
  t.deepEqual(errors, [], "an error after a send started is not shown");
  autosave.edit("Edited again");
  tick();
  t.deepEqual(saves, ["Edited"]);
  autosave.resume();
  autosave.edit("Edited a third time");
  tick();
  t.deepEqual(saves, ["Edited", "Edited a third time"]);
});

test("a draft save sends its images only when they changed", async (t) => {
  const sent: (readonly string[] | undefined)[] = [];
  const first = ["a"];
  const save = createResearchDraftImageSave(first, (_prompt, images) => {
    sent.push(images);
    return Promise.resolve();
  });
  await save("text", first);
  const second = ["a", "b"];
  await save("text", second);
  await save("text", second);
  t.deepEqual(sent, [undefined, second, undefined]);
});

/* -------------------------------------------------------------------------
 * The views
 * ---------------------------------------------------------------------- */

function draft(overrides: Partial<ResearchDraft> = {}): ResearchDraft {
  return {
    id: "d1",
    workspaceId: WORKSPACE_ID,
    prompt: "What is a trie?",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function draftResponses(): Record<string, unknown> {
  return {
    "workspaces.list": [workspace()],
    "settings.get": serverSettings(),
    "research.listTrees": [],
    "folders.get": { folders: [], membership: {}, collapsed: [], parents: {}, collapsedGroups: [] },
    "drafts.list": [draft()],
    "drafts.save": (input: { prompt: string }) => draft({ prompt: input.prompt }),
    "drafts.remove": { ok: true },
    "research.listTrash": [],
    "feed.recentQueriesForTrees": [],
    "research.createTree": { tree: tree({ id: "t9" }), nodes: [node({ id: "n9", treeId: "t9" })] },
  };
}

test.serial("Drafts lists the drafts; a draft's card opens its view", async (t) => {
  const app = await renderApp("/drafts", {
    queryClient: testQueryClient(),
    responses: draftResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Draft: What is a trie?" }) !== null,
    "the draft's card",
  );
  t.truthy(screen.getByRole("heading", { name: "Drafts", level: 1 }));
  fireEvent.click(screen.getByRole("button", { name: "Draft: What is a trie?" }));
  await waitUntil(
    t,
    () => screen.queryByRole("textbox", { name: "Draft question" }) !== null,
    "the draft's view",
  );
  t.is(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Draft question" }).value,
    "What is a trie?",
  );
  t.not(document.activeElement, screen.getByRole("textbox", { name: "Draft question" }));
  app.unmount();
});

test.serial("a draft card's Delete removes the draft and says so", async (t) => {
  const app = await renderApp("/drafts", {
    queryClient: testQueryClient(),
    responses: draftResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("button", { name: "Draft actions" }) !== null,
    "the draft's card",
  );
  fireEvent.click(screen.getByRole("button", { name: "Draft actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await waitUntil(
    t,
    () => useNotificationsStore.getState().items.some((item) => item.title === "Draft deleted."),
    "the desktop's toast",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "drafts.remove")?.input, {
    draftId: "d1",
  });
  app.unmount();
});

test.serial("an edit saves after a pause, and ⌘S saves at once", async (t) => {
  const app = await renderApp("/drafts/d1", {
    queryClient: testQueryClient(),
    responses: draftResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("textbox", { name: "Draft question" }) !== null,
    "the draft's view",
  );
  const field = screen.getByRole("textbox", { name: "Draft question" });
  fireEvent.change(field, { target: { value: "What is a radix trie?" } });
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "drafts.save"),
    "saved without waiting for the pause",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "drafts.save")?.input, {
    id: "d1",
    workspaceId: WORKSPACE_ID,
    prompt: "What is a radix trie?",
  });
  app.unmount();
});

test.serial("Send asks the question, removes the draft and opens the thread", async (t) => {
  const app = await renderApp("/drafts/d1", {
    queryClient: testQueryClient(),
    responses: draftResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByRole("textbox", { name: "Draft question" }) !== null,
    "the draft's view",
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitUntil(
    t,
    () => app.trpc.calls.some((call) => call.path === "drafts.remove"),
    "the draft is removed once sent",
  );
  t.deepEqual(app.trpc.calls.find((call) => call.path === "research.createTree")?.input, {
    prompt: "What is a trie?",
    model: "gemini-flash",
    effort: null,
    workspaceId: WORKSPACE_ID,
  });
  t.deepEqual(app.trpc.calls.find((call) => call.path === "drafts.remove")?.input, {
    draftId: "d1",
  });
  await waitUntil(
    t,
    () => screen.queryByRole("textbox", { name: "Draft question" }) === null,
    "the thread replaces the draft",
  );
  await waitUntil(
    t,
    () =>
      useNotificationsStore
        .getState()
        .items.some((item) => item.title === "Sent. Moved from Drafts to Unfiled."),
    "the desktop's toast",
  );
  app.unmount();
});

test.serial("a draft that was sent elsewhere says so", async (t) => {
  const app = await renderApp("/drafts/gone", {
    queryClient: testQueryClient(),
    responses: draftResponses(),
  });
  await waitUntil(
    t,
    () => screen.queryByText("This draft was sent or deleted.") !== null,
    "the empty state",
  );
  app.unmount();
});
