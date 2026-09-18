import test from "ava";

import { nodes, trees } from "../src/index.js";

import { createFixture } from "./helpers.js";

function admit(fixture: ReturnType<typeof createFixture>, prompt: string) {
  return trees.admitRoot(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    prompt,
    model: "gemini-flash",
  });
}

test("creates thread and root node atomically at position 0", (t) => {
  const fixture = createFixture(t);
  const first = admit(fixture, "First question");
  const second = admit(fixture, "Second question");
  t.is(first.nodes.length, 1);
  const root = first.nodes[0];
  t.is(root?.id, first.tree.rootNodeId);
  t.is(root?.parentNodeId, null);
  t.is(root?.status, "queued");
  t.is(root?.attempt, 1);
  t.is(root?.workspaceId, fixture.workspaceId);
  t.is(first.tree.title, "First question");
  t.deepEqual(
    trees.summaries(fixture.db, fixture.userId).map((summary) => summary.id),
    [second.tree.id, first.tree.id],
  );
});

test("rejects root node creation with empty prompt or unauthorized workspace ID", (t) => {
  const fixture = createFixture(t);
  t.throws(
    () =>
      trees.admitRoot(fixture.db, fixture.userId, {
        workspaceId: fixture.workspaceId,
        prompt: "   ",
        model: "gemini-flash",
      }),
    { message: /prompt cannot be empty/ },
  );
  t.throws(
    () =>
      trees.admitRoot(fixture.db, fixture.userId, {
        workspaceId: "nope",
        prompt: "Question",
        model: "gemini-flash",
      }),
    { message: /workspace nope was not found/ },
  );
});

test("summaries count statuses and raise attention flags only for unseen ones", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "complete");
  const child = nodes.admitChild(fixture.db, fixture.userId, {
    parentNodeId: rootId,
    prompt: "Follow-up",
  });
  nodes.setStatus(fixture.db, fixture.userId, child.id, "failed", { error: "boom" });
  const [summary] = trees.summaries(fixture.db, fixture.userId);
  t.is(summary?.completedCount, 1);
  t.is(summary?.failedCount, 1);
  t.is(summary?.runningCount, 0);
  t.true(summary?.hasUnseenUpdate);
  t.true(summary?.hasUnseenFailure);
  trees.markViewed(fixture.db, fixture.userId, detail.tree.id);
  const [seen] = trees.summaries(fixture.db, fixture.userId);
  t.false(seen?.hasUnseenUpdate);
  t.false(seen?.hasUnseenFailure);
  t.is(seen?.failedCount, 1, "the lifetime count survives the acknowledgement");
});

test("excludes interrupted runs from attention summary counts and status flags", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  const rootId = detail.tree.rootNodeId;
  nodes.setStatus(fixture.db, fixture.userId, rootId, "running");
  nodes.markInterrupted(fixture.db, fixture.userId, rootId);
  const [summary] = trees.summaries(fixture.db, fixture.userId);
  t.is(summary?.runningCount, 0);
  t.is(summary?.failedCount, 0);
  t.is(summary?.completedCount, 0);
  t.is(summary?.cancelledCount, 0);
  t.false(summary?.hasUnseenFailure);
});

test("reorder replaces one section and rejects stale, duplicate, and foreign ids", (t) => {
  const fixture = createFixture(t);
  const first = admit(fixture, "One");
  const second = admit(fixture, "Two");
  const third = admit(fixture, "Three");
  const archived = admit(fixture, "Archived");
  trees.archive(fixture.db, fixture.userId, archived.tree.id);

  const active = trees.summaries(fixture.db, fixture.userId).map((summary) => summary.id);
  t.deepEqual(active, [third.tree.id, second.tree.id, first.tree.id]);

  t.throws(
    () => trees.reorder(fixture.db, fixture.userId, fixture.workspaceId, false, [first.tree.id]),
    { message: /Reorder conflict: tree sequence is stale/ },
  );
  t.throws(
    () =>
      trees.reorder(fixture.db, fixture.userId, fixture.workspaceId, false, [
        first.tree.id,
        first.tree.id,
        second.tree.id,
      ]),
    { message: /duplicate/ },
  );
  t.throws(
    () =>
      trees.reorder(fixture.db, fixture.userId, fixture.workspaceId, false, [
        first.tree.id,
        second.tree.id,
        archived.tree.id,
      ]),
    { message: /is not in the requested sidebar section/ },
  );

  trees.reorder(fixture.db, fixture.userId, fixture.workspaceId, false, [
    first.tree.id,
    third.tree.id,
    second.tree.id,
  ]);
  t.deepEqual(
    trees.summaries(fixture.db, fixture.userId).map((summary) => summary.id),
    [first.tree.id, third.tree.id, second.tree.id],
  );
  t.deepEqual(
    trees
      .summaries(fixture.db, fixture.userId, { includeArchived: true })
      .filter((summary) => summary.archivedAt !== null)
      .map((summary) => summary.id),
    [archived.tree.id],
    "the archived section is untouched",
  );
});

test("archive and restore move a thread between sections", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  const archived = trees.archive(fixture.db, fixture.userId, detail.tree.id);
  t.not(archived.archivedAt, null);
  t.deepEqual(trees.summaries(fixture.db, fixture.userId), []);
  t.is(trees.summaries(fixture.db, fixture.userId, { includeArchived: true }).length, 1);
  const restored = trees.restore(fixture.db, fixture.userId, detail.tree.id);
  t.is(restored.archivedAt, null);
  t.is(trees.summaries(fixture.db, fixture.userId).length, 1);
});

test("follow, bookmark, rename, and touch move updated_at strictly forward", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  t.true(trees.setFollowed(fixture.db, fixture.userId, detail.tree.id, true).followed);
  t.true(trees.setBookmarked(fixture.db, fixture.userId, detail.tree.id, true).bookmarked);
  t.is(trees.rename(fixture.db, fixture.userId, detail.tree.id, "  Renamed  ").title, "Renamed");
  const before = trees.get(fixture.db, fixture.userId, detail.tree.id)?.updatedAt ?? 0;
  trees.touchTree(fixture.db, detail.tree.id, before - 10_000);
  const after = trees.get(fixture.db, fixture.userId, detail.tree.id)?.updatedAt ?? 0;
  t.is(after, before + 1, "a clock that went backwards still advances updated_at");
});

test("prevents thread deletion when runs are actively executing", (t) => {
  const fixture = createFixture(t);
  const detail = admit(fixture, "Root");
  t.throws(() => trees.remove(fixture.db, fixture.userId, detail.tree.id), {
    message: /Cannot delete research thread with an active run/,
  });
  nodes.setStatus(fixture.db, fixture.userId, detail.tree.rootNodeId, "cancelled");
  trees.remove(fixture.db, fixture.userId, detail.tree.id);
  t.is(trees.get(fixture.db, fixture.userId, detail.tree.id), null);
});
