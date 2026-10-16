// Shared threads: permissions, invitations, member-specific archive/trash/folders,
// billing attribution, and optimistic concurrency control
// (`docs/02-domain-model-and-database.md` §5.16).

import test from "ava";

import {
  access,
  folders,
  followups,
  highlights,
  nodes,
  posts,
  runs,
  schema,
  sharing,
  snapshots,
  trash,
  trees,
  usage,
} from "../src/index.js";

import { addUser, anchorFor, answerTurn, createFixture, runOf } from "./helpers.js";

type Fixture = ReturnType<typeof createFixture>;

interface Shared {
  fixture: Fixture;
  treeId: string;
  rootId: string;
  commenter: { userId: string; workspaceId: string };
  viewer: { userId: string; workspaceId: string };
  stranger: { userId: string; workspaceId: string };
  revision: string;
}

let loginCounter = 0;

/** A thread with a complete answer, shared with a commenter and a viewer
 * through accepted invitations. */
function sharedThread(t: Parameters<typeof createFixture>[0]): Shared {
  const fixture = createFixture(t);
  loginCounter += 1;
  const commenter = addUser(fixture.db, `commenter${loginCounter}`);
  const viewer = addUser(fixture.db, `viewer${loginCounter}`);
  const stranger = addUser(fixture.db, `stranger${loginCounter}`);
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "exchange",
    workspaceId: fixture.workspaceId,
    message: { text: "What is a bloom filter?" },
    agent: { model: "gemini-flash" },
  });
  const rootId = detail.tree.rootNodeId;
  const committed = snapshots.commit(fixture.db, fixture.userId, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "A bloom filter is a probabilistic set.")],
    outcome: { status: "complete" },
  });
  nodes.setStatus(fixture.db, fixture.userId, rootId, "complete");
  const link = sharing.createInvite(fixture.db, fixture.userId, {
    treeId: detail.tree.id,
    role: "commenter",
  });
  sharing.acceptInvite(
    fixture.db,
    { id: commenter.userId, login: `commenter${loginCounter}` },
    {
      token: link.token,
    },
  );
  const byLogin = sharing.createInvite(fixture.db, fixture.userId, {
    treeId: detail.tree.id,
    role: "viewer",
    githubLogin: `viewer${loginCounter}`,
  });
  sharing.acceptInvite(
    fixture.db,
    { id: viewer.userId, login: `viewer${loginCounter}` },
    {
      inviteId: byLogin.invite.id,
    },
  );
  return {
    fixture,
    treeId: detail.tree.id,
    rootId,
    commenter,
    viewer,
    stranger,
    revision: committed.revision,
  };
}

function ask(shared: Shared, userId: string, text: string, parentNodeId = shared.rootId) {
  return nodes.admitChild(shared.fixture.db, userId, {
    parentNodeId,
    message: { text },
  });
}

test("resolves tree roles by user permissions and excludes unauthorized access", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const role = (userId: string | null) =>
    access.treeAccess(db, userId, shared.treeId)?.role ?? null;
  t.is(role(shared.fixture.userId), "owner");
  t.is(role(shared.commenter.userId), "commenter");
  t.is(role(shared.viewer.userId), "viewer");
  t.is(role(shared.stranger.userId), null);
  t.is(role(null), null);
  sharing.setVisibility(db, shared.fixture.userId, shared.treeId, "public");
  t.is(role(shared.stranger.userId), "viewer");
  t.is(role(null), "viewer");
  // Trashing by the owner revokes access for members.
  trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.is(role(shared.commenter.userId), null);
  t.is(role(null), null);
  t.is(role(shared.fixture.userId), "owner");
  trash.restoreTree(db, shared.fixture.userId, shared.treeId);
  t.is(role(shared.commenter.userId), "commenter");
});

