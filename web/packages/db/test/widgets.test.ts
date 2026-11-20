// Widget revisions and saved inputs (`repos/widgets.ts`), after the desktop's
// `research_artifacts.rs` tests.

import { createHash } from "node:crypto";

import test from "ava";

import type { SessionDatabase } from "../src/index.js";
import { deletion, trees, widgets } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

function thread(fixture: ReturnType<typeof createFixture>) {
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "Question" },
    agent: { model: "gemini-flash" },
  });
  return { treeId: detail.tree.id, nodeId: detail.tree.rootNodeId };
}

function input(
  owner: { treeId: string; nodeId: string },
  html: string,
  parentRevision?: string,
  extra: Partial<widgets.ArtifactInput> = {},
): widgets.ArtifactInput {
  return {
    ...owner,
    slot: "0",
    artifactId: "chart",
    title: "Chart",
    html,
    ...(parentRevision === undefined ? {} : { parentRevision }),
    ...extra,
  };
}

function revisionOf(db: SessionDatabase, owner: { treeId: string; nodeId: string }, html: string) {
  return widgets.register(db, input(owner, html)).revision;
}

test("revisions are immutable and branches keep their parent", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const root = widgets.register(fixture.db, input(owner, "root"));
  t.is(root.revision.length, 64);
  t.is(root.parentRevision, null);
  t.false(root.unresolvedParent);
  widgets.register(fixture.db, input(owner, "left", root.revision));
  widgets.register(fixture.db, input(owner, "right", root.revision));
  const changed = widgets.register(
    fixture.db,
    input(owner, "root", undefined, { title: "changed" }),
  );
  t.is(changed.title, "Chart");
  t.is(changed.revision, root.revision);
  const history = widgets.history(fixture.db, owner.treeId, "chart");
  t.is(history.length, 3);
  t.is(history[0]!.revision, root.revision, "the root comes first");
  t.is(history.filter((entry) => entry.parentRevision === root.revision).length, 2);
  t.true(history.every((entry) => !entry.unresolvedParent));
  t.deepEqual(widgets.history(fixture.db, owner.treeId, "other"), []);
});

test("an unresolvable parent registers as a root and resolves when the parent arrives", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const invented = "a".repeat(64);
  const orphan = widgets.register(fixture.db, input(owner, "orphan", invented));
  t.true(orphan.unresolvedParent);
  t.is(orphan.parentRevision, invented);
  for (const malformed of ["not-a-hash", "A".repeat(64), ""]) {
    const revision = widgets.register(
      fixture.db,
      input(owner, `malformed ${malformed}`, malformed),
    );
    t.true(revision.unresolvedParent);
    t.is(revision.parentRevision, null);
  }
  // The parent's revision id depends only on its identity, node, source and
  // parent (the desktop's rule), so a child can name it before it is stored.
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const parentRevision = sha256(JSON.stringify(["chart", owner.nodeId, sha256("parent"), null]));
  const child = widgets.register(fixture.db, input(owner, "child", parentRevision));
  t.true(child.unresolvedParent, "the parent is not stored yet");
  widgets.register(fixture.db, input(owner, "parent"));
  const after = widgets.history(fixture.db, owner.treeId, "chart");
  const childIndex = after.findIndex((entry) => entry.revision === child.revision);
  const parentIndex = after.findIndex((entry) => entry.revision === parentRevision);
  t.false(after[childIndex]!.unresolvedParent);
  t.true(parentIndex < childIndex, "lineage order puts the parent first");
  // Saved inputs work on a revision with an unresolved parent; copying from
  // the parent is refused.
  const reference = { treeId: owner.treeId, artifactId: "chart", revision: orphan.revision };
  widgets.updateState(fixture.db, fixture.userId, reference, "enable", null);
  t.throws(() => widgets.updateState(fixture.db, fixture.userId, reference, "migrate", null));
});

test("titles, ids and line endings are normalised", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const a = widgets.register(
    fixture.db,
    input(owner, "<p>a</p>\r\n<p>b</p>", undefined, {
      title: `Line one\nLine\ttwo ${"x".repeat(200)}`,
    }),
  );
  const b = widgets.register(fixture.db, input(owner, "<p>a</p>\n<p>b</p>"));
  t.is(a.revision, b.revision);
  t.false(a.html.includes("\r"));
  t.true(a.title.startsWith("Line one Line two x"));
  t.is([...a.title].length, 120);
  t.true(
    widgets
      .register(fixture.db, input(owner, "x", undefined, { artifactId: "-bad id" }))
      .artifactId.startsWith("legacy-"),
  );
  const legacy = (slot: string) =>
    widgets.register(fixture.db, input(owner, "legacy", undefined, { artifactId: undefined, slot }))
      .artifactId;
  t.is(legacy("item-1:0:0"), legacy("item-3:2:40"));
  t.is(
    widgets.register(fixture.db, input(owner, "untitled", undefined, { title: " \n " })).title,
    "Answer widget",
  );
  t.throws(() => widgets.register(fixture.db, input(owner, "x".repeat(64 * 1024 + 1))), {
    message: "invalid artifact source or owner",
  });
});

