// Who may call what on a thread: a role × procedure matrix
// (`06-auth-and-users.md` §4, `02-domain-model-and-database.md` §5.16).
//
// Every procedure that names a thread, a node, a highlight or a member is
// called by each kind of caller:
// - `owner`: the thread's creator;
// - `commenter` and `viewer`: members with that role;
// - `reader`: a signed-in account that is not a member, on a public thread;
// - `stranger`: a signed-in account that is not a member, on a private
//   thread;
// - `guest`: no session, on a public thread.
//
// The matrix checks access only. "ok" means the call got past the access
// rules: it succeeded, or failed for another reason (a run still queued, a
// stale revision). A role too low answers `FORBIDDEN`; a thread the caller
// may not read answers `NOT_FOUND`, the same as an id that does not exist, so
// a private id is never an existence oracle; a guest calling a signed-in
// procedure answers `UNAUTHORIZED`. Each cell runs on a thread of its own.

import type { SessionDatabase } from "@session/db";
import { highlights, nodes, sharing, snapshots, trees, workspaces } from "@session/db";
import type { User } from "@session/shared";
import { TRPCError } from "@trpc/server";
import test from "ava";

import { anchorFor, answerTurn, createHarness, type Caller } from "./helpers.js";

type Role = "owner" | "commenter" | "viewer" | "reader" | "stranger" | "guest";

type Outcome = "ok" | "FORBIDDEN" | "NOT_FOUND" | "UNAUTHORIZED";

const ROLES: readonly Role[] = ["owner", "commenter", "viewer", "reader", "stranger", "guest"];

interface Seeded {
  treeId: string;
  rootId: string;
  childId: string;
  highlightId: string;
  revision: string;
  viewerId: string;
}

interface Accounts {
  owner: User;
  commenter: User;
  viewer: User;
  reader: User;
  stranger: User;
}

/** A thread with a complete answer, an owner's highlight and a queued inline
 * follow-up, shared with the commenter and the viewer; public when the cell
 * is the reader's or the guest's. Written through the repositories, so the
 * seeding spends none of the callers' mutation budget. */
function seed(db: SessionDatabase, accounts: Accounts, isPublic: boolean): Seeded {
  const workspace = workspaces.ensureDefault(db, accounts.owner.id);
  const detail = trees.admitRoot(db, accounts.owner.id, {
    type: "exchange",
    workspaceId: workspace.id,
    message: { text: "What is a bloom filter?" },
    agent: { model: "gemini-flash" },
  });
  const rootId = detail.tree.rootNodeId;
  const committed = snapshots.commit(db, accounts.owner.id, {
    nodeId: rootId,
    turns: [answerTurn(rootId, "A bloom filter is a probabilistic set membership structure.")],
    outcome: { status: "complete" },
  });
  nodes.setStatus(db, accounts.owner.id, rootId, "complete");
  const highlight = highlights.create(
    db,
    accounts.owner.id,
    rootId,
    anchorFor(committed.revision, "bloom filter", 2),
  );
  const child = nodes.admitChild(db, accounts.owner.id, {
    parentNodeId: rootId,
    message: { text: "And a cuckoo filter?" },
    inline: true,
  });
  for (const [user, role] of [
    [accounts.commenter, "commenter"],
    [accounts.viewer, "viewer"],
  ] as const) {
    const invite = sharing.createInvite(db, accounts.owner.id, { treeId: detail.tree.id, role });
    sharing.acceptInvite(db, user, { token: invite.token });
  }
  if (isPublic) {
    sharing.setVisibility(db, accounts.owner.id, detail.tree.id, "public");
  }
  return {
    treeId: detail.tree.id,
    rootId,
    childId: child.id,
    highlightId: highlight.id,
    revision: committed.revision,
    viewerId: accounts.viewer.id,
  };
}

interface Row {
  name: string;
  run: (caller: Caller, seeded: Seeded) => Promise<unknown>;
  expect: Record<Role, Outcome>;
}

/** Outcomes by role, in `ROLES` order. */
function by(
  owner: Outcome,
  commenter: Outcome,
  viewer: Outcome,
  reader: Outcome,
  stranger: Outcome,
  guest: Outcome,
): Record<Role, Outcome> {
  return { owner, commenter, viewer, reader, stranger, guest };
}

