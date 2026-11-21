// Members' own API keys (`03-agents-and-research.md` K4, K7; ADR-23): the
// key is checked with the provider during `apiKeys.set` and saved only when
// the provider accepts it; it is stored sealed, never raw; a key a run finds
// rejected becomes `invalid`. Every provider answer is a stub: no test
// reaches the network.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { apiKeys as keyRepo, billing, tableRowCount } from "@session/db";
import test from "ava";

import { DEVELOPMENT_SECRET_KEY } from "../src/config.js";
import { storedAllowances } from "../src/keys/allowances.js";
import {
  KEY_CHECK_TIMEOUT_MS,
  PROVIDER_MODELS_URL,
  checkWithProvider,
  keyContext,
} from "../src/keys/apiKeys.js";
import { payerFacts } from "../src/runs/allowance.js";
import { fixturePageFetch } from "../src/runs/fixtureProvider.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";
import { createSecretBox } from "../src/secretBox.js";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";
import { until } from "./runsHelpers.js";

const ANTHROPIC_KEY = "sk-ant-api03-k4-raw-key-must-never-be-stored-a1f9";
const OPENAI_KEY = "sk-proj-k4-openai-raw-key-must-never-be-stored-77c2";

interface ProviderCall {
  url: string;
  headers: Headers;
}

/** A provider stub: `answer` decides each call; every call is recorded. */
function providerStub(answer: (call: ProviderCall, init?: RequestInit) => Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: ProviderCall[];
} {
  const calls: ProviderCall[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const call = { url, headers: new Headers(init?.headers) };
      calls.push(call);
      return answer(call, init);
    },
  };
}

const accepts = () => providerStub(() => Promise.resolve(Response.json({ data: [] })));
const status = (code: number) =>
  providerStub(() => Promise.resolve(new Response("{}", { status: code })));

function savedNothing(t: Parameters<typeof createHarness>[0], harness: Harness) {
  t.is(tableRowCount(harness.db, "api_keys"), 0, "nothing is saved");
}

test("an accepted key is saved valid and stored sealed: the database file holds no raw key", async (t) => {
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch });
  const user = harness.addUser("keyholder");
  const caller = harness.caller(user);

  const anthropic = await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  const openai = await caller.apiKeys.set({ provider: "openai", raw: `  ${OPENAI_KEY}\n` });
  t.deepEqual(anthropic, {
    provider: "anthropic",
    last4: "a1f9",
    status: "valid",
    addedAt: anthropic.addedAt,
  });
  t.deepEqual(openai, {
    provider: "openai",
    last4: "77c2",
    status: "valid",
    addedAt: openai.addedAt,
  });
  t.true(Number.isInteger(anthropic.addedAt) && anthropic.addedAt > 0);
  t.deepEqual(await caller.apiKeys.list(), [anthropic, openai]);
  // Reads never carry the key or its sealed form.
  const reading = JSON.stringify(await caller.usage.get());
  t.false(reading.includes("sk-"));
  t.false(reading.includes("v1."));

  /** Every file of the database (main, WAL, shared memory) holds neither
   * raw key, as UTF-8 or UTF-16. */
  const scan = (when: string) => {
    const files = readdirSync(harness.directory).filter((name) => name.startsWith("session.db"));
    t.true(files.includes("session.db"), when);
    for (const name of files) {
      const bytes = readFileSync(join(harness.directory, name));
      for (const raw of [ANTHROPIC_KEY, OPENAI_KEY]) {
        t.is(bytes.indexOf(raw), -1, `${when}: ${name} holds no raw key`);
        t.is(bytes.indexOf(Buffer.from(raw, "utf16le")), -1, `${when}: ${name}, UTF-16`);
      }
    }
    return files;
  };
  // Before the checkpoint the writes are in the WAL; after it, in the file.
  t.true(scan("before the checkpoint").includes("session.db-wal"));
  harness.db.$client.pragma("wal_checkpoint(TRUNCATE)");
  scan("after the checkpoint");

  // Nor does anything the server logged.
  const logged = harness.logs.join("\n");
  t.true(logged.includes("api key checked"), "the check is logged");
  for (const raw of [ANTHROPIC_KEY, OPENAI_KEY]) {
    t.false(logged.includes(raw));
    t.false(logged.includes(raw.slice(8, -4)), "no part of the key either");
  }

  // What is stored opens to the key, under the configured key and the
  // owner's context only.
  const stored = keyRepo.find(harness.db, user.id, "anthropic");
  const box = createSecretBox(harness.config.secretKey);
  t.is(box.open(stored?.sealed ?? "", keyContext(user.id, "anthropic")), ANTHROPIC_KEY);
  t.throws(() => box.open(stored?.sealed ?? "", keyContext("someone-else", "anthropic")));
  t.throws(() => box.open(stored?.sealed ?? "", keyContext(user.id, "openai")));
  t.throws(() =>
    createSecretBox(Buffer.alloc(32, 1)).open(
      stored?.sealed ?? "",
      keyContext(user.id, "anthropic"),
    ),
  );
});

