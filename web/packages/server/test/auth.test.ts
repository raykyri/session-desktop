// Sign-in with GitHub and X against fixture OAuth endpoints (plan `04` I4,
// Z2; `06-auth-and-users.md` §2): the injected `fetch` answers the real
// providers' token and profile URLs and records each request, so the tests
// see the exact exchange the server makes.

import { accountInvites, accounts, auth, users } from "@session/db";
import test from "ava";

import { safeReturnTo } from "../src/auth/routes.js";
import { weekOf } from "../src/runs/ledger.js";
import { MemoryLedger } from "../src/runs/memoryLedger.js";

import type { Harness } from "./helpers.js";
import { PUBLIC_ORIGIN, createHarness } from "./helpers.js";

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

interface ProviderStub {
  calls: Call[];
  /** GitHub `GET /user` and X `GET /2/users/me` answers by access token. */
  github?: Record<string, unknown>;
  githubEmails?: unknown;
  x?: Record<string, unknown>;
  profileStatus?: number;
  tokenStatus?: number;
}

const GITHUB_PROFILE = {
  id: 4242,
  login: "octocat",
  name: "Octo Cat",
  avatar_url: "https://avatars.githubusercontent.com/u/1",
  created_at: "2015-01-02T03:04:05Z",
};

const X_PROFILE = {
  id: "1500000000000000001",
  username: "octocat",
  name: "Octo on X",
  profile_image_url: "https://pbs.twimg.com/profile_images/1/a.jpg",
  created_at: "2019-05-06T07:08:09.000Z",
  confirmed_email: "octo@x.example",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answers the four provider endpoints and nothing else, so a request to any
 * other host fails the test rather than reaching the network. */
function providerFetch(stub: ProviderStub): typeof globalThis.fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    stub.calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    });
    switch (url) {
      case "https://github.com/login/oauth/access_token":
      case "https://api.x.com/2/oauth2/token": {
        const code = new URLSearchParams(typeof init?.body === "string" ? init.body : "").get(
          "code",
        );
        return Promise.resolve(
          json({ access_token: `token-for-${code ?? ""}` }, stub.tokenStatus ?? 200),
        );
      }
      case "https://api.github.com/user":
        return Promise.resolve(json(stub.github ?? GITHUB_PROFILE, stub.profileStatus ?? 200));
      case "https://api.github.com/user/emails":
        return Promise.resolve(
          json(
            stub.githubEmails ?? [
              { email: "old@example.com", primary: false, verified: true },
              { email: "octo@example.com", primary: true, verified: true },
            ],
          ),
        );
      case "https://api.x.com/2/users/me?user.fields=created_at,profile_image_url,confirmed_email":
        return Promise.resolve(json({ data: stub.x ?? X_PROFILE }, stub.profileStatus ?? 200));
      default:
        throw new Error(`unexpected fetch of ${url}`);
    }
  };
}

function harnessWith(t: Parameters<typeof createHarness>[0], stub: ProviderStub, env = {}) {
  return createHarness(t, {
    env: { SESSION_X_CLIENT_ID: "x-client", SESSION_X_CLIENT_SECRET: "x-secret", ...env },
    fetch: providerFetch(stub),
  });
}

/** The session cookie among the `Set-Cookie` headers; the callback also
 * clears the short-lived `oauth_state` one. */
function sessionCookie(response: Response): string | null {
  return response.headers.getSetCookie().find((value) => value.startsWith("session=")) ?? null;
}

function tokenOf(response: Response): string {
  return /session=([^;]+)/.exec(sessionCookie(response) ?? "")?.[1] ?? "";
}

/** Starts a sign-in the way the client does: `POST /auth/<p>/start`. The
 * state travels in the authorization URL and in a `SameSite=Lax` cookie the
 * callback has to see again. */
