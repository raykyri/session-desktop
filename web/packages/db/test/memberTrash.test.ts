// A member's Trash for shared threads: per workspace, and emptied even when
// the owner has since moved a thread to their own Trash.

import test from "ava";
import { and, eq } from "drizzle-orm";

import { access, schema, sharing, trash, trees, workspaces } from "../src/index.js";

import { sharedThreadFixture } from "./helpers.js";
import type { SharedThreadFixture } from "./helpers.js";

/** Another thread of the same owner, shared with the same member. */
function shareAnother(shared: SharedThreadFixture, prompt: string): string {
  const { db, userId, workspaceId } = shared.fixture;
  const member = shared.members[0];
  if (!member) throw new Error("the fixture has no member");
  const detail = trees.admitRoot(db, userId, {
    type: "post",
    workspaceId,
    message: { text: prompt },
    agent: { model: "gemini-flash" },
  });
  const link = sharing.createInvite(db, userId, { treeId: detail.tree.id, role: "commenter" });
  sharing.acceptInvite(db, { id: member.userId, login: member.login }, { token: link.token });
  return detail.tree.id;
}

test("a member's Empty Trash leaves a thread the owner has since trashed", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  const other = shareAnother(shared, "A second shared note");
  trash.trashTree(db, member.userId, shared.treeId);
  trash.trashTree(db, member.userId, other);
  // The owner trashes the first: the member can no longer read it, and it
  // leaves their Trash listing, but their member row is still there.
  trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.is(access.treeAccess(db, member.userId, shared.treeId), null);
  t.deepEqual(
    trees.sharedSummaries(db, member.userId, "trash").map((summary) => summary.id),
    [other],
  );

  const emptied = trash.empty(db, member.userId, member.workspaceId);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId, other].sort());
  t.is(access.memberRow(db, member.userId, shared.treeId), null);
  t.is(access.memberRow(db, member.userId, other), null);
  // The owner's thread is untouched, still in their Trash.
  t.not(trees.get(db, shared.fixture.userId, shared.treeId)?.trashedAt ?? null, null);
  // Restoring it does not bring the member back.
  trash.restoreTree(db, shared.fixture.userId, shared.treeId);
  t.is(access.treeAccess(db, member.userId, shared.treeId), null);
});

test("a member's Trash is per workspace", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  const defaultWorkspace = workspaces.ensureDefault(db, member.userId).id;
  t.is(defaultWorkspace, member.workspaceId);
  const second = workspaces.create(db, member.userId, "Second").id;
  const other = shareAnother(shared, "A second shared note");
  const third = shareAnother(shared, "A third shared note");

  // Another account's workspace is refused.
  t.throws(
    () =>
      trash.trashTree(db, member.userId, shared.treeId, {
        workspaceId: shared.fixture.workspaceId,
      }),
    { message: /was not found$/ },
  );

  // Trashed from the second workspace, from the default one (no workspace
  // named), and a row with no workspace of its own (an older row).
  trash.trashTree(db, member.userId, shared.treeId, { workspaceId: second });
  trash.trashTree(db, member.userId, other);
  trash.trashTree(db, member.userId, third, { workspaceId: second });
  db.update(schema.treeMembers)
    .set({ trashWorkspaceId: null })
    .where(and(eq(schema.treeMembers.treeId, third), eq(schema.treeMembers.userId, member.userId)))
    .run();

  const listed = (workspaceId?: string) =>
    trees
      .sharedSummaries(db, member.userId, "trash", { workspaceId })
      .map((summary) => summary.id)
      .sort();
  t.deepEqual(listed(second), [shared.treeId]);
  t.deepEqual(listed(defaultWorkspace), [other, third].sort());
  t.deepEqual(listed(), [shared.treeId, other, third].sort(), "no workspace: the whole Trash");

  const emptied = trash.empty(db, member.userId, second);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId]);
  t.not(access.memberRow(db, member.userId, other), null);
  t.not(access.memberRow(db, member.userId, third), null);

  // Restore clears the workspace with the flag.
  trash.restoreTree(db, member.userId, other);
  t.is(access.memberRow(db, member.userId, other)?.trashWorkspaceId, null);
  t.deepEqual(listed(defaultWorkspace), [third]);
});

test("the change reports the workspace whose Trash it changed", (t) => {
  const shared = sharedThreadFixture(t);
  const { db } = shared.fixture;
  const member = shared.members[0];
  if (!member) return t.fail();
  const second = workspaces.create(db, member.userId, "Second").id;
  t.is(
    trash.trashTree(db, member.userId, shared.treeId, { workspaceId: second }).trashWorkspaceId,
    second,
  );
  t.is(trash.restoreTree(db, member.userId, shared.treeId).trashWorkspaceId, second);
  t.is(
    trash.trashTree(db, shared.fixture.userId, shared.treeId).trashWorkspaceId,
    shared.fixture.workspaceId,
  );
});
