// Shared threads in the repositories: roles, invitations, per-person Archive,
// Trash and filing, attribution, who pays, and stale-revision refusals
// (`docs/02-domain-model-and-database.md` §5.16).

import test from "ava";

import {
  access,
  folders,
  followups,
  highlights,
  nodes,
  posts,
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

test("treeAccess gives each person their role, and nobody else anything", (t) => {
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
  // The owner's Trash hides the thread from everyone else.
  trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.is(role(shared.commenter.userId), null);
  t.is(role(null), null);
  t.is(role(shared.fixture.userId), "owner");
  trash.restoreTree(db, shared.fixture.userId, shared.treeId);
  t.is(role(shared.commenter.userId), "commenter");
});

test("only the owner changes visibility, members and invitations", (t) => {
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

test("a viewer cannot ask, note or highlight; a commenter can", (t) => {
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
  // Highlights are shared: everyone who reads the thread sees them.
  t.is(highlights.listForNode(db, shared.viewer.userId, shared.rootId).length, 1);
  // A commenter removes only their own; the owner any.
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

test("a commenter changes only their own nodes, and only while nobody else replied", (t) => {
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
  // Someone else replies under it: it is no longer the commenter's to change.
  nodes.setStatus(db, shared.fixture.userId, own.id, "complete");
  const reply = ask(shared, shared.fixture.userId, "Owner replies", own.id);
  nodes.setStatus(db, shared.fixture.userId, reply.id, "complete");
  t.throws(() => nodes.removeBranch(db, shared.commenter.userId, own.id), {
    message: /Someone else has replied/,
  });
  // The owner may delete anyone's branch.
  const removal = nodes.removeBranch(db, shared.fixture.userId, own.id);
  t.is(removal.removedBy, shared.fixture.userId);
  t.is(removal.removedNodeIds.length, 2);
});

test("notes are edited by their author, who is recorded as the editor", (t) => {
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
  // Only the author edits a note's text, the owner included.
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
  // A stale edit is refused.
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

test("the asker pays: the run queue and the daily runs count the question's author", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const question = ask(shared, shared.commenter.userId, "Paid by the commenter");
  // A failed question's retry is its author's to start, and theirs to pay.
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
  // The queued follow-up of a commenter is sent billed to them, whoever
  // dispatches it.
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
  // Attempts count against the payer's daily runs, not the owner's.
  db.insert(schema.runAttempts)
    .values({
      nodeId: question.id,
      attempt: 2,
      kind: "fresh",
      model: "gemini-flash",
      startedAt: Date.now(),
    })
    .run();
  t.is(usage.dailyTotals(db, shared.commenter.userId).runs, 1);
  t.is(usage.dailyTotals(db, shared.fixture.userId).runs, 0);
  t.is(runOf(sent.node).status, "queued");
});

test("a member's Archive and Trash are their own; the owner's Trash hides it from them", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const listed = (userId: string, place: trees.SharedPlace) =>
    trees.sharedSummaries(db, userId, place).map((summary) => summary.id);
  t.deepEqual(listed(shared.commenter.userId, "shared"), [shared.treeId]);
  t.is(trees.sharedSummaries(db, shared.commenter.userId)[0]?.role, "commenter");

  trees.archive(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "shared"), []);
  t.deepEqual(listed(shared.commenter.userId, "archive"), [shared.treeId]);
  // Nothing changed for the owner or the other member.
  t.is(trees.get(db, shared.fixture.userId, shared.treeId)?.archivedAt, null);
  t.deepEqual(listed(shared.viewer.userId, "shared"), [shared.treeId]);
  trees.restore(db, shared.commenter.userId, shared.treeId);

  trash.trashTree(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "trash"), [shared.treeId]);
  t.deepEqual(listed(shared.commenter.userId, "shared"), []);
  t.is(trees.get(db, shared.fixture.userId, shared.treeId)?.trashedAt, null);
  // A member's Trash does not lock the thread: they can still ask in it.
  const fromTrash = ask(shared, shared.commenter.userId, "Asked from the Trash");
  nodes.setStatus(db, shared.commenter.userId, fromTrash.id, "cancelled");
  trash.restoreTree(db, shared.commenter.userId, shared.treeId);
  t.deepEqual(listed(shared.commenter.userId, "shared"), [shared.treeId]);

  // The owner's Trash hides it from every member until the owner restores it.
  const ownerTrash = trash.trashTree(db, shared.fixture.userId, shared.treeId);
  t.is(ownerTrash.tree.trashedBy, shared.fixture.userId);
  t.deepEqual(listed(shared.viewer.userId, "shared"), []);
  t.is(trees.get(db, shared.viewer.userId, shared.treeId), null);
  trash.restoreTree(db, shared.fixture.userId, shared.treeId);
  t.deepEqual(listed(shared.viewer.userId, "shared"), [shared.treeId]);

  // Emptying a member's Trash leaves the thread; it stays for the others.
  trash.trashTree(db, shared.viewer.userId, shared.treeId);
  const emptied = trash.empty(db, shared.viewer.userId, shared.viewer.workspaceId);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId]);
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId), null);
  t.truthy(trees.get(db, shared.fixture.userId, shared.treeId));
});

