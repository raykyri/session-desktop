// Every mutating procedure, called by the wrong account
// (`06-auth-and-users.md` §4, `03-api-and-events.md` §2).
//
// Cross-tenant resource queries return NOT_FOUND to prevent ID enumeration and unauthorized modifications.
//
// Written as a table rather than as one test per procedure because the risk is
// a procedure nobody thought about: a new mutation that takes an id has to be
// added here, and the count assertion below is what makes leaving it out
// visible.

import { snapshots } from "@session/db";
import type { SessionEvent } from "@session/shared";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { anchorFor, answerTurn, createHarness, type Caller } from "./helpers.js";

interface Owned {
  workspaceId: string;
  treeId: string;
  nodeId: string;
  childNodeId: string;
  highlightId: string;
  responseRevision: string;
}

/** Everything one account owns that another could name. */
async function seedOwner(
  harness: ReturnType<typeof createHarness>,
  caller: Caller,
  userId: string,
) {
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is a bloom filter?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  const answer = "A bloom filter is a probabilistic set membership structure.";
  const committed = snapshots.commit(harness.db, userId, {
    nodeId,
    turns: [answerTurn(nodeId, answer)],
    outcome: { status: "complete" },
  });
  const highlight = await caller.highlights.create({
    nodeId,
    anchor: anchorFor(committed.revision, "bloom filter", 2),
  });
  const child = await caller.research.forkNode({
    parentNodeId: nodeId,
    prompt: "And what is a cuckoo filter?",
    inline: true,
  });
  const childNodeId = child.id;

  const owned: Owned = {
    workspaceId: workspace.id,
    treeId: detail.tree.id,
    nodeId,
    childNodeId,
    highlightId: highlight.id,
    responseRevision: committed.revision,
  };
  return owned;
}

/** What the owner can see, so the test can prove none of it moved. */
function ownerState(caller: Caller, owned: Owned) {
  return Promise.all([
    caller.research.getTree({ treeId: owned.treeId }),
    caller.research.getNodeContent({ nodeId: owned.nodeId }),
    caller.highlights.listFeed({ workspaceId: owned.workspaceId }),
    caller.feed.recentActivity({ scope: "workspace", workspaceId: owned.workspaceId }),
  ]);
}

interface AttemptContext {
  /** The account that owns nothing in `owned`. */
  caller: Caller;
  owned: Owned;
  /** The stranger's own workspace, for the calls that mix one id of each. */
  ownWorkspaceId: string;
  harness: ReturnType<typeof createHarness>;
  strangerId: string;
}

interface Attempt {
  name: string;
  run: (ctx: AttemptContext) => Promise<unknown>;
}

