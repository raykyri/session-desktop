// Logging, budgets, backups, pruning and configuration (review round 3).

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";

import { auth, runs, tweets } from "@session/db";
import type { TRPCError } from "@trpc/server";
import test from "ava";

import {
  DAILY_INTERVAL_MS,
  createDocumentBackupScheduler,
  documentsBackupAgeSeconds,
  documentsBackupDue,
  documentsBackupStampPath,
} from "../src/backups.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { sweepExpired } from "../src/main.js";
import { MetricsRegistry, renderMetrics } from "../src/metrics.js";
import { loggedPath } from "../src/middleware/logging.js";
import { RATE_LIMITS } from "../src/middleware/rateLimit.js";

import { createHarness, testConfig } from "./helpers.js";

const silent = createLogger({ level: "error", write: () => undefined });

test("invitation, artifact and widget tokens never reach the access log", (t) => {
  t.is(loggedPath("/invite/abc123"), "/invite/[redacted]");
  t.is(loggedPath("/invite/abc123/"), "/invite/[redacted]");
  t.is(loggedPath("/w/token"), "/w/[redacted]");
  t.is(loggedPath("/a/token"), "/a/[redacted]");
  t.is(loggedPath("/r/tree-1"), "/r/tree-1");
  t.is(loggedPath("/invite"), "/invite");
});

test("renewing open threads does not spend the mutation budget", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("renewer");
  const caller = harness.caller(user);
  for (let index = 0; index < RATE_LIMITS.mutations.limit + 10; index += 1) {
    await caller.events.setInterest({ connectionId: "gone", nodeIds: [] });
  }
  // Edits still go through.
  await t.notThrowsAsync(caller.workspaces.ensureDefault());
  await t.notThrowsAsync(caller.workspaces.create({ name: "Still allowed" }));
});

async function answeredQuestion(harness: ReturnType<typeof createHarness>, login: string) {
  const user = harness.addUser(login);
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is a bloom filter?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.tree.rootNodeId;
  return { user, caller, nodeId, workspace };
}

test("titles and recaps asked for are refused past the daily limit, before the run", async (t) => {
  const harness = createHarness(t, {
    env: { SESSION_ENFORCE_LIMITS: "1", SESSION_DAILY_RUNS: "1" },
  });
  const { caller, nodeId } = await answeredQuestion(harness, "limited");
  // The question's first attempt uses the day's one run (`daily_runs`
  // counts attempts).
  runs.startAttempt(harness.db, { nodeId, attempt: 1, kind: "fresh", model: "gemini-flash" });
  const title = await t.throwsAsync<TRPCError>(caller.research.generateTitle({ nodeId }));
  t.is(title.code, "TOO_MANY_REQUESTS");
  const recap = await t.throwsAsync<TRPCError>(
    caller.recaps.generateCandidate({
      nodeId,
      expectedResponseRevision: "r",
      instructions: "Summarize.",
    }),
  );
  t.is(recap.code, "TOO_MANY_REQUESTS");
  t.deepEqual(harness.runs.metadata, [], "no metadata run was requested");
});

test("titles asked for draw on their own budget", async (t) => {
  const harness = createHarness(t);
  const { caller, nodeId } = await answeredQuestion(harness, "titler");
  for (let index = 0; index < RATE_LIMITS.metadata.limit; index += 1) {
    await caller.research.generateTitle({ nodeId });
  }
  const refused = await t.throwsAsync<TRPCError>(caller.research.generateTitle({ nodeId }));
  t.is(refused.code, "TOO_MANY_REQUESTS");
  t.is(harness.runs.metadata.length, RATE_LIMITS.metadata.limit);
});

test("an imported report is recapped after the import and after a body edit", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("importer");
  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.importReport({
    markdown: "# A report\n\nBloom filters answer membership with false positives.",
    prompt: "What are bloom filters?",
    workspaceId: workspace.id,
  });
  const root = detail.nodes[0];
  if (!root) return t.fail();
  t.deepEqual(harness.runs.metadata, [{ kind: "recap", userId: user.id, nodeId: root.id }]);
  const content = await caller.research.getNodeContent({ nodeId: root.id });
  const edited = await caller.research.updateDocument({
    nodeId: root.id,
    markdown: "# A report\n\nA new body.",
    expectedTitle: detail.tree.title,
    expectedResponseRevision: content.responseRevision ?? "",
    expectedHighlightIds: [],
  });
  t.true(edited.markdownChanged);
  t.is(harness.runs.metadata.length, 2);
  // A title-only save keeps the body and schedules nothing.
  const after = await caller.research.getNodeContent({ nodeId: root.id });
  await caller.research.updateDocument({
    nodeId: root.id,
    markdown: "# A report\n\nA new body.",
    title: "Renamed report",
    expectedTitle: edited.tree.title,
    expectedResponseRevision: after.responseRevision ?? "",
  });
  t.is(harness.runs.metadata.length, 2);
});

