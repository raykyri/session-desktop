import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchDraftView from "../src/components/research/ResearchDraftView";
import { ResearchFeedToast } from "../src/components/research/ResearchFeedChrome";
import { researchCardRefocus } from "../src/components/research/ResearchFeedPost";
import { createResearchDraftAutosave } from "../src/lib/researchDraftAutosave";

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
  assert.match(html, /aria-label="Go to the ask box"/);
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
