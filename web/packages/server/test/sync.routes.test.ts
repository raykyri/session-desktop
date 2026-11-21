// The sync routes (`01` S1, A3) over HTTP against the SQLite store: the
// protocol check, sign-in, CORS and the transport limits.

import test from "ava";

import { createHarness, PUBLIC_ORIGIN } from "./helpers.js";
import { Person } from "./syncHttp.js";

// ---- S1: the protocol check, sign-in, limits, CORS ----

test("S1: a request without Session-Protocol, or outside the accepted range, answers 426 UPGRADE_REQUIRED", async (t) => {
  const h = createHarness(t, { env: { SESSION_MIN_PROTOCOL: "4" } });
  const cookie = h.signIn(h.addUser("reader"));
  for (const path of [
    "/api/sync/pull?log=user:reader",
    "/api/trpc/models.list",
    "/api/runs/R/live",
  ]) {
    for (const version of [undefined, "3", "5", "four"]) {
      const res = await h.app.request(path, {
        headers: {
          Origin: PUBLIC_ORIGIN,
          Cookie: `session=${cookie}`,
          ...(version === undefined ? {} : { "Session-Protocol": version }),
        },
      });
      t.is(res.status, 426, `${path} ${version}`);
      t.like(await res.json(), { code: "UPGRADE_REQUIRED" });
    }
  }
  const post = await h.app.request("/api/sync/apply", {
    method: "POST",
    headers: {
      Origin: PUBLIC_ORIGIN,
      "X-Requested-With": "session",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ envelopes: [] }),
  });
  t.is(post.status, 426);
  // the current version passes the check
  const ok = await h.request("/api/sync/pull?log=user:reader", { cookie });
  t.is(ok.status, 200);
});

test("S1: writing needs a session (401) and an active account (403), answered before the server half", async (t) => {
  const h = createHarness(t);
  let calls = 0;
  for (const name of ["register", "apply"] as const) {
    const f = h.sync.server[name].bind(h.sync.server) as (...a: unknown[]) => unknown;
    (h.sync.server as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
      calls += 1;
      return f(...a);
    };
  }
  const signedOut = await h.request("/api/sync/register", { method: "POST", body: "{}" });
  t.is(signedOut.status, 401);
  t.like(await signedOut.json(), { code: "UNAUTHORIZED" });
  const someone = new Person(h, h.addUser("someone"));
  await someone.register();
  calls = 0;
  const e = someone.envelope("prefs.set", { layout: "wide" });
  const anon = await h.request("/api/sync/apply", {
    method: "POST",
    body: JSON.stringify({ envelopes: [e] }),
  });
  t.is(anon.status, 401);
  t.like(await anon.json(), { code: "UNAUTHORIZED" });
  const waiting = new Person(h, h.addWaitingUser("waiter"));
  t.is((await waiting.register()).status, 403);
  const refused = await waiting.post("/api/sync/apply", { envelopes: [e] });
  t.is(refused.status, 403);
  t.like(await refused.json(), { code: "FORBIDDEN" });
  t.is(calls, 0, "the server half was not called");
  // a waiting account reads the public path
  t.is((await waiting.post("/api/sync/snapshot", { log: "user:someone" })).status, 200);
});