test("apiKeys.set: 5 checks per 10 minutes per account, then TOO_MANY_REQUESTS", async (t) => {
  let now = 1_000_000;
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch, limiterNow: () => now });
  const caller = harness.caller(harness.addUser("eager"));
  for (let index = 0; index < 5; index += 1) {
    await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  }
  await t.throwsAsync(caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY }), {
    code: "TOO_MANY_REQUESTS",
  });
  t.is(provider.calls.length, 5, "the refused call reached no provider");
  // Format errors reach no provider and do not count.
  await t.throwsAsync(caller.apiKeys.set({ provider: "openai", raw: "sk-short" }), {
    code: "BAD_REQUEST",
  });
  // Another account has its own five.
  await harness
    .caller(harness.addUser("other"))
    .apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  // One check comes back every two minutes.
  now += 120_000;
  await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  await t.throwsAsync(caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY }), {
    code: "TOO_MANY_REQUESTS",
  });
});

test("apiKeys.set: at most 60 checks a minute across all accounts", async (t) => {
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch, limiterNow: () => 5_000_000 });
  for (let index = 0; index < 12; index += 1) {
    const caller = harness.caller(harness.addUser(`member${index}`));
    for (let call = 0; call < 5; call += 1) {
      await caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
    }
  }
  t.is(provider.calls.length, 60);
  const error = await t.throwsAsync(
    harness.caller(harness.addUser("sixty-first")).apiKeys.set({
      provider: "openai",
      raw: OPENAI_KEY,
    }),
  );
  t.like(error, { code: "TOO_MANY_REQUESTS" });
  t.is(provider.calls.length, 60);
});

test("apiKeys.set: one check in flight per account", async (t) => {
  // Each check waits until the test answers it, oldest first.
  const waiting: ((response: Response) => void)[] = [];
  const answer = (response: Response) => waiting.shift()?.(response);
  const held = providerStub(() => new Promise<Response>((resolve) => waiting.push(resolve)));
  const harness = createHarness(t, { fetch: held.fetch });
  const user = harness.addUser("double");
  const caller = harness.caller(user);
  const first = caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  await until(() => held.calls.length === 1, "the first check");
  const second = await t.throwsAsync(caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY }));
  t.like(second, { code: "TOO_MANY_REQUESTS" });
  // Another account is not held up.
  const other = harness.caller(harness.addUser("bystander"));
  const parallel = other.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  await until(() => held.calls.length === 2, "the other account's check");
  answer(Response.json({ data: [] }));
  t.like(await first, { status: "valid" });
  answer(Response.json({ data: [] }));
  t.like(await parallel, { status: "valid" });
  // The slot is free again once the first check ended.
  const third = caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  await until(() => held.calls.length === 3, "the next check");
  answer(Response.json({ data: [] }));
  t.like(await third, { status: "valid" });
});