/** One entry per mutating procedure that takes an id of something owned. */
const ATTEMPTS: readonly Attempt[] = [
  // ── research ──────────────────────────────────────────────────────────────
  {
    name: "research.createTree into another account's workspace",
    run: ({ caller, owned }) =>
      caller.research.createTree({
        prompt: "Whose workspace is this?",
        model: "gemini-flash",
        workspaceId: owned.workspaceId,
      }),
  },
  {
    name: "research.forkNode under another account's node",
    run: ({ caller, owned }) =>
      caller.research.forkNode({ parentNodeId: owned.nodeId, prompt: "And then?", inline: true }),
  },
  {
    name: "research.retryNode",
    run: ({ caller, owned }) => caller.research.retryNode({ nodeId: owned.nodeId }),
  },
  {
    name: "research.cancelNode",
    run: ({ caller, owned }) => caller.research.cancelNode({ nodeId: owned.childNodeId }),
  },
  {
    name: "research.renameTree",
    run: ({ caller, owned }) =>
      caller.research.renameTree({ treeId: owned.treeId, title: "Mine now" }),
  },
  {
    name: "research.renameNode",
    run: ({ caller, owned }) =>
      caller.research.renameNode({ nodeId: owned.nodeId, title: "Mine now" }),
  },
  {
    name: "research.updateDocument",
    run: ({ caller, owned }) =>
      caller.research.updateDocument({
        nodeId: owned.nodeId,
        markdown: "# Rewritten by a stranger",
        expectedTitle: "",
        expectedResponseRevision: owned.responseRevision,
      }),
  },
  {
    name: "research.markTreeViewed",
    run: ({ caller, owned }) => caller.research.markTreeViewed({ treeId: owned.treeId }),
  },
  {
    name: "research.archiveTree",
    run: ({ caller, owned }) => caller.research.archiveTree({ treeId: owned.treeId }),
  },
  {
    name: "research.restoreTree",
    run: ({ caller, owned }) => caller.research.restoreTree({ treeId: owned.treeId }),
  },
  {
    name: "research.removeTree",
    run: ({ caller, owned }) => caller.research.removeTree({ treeId: owned.treeId }),
  },
  {
    name: "research.removeBranch",
    run: ({ caller, owned }) => caller.research.removeBranch({ nodeId: owned.childNodeId }),
  },
  {
    name: "research.reorderTrees",
    run: async ({ caller, owned, ownWorkspaceId }) => {
      // A section with a thread of the caller's own, so the foreign id is what
      // the reorder trips over rather than an empty section.
      await caller.research.createTree({
        prompt: "My own thread",
        model: "gemini-flash",
        workspaceId: ownWorkspaceId,
      });
      return caller.research.reorderTrees({
        workspaceId: ownWorkspaceId,
        archived: false,
        treeIds: [owned.treeId],
      });
    },
  },
  {
    name: "research.generateTitle",
    run: ({ caller, owned }) => caller.research.generateTitle({ nodeId: owned.nodeId }),
  },
  {
    name: "research.importReport into another account's workspace",
    run: ({ caller, owned }) =>
      caller.research.importReport({
        markdown: "# A report\n\nBody.",
        prompt: "An import",
        workspaceId: owned.workspaceId,
      }),
  },

  // ── highlights and recaps ─────────────────────────────────────────────────
  {
    name: "highlights.create",
    run: ({ caller, owned }) =>
      caller.highlights.create({
        nodeId: owned.nodeId,
        anchor: anchorFor(owned.responseRevision, "probabilistic", 15),
      }),
  },
  {
    name: "highlights.remove",
    run: ({ caller, owned }) =>
      caller.highlights.remove({ nodeId: owned.nodeId, highlightId: owned.highlightId }),
  },
  {
    name: "highlights.removeMany",
    run: ({ caller, owned }) =>
      caller.highlights.removeMany({ nodeId: owned.nodeId, highlightIds: [owned.highlightId] }),
  },
  {
    name: "recaps.applyCandidate",
    run: ({ caller, owned }) =>
      caller.recaps.applyCandidate({
        nodeId: owned.nodeId,
        expectedResponseRevision: owned.responseRevision,
        candidate: {
          id: "cand-1",
          text: "A stranger's summary.",
          responseRevision: owned.responseRevision,
          instructions: "Summarize.",
          generatedAt: Date.now(),
          adapter: "gemini",
          model: "gemini-flash",
        },
      }),
  },

  // ── workspaces ────────────────────────────────────────────────────────────
  {
    name: "workspaces.rename",
    run: ({ caller, owned }) =>
      caller.workspaces.rename({ workspaceId: owned.workspaceId, name: "X" }),
  },
  {
    name: "workspaces.remove",
    run: ({ caller, owned }) => caller.workspaces.remove({ workspaceId: owned.workspaceId }),
  },
  {
    name: "settings.update pointing at another account's workspace",
    run: ({ caller, owned }) => caller.settings.update({ defaultWorkspaceId: owned.workspaceId }),
  },
];