test("restricts visibility, membership, and invitation updates to thread owners", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  for (const userId of [shared.commenter.userId, shared.viewer.userId]) {
    t.throws(() => sharing.setVisibility(db, userId, shared.treeId, "public"), {
      instanceOf: access.TreeAccessError,
    });
    t.throws(() => sharing.createInvite(db, userId, { treeId: shared.treeId, role: "viewer" }), {
      instanceOf: access.TreeAccessError,
    });
    t.throws(() => sharing.setRole(db, userId, shared.treeId, shared.viewer.userId, "commenter"), {
      instanceOf: access.TreeAccessError,
    });
  }
  t.throws(() => sharing.setVisibility(db, shared.stranger.userId, shared.treeId, "public"), {
    message: /was not found$/,
  });
  t.throws(() => trees.rename(db, shared.commenter.userId, shared.treeId, "Renamed"), {
    instanceOf: access.TreeAccessError,
  });
  const members = sharing.listMembers(db, shared.viewer.userId, shared.treeId);
  t.deepEqual(
    members.map((member) => member.role),
    ["owner", "commenter", "viewer"],
  );
});

test("restricts question, note, and highlight creation to commenters and owners", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  t.throws(() => ask(shared, shared.viewer.userId, "Can I ask?"), {
    instanceOf: access.TreeAccessError,
  });
  t.throws(
    () =>
      highlights.create(
        db,
        shared.viewer.userId,
        shared.rootId,
        anchorFor(shared.revision, "bloom filter", 2),
      ),
    { instanceOf: access.TreeAccessError },
  );
  const question = ask(shared, shared.commenter.userId, "How many hash functions?");
  t.is(question.authorId, shared.commenter.userId);
  const highlight = highlights.create(
    db,
    shared.commenter.userId,
    shared.rootId,
    anchorFor(shared.revision, "bloom filter", 2),
  );
  t.is(highlight.authorId, shared.commenter.userId);
  // Highlights are visible to all users with read access.
  t.is(highlights.listForNode(db, shared.viewer.userId, shared.rootId).length, 1);
  // Commenters can remove only their own highlights; owners can remove any highlight.
  const ownerHighlight = highlights.create(
    db,
    shared.fixture.userId,
    shared.rootId,
    anchorFor(shared.revision, "probabilistic", 15),
  );
  t.throws(() => highlights.remove(db, shared.commenter.userId, shared.rootId, ownerHighlight.id), {
    instanceOf: access.TreeAccessError,
  });
  highlights.remove(db, shared.commenter.userId, shared.rootId, highlight.id);
  highlights.remove(db, shared.fixture.userId, shared.rootId, ownerHighlight.id);
  t.is(highlights.listForNode(db, shared.fixture.userId, shared.rootId).length, 0);
});

test("restricts commenter node modifications to author's nodes without replies", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const ownerQuestion = ask(shared, shared.fixture.userId, "Owner's branch");
  t.throws(() => nodes.removeBranch(db, shared.commenter.userId, ownerQuestion.id), {
    instanceOf: access.TreeAccessError,
  });
  t.throws(() => nodes.rename(db, shared.commenter.userId, ownerQuestion.id, "Mine now"), {
    instanceOf: access.TreeAccessError,
  });
  const own = ask(shared, shared.commenter.userId, "Commenter's branch");
  nodes.rename(db, shared.commenter.userId, own.id, "Renamed by its author");
  // A reply prevents further modifications by the original author.
  nodes.setStatus(db, shared.fixture.userId, own.id, "complete");
  const reply = ask(shared, shared.fixture.userId, "Owner replies", own.id);
  nodes.setStatus(db, shared.fixture.userId, reply.id, "complete");
  t.throws(() => nodes.removeBranch(db, shared.commenter.userId, own.id), {
    message: /Someone else has replied/,
  });
  // Thread owners can delete any branch.
  const removal = nodes.removeBranch(db, shared.fixture.userId, own.id);
  t.is(removal.removedBy, shared.fixture.userId);
  t.is(removal.removedNodeIds.length, 2);
});

