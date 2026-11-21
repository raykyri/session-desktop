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
import { Person, newId } from "./syncHttp.js";

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

/* --------------------------------------------- the mutators' pre rows */

/** A write past its `pre`-stage limit: TOO_MANY_REQUESTS, and nothing
 * recorded, so the seq it carried is the client's next one still. */
async function refusedUnrecorded(
  t: Parameters<typeof createHarness>[0],
  p: Person,
  name: string,
  input: unknown,
) {
  const before = recordCount(p.h);
  const answer = await p.write(name, input);
  t.like(answer, { ok: false, error: { code: "TOO_MANY_REQUESTS" } });
  t.is(recordCount(p.h), before);
  // the seq was not used: the client's last seq is the one before it
  const sent = p.seq;
  const again = (await p.register(p.clientId)).body;
  t.true(again.ok && again.lastSeq === sent - 1);
}

const recordCount = (h: Harness) => rowCount(h, "records");

test("limit: spaces.create, 5 a day per user (pre)", async (t) => {
  const harness = pinned(t);
  const olga = new Person(harness, harness.addUser("olga"));
  for (let index = 0; index < 5; index += 1)
    await olga.ok("spaces.create", { id: newId(), name: `room-${index}` });
  await refusedUnrecorded(t, olga, "spaces.create", { id: newId(), name: "room-5" });
  const mona = new Person(harness, harness.addUser("mona"));
  await t.notThrowsAsync(mona.ok("spaces.create", { id: newId(), name: "monas" }));
});

test("limit: invites.create (channel), 20 a day per user (pre); 50 open per channel", async (t) => {
  const harness = pinned(t, { SESSION_LIMIT_CHANNEL_INVITES_PER_DAY: "60" });
  const olga = new Person(harness, harness.addUser("olga"));
  const lab = newId();
  await olga.ok("spaces.create", { id: lab, name: "lab", vis: "private" });
  for (let index = 0; index < 50; index += 1)
    await olga.ok("invites.create", { id: newId(), space: lab, days: 7 });
  // the 51st open link is refused for the channel's state, and recorded
  const full = await olga.write("invites.create", { id: newId(), space: lab, days: 7 });
  t.like(full, {
    ok: false,
    error: {
      code: "PRECONDITION_FAILED",
      message: "This channel has 50 open invite links. Revoke one to make another.",
    },
  });
  const sent = olga.seq;
  const again = (await olga.register(olga.clientId)).body;
  t.true(again.ok && again.lastSeq === sent);

  const daily = pinned(t);
  const ada = new Person(daily, daily.addUser("ada"));
  const club = newId();
  await ada.ok("spaces.create", { id: club, name: "club", vis: "private" });
  for (let index = 0; index < 20; index += 1)
    await ada.ok("invites.create", { id: newId(), space: club, days: 7 });
  await refusedUnrecorded(t, ada, "invites.create", { id: newId(), space: club, days: 7 });
});

test("limit: spaces.join, 60 an hour per user (pre)", async (t) => {
  // 60 joins and 60 leaves in a minute: the writes bucket is raised, so the
  // join's own limit refuses the 61st join
  const harness = pinned(t, { SESSION_LIMIT_WRITES_PER_MINUTE: "1000" });
  const olga = new Person(harness, harness.addUser("olga"));
  const lounge = newId();
  await olga.ok("spaces.create", { id: lounge, name: "lounge" });
  const mel = new Person(harness, harness.addUser("mel"));
  for (let index = 0; index < 60; index += 1) {
    await mel.ok("spaces.join", { space: lounge });
    await mel.ok("spaces.leave", { space: lounge });
  }
  await refusedUnrecorded(t, mel, "spaces.join", { space: lounge });
});

test("limit: spaces.directory and spaces.byName, 60 a minute per user or per IP, IPv6 by /64", async (t) => {
  const harness = pinned(t);
  const directory = (ip: string, cookie?: string) =>
    harness.request("/api/trpc/spaces.directory", {
      headers: { "Fly-Client-IP": ip },
      ...(cookie ? { cookie } : {}),
    });
  for (let index = 0; index < 59; index += 1)
    t.is((await directory(`2001:db8:5:6::${(index + 1).toString(16)}`)).status, 200);
  const byName = await harness.request(
    `/api/trpc/spaces.byName?input=${encodeURIComponent(JSON.stringify({ name: "lab" }))}`,
    { headers: { "Fly-Client-IP": "2001:db8:5:6:ffff::1" } },
  );
  t.is(byName.status, 200);
  // the 61st from the same /64 prefix, from an address it has not used
  t.is((await directory("2001:db8:5:6:aaaa::2")).status, 429);
  // another prefix, and a signed-in reader on the same prefix, have their own
  t.is((await directory("2001:db8:5:7::1")).status, 200);
  const cookie = harness.signIn(harness.addUser("reader"));
  t.is((await directory("2001:db8:5:6::1", cookie)).status, 200);
});

test("limit: admin.models.*, 60 a minute per site admin", async (t) => {
  const harness = pinned(t);
  const admin = harness.caller(harness.addUser("site.admin", { isAdmin: true }));
  for (let index = 0; index < 60; index += 1) await admin.admin.models.list();
  await t.throwsAsync(admin.admin.models.list(), { code: "TOO_MANY_REQUESTS" } as never);
  await t.throwsAsync(admin.admin.models.setDefaultEffort({ effort: "low" }), {
    code: "TOO_MANY_REQUESTS",
  } as never);
  const other = harness.caller(harness.addUser("other.admin", { isAdmin: true }));
  await t.notThrowsAsync(other.admin.models.list());
});

test("limit: About and the removal note, 300 characters, BAD_REQUEST and recorded", async (t) => {
  const harness = pinned(t);
  const olga = new Person(harness, harness.addUser("olga"));
  const lounge = newId();
  await olga.ok("spaces.create", { id: lounge, name: "lounge" });
  const long = await olga.write("spaces.update", { id: lounge, desc: "x".repeat(301) });
  t.like(long, { ok: false, error: { code: "BAD_REQUEST" } });
  const th = newId();
  await olga.ok("threads.create", { id: th, space: lounge, kind: "post", q: "A post" });
  const note = await olga.write("moderation.decide", {
    item: `p:${th}`,
    decision: "removed",
    note: "y".repeat(301),
  });
  t.like(note, { ok: false, error: { code: "BAD_REQUEST" } });
  // both used their seq: recorded
  const sent = olga.seq;
  const again = (await olga.register(olga.clientId)).body;
  t.true(again.ok && again.lastSeq === sent);
});

test("the pre-stage refusals are counted per bucket for /metrics", async (t) => {
  const harness = pinned(t, { SESSION_METRICS_TOKEN: "m", SESSION_LIMIT_SPACES_PER_DAY: "1" });
  const olga = new Person(harness, harness.addUser("olga"));
  await olga.ok("spaces.create", { id: newId(), name: "one" });
  await olga.write("spaces.create", { id: newId(), name: "two" });
  const metrics = await harness.app.request("/metrics", { headers: { Authorization: "Bearer m" } });
  t.regex(await metrics.text(), /session_rate_limited_total\{bucket="spacesCreated"\} 1/);
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
