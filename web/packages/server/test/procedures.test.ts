// A pass over the rest of the procedure inventory (`03-api-and-events.md` §2)
// and over the boot steps (`13-deployment-fly.md` §5).

import { readFileSync } from "node:fs";

import { nodes, snapshots } from "@session/db";
import test from "ava";

import { createLogger } from "../src/logger.js";
import { prepareDataDirectories, reconcileRuns, writeVertexCredentials } from "../src/main.js";
import { searchFeatures } from "../src/trpc/routers/system.js";

import { answerTurn, createHarness, testConfig } from "./helpers.js";

test("system.health and runtimeConfig answer without a session", async (t) => {
  const harness = createHarness(t);
  const anonymous = harness.caller(null);
  t.deepEqual(await anonymous.system.health(), { ok: true, version: "0.0.0" });
  const config = await anonymous.system.runtimeConfig();
  t.is(config.limits.runsPerUser, 2);
  t.is(config.limits.documentsPerQuestion, 10);
  t.false(config.limits.enforced);
  t.deepEqual(config.features, { webSearch: true, searchVendor: "parallel" });
  t.is(await anonymous.auth.me(), null);
  await t.throwsAsync(harness.caller(null).settings.get(), { message: /sign in/ });
});

test("the search vendor falls back to whichever key exists", (t) => {
  const withTavilyOnly = testConfig("/tmp/session-config", {
    PARALLEL_API_KEY: "",
    TAVILY_API_KEY: "tavily-key",
  });
  t.deepEqual(searchFeatures(withTavilyOnly), { webSearch: true, searchVendor: "tavily" });
  const withNeither = testConfig("/tmp/session-config", { PARALLEL_API_KEY: "" });
  t.deepEqual(searchFeatures(withNeither), { webSearch: false });
});

test("settings round-trip with the shared instruction clamp", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("settler"));
  const initial = await caller.settings.get();
  t.is(initial.defaultModel, "gemini-flash");
  t.is(initial.researchLaunchInstruction, null);

  const updated = await caller.settings.update({
    settings: { appearance: "light", textSize: 16 },
    researchLaunchInstruction: "x".repeat(5000),
  });
  t.is(updated.appearance, "light");
  t.is(updated.textSize, 16);
  // 4 KiB cap from `shared`, applied before the row is written.
  t.is(Buffer.byteLength(updated.researchLaunchInstruction ?? "", "utf8"), 4096);
  t.is((await caller.settings.get()).appearance, "light");

  await t.throwsAsync(caller.settings.update({ settings: { textSize: 400 } }));
});

test("drafts are per key and cleared by an empty value", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("drafter"));
  t.is((await caller.drafts.get({ key: "home" })).value, null);
  await caller.drafts.set({ key: "home", value: "half a question" });
  t.is((await caller.drafts.get({ key: "home" })).value, "half a question");
  await caller.drafts.set({ key: "home", value: "" });
  t.is((await caller.drafts.get({ key: "home" })).value, null);
});

test("usage and the admin surface are gated on is_admin", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("plain");
  const admin = harness.addUser("chief", { isAdmin: true });
  const summary = await harness.caller(user).usage.summary();
  t.is(summary.runs, 0);
  t.is(summary.dailyRunLimit, 10);

  await t.throwsAsync(harness.caller(user).admin.listUsers(), { message: /administrator/ });
  const listed = await harness.caller(admin).admin.listUsers();
  t.is(listed.length, 2);
  t.true(listed.every((entry) => entry.limits.dailyRuns === 10));

  const limits = await harness.caller(admin).admin.setLimits({ userId: user.id, dailyRuns: 3 });
  t.is(limits.dailyRuns, 3);
  t.is((await harness.caller(user).usage.summary()).dailyRunLimit, 3);
  await t.throwsAsync(harness.caller(admin).admin.setLimits({ userId: "nobody", dailyRuns: 1 }), {
    message: /was not found/,
  });
});