test("restricts note edits to authors and updates editedBy", (t) => {
  const fixture = createFixture(t);
  const commenter = addUser(fixture.db, "note-commenter");
  const detail = posts.admitPost(fixture.db, fixture.userId, {
    workspaceId: fixture.workspaceId,
    text: "Owner's note",
    agent: { model: "gemini-flash" },
  });
  const invite = sharing.createInvite(fixture.db, fixture.userId, {
    treeId: detail.tree.id,
    role: "commenter",
  });
  sharing.acceptInvite(
    fixture.db,
    { id: commenter.userId, login: "note-commenter" },
    {
      token: invite.token,
    },
  );
  const reply = posts.admitFollowUpNote(
    fixture.db,
    commenter.userId,
    detail.tree.rootNodeId,
    "Commenter's note",
  );
  t.throws(
    () =>
      posts.updatePost(fixture.db, commenter.userId, {
        nodeId: detail.tree.rootNodeId,
        text: "Changed by someone else",
        expectedText: "Owner's note",
      }),
    { instanceOf: access.TreeAccessError },
  );
  // Note text editing is restricted to the note author.
  t.throws(
    () =>
      posts.updatePost(fixture.db, fixture.userId, {
        nodeId: reply.id,
        text: "Owner rewrites it",
        expectedText: "Commenter's note",
      }),
    { instanceOf: access.TreeAccessError },
  );
  const edited = posts.updatePost(fixture.db, commenter.userId, {
    nodeId: reply.id,
    text: "Commenter's note, edited",
    expectedText: "Commenter's note",
  });
  t.is(edited.node.type === "post" ? edited.node.editedBy : null, commenter.userId);
  // Rejects concurrent edits when expectedText mismatches.
  t.throws(
    () =>
      posts.updatePost(fixture.db, commenter.userId, {
        nodeId: reply.id,
        text: "Third version",
        expectedText: "Commenter's note",
      }),
    { message: /changed while you were editing/ },
  );
});

test("attributes queue entries and daily run usage to the question author", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const question = ask(shared, shared.commenter.userId, "Paid by the commenter");
  // Retrying a failed question is restricted to the author and attributed to their usage.
  nodes.setStatus(db, shared.commenter.userId, question.id, "failed", { error: "boom" });
  t.throws(() => nodes.resetForRetry(db, shared.fixture.userId, question.id), {
    instanceOf: access.TreeAccessError,
  });
  nodes.resetForRetry(db, shared.commenter.userId, question.id);
  const row = db
    .select()
    .from(schema.runQueue)
    .all()
    .find((candidate) => candidate.nodeId === question.id);
  t.is(row?.userId, shared.commenter.userId);
  // Queued follow-up runs are billed to the author regardless of who dispatches them.
  nodes.setStatus(db, shared.commenter.userId, question.id, "running");
  const queued = followups.ask(db, shared.commenter.userId, {
    headNodeId: question.id,
    message: { text: "Queued by the commenter" },
    agent: { model: "gemini-flash" },
  });
  t.is(queued.kind, "queued");
  nodes.setStatus(db, shared.commenter.userId, question.id, "complete");
  const step = followups.nextStep(db, shared.fixture.userId, question.id);
  if (step.kind !== "send") {
    t.fail(`expected a send, got ${step.kind}`);
    return;
  }
  const sent = followups.send(db, shared.fixture.userId, step.item.id, step.tailId);
  t.is(sent.node.authorId, shared.commenter.userId);
  const sentRow = db
    .select()
    .from(schema.runQueue)
    .all()
    .find((candidate) => candidate.nodeId === sent.node.id);
  t.is(sentRow?.userId, shared.commenter.userId);
  // Run attempts count toward the author's daily limit, not the thread owner's.
  runs.startAttempt(db, { nodeId: question.id, attempt: 2, kind: "fresh", model: "gemini-flash" });
  t.is(usage.dailyTotals(db, shared.commenter.userId).runs, 1);
  t.is(usage.dailyTotals(db, shared.fixture.userId).runs, 0);
  t.is(runOf(sent.node).status, "queued");
});

