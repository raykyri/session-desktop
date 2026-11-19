// The run queue and attempts of server jobs, and API keys at rest (phase 2a).

import { randomBytes } from "node:crypto";

import test from "ava";

import { KeyCipher, apiKeys, runs, users } from "../src/index.js";

import { addUser, createFixture } from "./helpers.js";

test("a run is queued once, claimed once, requeued after a 429, and released", (t) => {
  const { db, userId } = createFixture(t);
  t.true(runs.enqueue(db, { runId: "R1", userId, provider: "anthropic", at: 10 }));
  t.false(
    runs.enqueue(db, { runId: "R1", userId, provider: "anthropic", at: 20 }),
    "at least once",
  );
  runs.enqueue(db, { runId: "R2", userId, provider: "vertex", at: 15 });
  t.deepEqual(
    runs.waiting(db, 100).map((r) => r.runId),
    ["R1", "R2"],
  );
  t.true(runs.claim(db, "R1", 30));
  t.false(runs.claim(db, "R1", 31));
  t.deepEqual(
    runs.claimed(db).map((r) => r.runId),
    ["R1"],
  );
  t.is(runs.runningCounts(db).byUser.get(userId), 1);
  t.is(runs.runningCounts(db).byProvider.get("anthropic"), 1);
  runs.requeue(db, "R1", 1000);
  t.deepEqual(
    runs.waiting(db, 100).map((r) => r.runId),
    ["R2"],
    "held back until notBefore",
  );
  t.deepEqual(
    runs.waiting(db, 1000).map((r) => r.runId),
    ["R1", "R2"],
  );
  runs.claim(db, "R1");
  t.is(runs.noteResume(db, "R1"), 1);
  t.is(runs.noteResume(db, "R1"), 2);
  runs.setSeq(db, "R1", 41);
  t.is(runs.get(db, "R1")?.seq, 41);
  t.is(runs.countOfUser(db, userId), 2);
  runs.release(db, "R1");
  t.is(runs.get(db, "R1"), null);
});

test("attempts are numbered within their run", (t) => {
  const { db } = createFixture(t);
  const a = runs.startAttempt(db, { runId: "R1", kind: "fresh", model: "m", payer: "session" });
  const b = runs.startAttempt(db, { runId: "R1", kind: "resume", model: "m", payer: "K1" });
  t.deepEqual([a, b], [1, 2]);
  runs.finishAttempt(db, {
    runId: "R1",
    n: 2,
    outcome: "complete",
    steps: 3,
    usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 },
  });
  const rows = runs.attempts(db, "R1");
  t.like(rows[1], { n: 2, kind: "resume", payer: "K1", outcome: "complete", steps: 3 });
  t.is(rows[0]?.outcome, null);
});

test("an API key is stored encrypted; its fingerprint finds a duplicate of the same person only", (t) => {
  const { db, userId, handle } = createFixture(t);
  const other = addUser(db, "Other");
  const cipher = new KeyCipher(randomBytes(32));
  const raw = "sk-ant-SECRET-VALUE-0001";
  apiKeys.put(db, cipher, {
    id: "K1",
    userId,
    handle,
    raw,
    mask: "sk-ant-…0001",
    provider: "Anthropic",
  });
  const row = apiKeys.get(db, "K1");
  t.truthy(row);
  t.false(JSON.stringify(db.$client.prepare("SELECT * FROM api_keys").all()).includes("SECRET"));
  t.is(apiKeys.raw(db, cipher, "K1"), raw);
  t.is(apiKeys.findByRaw(db, cipher, userId, handle, raw), "K1");
  t.is(apiKeys.findByRaw(db, cipher, other.userId, other.handle, raw), null);
  t.throws(
    () => apiKeys.raw(db, new KeyCipher(randomBytes(32)), "K1"),
    undefined,
    "another key opens nothing",
  );
  apiKeys.put(db, cipher, {
    id: "K1",
    userId,
    handle,
    raw: "sk-or-NEW-0002",
    mask: "m",
    provider: "OpenRouter",
  });
  t.is(apiKeys.raw(db, cipher, "K1"), "sk-or-NEW-0002");
  t.is(apiKeys.findByRaw(db, cipher, userId, handle, raw), null);
  apiKeys.remove(db, "K1");
  t.deepEqual(apiKeys.list(db, userId), []);
});

test("a handle is the login in lower case when the account is made, and stays", (t) => {
  const { db } = createFixture(t);
  const a = users.upsertFromGitHub(db, { githubId: 1, login: "Mel-Cho" }).user;
  t.is(a.handle, "mel-cho");
  const renamed = users.upsertFromGitHub(db, { githubId: 1, login: "MelC" }).user;
  t.is(renamed.handle, "mel-cho");
  const b = users.upsertFromGitHub(db, { githubId: 2, login: "mel-cho" }).user;
  t.is(b.handle, "mel-cho-2", "a login reused after a rename gets a free handle");
  t.is(users.findByHandle(db, "mel-cho")?.id, a.id);
  t.is(users.upsertFromGitHub(db, { githubId: 3, login: "null" }).user.handle, "null-1");
});