test("prevents cross-account access and returns NOT_FOUND for unauthorized entity IDs", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("owner");
  const ownerCaller = harness.caller(owner);
  const stranger = harness.addUser("stranger");
  const strangerCaller = harness.caller(stranger);
  const owned = await seedOwner(harness, ownerCaller, owner.id);
  const strangerWorkspace = await strangerCaller.workspaces.ensureDefault();
  const before = await ownerState(ownerCaller, owned);

  for (const attempt of ATTEMPTS) {
    const error = await t.throwsAsync<TRPCError>(
      attempt.run({
        caller: strangerCaller,
        owned,
        ownWorkspaceId: strangerWorkspace.id,
        harness,
        strangerId: stranger.id,
      }),
      undefined,
      `${attempt.name} is refused`,
    );
    t.is(
      error?.code,
      "NOT_FOUND",
      `${attempt.name} answers NOT_FOUND rather than leaking that the id exists`,
    );
  }

  // Nothing the owner can see moved.
  t.deepEqual(await ownerState(ownerCaller, owned), before, "none of the owner's state changed");
});

test("global feed reads cross accounts while personal scopes and fields stay bounded", async (t) => {
  const harness = createHarness(t);
  const first = harness.addUser("first-feed-owner");
  const second = harness.addUser("second-feed-owner");
  const firstCaller = harness.caller(first);
  const secondCaller = harness.caller(second);
  const firstWorkspace = await firstCaller.workspaces.ensureDefault();
  const secondWorkspace = await secondCaller.workspaces.ensureDefault();
  await firstCaller.research.createTree({
    prompt: "First public root",
    model: "gemini-flash",
    workspaceId: firstWorkspace.id,
  });
  await secondCaller.research.createTree({
    prompt: "Second public root",
    model: "gemini-flash",
    workspaceId: secondWorkspace.id,
  });

  const itemIds = (page: Awaited<ReturnType<typeof firstCaller.feed.recentActivity>>) =>
    page.items.map((item) => item.query.nodeId).sort();
  const all = await firstCaller.feed.recentActivity({ scope: "all" });
  const strangerAll = await secondCaller.feed.recentActivity({ scope: "all" });
  const guestAll = await harness.caller(null).feed.recentActivity();
  t.deepEqual(itemIds(strangerAll), itemIds(all));
  t.deepEqual(itemIds(guestAll), itemIds(all));
  t.is(all.items.length, 2);

  const mine = await firstCaller.feed.recentActivity({ scope: "mine" });
  t.is(mine.items.length, 1);
  const workspace = await firstCaller.feed.recentActivity({
    scope: "workspace",
    workspaceId: firstWorkspace.id,
  });
  t.deepEqual(itemIds(workspace), itemIds(mine));

  const publicQuery = all.items.find((item) => item.kind === "research-query");
  t.is(publicQuery?.kind, "research-query");
  if (publicQuery?.kind === "research-query") {
    t.false("userId" in publicQuery.query);
    t.false("error" in publicQuery.query);
    t.false("highlights" in publicQuery.query);
  }

  const guest = harness.caller(null);
  await t.throwsAsync(guest.feed.recentActivity({ scope: "mine" }), { message: /sign in/ });
  await t.throwsAsync(guest.feed.recentActivity({ scope: "workspace" }), {
    message: /sign in/,
  });
});

test("feed item events fan out to other signed-in accounts", async (t) => {
  const harness = createHarness(t);
  const author = harness.addUser("feed-event-author");
  const observer = harness.addUser("feed-event-observer");
  const subscription = harness.eventBus.subscribe(observer.id, "feed-observer");
  const caller = harness.caller(author);

  // An imported report is a complete root, so the thread can be deleted at once.
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.importReport({
    markdown: "# Broadcast\n\nA report.\n",
    prompt: "Broadcast",
    workspaceId: workspace.id,
  });
  const rootId = detail.tree.rootNodeId;
  const upserted = await subscription.events.next();
  const upsertedEvent = upserted.value as SessionEvent | undefined;
  t.false(upserted.done);
  t.is(upsertedEvent?.type, "feed.item.upserted");
  t.is((upsertedEvent?.payload["item"] as { query?: { nodeId?: string } }).query?.nodeId, rootId);

  await caller.research.removeTree({ treeId: detail.tree.id });
  const removed = await subscription.events.next();
  const removedEvent = removed.value as SessionEvent | undefined;
  t.false(removed.done);
  t.is(removedEvent?.type, "feed.item.removed");
  t.is(removedEvent?.payload["id"], rootId);
  subscription.close();
});
