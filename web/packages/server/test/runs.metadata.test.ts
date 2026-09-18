// Metadata runs: titles, recaps, and encyclopedia pages on `gemini-flash`
// (`04-agent-runtime.md` §9).

import { encyclopedia, nodes as nodesRepo, snapshots as snapshotsRepo, usage } from "@session/db";
import { MIN_RECAP_CHARS, defaultTitle, normalizeRecap, recapJobKey } from "@session/shared";
import test from "ava";

import { setFixtureScenario } from "../src/runs/fixtureProvider.js";

import { answerTurn, createHarness } from "./helpers.js";
import { collectEvents, createAgentHarness } from "./runsHelpers.js";

/** An answer long enough to be worth summarizing (`MIN_RECAP_CHARS`). */
const LONG_ANSWER = `${"A bloom filter trades a tunable false-positive rate for constant space per element. ".repeat(
  20,
)}`;

async function completedNode(harness: ReturnType<typeof createAgentHarness>, login: string) {
  const user = harness.addUser(login);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is a bloom filter?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  const commit = snapshotsRepo.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, LONG_ANSWER)],
    outcome: { status: "complete" },
  });
  return { user, caller, workspace, nodeId, revision: commit.revision };
}

test.serial("a title is generated, sanitized, and given to the thread", async (t) => {
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await completedNode(harness, "titler");

  const title = await caller.research.generateTitle({ nodeId });
  t.true(title.length > 0);
  t.true(title.length <= 80);
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.title, title);
  const tree = nodesRepo.get(harness.db, user.id, nodeId)?.treeId ?? "";
  t.is((await caller.research.getTree({ treeId: tree })).tree.title, title, "the thread is named");

  const totals = usage.dailyTotals(harness.db, user.id);
  t.true(totals.inputTokens > 0, "a metadata run records its usage too");
});

test.serial("a recap candidate is generated, previewed, and applied", async (t) => {
  const harness = createAgentHarness(t);
  const { user, caller, nodeId, revision } = await completedNode(harness, "recapper");
  const events = collectEvents(t, harness, user.id, [nodeId]);

  const candidate = await caller.recaps.generateCandidate({
    nodeId,
    expectedResponseRevision: revision,
    instructions: "Summarize in one sentence.",
  });
  t.is(candidate.responseRevision, revision);
  t.is(candidate.model, "gemini-flash");
  t.is(candidate.instructions, "Summarize in one sentence.");
  t.is(normalizeRecap(candidate.text), candidate.text, "the candidate is already normalized");

  t.deepEqual(
    events
      .filter((event) => event.type === "research.recap.pending")
      .map((event) => event.payload["pending"]),
    [true, false],
    "the pending flag is settled on the way out",
  );

  // The server's own copy is what gets stored, whatever comes back over the wire.
  const node = await caller.recaps.applyCandidate({
    nodeId,
    expectedResponseRevision: revision,
    candidate: { ...candidate, text: "text the client made up" },
  });
  t.is(node.recap?.text, candidate.text);

  // A stale revision is refused rather than silently applied.
  await t.throwsAsync(
    caller.recaps.applyCandidate({
      nodeId,
      expectedResponseRevision: "0".repeat(64),
      expectedCurrentRecapId: node.recap?.id ?? null,
      candidate,
    }),
    { message: /different answer|answer changed/ },
  );
});

test.serial(
  "an automatic recap is scheduled once per answer and skipped when too short",
  async (t) => {
    const harness = createAgentHarness(t);
    const { user, nodeId } = await completedNode(harness, "auto");
    const node = nodesRepo.get(harness.db, user.id, nodeId);
    t.truthy(node);
    if (!node) {
      return;
    }
    const key = recapJobKey(node);

    const runner = harness.agent.metadata;
    const [first, second] = await Promise.all([
      runner.runScheduledRecap(user.id, nodeId),
      // The same answer, scheduled twice: the dedupe key collapses them.
      runner.runScheduledRecap(user.id, nodeId),
    ]);
    t.true(first || second, "one of the two ran");
    t.false(first && second, "and only one");
    t.false(runner.isRecapPending(key), "the job is no longer pending");
    t.truthy(nodesRepo.get(harness.db, user.id, nodeId)?.recap?.text);

    // A second call now finds a recap already there and declines.
    t.false(await runner.runScheduledRecap(user.id, nodeId));

    // A short answer is below `MIN_RECAP_CHARS` and never reaches the model.
    const short = harness.addUser("brief");
    const caller = harness.caller(short);
    const workspace = await caller.workspaces.ensureDefault();
    const detail = await caller.research.createTree({
      prompt: "short",
      model: "gemini-flash",
      workspaceId: workspace.id,
    });
    const shortId = detail.nodes[0]?.id ?? "";
    snapshotsRepo.commit(harness.db, short.id, {
      nodeId: shortId,
      turns: [answerTurn(shortId, "Too short to summarize.")],
      outcome: { status: "complete" },
    });
    t.true("Too short to summarize.".length < MIN_RECAP_CHARS);
    t.false(await runner.runScheduledRecap(short.id, shortId));
    t.is(nodesRepo.get(harness.db, short.id, shortId)?.recap, undefined);
  },
);

