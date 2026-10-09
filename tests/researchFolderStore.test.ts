import assert from "node:assert/strict";
import test from "node:test";
import { createResearchFolderStore } from "../src/lib/researchFolderStore";
import {
  emptyResearchFolderState,
  researchFolderStateWithCollapsed,
} from "../src/lib/researchFolders";
import type { ResearchFolderState } from "../src/types";

/** A promise the test can resolve or reject to simulate a backend response. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const stored = (folderName: string): ResearchFolderState => ({
  ...emptyResearchFolderState(),
  folders: [{ id: `f-${folderName}`, name: folderName, workspaceId: "ws" }],
});

function harness() {
  const lists: ReturnType<typeof deferred<ResearchFolderState>>[] = [];
  const saves: { state: ResearchFolderState; reply: ReturnType<typeof deferred<ResearchFolderState>> }[] =
    [];
  const states: ResearchFolderState[] = [];
  const loadErrors: (string | null)[] = [];
  const store = createResearchFolderStore({
    list: () => {
      const reply = deferred<ResearchFolderState>();
      lists.push(reply);
      return reply.promise;
    },
    save: (state) => {
      const reply = deferred<ResearchFolderState>();
      saves.push({ state, reply });
      return reply.promise;
    },
    onState: (state) => states.push(state),
    onLoadError: (message) => loadErrors.push(message),
  });
  return { store, lists, saves, states, loadErrors };
}

const collapse = (place: string) => (state: ResearchFolderState) =>
  researchFolderStateWithCollapsed(state, place, true);

test("a change waits for the stored folders, so it never replaces folders not yet read", async () => {
  const { store, lists, saves } = harness();
  const committed = store.commit(collapse("f-Later"));
  await flush();
  assert.equal(lists.length, 1);
  assert.equal(saves.length, 0, "nothing is written before the load");
  lists[0].resolve(stored("Later"));
  await flush();
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].state.folders.map((folder) => folder.name), ["Later"]);
  assert.deepEqual(saves[0].state.collapsed, ["f-Later"]);
  saves[0].reply.resolve(saves[0].state);
  await committed;
});

test("a failed load rejects the change, reports it, and the next change loads again", async () => {
  const { store, lists, saves, loadErrors } = harness();
  const first = store.commit(collapse("a"));
  lists[0].reject("disk unreadable");
  await assert.rejects(first, /Folders couldn't be loaded, so the change wasn't saved\. disk unreadable/);
  assert.equal(saves.length, 0);
  assert.deepEqual(loadErrors, ["disk unreadable"]);

  const second = store.commit(collapse("b"));
  assert.equal(lists.length, 2, "the load is retried");
  lists[1].resolve(stored("Later"));
  await flush();
  assert.deepEqual(loadErrors, ["disk unreadable", null]);
  saves[0].reply.resolve(saves[0].state);
  await second;
  assert.deepEqual(store.getState().collapsed, ["b"]);
});

test("writes go out in order, and a rejected write restores the state it replaced", async () => {
  const { store, lists, saves } = harness();
  void store.load();
  lists[0].resolve(emptyResearchFolderState());
  await flush();

  const first = store.commit(collapse("a"));
  const second = store.commit(collapse("b"));
  await flush();
  assert.equal(saves.length, 1, "the second write waits for the first");
  assert.deepEqual(store.getState().collapsed, ["a", "b"], "both apply locally at once");

  saves[0].reply.reject("write failed");
  await assert.rejects(first, /write failed/);
  // The second change superseded the first, so the rollback doesn't apply.
  assert.deepEqual(store.getState().collapsed, ["a", "b"]);
  await flush();
  assert.equal(saves.length, 2);
  saves[1].reply.reject("still failing");
  await assert.rejects(second, /still failing/);
  assert.deepEqual(store.getState().collapsed, ["a"], "the latest write rolls back to its own previous state");
});

test("refresh waits for this window's writes and discards results after a concurrent change", async () => {
  const { store, lists, saves } = harness();
  void store.load();
  lists[0].resolve(emptyResearchFolderState());
  await flush();

  const write = store.commit(collapse("a"));
  await flush();
  const refreshed = store.refresh();
  await flush();
  assert.equal(lists.length, 1, "refresh doesn't read while a write is pending");
  saves[0].reply.resolve(saves[0].state);
  await write;
  await flush();
  assert.equal(lists.length, 2);
  lists[1].resolve(stored("From another window"));
  await refreshed;
  assert.deepEqual(store.getState().folders.map((folder) => folder.name), ["From another window"]);

  // A local change during the refresh invalidates the fetched state.
  const stale = store.refresh();
  await flush();
  const change = store.commit(collapse("mine"));
  await flush();
  lists[2].resolve(stored("Stale"));
  await stale;
  assert.deepEqual(store.getState().folders.map((folder) => folder.name), ["From another window"]);
  assert.deepEqual(store.getState().collapsed, ["mine"]);
  saves[1].reply.resolve(saves[1].state);
  await change;
});

test("a successful refresh after a failed load allows writes without another load", async () => {
  const { store, lists, saves, loadErrors } = harness();
  void store.load().catch(() => undefined);
  lists[0].reject("busy");
  await flush();
  const refreshed = store.refresh();
  await flush();
  lists[1].resolve(stored("Later"));
  await refreshed;
  assert.deepEqual(loadErrors, ["busy", null]);
  const change = store.commit(collapse("f-Later"));
  await flush();
  assert.equal(lists.length, 2);
  assert.equal(saves.length, 1);
  saves[0].reply.resolve(saves[0].state);
  await change;
});