test("reverting and unchanged results are new revisions", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const a = widgets.register(fixture.db, input(owner, "a"));
  const b = widgets.register(fixture.db, input(owner, "b", a.revision));
  const revert = widgets.register(fixture.db, input(owner, "a", b.revision));
  const unchanged = widgets.register(fixture.db, input(owner, "a", revert.revision));
  t.is(a.contentHash, revert.contentHash);
  t.not(a.revision, revert.revision);
  t.not(unchanged.revision, revert.revision);
  t.deepEqual(
    widgets.history(fixture.db, owner.treeId, "chart").map((entry) => entry.revision),
    [a.revision, b.revision, revert.revision, unchanged.revision],
  );
});

test("saved inputs follow the desktop's actions", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const parent = widgets.register(fixture.db, input(owner, "parent"));
  const child = widgets.register(fixture.db, input(owner, "child", parent.revision));
  const ref = (revision: string) => ({ treeId: owner.treeId, artifactId: "chart", revision });
  const update = (
    revision: string,
    action: Parameters<typeof widgets.updateState>[3],
    value: unknown = null,
  ) => widgets.updateState(fixture.db, fixture.userId, ref(revision), action, value);

  t.deepEqual(widgets.getState(fixture.db, fixture.userId, ref(parent.revision)), {
    enabled: false,
    value: null,
  });
  t.throws(() => update(parent.revision, "save", { v: 1 }), {
    message: "remembering inputs is disabled",
  });
  t.deepEqual(update(parent.revision, "enable"), { enabled: true, value: null });
  t.deepEqual(update(parent.revision, "save", { v: 1, x: [1, 2] }), {
    enabled: true,
    value: { v: 1, x: [1, 2] },
  });
  t.deepEqual(widgets.getState(fixture.db, fixture.userId, ref(parent.revision)), {
    enabled: true,
    value: { v: 1, x: [1, 2] },
  });
  t.throws(() => update(child.revision, "migrate"), {
    message: "enable remembering inputs before copying parent state",
  });
  update(child.revision, "enable");
  t.deepEqual(update(child.revision, "migrate"), { enabled: true, value: { v: 1, x: [1, 2] } });
  t.deepEqual(update(child.revision, "reset"), { enabled: true, value: null });
  t.deepEqual(update(parent.revision, "disable"), { enabled: false, value: null });
  t.throws(() => update(child.revision, "migrate"), { message: "the parent has no saved inputs" });
  update(parent.revision, "enable");
  t.throws(() => update(parent.revision, "migrate"), { message: "this revision has no parent" });
  t.throws(() => update(parent.revision, "save", "é".repeat(9000)), {
    message: "saved inputs exceed the 16 KiB limit",
  });
  t.throws(() => update(parent.revision, "save", { bad: Number.NaN }));
  t.throws(() => update("b".repeat(64), "enable"), { message: "widget revision was not found" });
  t.throws(() => widgets.getState(fixture.db, fixture.userId, ref("b".repeat(64))), {
    message: "widget revision was not found",
  });
});

test("saved inputs are per person", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const other = addUser(fixture.db, "reader");
  const revision = revisionOf(fixture.db, owner, "<p>x</p>");
  const ref = { treeId: owner.treeId, artifactId: "chart", revision };
  widgets.updateState(fixture.db, fixture.userId, ref, "enable", null);
  widgets.updateState(fixture.db, fixture.userId, ref, "save", { mine: true });
  t.deepEqual(widgets.getState(fixture.db, other.userId, ref), { enabled: false, value: null });
  widgets.updateState(fixture.db, other.userId, ref, "enable", null);
  widgets.updateState(fixture.db, other.userId, ref, "save", { theirs: true });
  t.deepEqual(widgets.getState(fixture.db, fixture.userId, ref).value, { mine: true });
  t.deepEqual(widgets.getState(fixture.db, other.userId, ref).value, { theirs: true });
});

test("removing the answer removes its revisions and their saved inputs", (t) => {
  const fixture = createFixture(t);
  const owner = thread(fixture);
  const revision = revisionOf(fixture.db, owner, "<p>x</p>");
  const ref = { treeId: owner.treeId, artifactId: "chart", revision };
  widgets.updateState(fixture.db, fixture.userId, ref, "enable", null);
  fixture.db.$client.prepare("UPDATE nodes SET status = 'complete'").run();
  trees.remove(fixture.db, fixture.userId, owner.treeId);
  deletion.drain(fixture.db);
  t.false(widgets.exists(fixture.db, ref));
  t.is(
    (fixture.db.$client.prepare("SELECT count(*) AS n FROM widget_state").get() as { n: number }).n,
    0,
  );
});