test.serial("an encyclopedia page is generated, split, and linked", async (t) => {
  const harness = createAgentHarness(t);
  const user = harness.addUser("encyclopedist");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const events = collectEvents(t, harness, user.id, []);

  const requested = await caller.encyclopedia.requestPage({
    workspaceId: workspace.id,
    term: "Bloom filter",
    source: { excerpt: "A bloom filter is a probabilistic set.", siblingTerms: ["Hashing"] },
  });
  t.is(requested.status, "generating");

  await harness.agent.idle();
  const page = encyclopedia.getPage(harness.db, user.id, workspace.id, "bloom-filter");
  t.is(page?.status, "ready");
  t.is(page?.title, "Bloom filter", "the leading heading became the title");
  t.false(page?.body.startsWith("# "), "and was taken out of the body");
  t.deepEqual(
    page?.links,
    ["burton-howard-bloom", "lsm-tree"],
    "links are recomputed from the body",
  );
  t.true(
    events.some(
      (event) =>
        event.type === "encyclopedia.page.updated" &&
        (event.payload["page"] as { status?: string } | undefined)?.status === "ready",
    ),
  );
});

test.serial("the noop service reports that metadata runs are unavailable", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("phase3");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "root",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  const commit = snapshotsRepo.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, LONG_ANSWER)],
    outcome: { status: "complete" },
  });
  await t.throwsAsync(
    caller.recaps.generateCandidate({
      nodeId,
      expectedResponseRevision: commit.revision,
      instructions: "Summarize.",
    }),
    { message: /not available on this server/ },
  );
  // The title falls back to what the node already has.
  t.is(typeof (await caller.research.generateTitle({ nodeId })), "string");
});

test.serial("a grounded run records the searches the provider billed", async (t) => {
  setFixtureScenario("grounded");
  const harness = createAgentHarness(t);
  const user = harness.addUser("grounded");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is the Kessler syndrome?",
    model: "gemini-flash-google",
    workspaceId: workspace.id,
  });
  await harness.settle();
  t.is(nodesRepo.get(harness.db, user.id, detail.nodes[0]?.id ?? "")?.status, "complete");

  // Two `webSearchQueries`, billed per query, with no owned tool involved
  // (`04-agent-runtime.md` §6.2).
  const searches = harness.db.$client
    .prepare(`SELECT count(*) AS n FROM usage_events WHERE user_id = ? AND kind = 'search'`)
    .get(user.id) as { n: number };
  t.is(searches.n, 2);
});

test.serial("a rename during title generation is not overwritten", async (t) => {
  // The model takes seconds and the rename is a deliberate act; a generated
  // title is a default, and a default must not replace a decision. The rename
  // lands while `generateTitle` is awaiting the model, which is exactly the
  // window a user hits by naming a thread as soon as its answer appears.
  const harness = createAgentHarness(t);
  const { user, caller, nodeId } = await completedNode(harness, "renamer");

  const generating = caller.research.generateTitle({ nodeId });
  const renamed = await caller.research.renameNode({ nodeId, title: "My own name" });
  t.is(renamed.title, "My own name");

  const returned = await generating;
  t.is(returned, "My own name", "the generator reports the name that is actually set");
  t.is(nodesRepo.get(harness.db, user.id, nodeId)?.title, "My own name");
  // The thread rename rides along with the generated title, so skipping the
  // generated title skips that too: the thread keeps the name it had rather
  // than taking one the user did not ask for.
  const treeId = nodesRepo.get(harness.db, user.id, nodeId)?.treeId ?? "";
  const tree = (await caller.research.getTree({ treeId })).tree;
  t.is(tree.title, defaultTitle("What is a bloom filter?"));
});