test("a member files a shared thread in their own folder; the owner's filing is untouched", (t) => {
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

test("invitations: link tokens are hashed, login invitations are for one account", (t) => {
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
  t.deepEqual(accepted, { treeId: detail.tree.id, role: "commenter", joined: true });
  // Used: accepting again is "not found".
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
  // A revoked link no longer works.
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

test("removing a member drops their queued follow-ups and names their active runs", (t) => {
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
  // Their question stays in the thread, attributed to them.
  t.is(nodes.get(db, shared.fixture.userId, running.id)?.authorId, shared.commenter.userId);
  // A viewer leaves on their own.
  sharing.leave(db, shared.viewer.userId, shared.treeId);
  t.deepEqual(
    sharing.listMembers(db, shared.fixture.userId, shared.treeId).map((member) => member.role),
    ["owner"],
  );
});

/** Waits until the clock moves past `at`, so the next write is later. */
function after(at: number): void {
  while (Date.now() <= at) {
    // spin; at most a millisecond
  }
}

test("a removed member cannot rejoin through a link created before the removal", (t) => {
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
  // The link they joined with and a link pending at the removal both refuse them.
  t.throws(() => sharing.acceptInvite(db, commenter, { token: oldLink.token }), {
    message: "You were removed from this thread.",
  });
  t.is(access.treeAccess(db, shared.commenter.userId, shared.treeId), null);
  // The same links still admit someone else.
  const newcomer = addUser(db, `newcomer${loginCounter}`);
  t.true(
    sharing.acceptInvite(
      db,
      { id: newcomer.userId, login: `newcomer${loginCounter}` },
      { token: oldLink.token },
    ).joined,
  );
  // A used link stays listed, so the owner can still revoke it; the used
  // login invitation from the fixture does not.
  const listed = sharing.listInvites(db, shared.fixture.userId, shared.treeId);
  t.true(listed.some((invite) => invite.id === oldLink.invite.id));
  t.false(listed.some((invite) => invite.githubLogin !== null));
  // A link created after the removal lets them back in and clears it.
  after(removal[0]?.removedAt ?? 0);
  const newLink = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "viewer",
  });
  t.deepEqual(sharing.acceptInvite(db, commenter, { token: newLink.token }), {
    treeId: shared.treeId,
    role: "viewer",
    joined: true,
  });
  t.deepEqual(db.select().from(schema.treeMemberRemovals).all(), []);
  // Once back in, the older link works for them again (joining never lowers
  // a role, and they are a member).
  t.true(sharing.acceptInvite(db, commenter, { token: oldLink.token }).role === "viewer");
});

test("a login invitation lets a removed member back in", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const viewerLogin = (
    sharing
      .listMembers(db, shared.fixture.userId, shared.treeId)
      .find((member) => member.userId === shared.viewer.userId) ?? { login: "" }
  ).login;
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.viewer.userId);
  // Created in the same millisecond as the removal or later: a login
  // invitation names them, so it admits them either way.
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
    { treeId: shared.treeId, role: "commenter", joined: true },
  );
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId)?.role, "commenter");
  t.deepEqual(db.select().from(schema.treeMemberRemovals).all(), []);
});

