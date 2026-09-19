// A pass over the rest of the procedure inventory (`03-api-and-events.md` §2)
// and over the boot steps (`13-deployment-fly.md` §5).

import { readFileSync, statSync } from "node:fs";

import { nodes, snapshots } from "@session/db";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import { createLogger } from "../src/logger.js";
import {
  BACKUP_DOCUMENTS_SCRIPT,
  DAILY_INTERVAL_MS,
  SHUTDOWN_DEADLINE_MS,
  backupDocuments,
  drainWithin,
  prepareDataDirectories,
  reconcileRuns,
  writeVertexCredentials,
} from "../src/main.js";
import {
  INTERNAL_MESSAGE,
  repo,
  trpcCodeForError,
  trpcCodeForRepoError,
} from "../src/trpc/errors.js";
import { searchFeatures } from "../src/trpc/routers/system.js";

import { ARTIFACT_ORIGIN, answerTurn, createHarness, testConfig } from "./helpers.js";

test("returns health status and runtime config for unauthenticated requests", async (t) => {
  const harness = createHarness(t);
  const anonymous = harness.caller(null);
  t.deepEqual(await anonymous.system.health(), { ok: true, version: "0.0.0" });
  const config = await anonymous.system.runtimeConfig();
  t.is(config.limits.runsPerUser, 2);
  t.is(config.limits.documentsPerQuestion, 10);
  t.false(config.limits.enforced);
  // The artifact origin travels here because the preview panel validates
  // `postMessage` against it (`11-artifacts-and-browser.md` §3).
  t.deepEqual(config.features, {
    webSearch: true,
    searchVendor: "parallel",
    artifactOrigin: ARTIFACT_ORIGIN,
  });
  t.is(await anonymous.auth.me(), null);
  await t.throwsAsync(harness.caller(null).settings.get(), { message: /sign in/ });
});

test("guests read the public catalog and cannot mutate it", async (t) => {
  const harness = createHarness(t);
  const owner = harness.addUser("publisher", { isAdmin: true });
  const other = harness.addUser("other-account");
  const signedIn = harness.caller(owner);
  const otherCaller = harness.caller(other);
  const workspace = await signedIn.workspaces.ensureDefault();
  const otherWorkspace = await otherCaller.workspaces.ensureDefault();
  const created = await signedIn.research.createTree({
    prompt: "What is collective memory?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const otherTree = await otherCaller.research.createTree({
    prompt: "A private question",
    model: "gemini-flash",
    workspaceId: otherWorkspace.id,
  });
  const nodeId = created.nodes[0]?.id ?? "";
  snapshots.commit(harness.db, owner.id, {
    nodeId,
    turns: [answerTurn(nodeId, "Collective memory is shared.")],
    outcome: { status: "complete" },
  });
  const page = await signedIn.encyclopedia.requestPage({
    workspaceId: workspace.id,
    term: "Collective memory",
    source: { nodeId, excerpt: "Collective memory is shared.", siblingTerms: [] },
  });

  const guest = harness.caller(null);
  const listed = await guest.workspaces.list();
  t.is(listed[0]?.id, workspace.id);
  const trees = await guest.research.listTrees({ workspaceId: workspace.id });
  t.is(trees.length, 1);
  t.is(trees[0]?.title, "What is collective memory?");
  const detail = await guest.research.getTree({ treeId: created.tree.id });
  t.is(detail.tree.id, created.tree.id);
  const content = await guest.research.getNodeContent({ nodeId });
  t.is(content.node.id, nodeId);
  const activity = await guest.feed.recentActivity({ workspaceId: workspace.id });
  t.is(activity.items.length, 1);
  t.is(
    (await guest.encyclopedia.getPage({ workspaceId: workspace.id, slug: page.slug }))?.slug,
    page.slug,
  );

  const otherSeesOwner = await otherCaller.research.listTrees({ workspaceId: workspace.id });
  t.is(otherSeesOwner.length, 0);
  await t.throwsAsync(guest.research.getTree({ treeId: otherTree.tree.id }), {
    message: /not found/,
  });
  await t.throwsAsync(guest.research.getNodeContent({ nodeId: otherTree.nodes[0]?.id ?? "" }), {
    message: /not found/,
  });
  await t.throwsAsync(
    guest.encyclopedia.getPage({ workspaceId: otherWorkspace.id, slug: page.slug }),
    { message: /not found/ },
  );
  await t.throwsAsync(guest.research.listActivity(), { message: /sign in/ });
  await t.throwsAsync(
    guest.research.createTree({
      prompt: "Should not work",
      model: "gemini-flash",
      workspaceId: workspace.id,
    }),
    { message: /sign in/ },
  );
});

