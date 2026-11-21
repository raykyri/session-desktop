// Abuse limits, cookie CSRF, credential separation and CORS (plan `04` Z1,
// Z2, Z4). One test per limit row this server applies: each takes the
// limit, then shows the next request answering TOO_MANY_REQUESTS (429)
// with nothing recorded.

import { accountInvites, auth } from "@session/db";
import test from "ava";

import { hashClientIp } from "../src/auth/session.js";
import { loggedPath } from "../src/middleware/logging.js";
import { ipLimitKey } from "../src/net/ipKey.js";

import type { Harness } from "./helpers.js";
import { createHarness } from "./helpers.js";

/** A harness whose limiter clock stands still, so no bucket refills while a
 * test spends it. */
function pinned(t: Parameters<typeof createHarness>[0], env: Record<string, string> = {}) {
  const at = Date.now();
  return createHarness(t, { limiterNow: () => at, env });
}

function trpcPost(harness: Harness, path: string, body: unknown, ip = "7.7.7.7", cookie?: string) {
  return harness.request(`/api/trpc/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Fly-Client-IP": ip },
    body: JSON.stringify(body),
    ...(cookie ? { cookie } : {}),
  });
}

function rowCount(harness: Harness, table: string): number {
  return (harness.db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
    .n;
}

/* ------------------------------------------------------------ Z1 rows */

test("limit: replicated writes and mutations, 60 a minute per user", async (t) => {
  const harness = pinned(t);
  const caller = harness.caller(harness.addUser("writer"));
  for (let index = 0; index < 60; index += 1) await caller.settings.update({});
  await t.throwsAsync(caller.settings.update({}), { code: "TOO_MANY_REQUESTS" } as never);
  await t.notThrowsAsync(harness.caller(harness.addUser("writer2")).settings.update({}));
});

test("limit: snapshots, 30 a minute per user and per IP signed out", async (t) => {
  const harness = pinned(t);
  const snapshot = (headers: Record<string, string>, cookie?: string) =>
    harness.request("/api/sync/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
      ...(cookie ? { cookie } : {}),
    });
  for (let index = 0; index < 30; index += 1) {
    t.not((await snapshot({ "Fly-Client-IP": "1.1.1.1" })).status, 429);
  }
  t.is((await snapshot({ "Fly-Client-IP": "1.1.1.1" })).status, 429);
  // The same /64 is the same key; a signed-in reader has their own bucket.
  t.is((await snapshot({ "Fly-Client-IP": "1.1.1.2" })).status === 429, false);
  const cookie = harness.signIn(harness.addUser("reader"));
  for (let index = 0; index < 30; index += 1) {
    await snapshot({ "Fly-Client-IP": "1.1.1.1" }, cookie);
  }
  t.is((await snapshot({ "Fly-Client-IP": "1.1.1.1" }, cookie)).status, 429);
});

test("limit: accountInvites.create, 10 a day per user beyond the 3 open", async (t) => {
  const harness = pinned(t);
  const admin = harness.caller(harness.addUser("seeder", { isAdmin: true }));
  // An admin is exempt from 3 open, not from 10 created a day.
  for (let index = 0; index < 10; index += 1) await admin.accountInvites.create();
  const before = rowCount(harness, "invites");
  await t.throwsAsync(admin.accountInvites.create(), { code: "TOO_MANY_REQUESTS" } as never);
  t.is(rowCount(harness, "invites"), before);
});

test("limit: accountInvites.list and members.tree, 60 a minute per user", async (t) => {
  const harness = pinned(t);
  const caller = harness.caller(harness.addUser("reader"));
  for (let index = 0; index < 30; index += 1) {
    await caller.accountInvites.list();
    await caller.members.tree();
  }
  await t.throwsAsync(caller.members.tree(), { code: "TOO_MANY_REQUESTS" } as never);
  await t.throwsAsync(caller.accountInvites.list(), { code: "TOO_MANY_REQUESTS" } as never);
});

test("limit: checkInvite, redeem and account.create share the /auth/* bucket, 20 a minute per IP", async (t) => {
  const harness = pinned(t);
  const member = harness.addUser("sender");
  const valid = (await harness.caller(member).accountInvites.create()).code;
  const waiting = harness.addWaitingUser("waits");
  const cookie = harness.signIn(waiting);
  // 10 sign-in starts, 9 open checks, 1 redeem: 20.
  for (let index = 0; index < 10; index += 1) {
    const response = await harness.request("/auth/github/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Fly-Client-IP": "7.7.7.7" },
      body: "{}",
    });
    t.is(response.status, 200);
  }
  for (let index = 0; index < 9; index += 1) {
    t.is((await trpcPost(harness, "auth.checkInvite", { code: valid })).status, 200);
  }
  t.is(
    (await trpcPost(harness, "accountInvites.redeem", { code: valid }, "7.7.7.7", cookie)).status,
    200,
  );
  const refused = await trpcPost(
    harness,
    "account.create",
    { name: "W", handle: "waits" },
    "7.7.7.7",
    cookie,
  );
  t.is(refused.status, 429);
  t.is(
    (
      await harness.request("/auth/x/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Fly-Client-IP": "7.7.7.7" },
        body: "{}",
      })
    ).status,
    429,
  );
  // Nothing was recorded: the account is still waiting.
  t.is(
    (
      harness.db.$client.prepare(`SELECT status FROM users WHERE id = ?`).get(waiting.id) as {
        status: string;
      }
    ).status,
    "waiting",
  );
  // Another address is unaffected.
  t.is((await trpcPost(harness, "auth.checkInvite", { code: valid }, "8.8.8.8")).status, 200);
});

test("limit: 10 failed invite checks an hour per IP and per user", async (t) => {
  const harness = pinned(t, { SESSION_LIMIT_AUTH_PER_MINUTE: "100" });
  for (let index = 0; index < 10; index += 1) {
    const response = await trpcPost(
      harness,
      "auth.checkInvite",
      { code: "SESS-ZZZZ-ZZ" },
      "6.6.6.6",
    );
    t.is(response.status, 200);
  }
  t.is(
    (await trpcPost(harness, "auth.checkInvite", { code: "SESS-ZZZZ-ZZ" }, "6.6.6.6")).status,
    429,
  );
  // An open code is refused too once the address is out of checks.
  const valid = (await harness.caller(harness.addUser("sender")).accountInvites.create()).code;
  t.is((await trpcPost(harness, "auth.checkInvite", { code: valid }, "6.6.6.6")).status, 429);
  // Per user: a waiting account moving between addresses keeps its count.
  const waiting = harness.addWaitingUser("prober");
  const cookie = harness.signIn(waiting);
  for (let index = 0; index < 10; index += 1) {
    await trpcPost(
      harness,
      "accountInvites.redeem",
      { code: "SESS-YYYY-YY" },
      `5.5.5.${index}`,
      cookie,
    );
  }
  const blocked = await trpcPost(
    harness,
    "accountInvites.redeem",
    { code: valid },
    "5.5.6.1",
    cookie,
  );
  t.is(blocked.status, 429);
  t.is((await harness.caller(waiting).auth.me())?.pendingInvite, null);
});

test("limit: POST /auth/<provider>/start uses the /auth/* bucket", async (t) => {
  const harness = pinned(t);
  const statuses: number[] = [];
  for (let index = 0; index <= harness.config.abuse.authPerMinute; index += 1) {
    const response = await harness.request("/auth/github/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Fly-Client-IP": "4.4.4.4" },
      body: "{}",
    });
    statuses.push(response.status);
  }
  t.is(statuses.filter((status) => status === 200).length, harness.config.abuse.authPerMinute);
  t.is(statuses.at(-1), 429);
  // The refused request wrote no OAuth state.
  t.is(rowCount(harness, "oauth_states"), harness.config.abuse.authPerMinute);
});

test("limit: waiting accounts, 5 per IP key a day (counted in signup_attempts)", (t) => {
  // The callback's refusal is in `auth.test.ts` ("the 6th waiting account");
  // this checks the key it counts under: IPv6 by /64.
  const harness = createHarness(t);
  const a = hashClientIp(harness.config, "2001:db8:aa:bb:1:2:3:4");
  const b = hashClientIp(harness.config, "2001:db8:aa:bb::ffff");
  const c = hashClientIp(harness.config, "2001:db8:aa:bc::1");
  t.is(a, b);
  t.not(a, c);
  for (let index = 0; index < 5; index += 1) auth.recordSignupAttempt(harness.db, a, "waiting");
  t.is(auth.countSignupAttempts(harness.db, b, Date.now() - 86_400_000, "waiting"), 5);
});

test("limit: handle availability, 30 a minute per user", async (t) => {
  const harness = pinned(t);
  const caller = harness.caller(harness.addWaitingUser("picker"));
  for (let index = 0; index < 30; index += 1) {
    await caller.account.checkHandle({ handle: `name${index}` });
  }
  await t.throwsAsync(caller.account.checkHandle({ handle: "one.more" }), {
    code: "TOO_MANY_REQUESTS",
  } as never);
});

test("limits are settings validated at boot", (t) => {
  const harness = createHarness(t, { env: { SESSION_LIMIT_OPEN_INVITES: "5" } });
  t.is(harness.config.abuse.openInvites, 5);
  t.throws(() => createHarness(t, { env: { SESSION_LIMIT_AUTH_PER_MINUTE: "0" } }), {
    message: /SESSION_LIMIT_AUTH_PER_MINUTE/,
  });
});

test("refusals are counted per bucket for /metrics", async (t) => {
  const harness = pinned(t, { SESSION_METRICS_TOKEN: "m" });
  const caller = harness.caller(harness.addWaitingUser("counted"));
  for (let index = 0; index < 31; index += 1) {
    await caller.account.checkHandle({ handle: "abc" }).catch(() => undefined);
  }
  const metrics = await harness.app.request("/metrics", { headers: { Authorization: "Bearer m" } });
  t.regex(await metrics.text(), /session_rate_limited_total\{bucket="handleChecks"\} 1/);
});

/* ------------------------------------------------------------- IP key */

test("IPv6 clients are keyed on their /64 prefix; IPv4 on the address", (t) => {
  t.is(ipLimitKey("203.0.113.9"), "203.0.113.9");
  t.is(ipLimitKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  t.is(ipLimitKey("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  t.is(ipLimitKey("2001:DB8:0001:0002:ffff::1"), "2001:db8:1:2::/64");
  t.is(ipLimitKey("[2001:db8::1]:443"), "2001:db8:0:0::/64");
  t.is(ipLimitKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  t.is(ipLimitKey("::ffff:198.51.100.7"), "198.51.100.7");
  t.is(ipLimitKey("unknown"), "unknown");
});

/* ---------------------------------------------------------- Z2 CSRF */

test("csrf: a cookie GET of the sync event stream from another site is refused", async (t) => {
  const harness = createHarness(t);
  const cookie = harness.signIn(harness.addUser("victim"));
  for (const path of ["/api/sync/events", "/api/sync/pull?log=x", "/api/runs/R/live"]) {
    const response = await harness.app.request(path, {
      headers: { Cookie: `session=${cookie}`, "Sec-Fetch-Site": "cross-site" },
    });
    t.is(response.status, 403, path);
    const foreign = await harness.app.request(path, {
      headers: { Cookie: `session=${cookie}`, Origin: "https://evil.example" },
    });
    t.is(foreign.status, 403, path);
  }
  // The same GET from the app itself passes the guard (and finds no route
  // until the sync server lands).
  const own = await harness.app.request("/api/sync/events", {
    headers: { Cookie: `session=${cookie}`, "Sec-Fetch-Site": "same-origin" },
  });
  t.not(own.status, 403);
});

test("csrf: a cookie POST without X-Requested-With is refused", async (t) => {
  const harness = createHarness(t);
  const cookie = harness.signIn(harness.addUser("victim"));
  for (const path of ["/api/sync/apply", "/api/trpc/accountInvites.create", "/auth/x/start"]) {
    const response = await harness.app.request(path, {
      method: "POST",
      headers: { Cookie: `session=${cookie}`, "Content-Type": "application/json" },
      body: "{}",
    });
    t.is(response.status, 403, path);
  }
  t.is(rowCount(harness, "invites"), 0);
});

test("csrf: a cross-origin POST is refused even with the header", async (t) => {
  const harness = createHarness(t);
  const response = await harness.app.request("/api/trpc/auth.checkInvite", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "X-Requested-With": "session",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code: "SESS-AAAA-AA" }),
  });
  t.is(response.status, 403);
});

/* ------------------------------------------------- Z4 credentials, CORS */

test("a request with an Authorization header answers 400", async (t) => {
  const harness = createHarness(t);
  const cookie = harness.signIn(harness.addUser("bearer"));
  for (const [path, method] of [
    ["/api/trpc/auth.me", "GET"],
    ["/api/trpc/accountInvites.create", "POST"],
    ["/api/sync/apply", "POST"],
    ["/api/sync/events", "GET"],
    ["/api/runs/R/live", "GET"],
  ] as const) {
    const response = await harness.request(path, {
      method,
      headers: { Authorization: "Bearer device-token", "Content-Type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
      cookie,
    });
    t.is(response.status, 400, path);
  }
  t.is(rowCount(harness, "invites"), 0);
  // `/metrics` keeps its own bearer token.
  t.is(
    (await harness.app.request("/metrics", { headers: { Authorization: "Bearer x" } })).status,
    404,
  );
});

test("no response carries an Access-Control-Allow-* header", async (t) => {
  const harness = createHarness(t, {
    env: { SESSION_X_CLIENT_ID: "x", SESSION_X_CLIENT_SECRET: "y" },
  });
  const cookie = harness.signIn(harness.addUser("corsless"));
  const requests: [string, RequestInit][] = [
    ["/healthz", {}],
    ["/api/trpc/auth.me", {}],
    ["/api/trpc/auth.me", { headers: { Origin: "https://evil.example" } }],
    [
      "/api/trpc/auth.checkInvite",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "x-requested-with",
        },
      },
    ],
    ["/api/sync/snapshot", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }],
    ["/auth/x", {}],
    ["/auth/github/callback?state=s&code=c", {}],
    ["/i", {}],
    [
      "/api/trpc/accountInvites.list",
      { headers: { Cookie: `session=${cookie}`, Origin: "http://localhost:8787" } },
    ],
  ];
  for (const [path, init] of requests) {
    const response = await harness.app.request(path, init);
    const cors = [...response.headers.keys()].filter((name) =>
      name.toLowerCase().startsWith("access-control-"),
    );
    t.deepEqual(cors, [], path);
  }
});

/* ------------------------------------------------------------ logging */

test("the access log redacts any path under /i/", (t) => {
  t.is(loggedPath("/i/SESS-9TQ2-X8"), "/i/[redacted]");
  t.is(loggedPath("/i/SESS-9TQ2-X8/extra"), "/i/[redacted]");
  t.is(loggedPath("/i"), "/i");
  t.is(loggedPath("/invite/abc"), "/invite/[redacted]");
});

test("no request log line carries an invite code", async (t) => {
  const lines: string[] = [];
  const harness = createHarness(t);
  const { createLogger } = await import("../src/logger.js");
  const { createApp } = await import("../src/app.js");
  const app = createApp({
    ...harness.deps,
    logger: createLogger({ level: "info", write: (line) => lines.push(line) }),
    clientDistDirectory: "/nonexistent",
  });
  const member = harness.addUser("logger");
  const { code } = accountInvites.create(harness.db, {
    createdBy: member.id,
    encrypt: () => "sealed",
  }) as { code: string };
  const headers = {
    Origin: "http://localhost:8787",
    "X-Requested-With": "session",
    "Content-Type": "application/json",
  };
  await app.request("/api/trpc/auth.checkInvite", {
    method: "POST",
    headers,
    body: JSON.stringify({ code }),
  });
  await app.request("/auth/x/start", { method: "POST", headers, body: JSON.stringify({ code }) });
  await app.request(`/i/${code}`);
  t.true(lines.length >= 3);
  t.false(lines.some((line) => line.includes(code) || line.includes(code.replace(/-/g, ""))));
});
