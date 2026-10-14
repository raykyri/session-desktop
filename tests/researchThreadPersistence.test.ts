import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchComposerDraftRestoration,
  createResearchThreadPersistence,
} from "../src/lib/researchThreadPersistence";
import type { SavedResearchNavigation } from "../src/lib/researchNavigation";
import type { ResearchHighlightAnchor } from "../src/types";

const anchor: ResearchHighlightAnchor = {
  version: 1,
  projection: "answer-v1",
  responseRevision: "revision",
  start: 0,
  end: 4,
  exact: "text",
  prefix: "",
  suffix: "",
};

test("scroll and both composers mutate immediately and share one durable debounce", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  let writes = 0;
  const owner = createResearchThreadPersistence(store, () => {
    writes++;
  });
  owner.recordScroll("a", "node-a", 150);
  owner.recordDraft("a", "ordinary");
  owner.recordPendingBranch("b", "node-b", anchor, "targeted");
  assert.equal(store.a.scrollByNode["node-a"].top, 150);
  assert.equal(store.a.followupDraft?.text, "ordinary");
  assert.equal(store.b.askByNode?.["node-b"].text, "targeted");
  assert.equal(writes, 0);
  t.mock.timers.tick(250);
  assert.equal(writes, 1);
});

test("final flush saves pending edits once and cancels the delayed callback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  const saved: string[] = [];
  const owner = createResearchThreadPersistence(store, () =>
    saved.push(JSON.stringify(store)),
  );
  owner.recordDraft("tree", "last keystroke");
  owner.flush();
  assert.equal(JSON.parse(saved[0]).tree.followupDraft.text, "last keystroke");
  t.mock.timers.tick(1_000);
  assert.equal(saved.length, 1);
});

test("tree restoration blocks transitional clears and outgoing text, then permits edits", () => {
  const store: Record<string, SavedResearchNavigation> = {
    a: {
      scrollByNode: {},
      followupDraft: { text: "first", updatedAt: 1 },
    },
    b: {
      scrollByNode: {},
      followupDraft: { text: "second", updatedAt: 2 },
    },
  };
  const restore = createResearchComposerDraftRestoration(store);
  assert.equal(restore.restore("a"), "first");
  assert.equal(restore.canPersist("a", ""), false);
  assert.equal(restore.canPersist("a", "first"), true);
  assert.equal(restore.restore("b"), "second");
  assert.equal(restore.canPersist("b", "first"), false);
  assert.equal(restore.canPersist("b", "second"), true);
  assert.equal(restore.canPersist("b", "edited"), true);
  assert.equal(restore.restore(null), "");
  assert.equal(store.a.followupDraft?.text, "first");
});

test("a tree without a saved draft releases the guard once the composer is empty", () => {
  const store: Record<string, SavedResearchNavigation> = {};
  const restore = createResearchComposerDraftRestoration(store);
  assert.equal(restore.restore("tree"), "");
  assert.equal(restore.canPersist("tree", "outgoing tree's text"), false);
  assert.equal(restore.canPersist("tree", ""), true);
  assert.equal(restore.canPersist("tree", "typed after restoring"), true);
});

test("clearing a draft or dismissing a pending branch prevents restoration after flush", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  let saved = "";
  const owner = createResearchThreadPersistence(store, () => {
    saved = JSON.stringify(store);
  });
  owner.recordDraft("tree", "sent");
  owner.recordPendingBranch("tree", "node", anchor, "ask");
  owner.recordDraft("tree", "");
  owner.clearPendingBranch("tree", "node");
  assert.equal(JSON.parse(saved).tree.followupDraft, undefined);
  assert.deepEqual(JSON.parse(saved).tree.askByNode, {});
  t.mock.timers.tick(1_000);
  assert.equal(store.tree.followupDraft, undefined);
});
