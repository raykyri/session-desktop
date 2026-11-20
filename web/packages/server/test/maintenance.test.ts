// Logging, budgets, backups, pruning and configuration (review round 3).

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";

import { auth } from "@session/db";
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

test("maintenance prunes old sign-up attempts", (t) => {
  const harness = createHarness(t);
  const at = Date.now();
  auth.recordSignupAttempt(harness.db, "ip", "created", at - auth.SIGNUP_ATTEMPT_RETENTION_MS - 1);
  auth.recordSignupAttempt(harness.db, "ip", "created", at);
  sweepExpired(harness.deps, harness.limiter, silent, at);
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