test("isolates member archive and trash states while owner trash revokes member access", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const listed = (userId: string, place: trees.SharedPlace) =>
    trees.sharedSummaries(db, userId, place).map((summary) => summary.id);
  t.deepEqual(listed(shared.commenter.userId, "shared"), [shared.treeId]);
  t.is(trees.sharedSummaries(db, shared.commenter.userId)[0]?.role, "commenter");

  trees.archive(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "shared"), []);
  t.deepEqual(listed(shared.commenter.userId, "archive"), [shared.treeId]);
  // Archiving by a member does not affect other members or the owner.
  t.is(trees.get(db, shared.fixture.userId, shared.treeId)?.archivedAt, null);
  t.deepEqual(listed(shared.viewer.userId, "shared"), [shared.treeId]);
  trees.restore(db, shared.commenter.userId, shared.treeId);

  trash.trashTree(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "trash"), [shared.treeId]);
  t.deepEqual(listed(shared.commenter.userId, "shared"), []);
  t.is(trees.get(db, shared.fixture.userId, shared.treeId)?.trashedAt, null);
  // Trashing by a member does not revoke write permissions.
  const fromTrash = ask(shared, shared.commenter.userId, "Asked from the Trash");
  nodes.setStatus(db, shared.commenter.userId, fromTrash.id, "cancelled");
  trash.restoreTree(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "shared"), [shared.treeId]);

  // Trashing by the owner hides the thread from all members until restored.
  const ownerTrash = trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.is(ownerTrash.tree.trashedBy, shared.fixture.userId);
  t.deepEqual(listed(shared.viewer.userId, "shared"), []);
  t.is(trees.get(db, shared.viewer.userId, shared.treeId), null);
  trash.restoreTree(db, shared.fixture.userId, shared.treeId);
  t.deepEqual(listed(shared.viewer.userId, "shared"), [shared.treeId]);

  // Emptying trash as a member removes membership without affecting other users.
  trash.trashTree(db, shared.viewer.userId, shared.treeId);
  const emptied = trash.empty(db, shared.viewer.userId, shared.viewer.workspaceId);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId]);
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId), null);
  t.truthy(trees.get(db, shared.fixture.userId, shared.treeId));
});

test("maintains separate folder membership per user for shared threads", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const memberState = folders.getState(db, shared.commenter.userId, shared.commenter.workspaceId);
  folders.setState(db, shared.commenter.userId, shared.commenter.workspaceId, {
    ...memberState,
    folders: [
      { id: "member-folder", name: "Shared reading", workspaceId: shared.commenter.workspaceId },
    ],
    membership: { [shared.treeId]: "member-folder" },
  });
  const after = folders.getState(db, shared.commenter.userId, shared.commenter.workspaceId);
  t.is(after.membership[shared.treeId], "member-folder");
  t.deepEqual(
    trees
      .summaries(db, shared.commenter.userId, { workspaceId: shared.commenter.workspaceId })
      .map((summary) => [summary.id, summary.role]),
    [[shared.treeId, "commenter"]],
  );
  t.is(
    folders.getState(db, shared.fixture.userId, shared.fixture.workspaceId).membership[
      shared.treeId
    ],
    undefined,
  );
  // Unfiling clears it.
  folders.setState(db, shared.commenter.userId, shared.commenter.workspaceId, {
    ...after,
    membership: {},
  });
  t.is(
    folders.getState(db, shared.commenter.userId, shared.commenter.workspaceId).membership[
      shared.treeId
    ],
    undefined,
  );
});

test("hashes invitation link tokens and restricts login invitations to targeted account", (t) => {
  const fixture = createFixture(t);
  const invitee = addUser(fixture.db, "Invitee");
  const other = addUser(fixture.db, "someone-else");
  const detail = trees.admitRoot(fixture.db, fixture.userId, {
    type: "post",
    workspaceId: fixture.workspaceId,
    message: { text: "A note to share" },
    agent: { model: "gemini-flash" },
  });
  const byLogin = sharing.createInvite(fixture.db, fixture.userId, {
    treeId: detail.tree.id,
    role: "commenter",
    githubLogin: "@invitee",
  });
  t.is(byLogin.inviteeId, invitee.userId);
  const stored = fixture.db.select().from(schema.treeInvites).all();
  t.false(stored.some((row) => row.tokenHash === byLogin.token));
  t.deepEqual(
    sharing.receivedInvites(fixture.db, "INVITEE").map((invite) => invite.treeId),
    [detail.tree.id],
  );
  t.throws(
    () =>
      sharing.acceptInvite(
        fixture.db,
        { id: other.userId, login: "someone-else" },
        {
          token: byLogin.token,
        },
      ),
    { message: /another GitHub account/ },
  );
  const accepted = sharing.acceptInvite(
    fixture.db,
    { id: invitee.userId, login: "invitee" },
    {
      inviteId: byLogin.invite.id,
    },
  );
  t.deepEqual(accepted, {
    treeId: detail.tree.id,
    role: "commenter",
    joined: true,
    restored: false,
  });
  // Re-accepting a redeemed invitation returns not found.
  t.throws(
    () =>
      sharing.acceptInvite(
        fixture.db,
        { id: invitee.userId, login: "invitee" },
        {
          inviteId: byLogin.invite.id,
        },
      ),
    { message: /^This invitation was not found/ },
  );
  // Revoked invitation links are rejected.
  const link = sharing.createInvite(fixture.db, fixture.userId, {
    treeId: detail.tree.id,
    role: "viewer",
  });
  t.deepEqual(
    sharing.listInvites(fixture.db, fixture.userId, detail.tree.id).map((invite) => invite.id),
    [link.invite.id],
  );
  sharing.revokeInvite(fixture.db, fixture.userId, link.invite.id);
  t.throws(
    () =>
      sharing.acceptInvite(
        fixture.db,
        { id: other.userId, login: "someone-else" },
        {
          token: link.token,
        },
      ),
    { message: /^This invitation was not found/ },
  );
  t.throws(
    () => sharing.acceptInvite(fixture.db, { id: other.userId, login: "x" }, { token: "nope" }),
    {
      message: /^This invitation was not found/,
    },
  );
});

