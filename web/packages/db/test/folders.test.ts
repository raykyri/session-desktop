import type { ResearchFolderState } from "@session/shared";
import test from "ava";

import { folders, schema, trees } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

function admit(fixture: Fixture, prompt: string): string {
  return trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: prompt },
    agent: { model: "gemini-flash" },
    status: "complete",
  }).tree.id;
}

function write(fixture: Fixture, next: Partial<ResearchFolderState>): ResearchFolderState {
  return folders.setState(fixture.db, fixture.userId, fixture.workspaceId, state(next));
}

function state(partial: Partial<ResearchFolderState>): ResearchFolderState {
  return {
    folders: [],
    membership: {},
    collapsed: [],
    parents: {},
    collapsedGroups: [],
    ...partial,
  };
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
      collapsed: ["f1", "f1", "missing"],
    }),
  );
  t.deepEqual(
    normalized.folders.map((folder) => folder.name),
    ["One", "Two"],
    "the first record of an id wins",
  );
  t.deepEqual(normalized.membership, { t1: "f1" });
  t.deepEqual(normalized.collapsed, ["f1"]);
});

test("the stored state round-trips folders, membership, and collapse", (t) => {
  const fixture = createFixture(t);
  const first = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "One" },
    agent: { model: "gemini-flash" },
  });
  const second = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Two" },
    agent: { model: "gemini-flash" },
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
      membership: { [first.tree.id]: "f1", [second.tree.id]: "f2" },
      collapsed: ["f2"],
    }),
  );
  t.deepEqual(
    stored.folders.map((folder) => folder.id),
    ["f1", "f2"],
  );
  t.deepEqual(stored.membership, { [first.tree.id]: "f1", [second.tree.id]: "f2" });
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
    }),
  );
  t.deepEqual(stored.membership, {});
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
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "One" },
    agent: { model: "gemini-flash" },
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
    "the empty folder remains",
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
    { id: "shared-id", name: "Theirs", workspaceId: other.workspaceId, trashedAt: null },
  ]);
});

test("folder names are trimmed and validated as on the desktop", (t) => {
  const fixture = createFixture(t);
  const ws = fixture.workspaceId;
  const stored = write(fixture, {
    folders: [{ id: "f1", name: "  Reading  ", workspaceId: ws }],
  });
  t.is(stored.folders[0]?.name, "Reading");
  const refusals: [string, string, RegExp][] = [
    ["f2", "   ", /^Folder names cannot be empty\.$/],
    ["f2", "x".repeat(41), /^Folder names can be at most 40 characters\.$/],
    ["f2", "Trash", /^The name "Trash" is reserved\.$/],
    ["f2", " drafts ", /^The name "drafts" is reserved\.$/],
    ["f2", "READING", /^A folder named "READING" already exists\.$/],
    ["system:mine", "Mine", /^The folder id "system:mine" is reserved\.$/],
    ["", "Mine", /^Folder ids cannot be empty\.$/],
  ];
  for (const [id, name, message] of refusals) {
    t.throws(
      () =>
        write(fixture, {
          folders: [
            { id: "f1", name: "Reading", workspaceId: ws },
            { id, name, workspaceId: ws },
          ],
        }),
      { message },
      `${id} ${name}`,
    );
  }
  // Forty code points, as the desktop counts `chars()`.
  const emoji = "\u{1F4DA}".repeat(40);
  t.is(write(fixture, { folders: [{ id: "f3", name: emoji, workspaceId: ws }] }).folders.length, 1);
  t.deepEqual(
    folders.getState(fixture.db, fixture.userId, ws).folders.map((folder) => folder.id),
    ["f3"],
    "a refused write stores nothing",
  );
});

