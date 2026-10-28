import assert from "node:assert/strict";
import test from "node:test";
import {
  pruneResearchNavigationNodes,
  researchNavigationStore,
  savedResearchChainDrafts,
  saveResearchNavigation,
  type SavedResearchNavigation,
} from "../src/lib/researchNavigation";
import { createResearchThreadPersistence, subscribeResearchDraftSubmitted } from "../src/lib/researchThreadPersistence";

test("branch drafts load from disk, survive a range remount, and clear after sending", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const disk = new Map<string, string>([["session.research-navigation.v1", JSON.stringify({
    tree: {
      scrollByNode: {},
      followupDraft: { text: "Root draft", updatedAt: 1 },
      chainDrafts: { branch: "Saved branch", sibling: "Other branch", bad: 123, empty: "" },
      composerEditingByHead: { branch: "failed", bad: 123 },
    },
  })]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => disk.get(key) ?? null,
    setItem: (key: string, value: string) => disk.set(key, value),
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const persistence = createResearchThreadPersistence();
  const initial = savedResearchChainDrafts("tree");
  assert.deepEqual(initial, { branch: "Saved branch", sibling: "Other branch" });
  assert.deepEqual(researchNavigationStore().tree.composerEditingByHead, { branch: "failed" });
  initial.branch = "Last typed text";
  assert.equal(savedResearchChainDrafts("tree").branch, "Saved branch", "React state must not mutate the store");
  persistence.recordChainDraft("tree", "branch", initial.branch);
  persistence.flush(); // The thread page unmounts into the range.
  assert.equal(savedResearchChainDrafts("tree").branch, "Last typed text");
  assert.equal(JSON.parse(disk.get("session.research-navigation.v1")!).tree.chainDrafts.branch, "Last typed text");
  assert.equal(researchNavigationStore().tree.followupDraft?.text, "Root draft");
  // Successful submission can finish while the original page is unmounted.
  persistence.clearSubmittedDraft("tree", "branch", "Last typed text", false);
  assert.deepEqual(savedResearchChainDrafts("tree"), { sibling: "Other branch" });
  assert.deepEqual(researchNavigationStore().tree.composerEditingByHead, {});
  pruneResearchNavigationNodes("tree", ["root"]);
  assert.deepEqual(savedResearchChainDrafts("tree"), {});
  saveResearchNavigation();
  assert.deepEqual(JSON.parse(disk.get("session.research-navigation.v1")!).tree.chainDrafts, {});
});

test("branch drafts remain isolated by tree and clearing one preserves the others", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  let writes = 0;
  const persistence = createResearchThreadPersistence(store, () => writes++);
  persistence.recordChainDraft("a", "branch", "first tree");
  persistence.recordChainDraft("b", "branch", "second tree");
  persistence.recordChainDraft("a", "sibling", "sibling text");
  persistence.recordChainDraft("a", "branch", "");
  persistence.flush();
  assert.deepEqual(store.a.chainDrafts, { sibling: "sibling text" });
  assert.deepEqual(store.b.chainDrafts, { branch: "second tree" });
  assert.equal(writes, 1);
  persistence.recordChainDraft("a", "sibling", "sibling text");
  t.mock.timers.tick(1000);
  assert.equal(writes, 1, "unchanged drafts do not schedule writes");
});

test("a late submission clears only its own draft and informs the remounted composer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store: Record<string, SavedResearchNavigation> = {};
  const oldPage = createResearchThreadPersistence(store, () => {});
  oldPage.recordChainDraft("tree", "branch", "  submitted text  ");
  oldPage.recordComposerEditing("tree", { branch: "failed" });
  oldPage.flush();
  const newPage = createResearchThreadPersistence(store, () => {});
  let mountedText = store.tree.chainDrafts!.branch;
  const unsubscribe = subscribeResearchDraftSubmitted((draft) => {
    if (draft.treeId === "tree" && draft.headId === "branch" && mountedText === draft.text) mountedText = "";
  });
  t.after(unsubscribe);
  oldPage.clearSubmittedDraft("tree", "branch", "  submitted text  ", false);
  assert.equal(mountedText, "", "sent text cannot be persisted again by the remount");
  assert.equal(store.tree.chainDrafts, undefined);
  assert.deepEqual(store.tree.composerEditingByHead, {});

  // A second send returns after the remounted user has written newer text.
  newPage.recordChainDraft("tree", "branch", "New draft");
  mountedText = "New draft";
  newPage.recordComposerEditing("tree", { branch: "another-failed" });
  oldPage.clearSubmittedDraft("tree", "branch", "  submitted text  ", false);
  assert.equal(mountedText, "New draft");
  assert.equal((store.tree as SavedResearchNavigation).chainDrafts?.branch, "New draft");
  assert.deepEqual(store.tree.composerEditingByHead, { branch: "another-failed" });
  newPage.flush();
});

test("completion removes sent images while retaining attachments added after remount", () => {
  const image = (id: string) => ({ kind: "image" as const, id, mimeType: "image/png", byteSize: 100 });
  const store: Record<string, SavedResearchNavigation> = {
    tree: { scrollByNode: {}, chainDrafts: { branch: "New text" }, composerImages: {
      images: { branch: [image("sent"), image("new")], sibling: [image("other")] }, updatedAt: Date.now(),
    } },
  };
  const persistence = createResearchThreadPersistence(store, () => {});
  let mountedImages = [image("sent"), image("new")];
  const unsubscribe = subscribeResearchDraftSubmitted((draft) => {
    mountedImages = mountedImages.filter((item) => !draft.imageIds.includes(item.id));
  });
  try {
    persistence.clearSubmittedDraft("tree", "branch", "Old text", false, ["sent"]);
    assert.deepEqual(mountedImages.map((item) => item.id), ["new"]);
    assert.deepEqual(store.tree.composerImages?.images.branch.map((item) => item.id), ["new"]);
    assert.deepEqual(store.tree.composerImages?.images.sibling.map((item) => item.id), ["other"]);
    assert.equal(store.tree.chainDrafts?.branch, "New text");
  } finally {
    unsubscribe();
  }
});