test("removes queued follow-ups and reports active runs when removing a member", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const running = ask(shared, shared.commenter.userId, "Running question");
  nodes.setStatus(db, shared.commenter.userId, running.id, "running");
  followups.ask(db, shared.commenter.userId, {
    headNodeId: running.id,
    message: { text: "Queued behind it" },
    agent: { model: "gemini-flash" },
  });
  const departure = sharing.removeMember(
    db,
    shared.fixture.userId,
    shared.treeId,
    shared.commenter.userId,
  );
  t.deepEqual(departure.activeNodeIds, [running.id]);
  t.deepEqual(departure.changedHeadNodeIds, [running.id]);
  t.is(departure.removedFollowupIds.length, 1);
  t.is(access.treeAccess(db, shared.commenter.userId, shared.treeId), null);
  // Authored nodes remain in the thread with existing attribution.
  t.is(nodes.get(db, shared.fixture.userId, running.id)?.authorId, shared.commenter.userId);
  // Members can leave threads independently.
  sharing.leave(db, shared.viewer.userId, shared.treeId);
  t.deepEqual(
    sharing.listMembers(db, shared.fixture.userId, shared.treeId).map((member) => member.role),
    ["owner"],
  );
});

/** Spins until the system clock advances past `at` so subsequent writes have later timestamps. */
function after(at: number): void {
  while (Date.now() <= at) {
    // spin; at most a millisecond
  }
}

test("prevents removed member from rejoining through a link created before the removal", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const commenterLogin = (
    sharing
      .listMembers(db, shared.fixture.userId, shared.treeId)
      .find((member) => member.userId === shared.commenter.userId) ?? { login: "" }
  ).login;
  const commenter = { id: shared.commenter.userId, login: commenterLogin };
  const oldLink = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
  });
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.commenter.userId);
  const removal = db.select().from(schema.treeMemberRemovals).all();
  t.deepEqual(
    removal.map((row) => [row.treeId, row.userId, row.removedBy]),
    [[shared.treeId, shared.commenter.userId, shared.fixture.userId]],
  );
  // Previously issued invitation links reject removed members.
  t.throws(() => sharing.acceptInvite(db, commenter, { token: oldLink.token }), {
    message: "You were removed from this thread.",
  });
  t.is(access.treeAccess(db, shared.commenter.userId, shared.treeId), null);
  // Existing invitation links remain valid for other users.
  const newcomer = addUser(db, `newcomer${loginCounter}`);
  t.true(
    sharing.acceptInvite(
      db,
      { id: newcomer.userId, login: `newcomer${loginCounter}` },
      { token: oldLink.token },
    ).joined,
  );
  // Link invitations remain listed after use to allow revocation; redeemed user-specific invites are deleted.
  const listed = sharing.listInvites(db, shared.fixture.userId, shared.treeId);
  t.true(listed.some((invite) => invite.id === oldLink.invite.id));
  t.false(listed.some((invite) => invite.githubLogin !== null));
  // Invitations created after removal allow rejoining and clear removal records.
  after(removal[0]?.removedAt ?? 0);
  const newLink = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
  });
  t.deepEqual(sharing.acceptInvite(db, commenter, { token: newLink.token }), {
    treeId: shared.treeId,
    role: "viewer",
    joined: true,
    restored: false,
  });
  t.deepEqual(db.select().from(schema.treeMemberRemovals).all(), []);
  // Once membership is re-established, previous links are accepted without lowering role.
  t.true(sharing.acceptInvite(db, commenter, { token: oldLink.token }).role === "viewer");
});

