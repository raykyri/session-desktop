import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchDraftView from "../src/components/research/ResearchDraftView";
import { ResearchFeedToast } from "../src/components/research/ResearchFeedChrome";
import { researchCardRefocus } from "../src/components/research/ResearchFeedCard";
import { createResearchDraftAutosave, createResearchDraftImageSave } from "../src/lib/researchDraftAutosave";
import { withWidgetDom } from "./widgetDom";

type DomWindow = Parameters<Parameters<typeof withWidgetDom>[0]>[0];

const noop = () => {};
const asyncNoop = async () => {};

test("a draft opens as a messages column: its question as the title, then a full-width ask box labelled Draft", () => {
  const html = renderToStaticMarkup(
    createElement(ResearchDraftView, {
      draft: { id: "d1", workspaceId: "ws", prompt: "An unsent draft", createdAt: 1, updatedAt: 1 },
      requireCmdEnterToSend: true,
      onSave: asyncNoop,
      onSend: asyncNoop,
    }),
  );
  assert.match(html, /<h2 class="research-column-title"[^>]*>An unsent draft<\/h2>/);
  // The header has no + Ask button.
  assert.doesNotMatch(html, /Go to the ask box/);
  assert.match(html, /research-composer-wrap is-full-width/);
  assert.match(html, /research-composer-mode-label"><b>Draft<\/b>/);
  assert.match(html, /<textarea[^>]*aria-label="Draft question"[^>]*>An unsent draft<\/textarea>/);
  assert.match(html, /type="submit"[^>]*aria-label="Send"/);
  // Opening a draft never focuses its box; Delete is in the feed row's menu.
  assert.doesNotMatch(html, /autofocus|Delete draft/i);
});

test("the toast's live region stays mounted while no toast shows", () => {
  const props = { onUndo: noop, onDismiss: noop, onPause: noop, onResume: noop };
  const empty = renderToStaticMarkup(createElement(ResearchFeedToast, { toast: null, ...props }));
  assert.match(empty, /^<div class="research-feed-toast-region" role="status" aria-live="polite"><\/div>$/);
  const shown = renderToStaticMarkup(
    createElement(ResearchFeedToast, { toast: { id: 1, message: "Moved.", undo: noop }, ...props }),
  );
  assert.match(shown, /role="status"[^>]*><div class="research-feed-toast">.*Moved\..*Undo/);
});

function autosaveHarness(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saves: string[] = [];
  const errors: string[] = [];
  let failNext: string | null = null;
  const autosave = createResearchDraftAutosave({
    initial: "Draft",
    delayMs: 500,
    save: async (prompt) => {
      saves.push(prompt);
      if (failNext) {
        const message = failNext;
        failNext = null;
        throw new Error(message);
      }
    },
    onError: (message) => errors.push(message),
  });
  return { autosave, saves, errors, failSave: (message: string) => (failNext = message) };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("draft edits save after a pause, skipping empty and unchanged text", (t) => {
  const { autosave, saves } = autosaveHarness(t);
  autosave.edit("Draft 1");
  t.mock.timers.tick(300);
  autosave.edit("Draft 12");
  t.mock.timers.tick(499);
  assert.deepEqual(saves, []);
  t.mock.timers.tick(1);
  assert.deepEqual(saves, ["Draft 12"]);
  autosave.edit("   ");
  autosave.edit("Draft 12");
  t.mock.timers.tick(1000);
  assert.deepEqual(saves, ["Draft 12"]);
});

test("closing the draft flushes a pending edit at once", (t) => {
  const { autosave, saves } = autosaveHarness(t);
  autosave.edit("Draft, edited");
  autosave.flush();
  assert.deepEqual(saves, ["Draft, edited"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(saves, ["Draft, edited"], "the timer was cleared");
  autosave.flush();
  assert.deepEqual(saves, ["Draft, edited"]);
});

test("⌘S saves a pending edit at once and resolves whether it saved", async (t) => {
  const { autosave, saves, errors, failSave } = autosaveHarness(t);
  assert.equal(await autosave.saveNow(), false, "nothing to save");
  autosave.edit("Draft, edited");
  assert.equal(await autosave.saveNow(), true);
  assert.deepEqual(saves, ["Draft, edited"]);
  t.mock.timers.tick(1000);
  assert.deepEqual(saves, ["Draft, edited"], "the timer was cleared");
  assert.equal(await autosave.saveNow(), false, "already saved");
  autosave.edit("   ");
  assert.equal(await autosave.saveNow(), false, "empty text is not saved");
  failSave("Disk full.");
  autosave.edit("Draft, edited again");
  await assert.rejects(autosave.saveNow(), /Disk full/);
  await settle();
  assert.deepEqual(errors, ["Disk full."]);
  autosave.finish();
  autosave.edit("Draft, sent");
  assert.equal(await autosave.saveNow(), false, "nothing saves once a send started");
});

test("⌘S in a draft saves the edit and shows a toast; with nothing to save it does nothing", async () => {
  await withWidgetDom(async (window) => {
    // Imported once the DOM is installed: React DOM decides at load whether
    // the browser fires input events, and typing in a field needs it to.
    const { createRoot } = await import("react-dom/client");
    // The ask box sizes its field to the text.
    const computedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      configurable: true,
      writable: true,
    });
    const saves: string[] = [];
    const toasts: string[] = [];
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(ResearchDraftView, {
          draft: { id: "d1", workspaceId: "ws", prompt: "Draft", createdAt: 1, updatedAt: 1 },
          requireCmdEnterToSend: true,
          onSave: async (prompt) => {
            saves.push(prompt);
          },
          onSend: asyncNoop,
          onToast: (message) => toasts.push(message),
        }),
      ),
    );
    const field = container.querySelector("textarea")!;
    const press = async () => {
      const event = new window.KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
      await act(async () => {
        field.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    try {
      assert.equal(await press(), true);
      assert.deepEqual([saves, toasts], [[], []]);
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Draft, edited");
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      assert.equal(await press(), true);
      assert.deepEqual(saves, ["Draft, edited"]);
      assert.deepEqual(toasts, ["Draft saved."]);
      assert.equal(field.value, "Draft, edited");
      assert.equal(await press(), true);
      assert.deepEqual([saves.length, toasts.length], [1, 1]);
    } finally {
      await act(async () => root.unmount());
      if (computedStyle) Object.defineProperty(globalThis, "getComputedStyle", computedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  });
});

test("sending or deleting stops autosave and suppresses pending save errors", async (t) => {
  const { autosave, saves, errors, failSave } = autosaveHarness(t);
  failSave("Draft not found.");
  autosave.edit("Draft, sent");
  t.mock.timers.tick(500);
  autosave.finish();
  await settle();
  assert.deepEqual(errors, []);
  autosave.edit("Draft, sent, then typed");
  t.mock.timers.tick(1000);
  autosave.flush();
  assert.deepEqual(saves, ["Draft, sent"]);
});

test("finishing cancels a pending save", (t) => {
  const { autosave, saves } = autosaveHarness(t);
  autosave.edit("Pending");
  autosave.finish();
  t.mock.timers.tick(1000);
  autosave.flush();
  assert.deepEqual(saves, []);
});

test("a failed send or delete resumes saving", (t) => {
  const { autosave, saves } = autosaveHarness(t);
  autosave.edit("Draft, edited");
  autosave.finish();
  autosave.resume();
  autosave.flush();
  assert.deepEqual(saves, ["Draft, edited"]);
});

test("a failed save is reported while the draft is being edited", async (t) => {
  const { autosave, errors, failSave } = autosaveHarness(t);
  failSave("Disk full.");
  autosave.edit("Draft 2");
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(errors, ["Disk full."]);
});

test("a moved card regains focus only if no other control received focus", () => {
  const body = { name: "body" };
  const anchor = { isConnected: true };
  assert.equal(researchCardRefocus(anchor, anchor, body), "wait", "the old … button keeps focus until the card moves");
  assert.equal(researchCardRefocus(anchor, { name: "field" }, body), "drop", "focus moved elsewhere first");
  anchor.isConnected = false;
  assert.equal(researchCardRefocus(anchor, body, body), "focus", "the button is gone and focus fell to the page");
  assert.equal(researchCardRefocus(anchor, null, body), "focus");
  assert.equal(researchCardRefocus(anchor, { name: "answer column" }, body), "drop", "it never takes focus back");
});

test("a draft save sends its images only when they changed since the last save", async () => {
  const sent: (readonly string[] | undefined)[] = [];
  let fail = false;
  const initial = ["a"];
  const save = createResearchDraftImageSave(initial, async (_prompt, images) => {
    sent.push(images);
    if (fail) throw new Error("offline");
  });
  await save("Text", initial);
  const changed = ["a", "b"];
  fail = true;
  await assert.rejects(save("Text", changed));
  // A failed save sends the images again with the next one.
  fail = false;
  await save("Text, edited", changed);
  await save("Text, edited again", changed);
  assert.deepEqual(sent, [undefined, changed, changed, undefined]);
});

test("a failed save leaves the text unsaved, so ⌘S and closing save it again", async (t) => {
  const { autosave, saves, errors, failSave } = autosaveHarness(t);
  failSave("Disk full.");
  autosave.edit("Draft 2");
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(errors, ["Disk full."]);
  assert.equal(await autosave.saveNow(), true, "⌘S saves the same text again");
  assert.deepEqual(saves, ["Draft 2", "Draft 2"]);
  assert.equal(await autosave.saveNow(), false, "saved now");

  failSave("Disk full.");
  autosave.edit("Draft 3");
  await assert.rejects(autosave.saveNow(), /Disk full/);
  autosave.flush();
  assert.deepEqual(saves, ["Draft 2", "Draft 2", "Draft 3", "Draft 3"], "closing saves it");
});

test("a failed save leaves the text saved when a newer save started and succeeded", async () => {
  const pending: {
    prompt: string;
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];
  const autosave = createResearchDraftAutosave({
    initial: "Draft",
    delayMs: 500,
    save: (prompt) => new Promise<void>((resolve, reject) => pending.push({ prompt, resolve, reject })),
    onError: noop,
  });
  autosave.edit("Draft 1");
  autosave.flush();
  autosave.edit("Draft 2");
  autosave.flush();
  pending[1]!.resolve();
  pending[0]!.reject(new Error("offline"));
  await settle();
  assert.equal(await autosave.saveNow(), false, "Draft 2 is stored");
  assert.deepEqual(
    pending.map((save) => save.prompt),
    ["Draft 1", "Draft 2"],
  );
});

/** Renders a draft with one image whose `onSave` fails `failures()` times. */
async function withDraftView(
  run: (view: {
    window: DomWindow;
    container: HTMLElement;
    saves: [string, string[] | undefined][];
    toasts: string[];
    failNext: () => void;
    press: () => Promise<void>;
    type: (value: string) => Promise<void>;
    unmount: () => Promise<void>;
  }) => Promise<void>,
) {
  await withWidgetDom(async (window) => {
    const { createRoot } = await import("react-dom/client");
    const computedStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", {
      value: window.getComputedStyle.bind(window),
      configurable: true,
      writable: true,
    });
    const saves: [string, string[] | undefined][] = [];
    const toasts: string[] = [];
    let failures = 0;
    const container = window.document.createElement("div");
    window.document.body.append(container);
    const root = createRoot(container);
    const image = {
      kind: "image" as const,
      id: "img1",
      mimeType: "image/png",
      byteSize: 10,
    };
    await act(async () =>
      root.render(
        createElement(ResearchDraftView, {
          draft: {
            id: "d1",
            workspaceId: "ws",
            prompt: "Draft",
            attachments: [image],
            createdAt: 1,
            updatedAt: 1,
          },
          requireCmdEnterToSend: true,
          onSave: async (prompt, images) => {
            saves.push([prompt, images?.map((saved) => saved.id)]);
            if (failures > 0) {
              failures -= 1;
              throw new Error("Disk full.");
            }
          },
          onSend: asyncNoop,
          onToast: (message) => toasts.push(message),
        }),
      ),
    );
    const field = container.querySelector("textarea")!;
    let mounted = true;
    const unmount = async () => {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
    };
    try {
      await run({
        window,
        container,
        saves,
        toasts,
        failNext: () => (failures += 1),
        press: async () => {
          await act(async () => {
            field.dispatchEvent(
              new window.KeyboardEvent("keydown", {
                key: "s",
                metaKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
          });
        },
        type: async (value) => {
          await act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
            field.dispatchEvent(new window.Event("input", { bubbles: true }));
          });
        },
        unmount,
      });
    } finally {
      await unmount();
      if (computedStyle) Object.defineProperty(globalThis, "getComputedStyle", computedStyle);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  });
}

const removeImage = async (window: DomWindow, container: HTMLElement) => {
  const remove = container.querySelector<HTMLButtonElement>('button[title="Remove image"]');
  assert.ok(remove, "the image has a remove button");
  await act(async () => {
    remove.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
};

test("⌘S in a draft retries a failed save of the text or of an image removal", async () => {
  await withDraftView(async ({ window, container, saves, toasts, failNext, press, type }) => {
    const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;
    failNext();
    await type("Draft, edited");
    await press();
    assert.equal(alertText(), "Disk full.");
    assert.deepEqual(toasts, []);
    await press();
    assert.deepEqual(
      saves.map(([prompt]) => prompt),
      ["Draft, edited", "Draft, edited"],
    );
    assert.deepEqual(toasts, ["Draft saved."]);

    // Removing the image saves at once; when that fails, ⌘S saves it again.
    failNext();
    await removeImage(window, container);
    assert.deepEqual(saves[2], ["Draft, edited", []]);
    assert.equal(alertText(), "Disk full.");
    await press();
    assert.deepEqual(saves[3], ["Draft, edited", []]);
    assert.deepEqual(toasts, ["Draft saved.", "Draft saved."]);
    await press();
    assert.equal(saves.length, 4, "nothing left to save");
  });
});

test("closing a draft after a failed image save saves the images again", async () => {
  await withDraftView(async ({ window, container, saves, failNext, unmount }) => {
    failNext();
    await removeImage(window, container);
    assert.deepEqual(saves, [["Draft", []]]);
    await unmount();
    assert.deepEqual(saves, [
      ["Draft", []],
      ["Draft", []],
    ]);
  });
});
