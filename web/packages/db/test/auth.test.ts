import test from "ava";

import { auth, closeDatabase, openDatabase, users } from "../src/index.js";

import { createFixture } from "./helpers.js";

test("a GitHub identity keeps its account across a login rename", (t) => {
  const db = openDatabase(":memory:");
  const first = users.upsertFromGitHub(db, { githubId: 7, login: "old", name: "A" });
  t.true(first.created);
  const second = users.upsertFromGitHub(db, { githubId: 7, login: "new", name: "B" });
  t.false(second.created);
  t.is(second.user.id, first.user.id);
  t.is(second.user.login, "new");
  t.is(users.listUsers(db).length, 1);
  closeDatabase(db);
});

test("the sign-up context is recorded once, on creation", (t) => {
  const db = openDatabase(":memory:");
  const { user } = users.upsertFromGitHub(db, { githubId: 8, login: "a" }, { signupIpHash: "h1" });
  users.upsertFromGitHub(db, { githubId: 8, login: "a" }, { signupIpHash: "h2" });
  const row = db.$client.prepare(`SELECT signup_ip_hash AS h FROM users WHERE id = ?`).get(user.id);
  t.deepEqual(row, { h: "h1" });
  closeDatabase(db);
});

test("admin is set by login and is not granted by sign-in", (t) => {
  const db = openDatabase(":memory:");
  users.upsertFromGitHub(db, { githubId: 9, login: "raymond" });
  t.false(users.findByLogin(db, "raymond")?.isAdmin ?? true);
  t.true(users.setAdmin(db, "raymond", true).isAdmin);
  users.upsertFromGitHub(db, { githubId: 9, login: "raymond" });
  t.true(users.findByLogin(db, "raymond")?.isAdmin ?? false);
  t.throws(() => users.setAdmin(db, "nobody", true), { message: /no account/ });
  closeDatabase(db);
});

test("the session table stores the hash, not the cookie", (t) => {
  const fixture = createFixture(t);
  const session = auth.createSession(fixture.db, fixture.userId, { userAgent: "test" });
  t.is(session.id, auth.hashSessionToken(session.token));
  t.not(session.id, session.token);
  const resolved = auth.readSession(fixture.db, session.token);
  t.is(resolved?.userId, fixture.userId);
  t.is(auth.readSession(fixture.db, "not-a-token"), null);
});

test("a session expires by idleness and by absolute age", (t) => {
  const fixture = createFixture(t);
  const idle = auth.createSession(fixture.db, fixture.userId);
  fixture.db.$client
    .prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
    .run(Date.now() - auth.SESSION_IDLE_MS - 1, idle.id);
  t.is(auth.readSession(fixture.db, idle.token), null);
  // The read that found the expired row removed it.
  t.deepEqual(fixture.db.$client.prepare(`SELECT count(*) AS n FROM sessions`).get(), { n: 0 });

  const aged = auth.createSession(fixture.db, fixture.userId);
  fixture.db.$client
    .prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
    .run(Date.now() - 1, aged.id);
  t.is(auth.readSession(fixture.db, aged.token), null);
});

test("last_seen_at slides at most once every five minutes", (t) => {
  const fixture = createFixture(t);
  const session = auth.createSession(fixture.db, fixture.userId);
  const before = auth.readSession(fixture.db, session.token);
  const again = auth.readSession(fixture.db, session.token);
  t.is(before?.lastSeenAt, again?.lastSeenAt);
  fixture.db.$client
    .prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
    .run(Date.now() - auth.SESSION_TOUCH_INTERVAL_MS - 1, session.id);
  const touched = auth.readSession(fixture.db, session.token);
  t.true((touched?.lastSeenAt ?? 0) > (before?.lastSeenAt ?? 0) - auth.SESSION_TOUCH_INTERVAL_MS);
});

test("an oauth state is single use and expires", (t) => {
  const fixture = createFixture(t);
  auth.createOAuthState(fixture.db, { state: "s1", codeVerifier: "v1", returnTo: "/r/1" });
  t.deepEqual(auth.consumeOAuthState(fixture.db, "s1"), {
    codeVerifier: "v1",
    returnTo: "/r/1",
  });
  t.is(auth.consumeOAuthState(fixture.db, "s1"), null);

  auth.createOAuthState(fixture.db, { state: "s2", codeVerifier: "v2" });
  fixture.db.$client
    .prepare(`UPDATE oauth_states SET created_at = ? WHERE state = ?`)
    .run(Date.now() - auth.OAUTH_STATE_TTL_MS - 1, "s2");
  t.is(auth.consumeOAuthState(fixture.db, "s2"), null);
});

test("invites debit the inviter's allotment and are spent once", (t) => {
  const fixture = createFixture(t);
  users.setInvitesRemaining(fixture.db, fixture.userId, 2);
  const codes = auth.createInvites(fixture.db, fixture.userId, 5);
  t.is(codes.length, 2);
  t.deepEqual(auth.createInvites(fixture.db, fixture.userId, 1), []);
  const code = codes[0] ?? "";
  t.true(auth.redeemInvite(fixture.db, code, fixture.userId));
  t.false(auth.redeemInvite(fixture.db, code, fixture.userId));
  t.false(auth.redeemInvite(fixture.db, "unknown", fixture.userId));
});

test("sign-up attempts are counted per ip and window", (t) => {
  const fixture = createFixture(t);
  const at = Date.now();
  auth.recordSignupAttempt(fixture.db, "ip-a", "ok", at - 10_000);
  auth.recordSignupAttempt(fixture.db, "ip-a", "rejected", at - 1000);
  auth.recordSignupAttempt(fixture.db, "ip-b", "ok", at - 1000);
  t.is(auth.countSignupAttempts(fixture.db, "ip-a", at - 60_000), 2);
  t.is(auth.countSignupAttempts(fixture.db, "ip-a", at - 5_000), 1);
  t.is(auth.countSignupAttempts(fixture.db, "ip-b", at - 60_000), 1);
});

test("per-user limits default to absent and round-trip", (t) => {
  const fixture = createFixture(t);
  t.is(auth.getUserLimits(fixture.db, fixture.userId), null);
  t.deepEqual(auth.setUserLimits(fixture.db, fixture.userId, { dailyTokens: 5 }), {
    dailyTokens: 5,
    dailyRuns: null,
  });
  t.deepEqual(auth.getUserLimits(fixture.db, fixture.userId), {
    dailyTokens: 5,
    dailyRuns: null,
  });
});