test("workspaces and folders behave as the sidebar expects", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("organizer"));
  const first = await caller.workspaces.ensureDefault();
  const second = await caller.workspaces.create({ name: "Reading" });
  t.deepEqual(
    (await caller.workspaces.list()).map((workspace) => workspace.name),
    ["Research", "Reading"],
  );
  await caller.workspaces.reorder({ workspaceIds: [second.id, first.id] });
  t.deepEqual(
    (await caller.workspaces.list()).map((workspace) => workspace.id),
    [second.id, first.id],
  );
  const renamed = await caller.workspaces.rename({ workspaceId: second.id, name: "Notes" });
  t.is(renamed.name, "Notes");
  t.is((await caller.workspaces.setDefault({ workspaceId: second.id })).id, second.id);
  t.is((await caller.settings.get()).defaultWorkspaceId, second.id);

  const state = await caller.folders.set({
    workspaceId: first.id,
    state: {
      folders: [{ id: "f1", name: "Later", workspaceId: first.id }],
      membership: {},
      starred: [],
      collapsed: [],
    },
  });
  t.is(state.folders.length, 1);
  t.is((await caller.folders.get({ workspaceId: first.id })).folders[0]?.name, "Later");

  const removal = await caller.workspaces.remove({ workspaceId: second.id });
  t.deepEqual(removal.removedTreeIds, []);
  t.is((await caller.workspaces.list()).length, 1);
});

test("the feed and the encyclopedia answer over the same workspace", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("browser");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is a skip list?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  snapshots.commit(harness.db, user.id, {
    nodeId,
    turns: [answerTurn(nodeId, "A [[Skip List]] is a layered linked list.")],
    outcome: { status: "complete" },
  });

  const activity = await caller.feed.recentActivity({ workspaceId: workspace.id });
  t.is(activity.items.length, 1);
  const queries = await caller.feed.recentQueries({ limit: 10 });
  t.is(queries.items.length, 1);
  t.is((await caller.research.listActivity()).length, 0);

  const page = await caller.encyclopedia.requestPage({
    workspaceId: workspace.id,
    term: "Skip List",
    source: { nodeId, excerpt: "A skip list is a layered linked list.", siblingTerms: [] },
  });
  t.is(page.slug, "skip-list");
  t.is(page.status, "generating");
  t.deepEqual(harness.runs.metadata.at(-1), {
    kind: "encyclopedia",
    userId: user.id,
    workspaceId: workspace.id,
    slug: "skip-list",
  });
  t.is((await caller.encyclopedia.listPages({ workspaceId: workspace.id })).length, 1);
  t.is(
    (await caller.encyclopedia.getPage({ workspaceId: workspace.id, slug: "skip-list" }))?.slug,
    "skip-list",
  );
  t.deepEqual(
    await caller.encyclopedia.deletePage({ workspaceId: workspace.id, slug: "skip-list" }),
    {
      removed: true,
    },
  );
});

test("boot writes the Vertex credential and re-queues interrupted runs", async (t) => {
  const harness = createHarness(t);
  prepareDataDirectories(harness.config);
  const path = writeVertexCredentials(harness.config);
  t.truthy(path);
  t.is(readFileSync(path ?? "", "utf8"), '{"type":"service_account"}');
  t.is(process.env["GOOGLE_APPLICATION_CREDENTIALS"], path ?? undefined);

  const user = harness.addUser("resumer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "long run",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";
  nodes.setStatus(harness.db, user.id, nodeId, "running", { startedAt: Date.now() });

  // A process that dies leaves a `running` node with no outcome; boot turns it
  // into `interrupted` and puts it back at the head of the queue.
  harness.runs.started.length = 0;
  reconcileRuns(harness.deps, harness.deps.logger ?? createLogger({ write: () => undefined }));
  t.is(nodes.get(harness.db, user.id, nodeId)?.status, "interrupted");
  t.deepEqual(harness.runs.started, [nodeId]);
});

test("a default workspace must be one of the account's own", async (t) => {
  const harness = createHarness(t);
  const caller = harness.caller(harness.addUser("settler2"));
  const stranger = harness.caller(harness.addUser("stranger3"));
  const own = await caller.workspaces.ensureDefault();
  const foreign = await stranger.workspaces.ensureDefault();
  await t.throwsAsync(caller.settings.update({ defaultWorkspaceId: foreign.id }), {
    message: /was not found/,
  });
  t.is((await caller.settings.update({ defaultWorkspaceId: own.id })).defaultWorkspaceId, own.id);
  t.is((await caller.settings.update({ defaultWorkspaceId: null })).defaultWorkspaceId, null);
});