test("a redirect from the provider is never followed and reads as unreachable", async (t) => {
  const inits: RequestInit[] = [];
  const redirecting = providerStub((_call, init) => {
    if (init) inits.push(init);
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
    );
  });
  const harness = createHarness(t, { fetch: redirecting.fetch });
  const error = await t.throwsAsync(
    harness.caller(harness.addUser("redirected")).apiKeys.set({
      provider: "anthropic",
      raw: ANTHROPIC_KEY,
    }),
  );
  t.like(error, { code: "BAD_GATEWAY" });
  t.is(inits[0]?.redirect, "error");
  // A fetch that refuses the redirect, as `redirect: "error"` makes it.
  const refusing = providerStub(() => Promise.reject(new TypeError("unexpected redirect")));
  t.is(await checkWithProvider("openai", OPENAI_KEY, { fetch: refusing.fetch }), "unreachable");
  savedNothing(t, harness);
});

test("a waiting account cannot list, set or remove keys, or change billing", async (t) => {
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch });
  const caller = harness.caller(harness.addWaitingUser("waiting"));
  await t.throwsAsync(caller.apiKeys.list(), { code: "FORBIDDEN" });
  await t.throwsAsync(caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY }), {
    code: "FORBIDDEN",
  });
  await t.throwsAsync(caller.apiKeys.remove({ provider: "anthropic" }), { code: "FORBIDDEN" });
  await t.throwsAsync(caller.usage.setBilling({ mode: "pause" }), { code: "FORBIDDEN" });
  t.is(provider.calls.length, 0, "no provider was asked");
  savedNothing(t, harness);
});

test("the check lists the provider's models with the provider's own header", async (t) => {
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch });
  const caller = harness.caller(harness.addUser("headers"));
  await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  await caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  const [anthropic, openai] = provider.calls;
  t.is(anthropic?.url, PROVIDER_MODELS_URL.anthropic);
  t.is(anthropic?.headers.get("x-api-key"), ANTHROPIC_KEY);
  t.truthy(anthropic?.headers.get("anthropic-version"));
  t.is(openai?.url, PROVIDER_MODELS_URL.openai);
  t.is(openai?.headers.get("authorization"), `Bearer ${OPENAI_KEY}`);
});

test("a key the provider rejects is refused and not saved", async (t) => {
  for (const code of [401, 403]) {
    const harness = createHarness(t, { fetch: status(code).fetch });
    const caller = harness.caller(harness.addUser(`rejected${code}`));
    const error = await t.throwsAsync(
      caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY }),
    );
    t.like(error, { code: "BAD_REQUEST", message: "That key was rejected by Anthropic." });
    savedNothing(t, harness);
  }
  const harness = createHarness(t, { fetch: status(401).fetch });
  const error = await t.throwsAsync(
    harness.caller(harness.addUser("rejectedopenai")).apiKeys.set({
      provider: "openai",
      raw: OPENAI_KEY,
    }),
  );
  t.like(error, { code: "BAD_REQUEST", message: "That key was rejected by OpenAI." });
  savedNothing(t, harness);
});

test("an unreachable provider refuses the save: a network error, a 5xx, a 429", async (t) => {
  const failing = [
    providerStub(() => Promise.reject(new TypeError("fetch failed"))),
    status(500),
    status(503),
    status(429),
  ];
  for (const [index, provider] of failing.entries()) {
    const harness = createHarness(t, { fetch: provider.fetch });
    const caller = harness.caller(harness.addUser(`unreachable${index}`));
    const error = await t.throwsAsync(caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY }));
    t.like(error, {
      code: "BAD_GATEWAY",
      message: "Couldn't reach OpenAI to check the key. Try again.",
    });
    savedNothing(t, harness);
  }
});

test("a provider that does not answer in time refuses the save", async (t) => {
  t.is(KEY_CHECK_TIMEOUT_MS, 10_000);
  let aborted = false;
  // Answers only when the request is aborted, as a stalled connection does.
  const stalled = providerStub(
    (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason as Error);
        });
      }),
  );
  const harness = createHarness(t, { fetch: stalled.fetch, deps: { keyCheckTimeoutMs: 50 } });
  const caller = harness.caller(harness.addUser("stalled"));
  const started = Date.now();
  const error = await t.throwsAsync(
    caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY }),
  );
  t.like(error, {
    code: "BAD_GATEWAY",
    message: "Couldn't reach Anthropic to check the key. Try again.",
  });
  t.true(aborted, "the request was aborted at the timeout");
  t.true(Date.now() - started < 5_000);
  savedNothing(t, harness);
});