test("removing a member revokes the login invitations still addressed to them", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  const login = `commenter${loginCounter}`;
  const pending = sharing.createInvite(db, shared.fixture.userId, {
    treeId: shared.treeId,
    role: "commenter",
    githubLogin: login,
  });
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.commenter.userId);
  t.throws(
    () =>
      sharing.acceptInvite(
        db,
        { id: shared.commenter.userId, login },
        { inviteId: pending.invite.id },
      ),
    { message: sharing.INVITE_MESSAGES.notFound },
  );
  t.throws(
    () =>
      sharing.acceptInvite(db, { id: shared.commenter.userId, login }, { token: pending.token }),
    { message: sharing.INVITE_MESSAGES.notFound },
  );
  t.deepEqual(sharing.receivedInvites(db, login), []);
  t.is(access.treeAccess(db, shared.commenter.userId, shared.treeId), null);
});

test("a member made a viewer loses their queued follow-ups and cannot retry one", (t) => {
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
  // Promoting drops nothing.
  t.deepEqual(
    sharing.setRole(db, shared.fixture.userId, shared.treeId, shared.commenter.userId, "commenter")
      .dropped,
    { removedFollowupIds: [], changedHeadNodeIds: [] },
  );
  // An item they still had (written past the role change) cannot be retried
  // once they are a viewer again.
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

test("a member's Delete and Empty Trash leave as leaving does", (t) => {
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

  // The viewer queues nothing, but Empty Trash reports their departure too.
  trash.trashTree(db, shared.viewer.userId, shared.treeId);
  const emptied = trash.empty(db, shared.viewer.userId, shared.viewer.workspaceId);
  t.deepEqual(emptied.leftTreeIds, [shared.treeId]);
  t.like(emptied.departures, [{ treeId: shared.treeId, memberId: shared.viewer.userId }]);
  t.is(access.treeAccess(db, shared.viewer.userId, shared.treeId), null);
});

test("leaving is not a removal: a link still lets the person back in", (t) => {
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

test("public threads are listed for everyone; detail names the participants", (t) => {
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
  t.deepEqual(
    detail.participants?.map((participant) => participant.id),
    [shared.fixture.userId, shared.commenter.userId, shared.viewer.userId],
  );
  t.is(detail.tree.role, "viewer");
  t.is(detail.tree.ownerId, shared.fixture.userId);
});

test("Follow subscribes a reader; a follower who loses access is dropped", (t) => {
  const shared = sharedThread(t);
  const { db } = shared.fixture;
  sharing.setFollowing(db, shared.viewer.userId, shared.treeId, true);
  sharing.setFollowing(db, shared.commenter.userId, shared.treeId, true);
  t.deepEqual(
    sharing.followers(db, shared.treeId).sort(),
    [shared.commenter.userId, shared.viewer.userId].sort(),
  );
  t.true(trees.get(db, shared.viewer.userId, shared.treeId)?.followed ?? false);
  sharing.removeMember(db, shared.fixture.userId, shared.treeId, shared.viewer.userId);
  t.deepEqual(sharing.followers(db, shared.treeId), [shared.commenter.userId]);
  t.throws(() => sharing.setFollowing(db, shared.stranger.userId, shared.treeId, true), {
    message: /was not found$/,
  });
});

test("reordering a chain from a stale order is refused", (t) => {
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