test("the document archive runs when the last one is a day old, once at a time", async (t) => {
  const harness = createHarness(t, {
    env: { LITESTREAM_REPLICA_URL: "s3://bucket/session" },
  });
  const { config } = harness;
  t.is(documentsBackupAgeSeconds(config), null);
  t.true(documentsBackupDue(config), "never archived: due");
  let started = 0;
  let finish: () => void = () => undefined;
  const scheduler = createDocumentBackupScheduler(config, silent, () => {
    started += 1;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const first = scheduler.check();
  void scheduler.check();
  t.is(started, 1, "a check during a run does nothing");
  // The script touches its marker on success.
  mkdirSync(config.tmpDir, { recursive: true });
  writeFileSync(documentsBackupStampPath(config), "");
  finish();
  await first;
  t.false(documentsBackupDue(config));
  await scheduler.check();
  t.is(started, 1, "a fresh archive is not repeated");

  const old = (Date.now() - DAILY_INTERVAL_MS - 60_000) / 1000;
  utimesSync(documentsBackupStampPath(config), old, old);
  t.true(documentsBackupDue(config));
  const metrics = renderMetrics({
    deps: harness.deps,
    config,
    registry: new MetricsRegistry(),
    health: "ready",
  });
  t.regex(metrics, /session_documents_backup_age_seconds (\d+)/);
  const age = Number(/session_documents_backup_age_seconds (\d+)/.exec(metrics)?.[1]);
  t.true(age * 1000 >= DAILY_INTERVAL_MS);
  void scheduler.check();
  t.is(started, 2);
  finish();

  // Without a replica nothing is due and no gauge is rendered.
  const plain = createHarness(t);
  t.false(documentsBackupDue(plain.config));
  t.false(
    renderMetrics({
      deps: plain.deps,
      config: plain.config,
      registry: new MetricsRegistry(),
      health: "ready",
    }).includes("session_documents_backup_age_seconds"),
  );
});

test("maintenance prunes expired post caches and old sign-up attempts", (t) => {
  const harness = createHarness(t);
  const at = Date.now();
  tweets.put(harness.db, { tweetId: "1", status: "unavailable", failure: "gone" });
  harness.db.$client
    .prepare("UPDATE tweet_cache SET fetched_at = ? WHERE tweet_id = '1'")
    .run(at - 7 * 60 * 60 * 1000);
  tweets.put(harness.db, { tweetId: "2", status: "unavailable", failure: "gone" });
  auth.recordSignupAttempt(harness.db, "ip", "created", at - auth.SIGNUP_ATTEMPT_RETENTION_MS - 1);
  auth.recordSignupAttempt(harness.db, "ip", "created", at);
  sweepExpired(harness.deps, harness.limiter, silent, at);
  t.is(tweets.get(harness.db, "1"), null);
  t.not(tweets.get(harness.db, "2"), null);
  t.is(auth.countSignupAttempts(harness.db, "ip", 0), 1);
});

test("concurrency caps of zero are refused", (t) => {
  for (const name of [
    "SESSION_RUNS_PER_USER",
    "SESSION_QUEUED_PER_USER",
    "SESSION_RUNS_GEMINI",
    "SESSION_RUNS_OPENROUTER",
    "SESSION_RUNS_ANTHROPIC",
  ]) {
    const error = t.throws(() =>
      loadConfig({
        SESSION_PUBLIC_ORIGIN: "http://localhost:8787",
        SESSION_ARTIFACT_ORIGIN: "http://artifacts.localhost:8787",
        [name]: "0",
      }),
    );
    t.true(error instanceof ConfigError, name);
    t.true((error as ConfigError).issues.join("\n").includes(name), name);
  }
  t.is(testConfig("/tmp/session-config-caps", { SESSION_RUNS_PER_USER: "1" }).limits.perUser, 1);
  // Daily limits may still be zero.
  t.is(testConfig("/tmp/session-config-caps", { SESSION_DAILY_RUNS: "0" }).limits.dailyRuns, 0);
});