test("a folder in the Trash does not hold its name, and cannot be restored over another", (t) => {
  const fixture = createFixture(t);
  const ws = fixture.workspaceId;
  const tree = admit(fixture, "Filed");
  write(fixture, {
    folders: [{ id: "old", name: "Reading", workspaceId: ws }],
    membership: { [tree]: "old" },
  });
  const trashed = write(fixture, {
    folders: [{ id: "old", name: "Reading", workspaceId: ws, trashedAt: 42 }],
    membership: { [tree]: "old" },
  });
  t.is(trashed.folders[0]?.trashedAt, 42);
  t.deepEqual(trashed.membership, { [tree]: "old" }, "its trees keep their membership");
  const reused = write(fixture, {
    folders: [
      { id: "old", name: "Reading", workspaceId: ws, trashedAt: 42 },
      { id: "new", name: "reading", workspaceId: ws },
    ],
    membership: { [tree]: "old" },
  });
  t.deepEqual(
    reused.folders.map((folder) => folder.id),
    ["old", "new"],
  );
  t.throws(
    () =>
      write(fixture, {
        folders: [
          { id: "old", name: "Reading", workspaceId: ws, trashedAt: null },
          { id: "new", name: "reading", workspaceId: ws },
        ],
      }),
    { message: /^A folder named "Reading" already exists\.$/ },
  );
  const restored = write(fixture, {
    folders: [
      { id: "old", name: "Reading", workspaceId: ws },
      { id: "new", name: "Other", workspaceId: ws },
    ],
    membership: { [tree]: "old" },
  });
  t.is(restored.folders[0]?.trashedAt, null);
  t.deepEqual(restored.membership, { [tree]: "old" });
});

test("Drafts membership and the system trays' collapsed flags round-trip", (t) => {
  const fixture = createFixture(t);
  const draft = admit(fixture, "Draft");
  const stored = write(fixture, {
    membership: { [draft]: "system:drafts" },
    collapsed: ["system:drafts", "system:archive", "system:unfiled", "system:other", "missing"],
  });
  t.deepEqual(stored.membership, { [draft]: "system:drafts" });
  t.deepEqual(stored.collapsed, ["system:archive", "system:drafts", "system:unfiled"]);
  const row = fixture.db
    .select()
    .from(schema.treeFolderMembership)
    .all()
    .find((membership) => membership.treeId === draft);
  t.deepEqual(row, { treeId: draft, folderId: null, systemPlace: "drafts" });
});

test("nesting is stored on the trees and kept one level deep", (t) => {
  const fixture = createFixture(t);
  const parent = admit(fixture, "Parent");
  const child = admit(fixture, "Child");
  const grandchild = admit(fixture, "Grandchild");
  const stored = write(fixture, {
    parents: {
      [child]: parent,
      [grandchild]: child,
      [parent]: parent,
      "missing-tree": parent,
    },
    collapsedGroups: [parent, parent, "missing-tree"],
  });
  t.deepEqual(stored.parents, { [child]: parent }, "the deeper link and the self link go");
  t.deepEqual(stored.collapsedGroups, [parent]);
  const rows = fixture.db.select().from(schema.trees).all();
  t.is(rows.find((row) => row.id === child)?.parentTreeId, parent);
  t.is(rows.find((row) => row.id === grandchild)?.parentTreeId, null);

  const flat = write(fixture, { parents: { [child]: parent, [grandchild]: parent } });
  t.deepEqual(flat.parents, { [child]: parent, [grandchild]: parent });
  t.deepEqual(flat.collapsedGroups, []);
});

test("a tree of another workspace cannot be nested", (t) => {
  const fixture = createFixture(t);
  const stranger = addUser(fixture.db, "nest-stranger");
  const mine = admit(fixture, "Mine");
  const theirs = trees.admitRoot(fixture.db, stranger.userId, {
    type: "post",
    workspaceId: stranger.workspaceId,
    message: { text: "Theirs" },
    agent: { model: "gemini-flash" },
  }).tree.id;
  const stored = write(fixture, { parents: { [mine]: theirs, [theirs]: mine } });
  t.deepEqual(stored.parents, {});
  t.deepEqual(folders.getState(fixture.db, stranger.userId, stranger.workspaceId).parents, {});
});