test("S1: a sync response from another origin carries no CORS headers", async (t) => {
  const h = createHarness(t);
  const res = await h.app.request("/api/sync/pull?log=user:x", {
    headers: { Origin: "https://evil.example", "Session-Protocol": "4" },
  });
  t.false([...res.headers.keys()].some((k) => k.toLowerCase().startsWith("access-control-")));
  const pre = await h.app.request("/api/sync/apply", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  t.false([...pre.headers.keys()].some((k) => k.toLowerCase().startsWith("access-control-")));
});

// ---- A3: the transport limits ----

test("A3: a batch of n envelopes counts n writes; those past the budget answer TOO_MANY_REQUESTS, unrecorded", async (t) => {
  let now = Date.parse("2026-11-21T12:00:00Z");
  const h = createHarness(t, {
    env: { SESSION_LIMIT_WRITES_PER_MINUTE: "5" },
    limiterNow: () => now,
  });
  const p = new Person(h, h.addUser("writer"));
  await p.register();
  const batch = Array.from({ length: 8 }, (_, k) =>
    p.envelope("prefs.set", { layout: k % 2 ? "wide" : "centred" }),
  );
  const first = await p.send(batch);
  t.is(first.status, 200);
  t.deepEqual(
    first.answers.map((a) => (a.ok ? "ok" : a.error.code)),
    ["ok", "ok", "ok", "ok", "ok", "TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS", "TOO_MANY_REQUESTS"],
  );
  // the budget is spent: the whole batch is refused, in the protocol shape,
  // with Retry-After
  const second = await p.post("/api/sync/apply", { envelopes: batch.slice(5) });
  t.is(second.status, 429);
  t.like(await second.json(), { code: "TOO_MANY_REQUESTS" });
  t.true(Number(second.headers.get("retry-after")) >= 1);
  // unrecorded: the same seqs apply once the budget refills
  now += 60_000;
  const third = await p.send(batch.slice(5));
  t.deepEqual(
    third.answers.map((a) => a.ok),
    [true, true, true],
  );
});

test("A3: registrations, the body size and the batch size are limited", async (t) => {
  const h = createHarness(t, {
    env: {
      SESSION_LIMIT_REGISTER_PER_MINUTE: "3",
      SESSION_LIMIT_APPLY_BYTES: "4096",
      SESSION_LIMIT_APPLY_BATCH: "3",
    },
  });
  const p = new Person(h, h.addUser("limits"));
  const regs = [];
  for (let k = 0; k < 4; k++) regs.push((await p.register()).status);
  t.deepEqual(regs, [200, 200, 200, 429]);
  const big = p.envelope("prefs.set", { layout: "wide", pad: "x".repeat(5000) });
  const tooBig = await p.post("/api/sync/apply", { envelopes: [big] });
  t.is(tooBig.status, 413);
  t.like(await tooBig.json(), { code: "TOO_LARGE" });
  const many = await p.post("/api/sync/apply", {
    envelopes: [1, 2, 3, 4].map(() => p.envelope("prefs.set", { layout: "wide" })),
  });
  t.is(many.status, 400);
  // within the body limit, an envelope over 256 KB answers TOO_LARGE, unrecorded
  const h2 = createHarness(t);
  const q = new Person(h2, h2.addUser("large"));
  await q.register();
  const e = q.envelope("prefs.set", { layout: "wide", pad: "x".repeat(300_000) });
  const r = await q.send([e]);
  t.like(r.answers[0], { ok: false, error: { code: "TOO_LARGE" } });
  q.seq -= 1;
  t.like((await q.send([q.envelope("prefs.set", { layout: "wide" })])).answers[0], { ok: true });
});

test("A3: a person has at most SESSION_LIMIT_STREAMS_PER_USER streams; a client id one, which a new stream replaces", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_STREAMS_PER_USER: "2" } });
  const p = new Person(h, h.addUser("streams"));
  const ids: string[] = [];
  for (let k = 0; k < 3; k++) {
    await p.register();
    ids.push(p.clientId);
  }
  const cursor = (await p.snapshot("user:streams")).cursor;
  const open = async (id: string) => {
    p.clientId = id;
    return p.events({ "user:streams": cursor });
  };
  const s1 = await open(ids[0] ?? "");
  const s2 = await open(ids[1] ?? "");
  t.deepEqual([s1.status, s2.status], [200, 200]);
  t.is((await s1.until("ready"))?.event, "ready");
  const s3 = await open(ids[2] ?? "");
  t.is(s3.status, 429);
  const again = await open(ids[0] ?? "");
  t.is(again.status, 200);
  // the replaced stream ends
  t.is(await s1.until("never", 1000), null);
  t.true(s1.ended);
  t.is(h.sync.hub.size(), 2);
  // another person's client id, or none, opens nothing
  const other = new Person(h, h.addUser("other"));
  other.clientId = ids[1] ?? "";
  t.is((await other.events({ "user:other": cursor })).status, 409);
  for (const s of [s2, again]) await s.close();
});

test("a snapshot with a tier or a thread list the protocol does not have answers 400 BAD_REQUEST", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("reader"));
  const bad = [
    { log: "user:reader", tier: "all" },
    { log: "user:reader", tier: "threads" },
    { log: "user:reader", tier: "window", threads: ["not-a-ulid"] },
    { log: "user:reader", threads: "x" },
  ];
  for (const body of bad) {
    const res = await p.post("/api/sync/snapshot", body);
    t.is(res.status, 400, JSON.stringify(body));
    t.like(await res.json(), { code: "BAD_REQUEST" });
  }
  t.is((await p.post("/api/sync/snapshot", { log: "user:reader", tier: "summary" })).status, 200);
  const snap = (await (await p.post("/api/sync/snapshot", { log: "user:reader" })).json()) as {
    serverTime?: number;
  };
  t.is(typeof snap.serverTime, "number");
});
