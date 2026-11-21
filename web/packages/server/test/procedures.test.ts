// A pass over the rest of the procedure inventory (`03-api-and-events.md` §2)
// and over the boot steps (`13-deployment-fly.md` §5).

import { readFileSync, statSync } from "node:fs";

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
  writeVertexCredentials,
} from "../src/main.js";
import {
  INTERNAL_MESSAGE,
  repo,
  trpcCodeForError,
  trpcCodeForRepoError,
} from "../src/trpc/errors.js";
import { searchFeatures } from "../src/trpc/routers/system.js";

import { createHarness, testConfig } from "./helpers.js";

test("returns health status and runtime config for unauthenticated requests", async (t) => {
  const harness = createHarness(t);
  const anonymous = harness.caller(null);
  t.deepEqual(await anonymous.system.health(), { ok: true, version: "0.0.0" });
  const config = await anonymous.system.runtimeConfig();
  t.is(config.limits.runsPerUser, 2);
  t.false(config.limits.enforced);
  t.deepEqual(config.features, { webSearch: true, searchVendor: "parallel" });
  t.is(await anonymous.auth.me(), null);
  await t.throwsAsync(harness.caller(null).settings.get(), { message: /sign in/ });
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

test("usage and the admin surface are gated on is_admin", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("plain");
  const admin = harness.addUser("chief", { isAdmin: true });
  const summary = await harness.caller(user).usage.summary();
  t.is(summary.runs, 0);
  t.is(summary.dailyRunLimit, 10);
  // @ts-expect-error Only the current UTC day is supported, including at runtime.
  await t.throwsAsync(harness.caller(user).usage.summary({ days: 7 }));

  await t.throwsAsync(harness.caller(user).admin.models.list(), { message: /administrator/ });
  t.like(await harness.caller(admin).admin.models.list(), { defaultModel: "gemini-flash" });
});

test("boot writes the Vertex credential", (t) => {
  const harness = createHarness(t);
  prepareDataDirectories(harness.config);
  const path = writeVertexCredentials(harness.config);
  t.truthy(path);
  t.is(readFileSync(path ?? "", "utf8"), '{"type":"service_account"}');
  t.is(process.env["GOOGLE_APPLICATION_CREDENTIALS"], path ?? undefined);
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
  // unclean log. What the deadline cuts short is recovered at boot; a SIGKILL
  // mid-checkpoint is not.
  //
  // The deadline timer is unref'd, as it must be in the server; this keeps
  // the worker's event loop alive until it fires, which the other tests in
  // the file do only when they happen to still be running.
  const keepAlive = setInterval(() => undefined, 10);
  t.teardown(() => clearInterval(keepAlive));
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