test("checkWithProvider: accepted, rejected and unreachable", async (t) => {
  t.is(await checkWithProvider("openai", OPENAI_KEY, { fetch: accepts().fetch }), "accepted");
  t.is(await checkWithProvider("openai", OPENAI_KEY, { fetch: status(401).fetch }), "rejected");
  t.is(await checkWithProvider("openai", OPENAI_KEY, { fetch: status(404).fetch }), "unreachable");
});

test("format refusals answer the mockup's messages before any provider call", async (t) => {
  const provider = accepts();
  const harness = createHarness(t, { fetch: provider.fetch });
  const caller = harness.caller(harness.addUser("formats"));
  const refusals: [Parameters<typeof caller.apiKeys.set>[0], string][] = [
    [{ provider: "anthropic", raw: "   " }, "Paste a key."],
    [
      { provider: "openai", raw: ANTHROPIC_KEY },
      "That looks like an Anthropic key. Add it under Anthropic.",
    ],
    [
      { provider: "anthropic", raw: OPENAI_KEY },
      "Anthropic keys start with sk-ant- and are longer than this. Copy the whole key from your Anthropic account.",
    ],
    [
      { provider: "openai", raw: "sk-short" },
      "OpenAI keys start with sk- and are longer than this. Copy the whole key from your OpenAI account.",
    ],
  ];
  for (const [input, message] of refusals) {
    const error = await t.throwsAsync(caller.apiKeys.set(input));
    t.like(error, { code: "BAD_REQUEST", message });
  }
  t.is(provider.calls.length, 0, "no provider was asked");
  savedNothing(t, harness);
});

test("remove deletes the key; without an Anthropic key billing returns to pause", async (t) => {
  const harness = createHarness(t, { fetch: accepts().fetch });
  const user = harness.addUser("remover");
  const caller = harness.caller(user);
  await t.throwsAsync(caller.usage.setBilling({ mode: "key" }), { code: "PRECONDITION_FAILED" });
  await caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  await t.throwsAsync(caller.usage.setBilling({ mode: "key" }), {
    code: "PRECONDITION_FAILED",
  });
  await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  t.deepEqual(await caller.usage.setBilling({ mode: "key" }), { billing: "key" });
  t.is((await caller.usage.get()).billing, "key");

  // Removing the OpenAI key leaves billing on the Anthropic key.
  t.deepEqual(await caller.apiKeys.remove({ provider: "openai" }), { removed: true });
  t.is((await caller.usage.get()).billing, "key");
  await caller.apiKeys.set({ provider: "openai", raw: OPENAI_KEY });
  t.deepEqual(await caller.apiKeys.remove({ provider: "anthropic" }), { removed: true });
  t.is((await caller.usage.get()).billing, "pause");
  t.deepEqual(
    (await caller.apiKeys.list()).map((key) => key.provider),
    ["openai"],
  );
  t.deepEqual(await caller.apiKeys.remove({ provider: "anthropic" }), { removed: false });
  // Keys and billing are per member.
  t.deepEqual(await harness.caller(harness.addUser("other")).apiKeys.list(), []);
  await t.throwsAsync(harness.caller(null).apiKeys.list(), { code: "UNAUTHORIZED" });
});