async function start(
  harness: Harness,
  provider: "github" | "x",
  body: { code?: string; returnTo?: string } = {},
  headers: Record<string, string> = {},
): Promise<{ state: string; cookie: string; url: URL }> {
  const response = await harness.request(`/auth/${provider}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`start answered ${response.status}`);
  const { url } = (await response.json()) as { url: string };
  const parsed = new URL(url);
  const cookie = /oauth_state=[^;]*/.exec(response.headers.get("set-cookie") ?? "")?.[0] ?? "";
  return { state: parsed.searchParams.get("state") ?? "", cookie, url: parsed };
}

async function callback(
  harness: Harness,
  provider: "github" | "x",
  handshake: { state: string; cookie: string },
  headers: Record<string, string> = {},
): Promise<Response> {
  return harness.request(`/auth/${provider}/callback?code=c-${provider}&state=${handshake.state}`, {
    headers: { Cookie: handshake.cookie, ...headers },
  });
}

async function signInWith(
  harness: Harness,
  provider: "github" | "x",
  body: { code?: string; returnTo?: string } = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return callback(harness, provider, await start(harness, provider, body, headers), headers);
}

function inviteFrom(harness: Harness, login = "inviter") {
  const inviter = harness.addUser(login);
  const made = accountInvites.create(harness.db, { createdBy: inviter.id, encrypt: () => "x" });
  if (!made.ok) throw new Error("limit");
  return { inviter, code: made.code, id: made.id };
}

test("the authorization URLs carry PKCE, state, the scopes and the callback", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const github = await start(harness, "github");
  t.is(github.url.origin + github.url.pathname, "https://github.com/login/oauth/authorize");
  t.is(github.url.searchParams.get("scope"), "read:user user:email");
  t.is(github.url.searchParams.get("redirect_uri"), `${PUBLIC_ORIGIN}/auth/github/callback`);
  t.is(github.url.searchParams.get("code_challenge_method"), "S256");
  t.is(github.url.searchParams.get("code_challenge")?.length, 43);
  const x = await start(harness, "x");
  t.is(x.url.origin + x.url.pathname, "https://x.com/i/oauth2/authorize");
  t.is(x.url.searchParams.get("scope"), "users.read tweet.read users.email");
  t.is(x.url.searchParams.get("client_id"), "x-client");
  t.is(x.url.searchParams.get("redirect_uri"), `${PUBLIC_ORIGIN}/auth/x/callback`);
  t.true(x.cookie.startsWith("oauth_state="));
});

test("the start route stores the code's hash, never the code", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const { code } = inviteFrom(harness);
  const { state } = await start(harness, "x", { code: code.toLowerCase(), returnTo: "/c/ml" });
  const row = harness.db.$client
    .prepare(`SELECT * FROM oauth_states WHERE state = ?`)
    .get(state) as Record<string, unknown>;
  t.is(row["provider"], "x");
  t.is(row["code_hash"], accountInvites.hashInviteCode(code));
  t.is(row["return_to"], "/c/ml");
  t.false(JSON.stringify(row).includes(code));
  // The GET start takes no code: an `invite` parameter is ignored.
  const response = await harness.request(`/auth/github?invite=${code}&return_to=/saved`);
  t.is(response.status, 302);
  const getState = new URL(response.headers.get("location") ?? "").searchParams.get("state");
  const stored = auth.consumeOAuthState(harness.db, getState ?? "");
  t.is(stored?.codeHash, null);
  t.is(stored?.returnTo, "/saved");
});

test("GitHub: a new identity without a code becomes a waiting account", async (t) => {
  const stub: ProviderStub = { calls: [] };
  const harness = harnessWith(t, stub);
  const response = await signInWith(harness, "github", { returnTo: "/c/ml" });
  t.is(response.status, 302);
  t.is(response.headers.get("location"), `${PUBLIC_ORIGIN}/welcome?new=1`);
  const cookie = sessionCookie(response) ?? "";
  t.true(cookie.includes("HttpOnly"));
  t.true(cookie.includes("SameSite=Lax"));
  // No `Secure` outside production, or the development cookie would be dropped.
  t.false(cookie.includes("Secure"));
  const user = users.findByIdentity(harness.db, "github", "4242");
  t.is(user?.status, "waiting");
  t.is(user?.handle, null);
  t.is(user?.avatarUrl, GITHUB_PROFILE.avatar_url);
  t.is(auth.readSession(harness.db, tokenOf(response))?.userId, user?.id);
  // The exchange: the code, the verifier, the client secret in the body.
  const exchange = stub.calls.find((call) => call.url.includes("access_token"));
  const form = new URLSearchParams(exchange?.body ?? "");
  t.is(form.get("code"), "c-github");
  t.is(form.get("grant_type"), "authorization_code");
  t.is(form.get("client_secret"), "client-secret");
  t.true((form.get("code_verifier") ?? "").length >= 43);
  t.is(
    stub.calls
      .find((call) => call.url === "https://api.github.com/user")
      ?.headers.get("authorization"),
    "Bearer token-for-c-github",
  );
  // The primary verified address is stored.
  const row = harness.db.$client
    .prepare(`SELECT email FROM users WHERE id = ?`)
    .get(user?.id ?? "") as { email: string };
  t.is(row.email, "octo@example.com");
  const me = await harness.caller(user).auth.me();
  t.deepEqual(me && { status: me.status, pendingInvite: me.pendingInvite }, {
    status: "waiting",
    pendingInvite: null,
  });
});

test("X: a new identity with an open code goes to the profile step", async (t) => {
  const stub: ProviderStub = { calls: [] };
  const harness = harnessWith(t, stub);
  const { code, inviter } = inviteFrom(harness, "ines.v");
  const response = await signInWith(harness, "x", { code, returnTo: "/c/ml" });
  t.is(response.headers.get("location"), `${PUBLIC_ORIGIN}/c/ml`);
  const exchange = stub.calls.find((call) => call.url === "https://api.x.com/2/oauth2/token");
  // X's confidential client: credentials as HTTP Basic, not in the body.
  t.is(
    exchange?.headers.get("authorization"),
    `Basic ${Buffer.from("x-client:x-secret").toString("base64")}`,
  );
  t.is(new URLSearchParams(exchange?.body ?? "").get("client_secret"), null);
  const user = users.findByIdentity(harness.db, "x", X_PROFILE.id);
  t.is(user?.status, "waiting");
  t.is(user?.login, "octocat");
  const caller = harness.caller(user);
  const me = await caller.auth.me();
  t.deepEqual(me?.pendingInvite, { name: "ines.v", handle: inviter.handle });
  // The profile step redeems the code and activates the account.
  const created = await caller.account.create({ name: "Octo", handle: "octo" });
  t.is(created.me.status, "active");
  t.is(created.me.handle, "octo");
  const activated = users.findById(harness.db, user?.id ?? "");
  t.is(activated?.displayName, "Octo");
  t.deepEqual(accountInvites.checkCode(harness.db, code), { status: "unusable" });
  const row = harness.db.$client
    .prepare(`SELECT invited_by AS by, email FROM users WHERE id = ?`)
    .get(user?.id ?? "") as { by: string; email: string };
  t.deepEqual(row, { by: inviter.id, email: "octo@x.example" });
});

test("an existing account signs in and the code is left untouched", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const first = await signInWith(harness, "github");
  const user = users.findByIdentity(harness.db, "github", "4242");
  const { code } = inviteFrom(harness);
  const again = await signInWith(harness, "github", { code, returnTo: "/saved" });
  t.is(again.headers.get("location"), `${PUBLIC_ORIGIN}/saved`);
  t.is(auth.readSession(harness.db, tokenOf(again))?.userId, user?.id);
  t.not(tokenOf(again), tokenOf(first));
  t.is(users.listUsers(harness.db).filter((u) => u.login === "octocat").length, 1);
  t.is(accountInvites.checkCode(harness.db, code).status, "open");
  t.is((await harness.caller(user).auth.me())?.pendingInvite, null);
});

test("the other provider's identity of the same person is a separate account", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  await signInWith(harness, "github");
  const github = users.findByIdentity(harness.db, "github", "4242");
  // Same username and the same email address: still a new identity.
  const x = await signInWith(harness, "x");
  t.is(x.headers.get("location"), `${PUBLIC_ORIGIN}/welcome?new=1`);
  const xUser = users.findByIdentity(harness.db, "x", X_PROFILE.id);
  t.truthy(xUser);
  t.not(xUser?.id, github?.id);
  t.is(auth.readSession(harness.db, tokenOf(x))?.userId, xUser?.id);
});

test("a deleted account's identity signs in again as a new waiting account", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const member = harness.addUser("leaver");
  harness.db.$client
    .prepare(`UPDATE users SET provider = 'x', provider_user_id = ? WHERE id = ?`)
    .run(X_PROFILE.id, member.id);
  accounts.deleteAccount(harness.db, member.id);
  const response = await signInWith(harness, "x");
  t.is(response.headers.get("location"), `${PUBLIC_ORIGIN}/welcome?new=1`);
  const fresh = users.findByIdentity(harness.db, "x", X_PROFILE.id);
  t.not(fresh?.id, member.id);
  t.is(fresh?.status, "waiting");
  t.false(users.handleAvailable(harness.db, member.handle ?? ""));
});

test("the 6th waiting account from one IP key in a day is refused", async (t) => {
  const stub: ProviderStub = { calls: [] };
  const harness = harnessWith(t, stub);
  const outcomes: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    stub.github = { ...GITHUB_PROFILE, id: 9000 + index, login: `w${index}` };
    const response = await signInWith(harness, "github", {}, { "Fly-Client-IP": "9.9.9.9" });
    outcomes.push(response.headers.get("location") ?? "");
  }
  t.is(outcomes.filter((location) => location.endsWith("/welcome?new=1")).length, 5);
  t.true(outcomes[5]?.includes("/login?error=too_many_accounts"));
  t.is(users.findByIdentity(harness.db, "github", "9005"), null);
  // Another address of the same IPv6 /64 is the same key; another /64 is not.
  for (let index = 0; index < 5; index += 1) {
    stub.github = { ...GITHUB_PROFILE, id: 9100 + index, login: `v6-${index}` };
    await signInWith(harness, "github", {}, { "Fly-Client-IP": `2001:db8:1:2::${index + 1}` });
  }
  stub.github = { ...GITHUB_PROFILE, id: 9199, login: "v6-same" };
  const same = await signInWith(harness, "github", {}, { "Fly-Client-IP": "2001:db8:1:2:ffff::9" });
  t.true(same.headers.get("location")?.includes("too_many_accounts"));
  stub.github = { ...GITHUB_PROFILE, id: 9198, login: "v6-other" };
  const other = await signInWith(harness, "github", {}, { "Fly-Client-IP": "2001:db8:1:3::1" });
  t.true(other.headers.get("location")?.endsWith("/welcome?new=1"));
  // A sign-in with an open code is not a waiting account and is not counted.
  stub.github = { ...GITHUB_PROFILE, id: 9200, login: "invited" };
  const { code } = inviteFrom(harness);
  const invited = await signInWith(harness, "github", { code }, { "Fly-Client-IP": "9.9.9.9" });
  t.is(invited.headers.get("location"), `${PUBLIC_ORIGIN}/`);
});

test("a state is single use and bound to its provider and cookie", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const handshake = await start(harness, "github");
  const first = await callback(harness, "github", handshake);
  t.is(first.status, 302);
  const replay = await callback(harness, "github", handshake);
  t.true(replay.headers.get("location")?.includes("error=expired_state"));
  // A GitHub handshake is not accepted by the X callback.
  const crossed = await start(harness, "github");
  const wrong = await callback(harness, "x", crossed);
  t.true(wrong.headers.get("location")?.includes("error=expired_state"));
  // Without the state cookie: the handshake an attacker started, replayed in
  // someone else's browser.
  const forged = await start(harness, "x");
  const noCookie = await harness.request(`/auth/x/callback?code=a&state=${forged.state}`);
  t.true(noCookie.headers.get("location")?.includes("error=expired_state"));
  t.is(sessionCookie(noCookie), null);
});

test("a denied consent and a failed exchange create nothing", async (t) => {
  const stub: ProviderStub = { calls: [], tokenStatus: 400 };
  const harness = harnessWith(t, stub);
  const denied = await start(harness, "x");
  const response = await harness.request(
    `/auth/x/callback?error=access_denied&state=${denied.state}`,
    { headers: { Cookie: denied.cookie } },
  );
  t.true(response.headers.get("location")?.includes("error=cancelled"));
  const failed = await signInWith(harness, "x");
  t.true(failed.headers.get("location")?.includes("error=exchange_failed"));
  stub.tokenStatus = 200;
  stub.profileStatus = 401;
  const profile = await signInWith(harness, "github");
  t.true(profile.headers.get("location")?.includes("error=profile_failed"));
  t.is(users.listUsers(harness.db).length, 0);
});

test("an avatar outside the providers' image hosts is dropped", async (t) => {
  const harness = harnessWith(t, {
    calls: [],
    x: { ...X_PROFILE, profile_image_url: "javascript:alert(1)" },
    github: { ...GITHUB_PROFILE, avatar_url: "http://avatars.githubusercontent.com/u/1" },
  });
  await signInWith(harness, "x");
  await signInWith(harness, "github");
  t.is(users.findByIdentity(harness.db, "x", X_PROFILE.id)?.avatarUrl, null);
  t.is(users.findByIdentity(harness.db, "github", "4242")?.avatarUrl, null);
});

test("the allowlist keeps a GitHub account from being created", async (t) => {
  const harness = harnessWith(t, { calls: [] }, { SESSION_ALLOWED_GITHUB_LOGINS: "raymond" });
  const response = await signInWith(harness, "github");
  t.true(response.headers.get("location")?.includes("error=not_allowed"));
  t.is(users.listUsers(harness.db).length, 0);
});

test("a provider without credentials answers 503 to the start, and sends a page to sign-in", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/auth/x/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  t.is(response.status, 503);
  const page = await harness.request("/auth/x");
  t.is(page.status, 302);
  t.true(page.headers.get("location")?.endsWith("/login?error=unavailable&provider=x"));
  // an unknown provider name goes to the app's Not found page
  const unknown = await harness.request("/auth/mastodon");
  t.is(unknown.status, 302);
  t.true(unknown.headers.get("location")?.endsWith("/not-found"));
  t.true(
    (await harness.request("/auth/mastodon/callback")).headers
      .get("location")
      ?.endsWith("/not-found"),
  );
});

test("test-login signs in without a provider, and logout clears the session", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/auth/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "Tester-One", isAdmin: true }),
  });
  t.is(response.status, 200);
  const body = (await response.json()) as { login: string; isAdmin: boolean; handle: string };
  t.is(body.login, "Tester-One");
  t.is(body.handle, "tester_one");
  t.true(body.isAdmin);
  const token = tokenOf(response);
  t.truthy(auth.readSession(harness.db, token));
  const waiting = await harness.request("/auth/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "someone-new", waiting: true }),
  });
  t.like(await waiting.json(), { status: "waiting", handle: null });

  const logout = await harness.request("/auth/logout", { method: "POST", cookie: token });
  t.is(logout.status, 204);
  t.is(auth.readSession(harness.db, token), null);
});

test("test-login is outside the per-address sign-in budget; provider sign-in is not", async (t) => {
  const harness = harnessWith(t, { calls: [] });
  const budget = harness.config.abuse.authPerMinute;
  for (let index = 0; index <= budget; index += 1) {
    const response = await harness.request("/auth/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: `tester-${index}` }),
    });
    t.is(response.status, 200, `sign-in ${index + 1}`);
  }
  const pages: string[] = [];
  for (let index = 0; index <= budget; index += 1) {
    pages.push((await harness.request("/auth/x")).headers.get("location") ?? "");
  }
  t.true(pages.at(0)?.startsWith("https://x.com/i/oauth2/authorize"));
  t.true(pages.at(-1)?.includes("error=rate_limited"));
});

test("test-login is absent unless SESSION_TEST_AUTH is set", async (t) => {
  const harness = createHarness(t, { env: { SESSION_TEST_AUTH: "0" } });
  const response = await harness.request("/auth/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  t.is(response.status, 404);
});

test("return_to accepts only same-origin paths", (t) => {
  t.is(safeReturnTo("/r/abc?tab=1"), "/r/abc?tab=1");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "r/abc", "", null]) {
    t.is(safeReturnTo(bad), null, String(bad));
  }
});

test("signing out ends this session and leaves the account's others", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("two-browsers");
  const laptop = harness.signIn(user);
  const phone = harness.signIn(user);
  const response = await harness.request("/api/trpc/auth.logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    cookie: laptop,
  });
  t.is(response.status, 200);
  t.true((response.headers.get("set-cookie") ?? "").startsWith("session=;"));
  t.is(auth.readSession(harness.db, laptop), null);
  t.truthy(auth.readSession(harness.db, phone));
});

test("the fixture provider runs the whole handshake in process", async (t) => {
  const harness = createHarness(t, { env: { SESSION_FIXTURE_OAUTH: "1" } });
  const handshake = await start(harness, "x");
  t.is(handshake.url.origin, PUBLIC_ORIGIN);
  const consent = await harness.request(`${handshake.url.pathname}${handshake.url.search}`, {
    headers: { Cookie: "session_fixture_identity=fixture.person" },
  });
  t.is(consent.status, 302);
  const back = new URL(consent.headers.get("location") ?? "");
  t.is(back.pathname, "/auth/x/callback");
  const response = await harness.request(`${back.pathname}${back.search}`, {
    headers: { Cookie: handshake.cookie },
  });
  t.is(response.headers.get("location"), `${PUBLIC_ORIGIN}/welcome?new=1`);
  const me = await harness
    .caller(
      users.findById(harness.db, auth.readSession(harness.db, tokenOf(response))?.userId ?? ""),
    )
    .auth.me();
  t.is(me?.login, "fixture.person");
  t.is(me?.provider, "x");
  // Not an open redirect.
  const elsewhere = await harness.request(
    `/auth/fixture/x/authorize?redirect_uri=${encodeURIComponent("https://evil.example/")}&state=s`,
  );
  t.is(elsewhere.status, 400);
});

test("test-login's spent records included tokens already spent this week", async (t) => {
  const ledger = new MemoryLedger();
  const now = Date.UTC(2026, 10, 24, 12);
  const harness = createHarness(t, { deps: { ledger, now: () => now } });
  const signIn = (body: Record<string, unknown>) =>
    harness.request("/auth/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await signIn({ login: "near-the-allowance", spent: 1_999_000 });
  t.is(response.status, 200);
  const { id } = (await response.json()) as { id: string };
  t.is(ledger.includedUsage(id, weekOf(now)), 1_999_000);
  t.true(ledger.rows({ userId: id }).every((row) => row.state === "closed"));
  // anything but a positive whole number records nothing
  for (const spent of [0, -5, 1.5, "100", null])
    await signIn({ login: "near-the-allowance", spent });
  t.is(ledger.rows({ userId: id }).length, 1);
});
