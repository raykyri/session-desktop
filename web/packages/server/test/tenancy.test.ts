// Every mutating procedure, called by the wrong account
// (`06-auth-and-users.md` §4, `03-api-and-events.md` §2).
//
// The rule is one sentence: a row another account owns answers exactly as a
// row that does not exist. `NOT_FOUND` either way, so an id is never an
// existence oracle, and nothing on the owner's side moves.
//
// Written as a table rather than as one test per procedure because the risk is
// a procedure nobody thought about: a new mutation that takes an id has to be
// added here, and the count assertion below is what makes leaving it out
// visible.

import { documents as documentsRepo, journal as journalRepo, snapshots } from "@session/db";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { anchorFor, answerTurn, createHarness, type Caller } from "./helpers.js";

interface Owned {
  workspaceId: string;
  treeId: string;
  nodeId: string;
  childNodeId: string;
  documentId: string;
  highlightId: string;
  responseRevision: string;
  journalEntryId: string;
  encyclopediaSlug: string;
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

  // A document with no node referencing it, so `documents.remove` is reachable.
  const document = documentsRepo.create(harness.db, userId, {
    workspaceId: workspace.id,
    name: "notes.txt",
    mime: "text/plain",
    byteSize: 12,
    sha256: "a".repeat(64),
    storagePath: `${harness.config.documentsDir}/${userId}/${"a".repeat(64)}`,
  });

  const entry = await caller.journal.add({ url: "https://example.com/an-article" });
  const page = await caller.encyclopedia.requestPage({
    workspaceId: workspace.id,
    term: "Bloom filter",
    source: { excerpt: "A bloom filter is probabilistic.", siblingTerms: [] },
  });

  const owned: Owned = {
    workspaceId: workspace.id,
    treeId: detail.tree.id,
    nodeId,
    childNodeId,
    documentId: document.id,
    highlightId: highlight.id,
    responseRevision: committed.revision,
    journalEntryId: entry.id,
    encyclopediaSlug: page.slug,
  };
  return owned;
}

/** What the owner can see, so the test can prove none of it moved. */
function ownerState(caller: Caller, owned: Owned) {
  return Promise.all([
    caller.research.getTree({ treeId: owned.treeId }),
    caller.research.getNodeContent({ nodeId: owned.nodeId }),
    caller.highlights.listFeed({ workspaceId: owned.workspaceId }),
    caller.documents.list({ workspaceId: owned.workspaceId }),
    caller.encyclopedia.listPages({ workspaceId: owned.workspaceId }),
    caller.feed.recentActivity({ workspaceId: owned.workspaceId }),
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
    name: "research.createTree attaching another account's document",
    run: ({ caller, owned, ownWorkspaceId }) =>
      caller.research.createTree({
        prompt: "Read this for me",
        model: "gemini-flash",
        workspaceId: ownWorkspaceId,
        documentIds: [owned.documentId],
      }),
  },
  {
    name: "research.forkNode under another account's node",
    run: ({ caller, owned }) =>
      caller.research.forkNode({ parentNodeId: owned.nodeId, prompt: "And then?", inline: true }),
  },
  {
    name: "research.forkNode attaching another account's document",
    run: async ({ caller, owned, ownWorkspaceId, harness, strangerId }) => {
      const mine = await caller.research.createTree({
        prompt: "My own thread",
        model: "gemini-flash",
        workspaceId: ownWorkspaceId,
      });
      const myNodeId = mine.nodes[0]?.id ?? "";
      snapshots.commit(harness.db, strangerId, {
        nodeId: myNodeId,
        turns: [answerTurn(myNodeId, "My own answer.")],
        outcome: { status: "complete" },
      });
      return caller.research.forkNode({
        parentNodeId: myNodeId,
        prompt: "Read this for me",
        inline: true,
        documentIds: [owned.documentId],
      });
    },
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
    name: "research.setTreeFollowed",
    run: ({ caller, owned }) =>
      caller.research.setTreeFollowed({ treeId: owned.treeId, value: true }),
  },
  {
    name: "research.setTreeBookmarked",
    run: ({ caller, owned }) =>
      caller.research.setTreeBookmarked({ treeId: owned.treeId, value: true }),
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
    run: ({ caller, owned, ownWorkspaceId }) =>
      caller.research.reorderTrees({
        workspaceId: ownWorkspaceId,
        archived: false,
        treeIds: [owned.treeId],
      }),
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
          model: "gemini-flash",
        },
      }),
  },

  // ── journal ───────────────────────────────────────────────────────────────
  {
    name: "journal.update",
    run: ({ caller, owned }) =>
      caller.journal.update({
        id: owned.journalEntryId,
        entry: {
          id: owned.journalEntryId,
          kind: "link",
          url: "https://evil.example/taken-over",
          createdAt: new Date().toISOString(),
        },
      }),
  },
  {
    name: "journal.restore",
    run: ({ caller, owned }) =>
      caller.journal.restore({
        entry: {
          id: owned.journalEntryId,
          kind: "link",
          url: "https://evil.example/taken-over",
          createdAt: new Date().toISOString(),
        },
      }),
  },
  {
    name: "journal.remove",
    run: ({ caller, owned }) => caller.journal.remove({ id: owned.journalEntryId }),
  },
  {
    name: "journal.hydrateTweet",
    run: ({ caller, owned }) => caller.journal.hydrateTweet({ entryId: owned.journalEntryId }),
  },

  // ── encyclopedia ──────────────────────────────────────────────────────────
  {
    name: "encyclopedia.requestPage",
    run: ({ caller, owned }) =>
      caller.encyclopedia.requestPage({
        workspaceId: owned.workspaceId,
        term: "Bloom filter",
        source: { excerpt: "A bloom filter is probabilistic.", siblingTerms: [] },
      }),
  },
  {
    name: "encyclopedia.regeneratePage",
    run: ({ caller, owned }) =>
      caller.encyclopedia.regeneratePage({
        workspaceId: owned.workspaceId,
        slug: owned.encyclopediaSlug,
      }),
  },
  {
    name: "encyclopedia.deletePage",
    run: ({ caller, owned }) =>
      caller.encyclopedia.deletePage({
        workspaceId: owned.workspaceId,
        slug: owned.encyclopediaSlug,
      }),
  },

  // ── documents and workspaces ──────────────────────────────────────────────
  {
    name: "documents.remove",
    run: ({ caller, owned }) => caller.documents.remove({ documentId: owned.documentId }),
  },
  {
    name: "artifacts.mintToken",
    run: ({ caller, owned }) => caller.artifacts.mintToken({ documentId: owned.documentId }),
  },
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

test("no account can name another's rows", async (t) => {
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

  // Nothing the owner can see moved, and in particular the document is still
  // deletable — an unchecked `node_documents` insert would have pinned it in
  // place for good, because `documents.remove` refuses an attached document.
  t.deepEqual(await ownerState(ownerCaller, owned), before, "none of the owner's state changed");
  t.true(
    journalRepo.get(harness.db, owner.id, owned.journalEntryId)?.url ===
      "https://example.com/an-article",
    "the owner's journal entry was not taken over",
  );
  t.deepEqual(
    documentsRepo.attachedTo(harness.db, stranger.id, owned.nodeId),
    [],
    "no node_documents row was written from a foreign id",
  );
  await t.notThrowsAsync(
    ownerCaller.documents.remove({ documentId: owned.documentId }),
    "the owner can still delete their own document",
  );
});