test("a key a run finds rejected becomes invalid, and billing returns to pause", async (t) => {
  const harness = createHarness(t, { fetch: accepts().fetch });
  const user = harness.addUser("revoked");
  const caller = harness.caller(user);
  await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  await caller.usage.setBilling({ mode: "key" });
  const allowances = storedAllowances({
    db: harness.db,
    box: createSecretBox(harness.config.secretKey),
    logger: harness.logger,
    config: harness.config,
  });
  t.is(allowances.billing(user.id), "key");
  const opened = allowances.anthropicKey(user.id);
  t.is(opened?.apiKey, ANTHROPIC_KEY);
  const sealed = keyRepo.find(harness.db, user.id, "anthropic")?.sealed;
  t.is(opened?.sealed, sealed);
  t.is(allowances.validKey(user.id, "anthropic"), sealed ?? null);
  t.is(allowances.validKey(user.id, "openai"), null);

  // A rejection of a key the member has since replaced changes nothing: the
  // sealed value is compared, not the plaintext.
  allowances.keyRejected?.(user.id, "anthropic", "v1.an-older-sealed-key");
  allowances.keyRejected?.(user.id, "anthropic", ANTHROPIC_KEY);
  t.is(keyRepo.find(harness.db, user.id, "anthropic")?.status, "valid");

  allowances.keyRejected?.(user.id, "anthropic", sealed ?? "");
  t.is(keyRepo.find(harness.db, user.id, "anthropic")?.status, "invalid");
  t.is(allowances.anthropicKey(user.id), null, "an invalid key pays for nothing");
  t.is(billing.get(harness.db, user.id), "pause");
  t.like((await caller.apiKeys.list())[0], { provider: "anthropic", status: "invalid" });
  await t.throwsAsync(caller.usage.setBilling({ mode: "key" }), { code: "PRECONDITION_FAILED" });

  // Saving a key again makes it valid.
  await caller.apiKeys.set({ provider: "anthropic", raw: ANTHROPIC_KEY });
  t.is(allowances.anthropicKey(user.id)?.apiKey, ANTHROPIC_KEY);
});

test("a stored key that does not open under the secret key reads invalid and pays for nothing", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("rotated");
  const other = createSecretBox(Buffer.alloc(32, 9));
  keyRepo.save(harness.db, {
    userId: user.id,
    provider: "anthropic",
    sealed: other.seal(ANTHROPIC_KEY, keyContext(user.id, "anthropic")),
    last4: "a1f9",
  });
  const allowances = storedAllowances({
    db: harness.db,
    box: createSecretBox(DEVELOPMENT_SECRET_KEY),
    logger: harness.logger,
    config: harness.config,
  });
  t.is(allowances.anthropicKey(user.id), null);
  // The row says valid, but it cannot pay: reads say invalid, and billing
  // cannot move to `key` on it (`03` K7).
  const caller = harness.caller(user);
  t.deepEqual(
    (await caller.apiKeys.list()).map((key) => [key.provider, key.status]),
    [["anthropic", "invalid"]],
  );
  t.like((await caller.usage.get()).keys[0], { status: "invalid" });
  await t.throwsAsync(caller.usage.setBilling({ mode: "key" }), { code: "PRECONDITION_FAILED" });
});

test("K4, K8: a stored key that does not open is no payer: validKey and the payer facts leave it out", (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("unopened");
  const other = createSecretBox(Buffer.alloc(32, 9));
  keyRepo.save(harness.db, {
    userId: user.id,
    provider: "anthropic",
    sealed: other.seal(ANTHROPIC_KEY, keyContext(user.id, "anthropic")),
    last4: "a1f9",
  });
  billing.set(harness.db, user.id, "key");
  const allowances = storedAllowances({
    db: harness.db,
    box: createSecretBox(DEVELOPMENT_SECRET_KEY),
    logger: harness.logger,
    config: harness.config,
  });
  t.is(keyRepo.find(harness.db, user.id, "anthropic")?.status, "valid", "stored valid");
  t.is(allowances.validKey(user.id, "anthropic"), null);
  const facts = payerFacts(
    { ledger: new MemoryLedger(), allowances, limits: harness.config.limits, now: Date.now },
    user.id,
  );
  t.deepEqual(facts.keys, []);
});

test("fixture providers answer the key check by the key's text, without a network", async (t) => {
  const check = (raw: string) =>
    checkWithProvider("anthropic", raw, { fetch: fixturePageFetch, timeoutMs: 5_000 });
  t.is(await check("sk-ant-e2e-accepted-key-000000"), "accepted");
  t.is(await check("sk-ant-e2e-rejected-key-000000"), "rejected");
  t.is(await check("sk-ant-e2e-unreachable-key-000"), "unreachable");
});
