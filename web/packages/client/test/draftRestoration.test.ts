import test from "ava";

import { restoreServerDraft, useDraftsStore } from "../src/stores/drafts.js";

test("a server draft restores text, model and attachments without replacing a newer local draft", (t) => {
  const key = "home:restore";
  const remote = {
    text: "server question",
    model: "gemini-flash",
    documentIds: ["d1"],
    updatedAt: 10,
  };
  t.deepEqual(restoreServerDraft(key, JSON.stringify(remote)), remote);
  t.deepEqual(useDraftsStore.getState().get(key), remote);
  t.is(restoreServerDraft(key, JSON.stringify({ ...remote, text: "older", updatedAt: 1 })), null);
});

test("pending reads cannot overwrite edits or resurrect a cleared draft", (t) => {
  const state = useDraftsStore.getState();
  state.setDraft("home:editing", { text: "current edit" });
  const remote = JSON.stringify({ text: "remote", updatedAt: Date.now() + 10_000 });
  t.is(restoreServerDraft("home:editing", remote), null);
  t.is(state.get("home:editing")?.text, "current edit");
  state.clearDraft("home:cleared");
  t.is(restoreServerDraft("home:cleared", remote), null);
  t.is(state.get("home:cleared"), undefined);
});

test("invalid server drafts are ignored", (t) => {
  for (const value of [
    "broken",
    "null",
    "{}",
    JSON.stringify({ text: "x", updatedAt: 1, documentIds: [42] }),
  ]) {
    t.is(restoreServerDraft("home:invalid", value), null);
  }
});