test("selects available search vendor based on configured API keys", (t) => {
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
    ["Default Workspace", "Reading"],
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

test("scopes feed activity and encyclopedia pages to the workspace", async (t) => {
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

test("a queued backlog is capped per account", async (t) => {
  // `SESSION_RUNS_PER_USER` bounds how many of an account's runs hold a
  // provider stream at once; nothing bounded how many were admitted, and a
  // queued node is spend the deployment has already committed to. The harness
  // never claims, so everything launched here stays waiting.
  const harness = createHarness(t, { env: { SESSION_QUEUED_PER_USER: "3" } });
  const user = harness.addUser("flooder");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const launch = (n: number) =>
    caller.research.createTree({
      prompt: `Question ${n}`,
      model: "gemini-flash",
      workspaceId: workspace.id,
    });

  await launch(1);
  await launch(2);
  await launch(3);
  const refused = await t.throwsAsync<TRPCError>(launch(4));
  t.is(refused?.code, "TOO_MANY_REQUESTS");
  t.regex(refused?.message ?? "", /3 questions queued/);

  // The cap is on what is waiting, not on what has ever been launched: a node
  // that leaves the queue makes room.
  const trees = await caller.research.listTrees({ workspaceId: workspace.id });
  await caller.research.cancelNode({ nodeId: trees[0]?.rootNodeId ?? "" });
  await t.notThrowsAsync(launch(5), "a finished question frees its slot");

  // An admin is exempt, as they are from the daily limits.
  const admin = harness.addUser("cap-admin", { isAdmin: true });
  const adminCaller = harness.caller(admin);
  const adminWorkspace = await adminCaller.workspaces.ensureDefault();
  for (let index = 0; index < 5; index += 1) {
    await adminCaller.research.createTree({
      prompt: `Admin question ${index}`,
      model: "gemini-flash",
      workspaceId: adminWorkspace.id,
    });
  }
  t.pass();
});

test("maps unexpected internal errors to INTERNAL_SERVER_ERROR and masks details from client responses", (t) => {
  // A driver failure — a full volume, a busy timeout, a corrupt page — has a
  // message written for a DBA and matches none of the copy patterns. Answering
  // `BAD_REQUEST` with that message blames the caller for the server's failure
  // and hands out the schema, and it leaves the one class of error worth
  // paging on indistinguishable from a typo in a form.
  const sqlite = Object.assign(new Error("no such column: nodes.doesnt_exist"), {
    name: "SqliteError",
    code: "SQLITE_ERROR",
  });
  const full = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });

  for (const error of [sqlite, full, new TypeError("x.map is not a function")]) {
    const thrown = t.throws<TRPCError>(() =>
      repo(() => {
        throw error;
      }),
    );
    t.is(thrown?.code, "INTERNAL_SERVER_ERROR", `${error.name} is the server's fault`);
    t.is(thrown?.message, INTERNAL_MESSAGE, "and its own message does not reach the client");
    t.is(thrown?.cause, error, "the real error is kept for the log");
  }

  // Deliberate, user-facing refusals are unchanged.
  t.is(trpcCodeForRepoError("research node abc was not found"), "NOT_FOUND");
  t.is(trpcCodeForRepoError("Research node title is required."), "BAD_REQUEST");
  t.is(trpcCodeForError(new Error("Research node title is required.")), "BAD_REQUEST");
  // The reorder's foreign-id message: the same answer as an absent one.
  t.is(
    trpcCodeForRepoError("research tree t1 is not in the requested sidebar section"),
    "NOT_FOUND",
  );
});

test("enforces shutdown deadline during drain to ensure WAL checkpoint execution", async (t) => {
  // Fly sends SIGKILL `kill_timeout` (30s) after SIGTERM. A provider that has
  // stopped sending without closing its stream holds the drain open past that,
  // the checkpoint never runs, and the next boot opens a database with an
  // unclean log. What the deadline cuts short is recovered by
  // `reconcileOnBoot`; a SIGKILL mid-checkpoint is not.
  t.is(await drainWithin(() => Promise.resolve(), 50), true, "a prompt drain reports success");

  const startedAt = Date.now();
  const stuck = await drainWithin(() => new Promise<void>(() => undefined), 50);
  t.is(stuck, false, "a drain that never finishes is abandoned");
  t.true(Date.now() - startedAt < 1_000, "and abandoned at the deadline, not later");

  // The deadline leaves room inside `kill_timeout` for the close and the
  // checkpoint that follow it.
  t.true(SHUTDOWN_DEADLINE_MS < 30_000);
});

test("the document backup is scheduled in process and is a no-op without a replica", async (t) => {
  // `/data/documents` is files on a volume that Litestream does not replicate,
  // so losing the volume loses every uploaded file. The script runs from here
  // rather than from an external scheduler because the deployment is one
  // machine holding one volume (`13-deployment-fly.md` §6).
  t.is(DAILY_INTERVAL_MS, 24 * 60 * 60 * 1000);
  t.true(statSync(BACKUP_DOCUMENTS_SCRIPT).isFile(), "the script resolves from this module");
  // Executable, because it is run directly rather than through a shell.
  t.is(statSync(BACKUP_DOCUMENTS_SCRIPT).mode & 0o111, 0o111);

  const logs: string[] = [];
  const logger = createLogger({
    level: "error",
    write: (line: string) => logs.push(line),
  });
  const withoutReplica = testConfig("/tmp/session-backup-config");
  t.is(withoutReplica.documentsReplicaUrl, null);
  t.is(withoutReplica.litestreamReplicaUrl, null);
  await backupDocuments(withoutReplica, logger);
  t.deepEqual(logs, [], "nothing is spawned and nothing is logged");
});
