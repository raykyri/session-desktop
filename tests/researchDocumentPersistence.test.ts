import assert from "node:assert/strict";
import test from "node:test";
import {
  createResearchComposerDraftRestoration,
  createResearchDocumentPersistence,
} from "../src/lib/researchDocumentPersistence";
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
  const owner = createResearchDocumentPersistence(store, () => {
    writes++;
  });
  owner.recordScroll("a", "node-a", 150);
  owner.recordDraft("a", "ordinary", "branch");
  owner.recordAsk("b", "node-b", anchor, "targeted");
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
  const owner = createResearchDocumentPersistence(store, () =>
    saved.push(JSON.stringify(store)),
  );
  owner.recordDraft("tree", "last keystroke", "thread");
  owner.flush();
  assert.equal(JSON.parse(saved[0]).tree.followupDraft.text, "last keystroke");
  t.mock.timers.tick(1_000);
  assert.equal(saved.length, 1);
});

test("tree restoration blocks transitional clears and outgoing text, then permits edits", () => {
  const store: Record<string, SavedResearchNavigation> = {
    a: {
      scrollByNode: {},
      followupDraft: { text: "first", mode: "branch", updatedAt: 1 },
    },
    b: {
      scrollByNode: {},
      followupDraft: { text: "second", mode: "thread", updatedAt: 2 },
    },
  };
  const restore = createResearchComposerDraftRestoration(store);
  assert.deepEqual(restore.restore("a"), { text: "first", mode: "branch" });
  assert.equal(restore.canPersist("a", "", "thread"), false);
  assert.equal(restore.canPersist("a", "first", "branch"), true);
  assert.deepEqual(restore.restore("b"), { text: "second", mode: "thread" });
  assert.equal(restore.canPersist("b", "first", "branch"), false);
  assert.equal(restore.canPersist("b", "second", "thread"), true);
  assert.equal(restore.canPersist("b", "edited", "branch"), true);
  assert.deepEqual(restore.restore(null), { text: "", mode: "thread" });
  assert.equal(store.a.followupDraft?.text, "first");
});

test("targeted restoration releases the ordinary guard for edits after dismissing the ask", () => {
  const store: Record<string, SavedResearchNavigation> = {};
  const restore = createResearchComposerDraftRestoration(store);
  restore.restore("tree");
  assert.equal(restore.canPersist("tree", "targeted text", "thread"), false);
  restore.finish();
  assert.equal(restore.canPersist("tree", "ordinary text after dismissal", "thread"), true);
});

test("clearing a draft or explicitly dismissing an ask cannot resurrect it after flush", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  let saved = "";
  const owner = createResearchDocumentPersistence(store, () => {
    saved = JSON.stringify(store);
  });
  owner.recordDraft("tree", "sent", "branch");
  owner.recordAsk("tree", "node", anchor, "ask");
  owner.recordDraft("tree", "", "branch");
  owner.clearAsk("tree", "node");
  assert.equal(JSON.parse(saved).tree.followupDraft, undefined);
  assert.deepEqual(JSON.parse(saved).tree.askByNode, {});
  t.mock.timers.tick(1_000);
  assert.equal(store.tree.followupDraft, undefined);
});