test("allows removed members to rejoin via targeted login invitation", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const viewerLogin = (
    sharing
      .listMembers(db, shared.fixture.userId, shared.treeId)
      .find((member) => member.userId === shared.viewer.userId) ?? { login: "" }
  ).login;
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.viewer.userId);
  // A targeted login invitation explicitly identifies the user account,
  // granting access whether issued concurrently with or after the removal.
  const byLogin = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
    githubLogin: viewerLogin,
  });
  t.deepEqual(
    sharing.acceptInvite(
      db,
      { id: shared.viewer.userId, login: viewerLogin },
      { inviteId: byLogin.invite.id },
    ),
    { treeId: shared.treeId, role: "commenter", joined: true, restored: false },
  );
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId)?.role, "commenter");
  t.deepEqual(db.select().from(schema.treeMemberRemovals).all(), []);
});

test("revokes pending login invitations when removing a member", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  // When a user invited by login joins via link instead, the pending login
  // invitation is revoked upon member removal.
  const login = `late${loginCounter}`;
  const late = addUser(db, login);
  const pending = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
    githubLogin: login,
  });
  const link = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
  });
  sharing.acceptInvite(db, { id: late.userId, login }, { token: link.token });
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, late.userId);
  t.throws(
    () => sharing.acceptInvite(db, { id: late.userId, login }, { inviteId: pending.invite.id }),
    { message: sharing.INVITE_MESSAGES.notFound },
  );
  t.throws(() => sharing.acceptInvite(db, { id: late.userId, login }, { token: pending.token }), {
    message: sharing.INVITE_MESSAGES.notFound,
  });
  t.deepEqual(sharing.receivedInvites(db, login), []);
  t.is(access.treeAccess(db, late.userId, shared.treeId), null);
});

test("clears queued follow-ups and prevents retries when demoting a member to viewer", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const running = ask(shared, shared.commenter.userId, "Running question");
  nodes.setStatus(db, shared.commenter.userId, running.id, "running");
  const queued = followups.ask(db, shared.commenter.userId, {
    headNodeId: running.id,
    message: { text: "Queued behind it" },
    agent: { model: "gemini-flash" },
  });
  if (queued.kind !== "queued") {
    t.fail("expected a queued item");
    return;
  }
  const change = sharing.setRole(
    db,
    shared.fixture.userId,
    shared.treeId,
    shared.commenter.userId,
    "viewer",
  );
  t.deepEqual(change.dropped, {
    removedFollowupIds: [queued.item.id],
    changedHeadNodeIds: [running.id],
  });
  t.deepEqual(followups.listForHead(db, shared.fixture.userId, running.id), []);
  t.false(followups.authorMayAsk(db, queued.item));
  // Promoting member role does not affect queued follow-ups.
  t.deepEqual(
    sharing.setRole(db, shared.fixture.userId, shared.treeId, shared.commenter.userId, "commenter")
      .dropped,
    { removedFollowupIds: [], changedHeadNodeIds: [] },
  );
  // Existing queue items cannot be retried once a user is demoted to viewer.
  sharing.setRole(db, shared.fixture.userId, shared.treeId, shared.commenter.userId, "viewer");
  db.insert(schema.followupQueue)
    .values({
      id: "left-behind",
      treeId: shared.treeId,
      headNodeId: running.id,
      authorId: shared.commenter.userId,
      messageJson: { text: "Left behind" },
      model: "gemini-flash",
      effort: null,
      position: 0,
      createdAt: 1,
      failedReason: "refused",
    })
    .run();
  t.throws(() => followups.retry(db, shared.commenter.userId, "left-behind"), {
    message: access.ACCESS_MESSAGES.viewer,
  });
});

