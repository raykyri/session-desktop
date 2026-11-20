// Saved drafts (`10-home-feed-journal.md` §1), ported from the desktop's
// `ResearchDraftView.tsx` and `researchDraftAutosave.ts`: the Drafts section,
// the draft's own view with its autosave and ⌘S, and sending it.

import type { ResearchDraft } from "@session/shared";
import { fireEvent, screen } from "@testing-library/react";
import test, { type ExecutionContext } from "ava";

import {
  createResearchDraftAutosave,
  createResearchDraftImageSave,
} from "../src/lib/researchDraftAutosave.js";
import { useNotificationsStore } from "../src/stores/notifications.js";

import { node, tree } from "./fixtures.js";
import { renderApp, waitUntil } from "./helpers.js";
import { serverSettings, testQueryClient, workspace, WORKSPACE_ID } from "./phase6Fixtures.js";

/** Test harness for autosave with manual timer control. */
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

test("debounces draft edits and skips empty or unchanged text", (t) => {
  const { autosave, saves, tick } = autosaveHarness();
  autosave.edit("Draft");
  tick();
  autosave.edit("   ");
  tick();
  t.deepEqual(saves, [], "no change recorded");
  autosave.edit("Draft, longer");
  tick();
  t.deepEqual(saves, ["Draft, longer"]);
});

test("flushes pending edits immediately on close", (t) => {
  const { autosave, saves } = autosaveHarness();
  autosave.edit("Edited");
  autosave.flush();
  t.deepEqual(saves, ["Edited"]);
});

test("saveNow writes pending edits and returns boolean status", async (t) => {
  const { autosave, saves } = autosaveHarness();
  t.false(await autosave.saveNow(), "nothing to save");
  autosave.edit("Edited");
  t.true(await autosave.saveNow());
  t.deepEqual(saves, ["Edited"]);
});

test("submission halts autosave and suppresses errors; failed submission resumes autosave", async (t) => {
  const { autosave, saves, errors, fail, tick } = autosaveHarness();
  fail("offline");
  autosave.edit("Edited");
  tick();
  autosave.finish();
  await Promise.resolve();
  await Promise.resolve();
  t.deepEqual(errors, [], "errors after submission started are suppressed");
  autosave.edit("Edited again");
  tick();
  t.deepEqual(saves, ["Edited"]);
  autosave.resume();
  autosave.edit("Edited a third time");
  tick();
  t.deepEqual(saves, ["Edited", "Edited a third time"]);
});

test("passes images only when changed since previous save", async (t) => {
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

test("failed save retains unsaved state for subsequent saveNow and flush attempts", async (t) => {
  const { autosave, saves, errors, fail, tick } = autosaveHarness();
  fail("offline");
  autosave.edit("Edited");
  tick();
  await Promise.resolve();
  await Promise.resolve();
  t.deepEqual(errors, ["offline"]);
  t.true(await autosave.saveNow(), "saveNow retries unsaved text");
  t.deepEqual(saves, ["Edited", "Edited"]);
  t.false(await autosave.saveNow(), "already saved");
  fail("offline");
  autosave.edit("Edited again");
  await t.throwsAsync(autosave.saveNow(), { message: "offline" });
  t.true(autosave.flush(), "flushed on close");
  t.deepEqual(saves, ["Edited", "Edited", "Edited again", "Edited again"]);
});

test("failed save does not overwrite newer successful save state", async (t) => {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const autosave = createResearchDraftAutosave({
    initial: "Draft",
    delayMs: 500,
    save: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
    onError: () => undefined,
  });
  autosave.edit("Draft 1");
  autosave.flush();
  autosave.edit("Draft 2");
  autosave.flush();
  pending[1]?.resolve();
  pending[0]?.reject(new Error("offline"));
  await Promise.resolve();
  await Promise.resolve();
  t.false(await autosave.saveNow(), "Draft 2 is stored");
  t.is(pending.length, 2);
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

test.serial(
  "deleting a draft card removes the draft and displays notification toast",
  async (t) => {
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
  },
);

test.serial("edits debounce automatically and ⌘S triggers immediate save", async (t) => {
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

/** Renders draft view with a mock drafts.save failing failNext() times. */
async function openFailingDraft(t: ExecutionContext) {
  let failures = 0;
  const image = { kind: "image" as const, id: "img1", mimeType: "image/png", byteSize: 10 };
  const app = await renderApp("/drafts/d1", {
    queryClient: testQueryClient(),
    responses: {
      ...draftResponses(),
      "drafts.list": [draft({ attachments: [image] })],
      "drafts.save": (input: { prompt: string }) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("The draft couldn't be saved.");
        }
        return draft({ prompt: input.prompt });
      },
    },
  });
  await waitUntil(
    t,
    () => screen.queryByRole("textbox", { name: "Draft question" }) !== null,
    "the draft's view",
  );
  const saves = () =>
    app.trpc.calls
      .filter((call) => call.path === "drafts.save")
      .map((call) => call.input as { prompt: string; images?: string[] });
  return {
    app,
    saves,
    failNext: () => {
      failures += 1;
    },
    field: screen.getByRole("textbox", { name: "Draft question" }),
  };
}

test.serial("save shortcut retries failed text save or image removal", async (t) => {
  useNotificationsStore.getState().clear();
  const { app, saves, failNext, field } = await openFailingDraft(t);
  failNext();
  fireEvent.change(field, { target: { value: "What is a radix trie?" } });
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await waitUntil(
    t,
    () => screen.queryByText("The draft couldn't be saved.") !== null,
    "error message is displayed",
  );
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await waitUntil(t, () => saves().length === 2, "⌘S saves the same text again");
  t.is(saves()[1]?.prompt, "What is a radix trie?");
  await waitUntil(
    t,
    () => useNotificationsStore.getState().items.some((item) => item.title === "Draft saved."),
    "toast notification is displayed",
  );

  failNext();
  fireEvent.click(screen.getByRole("button", { name: /^Remove image/ }));
  await waitUntil(t, () => saves().length === 3, "the removal saves at once");
  t.deepEqual(saves()[2]?.images, []);
  await waitUntil(
    t,
    () => screen.queryByText("The draft couldn't be saved.") !== null,
    "error message is displayed",
  );
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await waitUntil(t, () => saves().length === 4, "⌘S saves the removal again");
  t.deepEqual(saves()[3]?.images, []);
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  t.is(saves().length, 4, "no pending changes");
  app.unmount();
});

test.serial("unmounting a draft view after failed save retries persistence", async (t) => {
  const { app, saves, failNext, field } = await openFailingDraft(t);
  failNext();
  fireEvent.change(field, { target: { value: "What is a radix trie?" } });
  fireEvent.keyDown(field, { key: "s", metaKey: true });
  await waitUntil(
    t,
    () => screen.queryByText("The draft couldn't be saved.") !== null,
    "error message is displayed",
  );
  app.unmount();
  await waitUntil(t, () => saves().length === 2, "saved on unmount");
  t.deepEqual(
    saves().map((save) => save.prompt),
    ["What is a radix trie?", "What is a radix trie?"],
  );
});

test.serial("Send creates research thread, deletes draft, and navigates to thread", async (t) => {
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
    "thread view replaces draft view",
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

test.serial("draft sent in another session displays missing draft message", async (t) => {
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
