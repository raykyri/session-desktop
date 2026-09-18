import type { ResearchFolderState } from "@session/shared";
import test from "ava";

import { folders, trees } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function state(partial: Partial<ResearchFolderState>): ResearchFolderState {
  return { folders: [], membership: {}, starred: [], collapsed: [], ...partial };
}

test("normalization dedupes folders and drops entries naming absent folders", (t) => {
  const normalized = folders.normalizeFolderState(
    state({
      folders: [
        { id: "f1", name: "One", workspaceId: "w" },
        { id: "f1", name: "Duplicate", workspaceId: "w" },
        { id: "f2", name: "Two", workspaceId: "w" },
      ],
      membership: { t1: "f1", t2: "missing" },
      starred: ["t1", "t1", "f2"],
      collapsed: ["f1", "f1", "missing"],
    }),
  );
  t.deepEqual(
    normalized.folders.map((folder) => folder.name),
    ["One", "Two"],
    "the first record of an id wins",
  );
  t.deepEqual(normalized.membership, { t1: "f1" });
  t.deepEqual(normalized.starred, ["t1", "f2"]);
  t.deepEqual(normalized.collapsed, ["f1"]);
});

test("normalization does not prune stars by tree existence", (t) => {
  const normalized = folders.normalizeFolderState(state({ starred: ["a-tree-we-cannot-see"] }));
  t.deepEqual(normalized.starred, ["a-tree-we-cannot-see"]);
});

test("the stored state round-trips folders, membership, stars, and collapse", (t) => {
  const fixture = createFixture(t);
  const first = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "One",
    model: "gemini-flash",
  });
  const second = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "Two",
    model: "gemini-flash",
  });
  const stored = folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({
      folders: [
        { id: "f1", name: "Reading", workspaceId: fixture.workspaceId },
        { id: "f2", name: "Later", workspaceId: fixture.workspaceId },
      ],
      membership: { [first.tree.id]: "f1" },
      // An interleaving of a tree and a folder, which is why `starred` is a
      // rank rather than a flag.
      starred: [second.tree.id, "f2", first.tree.id],
      collapsed: ["f2"],
    }),
  );
  t.deepEqual(
    stored.folders.map((folder) => folder.id),
    ["f1", "f2"],
  );
  t.deepEqual(stored.membership, { [first.tree.id]: "f1" });
  t.deepEqual(stored.starred, [second.tree.id, "f2", first.tree.id]);
  t.deepEqual(stored.collapsed, ["f2"]);
  t.deepEqual(folders.getState(fixture.db, fixture.userId, fixture.workspaceId), stored);
});

test("entries naming a tree the workspace does not have are dropped", (t) => {
  const fixture = createFixture(t);
  const stored = folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({
      folders: [{ id: "f1", name: "Reading", workspaceId: fixture.workspaceId }],
      membership: { "tree-that-does-not-exist": "f1" },
      starred: ["tree-that-does-not-exist", "f1"],
    }),
  );
  t.deepEqual(stored.membership, {});
  t.deepEqual(stored.starred, ["f1"]);
});

test("a later write replaces the earlier one", (t) => {
  const fixture = createFixture(t);
  folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({ folders: [{ id: "f1", name: "Reading", workspaceId: fixture.workspaceId }] }),
  );
  const replaced = folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({ folders: [{ id: "f2", name: "Later", workspaceId: fixture.workspaceId }] }),
  );
  t.deepEqual(
    replaced.folders.map((folder) => folder.id),
    ["f2"],
  );
});

test("deleting a tree takes its membership with it", (t) => {
  const fixture = createFixture(t);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt: "One",
    model: "gemini-flash",
    status: "complete",
  });
  folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({
      folders: [{ id: "f1", name: "Reading", workspaceId: fixture.workspaceId }],
      membership: { [detail.tree.id]: "f1" },
    }),
  );
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  const after = folders.getState(fixture.db, fixture.userId, fixture.workspaceId);
  t.deepEqual(after.membership, {});
  t.deepEqual(
    after.folders.map((folder) => folder.id),
    ["f1"],
    "the empty folder survives",
  );
});

test("a folder id already owned elsewhere is not taken over", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "folders-other");
  folders.setState(
    fixture.db,
    other.userId,
    other.workspaceId,
    state({ folders: [{ id: "shared-id", name: "Theirs", workspaceId: other.workspaceId }] }),
  );
  const stored = folders.setState(
    fixture.db,
    fixture.userId,
    fixture.workspaceId,
    state({ folders: [{ id: "shared-id", name: "Mine", workspaceId: fixture.workspaceId }] }),
  );
  t.deepEqual(stored.folders, []);
  t.deepEqual(folders.getState(fixture.db, other.userId, other.workspaceId).folders, [
    { id: "shared-id", name: "Theirs", workspaceId: other.workspaceId },
  ]);
});