test("treats member deletion and emptying trash as leaving the thread", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const running = ask(shared, shared.commenter.userId, "Running question");
  nodes.setStatus(db, shared.commenter.userId, running.id, "running");
  followups.ask(db, shared.commenter.userId, {
    headNodeId: running.id,
    message: { text: "Queued behind it" },
    agent: { model: "gemini-flash" },
  });
  const removed = trees.remove(db, shared.commenter.userId, shared.treeId);
  t.true(removed.left);
  t.like(removed.departure, {
    treeId: shared.treeId,
    memberId: shared.commenter.userId,
    activeNodeIds: [running.id],
    changedHeadNodeIds: [running.id],
  });
  t.deepEqual(followups.listForHead(db, shared.fixture.userId, running.id), []);

  // Emptying trash reports departure for members without queued items.
  trash.trashTree(db, shared.viewer.userId, shared.treeId);
  const emptied = trash.empty(db, shared.viewer.userId, shared.viewer.workspaceId);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId]);
  t.like(emptied.departures, [{ treeId: shared.treeId, memberId: shared.viewer.userId }]);
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId), null);
});

test("permits users who voluntarily left to rejoin via invitation link", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const link = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
  });
  sharing.leave(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(db.select().from(schema.treeMemberRemovals).all(), []);
  t.true(
    sharing.acceptInvite(db, { id: shared.commenter.userId, login: "x" }, { token: link.token })
      .joined,
  );
});

test("lists public threads publicly and includes contributing participants in detail", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  t.deepEqual(trees.publicSummaries(db, null), []);
  sharing.setVisibility(db, shared.fixture.userId, shared.treeId, "public");
  const listed = trees.publicSummaries(db, null);
  t.deepEqual(
    listed.map((summary) => [summary.id, summary.role, summary.visibility]),
    [[shared.treeId, "viewer", "public"]],
  );
  t.is(trees.publicSummaries(db, shared.commenter.userId)[0]?.role, "commenter");
  ask(shared, shared.commenter.userId, "Commenter asks");
  const detail = trees.detail(db, null, shared.treeId);
  // Public detail view includes the owner and contributing authors; non-contributing
  // viewers are visible only to members.
  t.deepEqual(
    detail.participants?.map((participant) => participant.id),
    [shared.fixture.userId, shared.commenter.userId],
  );
  t.deepEqual(
    trees.detail(db, shared.viewer.userId, shared.treeId).participants?.map((p) => p.id),
    [shared.fixture.userId, shared.commenter.userId, shared.viewer.userId],
  );
  t.is(detail.tree.role, "viewer");
  t.is(detail.tree.ownerId, shared.fixture.userId);
});

test("manages thread followers and unsubscribes users who lose access", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  sharing.setFollowing(db, shared.viewer.userId, shared.treeId, true);
  sharing.setFollowing(db, shared.commenter.userId, shared.treeId, true);
  t.deepEqual(
    sharing.followers(db, shared.treeId).sort(),
    [shared.fixture.userId, shared.commenter.userId, shared.viewer.userId].sort(),
  );
  t.true(trees.get(db, shared.viewer.userId, shared.treeId)?.followed ?? false);
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.viewer.userId);
  t.deepEqual(
    sharing.followers(db, shared.treeId).sort(),
    [shared.fixture.userId, shared.commenter.userId].sort(),
  );
  t.throws(() => sharing.setFollowing(db, shared.stranger.userId, shared.treeId, true), {
    message: /was not found$/,
  });
});

test("rejects chain reordering when expected order is stale", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const first = nodes.admitChild(db, shared.fixture.userId, {
    parentNodeId: shared.rootId,
    message: { text: "Inline one" },
    inline: true,
  });
  const chain = [shared.rootId, first.id];
  t.throws(
    () => nodes.setChainOrder(db, shared.commenter.userId, shared.rootId, [...chain].reverse()),
    {
      instanceOf: access.TreeAccessError,
    },
  );
  nodes.setChainOrder(db, shared.fixture.userId, shared.rootId, [...chain].reverse(), chain);
  t.throws(() => nodes.setChainOrder(db, shared.fixture.userId, shared.rootId, chain, chain), {
    message: /^The conversation changed/,
  });
});