test("posts and documents can be parents", (t) => {
  const fixture = createFixture(t);
  const post = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "A note" },
    agent: { model: "gemini-flash" },
  }).tree.id;
  const document = trees.admitRoot(fixture.db, fixture.userId, {
    type: "document",
    source: "authored",
    workspaceId: fixture.workspaceId,
    agent: { model: "gemini-flash" },
    title: "Notes",
  }).tree.id;
  const question = admit(fixture, "Question");
  const another = admit(fixture, "Another");
  const stored = write(fixture, { parents: { [question]: post, [another]: document } });
  t.deepEqual(stored.parents, { [question]: post, [another]: document });
});

test("filing a child in another place moves it out of its group", (t) => {
  const fixture = createFixture(t);
  const ws = fixture.workspaceId;
  const parent = admit(fixture, "Parent");
  const child = admit(fixture, "Child");
  const folder = { id: "f1", name: "Reading", workspaceId: ws };
  // Nesting files the child where its parent is (Unfiled here).
  write(fixture, { folders: [folder], parents: { [child]: parent } });
  // Moving the parent with its child keeps the group.
  const moved = write(fixture, {
    folders: [folder],
    membership: { [parent]: "f1", [child]: "f1" },
    parents: { [child]: parent },
  });
  t.deepEqual(moved.parents, { [child]: parent });
  // Filing the child alone elsewhere moves it out.
  const filed = write(fixture, {
    folders: [folder],
    membership: { [parent]: "f1", [child]: "system:drafts" },
    parents: { [child]: parent },
  });
  t.deepEqual(filed.parents, {});
  t.deepEqual(filed.membership, { [parent]: "f1", [child]: "system:drafts" });
  // Nesting again sets the child's membership to its parent's in the same write.
  const nested = write(fixture, {
    folders: [folder],
    membership: { [parent]: "f1", [child]: "f1" },
    parents: { [child]: parent },
  });
  t.deepEqual(nested.parents, { [child]: parent });
});

test("collapsed trays and groups are per person", (t) => {
  const fixture = createFixture(t);
  const other = addUser(fixture.db, "collapse-other");
  const parent = admit(fixture, "Parent");
  const child = admit(fixture, "Child");
  // Rows another person holds for the same workspace and tree (as a member
  // will from phase 5).
  fixture.db
    .insert(schema.collapsedPlaces)
    .values({ userId: other.userId, workspaceId: fixture.workspaceId, placeId: "system:drafts" })
    .run();
  fixture.db.insert(schema.collapsedGroups).values({ userId: other.userId, treeId: parent }).run();

  const stored = write(fixture, {
    collapsed: ["system:archive"],
    parents: { [child]: parent },
    collapsedGroups: [],
  });
  t.deepEqual(stored.collapsed, ["system:archive"]);
  t.deepEqual(stored.collapsedGroups, []);
  const theirPlaces = fixture.db
    .select()
    .from(schema.collapsedPlaces)
    .all()
    .filter((row) => row.userId === other.userId);
  t.deepEqual(
    theirPlaces.map((row) => row.placeId),
    ["system:drafts"],
    "the other person's collapsed tray is untouched",
  );
  const theirGroups = fixture.db
    .select()
    .from(schema.collapsedGroups)
    .all()
    .filter((row) => row.userId === other.userId);
  t.is(theirGroups.length, 1, "the other person's collapsed group is untouched");
});

test("a write that stores the same state reports no change", (t) => {
  const fixture = createFixture(t);
  const tree = admit(fixture, "Tree");
  const next = state({
    folders: [{ id: "f1", name: "Reading", workspaceId: fixture.workspaceId }],
    membership: { [tree]: "f1" },
    collapsed: ["f1"],
  });
  t.true(folders.replaceState(fixture.db, fixture.userId, fixture.workspaceId, next).changed);
  t.false(folders.replaceState(fixture.db, fixture.userId, fixture.workspaceId, next).changed);
});

test("normalization keeps nesting one level deep", (t) => {
  const normalized = folders.normalizeFolderState(
    state({
      parents: { a: "b", b: "c", d: "d", e: "c" },
      collapsedGroups: ["c", "c"],
    }),
  );
  t.deepEqual(normalized.parents, { b: "c", e: "c" });
  t.deepEqual(normalized.collapsedGroups, ["c"]);
});
