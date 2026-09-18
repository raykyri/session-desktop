// The GitHub flow with a mocked provider (`06-auth-and-users.md` §2, §3).

import { auth, users } from "@session/db";
import test from "ava";

import { safeReturnTo } from "../src/auth/github.js";
import type { OAuthClient } from "../src/auth/github.js";

import { PUBLIC_ORIGIN, createHarness } from "./helpers.js";

interface GitHubStub {
  profile: Record<string, unknown>;
  status?: number;
  calls: { token: string }[];
}

/** Answers `https://api.github.com/user` and nothing else, so a request to any
 * other host fails the test rather than reaching the network. */
function githubFetch(stub: GitHubStub): typeof globalThis.fetch {
  return (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== "https://api.github.com/user") {
      throw new Error(`unexpected fetch of ${url}`);
    }
    const header = new Headers(init?.headers).get("authorization") ?? "";
    stub.calls.push({ token: header.replace(/^Bearer /, "") });
    return Promise.resolve(
      new Response(JSON.stringify(stub.profile), {
        status: stub.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

const oauthClient: OAuthClient = {
  authorizationUrl: (state, codeVerifier) =>
    new URL(
      `https://github.com/login/oauth/authorize?state=${state}&code_challenge=${codeVerifier.slice(0, 8)}`,
    ),
  exchange: (code) => Promise.resolve(`token-for-${code}`),
};

function harnessWith(t: Parameters<typeof createHarness>[0], stub: GitHubStub, env = {}) {
  return createHarness(t, {
    env,
    fetch: githubFetch(stub),
    createOAuthClient: () => oauthClient,
  });
}

/** The session cookie among the `Set-Cookie` headers; the callback also
 * clears the short-lived `oauth_state` one. */
function sessionCookie(response: Response): string | null {
  return response.headers.getSetCookie().find((value) => value.startsWith("session=")) ?? null;
}

function stateFrom(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return new URL(location).searchParams.get("state") ?? "";
}

/** The state travels in the redirect and in a `SameSite=Lax` cookie the
 * callback has to see again; a browser sends both, so the tests do too. */
async function startLogin(
  harness: ReturnType<typeof createHarness>,
  query = "",
  headers: Record<string, string> = {},
): Promise<{ state: string; cookie: string }> {
  const response = await harness.request(`/auth/github${query}`, { headers });
  const cookie = /oauth_state=[^;]*/.exec(response.headers.get("set-cookie") ?? "")?.[0] ?? "";
  return { state: stateFrom(response), cookie };
}

const PROFILE = {
  id: 4242,
  login: "octocat",
  name: "Octo Cat",
  avatar_url: "https://avatars.githubusercontent.com/u/1",
  created_at: "2015-01-02T03:04:05Z",
};

test("the start route stores state and a verifier and redirects to GitHub", async (t) => {
  const harness = harnessWith(t, { profile: PROFILE, calls: [] });
  const response = await harness.request("/auth/github?return_to=/r/abc");
  t.is(response.status, 302);
  const state = stateFrom(response);
  t.not(state, "");
  const stored = auth.consumeOAuthState(harness.db, state);
  t.truthy(stored);
  t.true((stored?.codeVerifier.length ?? 0) > 20);
  t.true(stored?.returnTo?.includes("/r/abc"));
});

test("the callback exchanges the code, creates the account, and sets the cookie", async (t) => {
  const stub: GitHubStub = { profile: PROFILE, calls: [] };
  const harness = harnessWith(t, stub);
  const { state, cookie: stateCookie } = await startLogin(harness, "?return_to=/r/abc");

  const callback = await harness.request(`/auth/github/callback?code=xyz&state=${state}`, {
    headers: { Cookie: stateCookie },
  });
  t.is(callback.status, 302);
  t.is(callback.headers.get("location"), `${PUBLIC_ORIGIN}/r/abc`);
  t.deepEqual(stub.calls, [{ token: "token-for-xyz" }]);

  const cookie = sessionCookie(callback) ?? "";
  t.true(cookie.startsWith("session="));
  t.true(cookie.includes("HttpOnly"));
  t.true(cookie.includes("SameSite=Lax"));
  // No `Secure` outside production, or the development cookie would be dropped.
  t.false(cookie.includes("Secure"));
  t.true(cookie.includes("Max-Age=2592000"));

  const user = users.findByGitHubId(harness.db, 4242);
  t.is(user?.login, "octocat");
  const token = /session=([^;]+)/.exec(cookie)?.[1] ?? "";
  t.is(auth.readSession(harness.db, token)?.userId, user?.id);
  const me = await harness.caller(user).auth.me();
  t.is(me?.login, "octocat");
});

test("a state is single use", async (t) => {
  const harness = harnessWith(t, { profile: PROFILE, calls: [] });
  const { state, cookie } = await startLogin(harness);
  const first = await harness.request(`/auth/github/callback?code=a&state=${state}`, {
    headers: { Cookie: cookie },
  });
  t.is(first.headers.get("location"), `${PUBLIC_ORIGIN}/`);
  const replay = await harness.request(`/auth/github/callback?code=a&state=${state}`, {
    headers: { Cookie: cookie },
  });
  t.true(replay.headers.get("location")?.includes("error=expired_state"));
});

test("the allowlist keeps an account from being created", async (t) => {
  const harness = harnessWith(
    t,
    { profile: PROFILE, calls: [] },
    {
      SESSION_ALLOWED_GITHUB_LOGINS: "raymond, someone",
    },
  );
  const { state, cookie } = await startLogin(harness);
  const callback = await harness.request(`/auth/github/callback?code=a&state=${state}`, {
    headers: { Cookie: cookie },
  });
  t.true(callback.headers.get("location")?.includes("error=not_allowed"));
  t.is(users.findByGitHubId(harness.db, 4242), null);
  t.is(sessionCookie(callback), null);
});

test("an invite is required, redeemed once, and recorded", async (t) => {
  const harness = harnessWith(t, { profile: PROFILE, calls: [] }, { SESSION_REQUIRE_INVITE: "1" });
  const withoutInvite = await startLogin(harness);
  const refused = await harness.request(
    `/auth/github/callback?code=a&state=${withoutInvite.state}`,
    { headers: { Cookie: withoutInvite.cookie } },
  );
  t.true(refused.headers.get("location")?.includes("error=invite_required"));

  const admin = harness.addUser("inviter", { isAdmin: true });
  const [code] = await harness
    .caller(admin)
    .admin.createInvites({ count: 1 })
    .then((r) => r.codes);
  t.truthy(code);

  const bad = await startLogin(harness, "?invite=nope");
  const rejected = await harness.request(`/auth/github/callback?code=a&state=${bad.state}`, {
    headers: { Cookie: bad.cookie },
  });
  t.true(rejected.headers.get("location")?.includes("error=invite_invalid"));
  // The half-created account is rolled back rather than left behind.
  t.is(users.findByGitHubId(harness.db, 4242), null);

  const good = await startLogin(harness, `?invite=${code ?? ""}`);
  const accepted = await harness.request(`/auth/github/callback?code=a&state=${good.state}`, {
    headers: { Cookie: good.cookie },
  });
  t.is(accepted.headers.get("location"), `${PUBLIC_ORIGIN}/`);
  t.is(users.findByGitHubId(harness.db, 4242)?.login, "octocat");
});

test("sign-up attempts are recorded against a salted address hash", async (t) => {
  const harness = harnessWith(t, { profile: PROFILE, calls: [] });
  const { state, cookie } = await startLogin(harness, "", { "Fly-Client-IP": "9.9.9.9" });
  await harness.request(`/auth/github/callback?code=a&state=${state}`, {
    headers: { "Fly-Client-IP": "9.9.9.9", Cookie: cookie },
  });
  const rows = harness.db.$client
    .prepare("SELECT ip_hash AS hash, outcome FROM signup_attempts")
    .all() as { hash: string; outcome: string }[];
  t.is(rows.length, 1);
  t.is(rows[0]?.outcome, "created");
  t.is(rows[0]?.hash.length, 64);
  t.false(rows[0]?.hash.includes("9.9.9.9"));
});

test("a failed profile fetch does not create an account", async (t) => {
  const harness = harnessWith(t, {
    profile: { message: "Bad credentials" },
    status: 401,
    calls: [],
  });
  const { state, cookie } = await startLogin(harness);
  const callback = await harness.request(`/auth/github/callback?code=a&state=${state}`, {
    headers: { Cookie: cookie },
  });
  t.true(callback.headers.get("location")?.includes("error=profile_failed"));
  t.is(users.listUsers(harness.db).length, 0);
});

test("test-login signs in without GitHub, and logout clears the session", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/auth/test-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "tester", isAdmin: true }),
  });
  t.is(response.status, 200);
  const body = (await response.json()) as { login: string; isAdmin: boolean };
  t.is(body.login, "tester");
  t.true(body.isAdmin);
  const token = /session=([^;]+)/.exec(sessionCookie(response) ?? "")?.[1] ?? "";
  t.truthy(auth.readSession(harness.db, token));

  const logout = await harness.request("/auth/logout", { method: "POST", cookie: token });
  t.is(logout.status, 204);
  t.is(auth.readSession(harness.db, token), null);
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

test("a callback without the state cookie is refused", async (t) => {
  const harness = harnessWith(t, { profile: PROFILE, calls: [] });
  const { state } = await startLogin(harness);
  // The handshake the attacker started, replayed in someone else's browser:
  // the row is there, the `SameSite=Lax` cookie is not.
  const forged = await harness.request(`/auth/github/callback?code=a&state=${state}`);
  t.true(forged.headers.get("location")?.includes("error=expired_state"));
  t.is(sessionCookie(forged), null);
  t.is(users.findByGitHubId(harness.db, 4242), null);
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