/** Readable by everyone who may read the thread, guests included. */
const PUBLIC_READ = by("ok", "ok", "ok", "ok", "NOT_FOUND", "ok");
/** Readable by every signed-in reader. */
const SIGNED_IN_READ = by("ok", "ok", "ok", "ok", "NOT_FOUND", "UNAUTHORIZED");
/** A commenter's or the owner's: asking, noting, highlighting, recaps. */
const COMMENTER = by("ok", "ok", "FORBIDDEN", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED");
/** The owner's alone. */
const OWNER = by("ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED");
/** Per person, for anyone with a place for the thread: the owner and its
 * members (Archive, Trash, Delete as leaving). */
const MEMBER = by("ok", "ok", "ok", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED");

const ROWS: readonly Row[] = [
  // ── reading ───────────────────────────────────────────────────────────────
  {
    name: "research.getTree",
    run: (caller, s) => caller.research.getTree({ treeId: s.treeId }),
    expect: PUBLIC_READ,
  },
  {
    name: "research.getNodeContent",
    run: (caller, s) => caller.research.getNodeContent({ nodeId: s.rootId }),
    expect: PUBLIC_READ,
  },
  {
    name: "followups.list",
    run: (caller, s) => caller.followups.list({ treeId: s.treeId }),
    expect: SIGNED_IN_READ,
  },
  {
    name: "sharing.listMembers",
    run: (caller, s) => caller.sharing.listMembers({ treeId: s.treeId }),
    expect: SIGNED_IN_READ,
  },
  {
    name: "events.presence",
    run: (caller, s) => caller.events.presence({ treeId: s.treeId }),
    expect: SIGNED_IN_READ,
  },
  {
    name: "research.markTreeViewed",
    run: (caller, s) => caller.research.markTreeViewed({ treeId: s.treeId }),
    expect: SIGNED_IN_READ,
  },
  {
    name: "subscriptions.set",
    run: (caller, s) => caller.subscriptions.set({ treeId: s.treeId, value: true }),
    expect: SIGNED_IN_READ,
  },

  // ── asking, notes, highlights, recaps ─────────────────────────────────────
  {
    name: "research.forkNode",
    run: (caller, s) => caller.research.forkNode({ parentNodeId: s.rootId, prompt: "Branch" }),
    expect: COMMENTER,
  },
  {
    name: "followups.ask",
    run: (caller, s) => caller.followups.ask({ headNodeId: s.rootId, prompt: "And then?" }),
    expect: COMMENTER,
  },
  {
    name: "highlights.create",
    run: (caller, s) =>
      caller.highlights.create({
        nodeId: s.rootId,
        anchor: anchorFor(s.revision, "probabilistic", 15),
      }),
    expect: COMMENTER,
  },
  {
    name: "recaps.generateCandidate",
    run: (caller, s) =>
      caller.recaps.generateCandidate({
        nodeId: s.rootId,
        expectedResponseRevision: s.revision,
        instructions: "Summarize.",
      }),
    expect: COMMENTER,
  },
  {
    name: "recaps.applyCandidate",
    run: (caller, s) =>
      caller.recaps.applyCandidate({
        nodeId: s.rootId,
        expectedResponseRevision: s.revision,
        candidate: {
          id: "cand-1",
          text: "A summary.",
          responseRevision: s.revision,
          instructions: "Summarize.",
          generatedAt: Date.now(),
          adapter: "gemini",
          model: "gemini-flash",
        },
      }),
    expect: COMMENTER,
  },

  // ── someone else's content (the owner's) ──────────────────────────────────
  {
    name: "highlights.remove of the owner's highlight",
    run: (caller, s) => caller.highlights.remove({ nodeId: s.rootId, highlightId: s.highlightId }),
    expect: OWNER,
  },
  {
    name: "highlights.removeMany of the owner's highlight",
    run: (caller, s) =>
      caller.highlights.removeMany({ nodeId: s.rootId, highlightIds: [s.highlightId] }),
    expect: OWNER,
  },
  {
    name: "research.renameNode of the owner's question",
    run: (caller, s) => caller.research.renameNode({ nodeId: s.rootId, title: "Renamed" }),
    expect: OWNER,
  },
  {
    name: "research.generateTitle of the owner's question",
    run: (caller, s) => caller.research.generateTitle({ nodeId: s.rootId }),
    expect: OWNER,
  },
  {
    name: "research.removeBranch of the owner's follow-up",
    run: (caller, s) => caller.research.removeBranch({ nodeId: s.childId }),
    expect: OWNER,
  },
  {
    name: "research.cancelNode of the owner's follow-up",
    run: (caller, s) => caller.research.cancelNode({ nodeId: s.childId }),
    expect: OWNER,
  },
  {
    name: "research.retryNode of the owner's question",
    run: (caller, s) => caller.research.retryNode({ nodeId: s.rootId }),
    expect: OWNER,
  },
  {
    name: "research.rerunNode of the owner's question",
    run: (caller, s) => caller.research.rerunNode({ nodeId: s.rootId }),
    expect: OWNER,
  },

  // ── the thread itself ─────────────────────────────────────────────────────
  {
    name: "research.renameTree",
    run: (caller, s) => caller.research.renameTree({ treeId: s.treeId, title: "Renamed" }),
    expect: OWNER,
  },
  {
    name: "research.setChainOrder",
    run: (caller, s) =>
      caller.research.setChainOrder({ headNodeId: s.rootId, nodeIds: [s.childId, s.rootId] }),
    expect: OWNER,
  },
  {
    name: "sharing.setVisibility",
    run: (caller, s) => caller.sharing.setVisibility({ treeId: s.treeId, visibility: "public" }),
    expect: OWNER,
  },
  {
    name: "sharing.setRole",
    run: (caller, s) =>
      caller.sharing.setRole({ treeId: s.treeId, userId: s.viewerId, role: "commenter" }),
    expect: OWNER,
  },
  {
    name: "sharing.removeMember",
    run: (caller, s) => caller.sharing.removeMember({ treeId: s.treeId, userId: s.viewerId }),
    expect: OWNER,
  },
  {
    name: "invites.create",
    run: (caller, s) => caller.invites.create({ treeId: s.treeId, role: "viewer" }),
    expect: OWNER,
  },
  {
    name: "invites.list",
    run: (caller, s) => caller.invites.list({ treeId: s.treeId }),
    expect: OWNER,
  },

  // ── per person ────────────────────────────────────────────────────────────
  {
    name: "research.archiveTree",
    run: (caller, s) => caller.research.archiveTree({ treeId: s.treeId }),
    expect: MEMBER,
  },
  {
    name: "research.restoreTree",
    run: (caller, s) => caller.research.restoreTree({ treeId: s.treeId }),
    expect: MEMBER,
  },
  {
    name: "research.trashTree",
    run: (caller, s) => caller.research.trashTree({ treeId: s.treeId }),
    expect: MEMBER,
  },
  {
    name: "research.restoreTreeFromTrash",
    run: (caller, s) => caller.research.restoreTreeFromTrash({ treeId: s.treeId }),
    expect: MEMBER,
  },
  {
    name: "research.removeTree",
    run: (caller, s) => caller.research.removeTree({ treeId: s.treeId }),
    expect: MEMBER,
  },
  {
    name: "sharing.leave",
    run: (caller, s) => caller.sharing.leave({ treeId: s.treeId }),
    expect: by("FORBIDDEN", "ok", "ok", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"),
  },
];

const ACCESS_CODES = new Set(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"]);

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    if (error.code === "INTERNAL_SERVER_ERROR") return `internal: ${error.message}`;
    return ACCESS_CODES.has(error.code) ? error.code : "ok";
  }
}

for (const row of ROWS) {
  test(`access matrix: ${row.name}`, async (t) => {
    const harness = createHarness(t);
    const accounts: Accounts = {
      owner: harness.addUser("matrix-owner"),
      commenter: harness.addUser("matrix-commenter"),
      viewer: harness.addUser("matrix-viewer"),
      reader: harness.addUser("matrix-reader"),
      stranger: harness.addUser("matrix-stranger"),
    };
    for (const role of ROLES) {
      const seeded = seed(harness.db, accounts, role === "reader" || role === "guest");
      const caller = harness.caller(role === "guest" ? null : accounts[role]);
      t.is(await outcomeOf(row.run(caller, seeded)), row.expect[role], `${row.name} as ${role}`);
    }
  });
}

test("workspaces are their owner's: another account's ids are not found", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("ws-owner");
  const stranger = harness.addUser("ws-stranger");
  const workspace = workspaces.ensureDefault(harness.db, owner.id);
  const caller = harness.caller(stranger);
  const attempts: [string, () => Promise<unknown>][] = [
    [
      "research.createTree",
      () =>
        caller.research.createTree({
          prompt: "Whose workspace?",
          model: "gemini-flash",
          workspaceId: workspace.id,
        }),
    ],
    [
      "research.importReport",
      () =>
        caller.research.importReport({
          markdown: "# A report\n\nBody.",
          prompt: "An import",
          workspaceId: workspace.id,
        }),
    ],
    ["workspaces.rename", () => caller.workspaces.rename({ workspaceId: workspace.id, name: "X" })],
    ["workspaces.remove", () => caller.workspaces.remove({ workspaceId: workspace.id })],
    ["settings.update", () => caller.settings.update({ defaultWorkspaceId: workspace.id })],
    ["research.listTrash", () => caller.research.listTrash({ workspaceId: workspace.id })],
  ];
  for (const [name, run] of attempts) {
    const outcome = await outcomeOf(run());
    // An empty list is the same answer as a refusal for a list.
    t.true(outcome === "NOT_FOUND" || name === "research.listTrash", `${name}: ${outcome}`);
  }
  t.deepEqual(await caller.research.listTrash({ workspaceId: workspace.id }), []);
});
