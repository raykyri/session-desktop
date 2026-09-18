// The HTTP surface: health, headers, CSRF, origin validation, rate limits
// (`03-api-and-events.md` §5, `06-auth-and-users.md` §5, §8).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auth } from "@session/db";
import test from "ava";

import { ConfigError, findDotenvFile, loadConfig, validatedOrigin } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { sweepExpired } from "../src/main.js";
import { RATE_LIMITS, RateLimiter } from "../src/middleware/rateLimit.js";
import { contentSecurityPolicy } from "../src/middleware/security.js";
import { resolveWithinRoot } from "../src/middleware/static.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness, testConfig } from "./helpers.js";

test("GET /healthz reports readiness and is not cached", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/healthz");
  t.is(response.status, 200);
  t.is(await response.text(), "ok\n");
  t.is(response.headers.get("cache-control"), "no-store");
});

test("every response carries the security headers", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/healthz");
  t.is(response.headers.get("referrer-policy"), "no-referrer");
  t.is(response.headers.get("x-content-type-options"), "nosniff");
  t.true(response.headers.get("content-security-policy")?.includes("default-src 'self'"));
  t.true(response.headers.get("content-security-policy")?.includes(`frame-src ${ARTIFACT_ORIGIN}`));
  t.true(response.headers.has("permissions-policy"));
  // HSTS is Fly's TLS terminating in front of us; there is none in test.
  t.false(response.headers.has("strict-transport-security"));
});

test("the CSP allows the twimg hosts and no eval", (t) => {
  const policy = contentSecurityPolicy(ARTIFACT_ORIGIN);
  t.true(policy.includes("https://pbs.twimg.com"));
  t.true(policy.includes("https://abs.twimg.com"));
  t.false(policy.includes("unsafe-eval"));
  t.true(policy.includes("form-action 'self' https://github.com"));
});

test("rejects mutation requests missing the custom header", async (t) => {
  const harness = createHarness(t);
  const response = await harness.app.request("/api/trpc/workspaces.ensureDefault", {
    method: "POST",
    headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" },
    body: "{}",
  });
  t.is(response.status, 403);
});

test("rejects cross-origin requests regardless of request headers", async (t) => {
  const harness = createHarness(t);
  const foreignOrigin = await harness.app.request("/api/trpc/workspaces.ensureDefault", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "X-Requested-With": "session",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  t.is(foreignOrigin.status, 403);

  const crossSite = await harness.app.request("/api/trpc/system.health", {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  t.is(crossSite.status, 403);
});

test("a same-origin query passes the guard", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/api/trpc/system.health", {
    headers: { "Sec-Fetch-Site": "same-origin" },
  });
  t.is(response.status, 200);
});

test("SESSION_PUBLIC_ORIGIN must be an origin without a path", (t) => {
  t.is(validatedOrigin("https://session.dev", "SESSION_PUBLIC_ORIGIN"), "https://session.dev");
  t.is(validatedOrigin("http://localhost:1480/", "SESSION_PUBLIC_ORIGIN"), "http://localhost:1480");
  for (const bad of [
    "https://session.dev/app",
    "https://user:pass@session.dev",
    "https://session.dev?a=1",
    "https://session.dev#x",
    "ftp://session.dev",
    "not a url",
  ]) {
    t.throws(() => validatedOrigin(bad, "SESSION_PUBLIC_ORIGIN"), undefined, bad);
  }
});

test("fails configuration loading with invalid environment variables and reports all errors", (t) => {
  const error = t.throws(() =>
    loadConfig({
      NODE_ENV: "staging",
      SESSION_PUBLIC_ORIGIN: "https://session.dev/app",
      SESSION_ARTIFACT_ORIGIN: "https://artifacts.session.dev",
      SESSION_RUNS_PER_USER: "many",
    }),
  );
  t.true(error instanceof ConfigError);
  const issues = (error as ConfigError).issues.join("\n");
  t.true(issues.includes("NODE_ENV"));
  t.true(issues.includes("SESSION_PUBLIC_ORIGIN"));
  t.true(issues.includes("SESSION_RUNS_PER_USER"));
});

test("test-only auth is impossible in production", (t) => {
  const config = testConfig("/tmp/session-config", {
    NODE_ENV: "production",
    SESSION_TEST_AUTH: "1",
  });
  t.false(config.testAuthEnabled);
  t.true(config.isProduction);
});

test("the auth routes are rate limited per address", async (t) => {
  const harness = createHarness(t);
  let last = 200;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await harness.request("/auth/github", {
      headers: { "Fly-Client-IP": "1.2.3.4" },
    });
    last = response.status;
  }
  t.is(last, 429);
  // A different address still has its own bucket.
  const other = await harness.request("/auth/github", { headers: { "Fly-Client-IP": "5.6.7.8" } });
  t.is(other.status, 302);
});

test("token buckets refill over their window", (t) => {
  let clock = 0;
  const limiter = new RateLimiter(() => clock);
  const spec = { limit: 2, windowMs: 1000 };
  t.true(limiter.take("k", spec).allowed);
  t.true(limiter.take("k", spec).allowed);
  const refused = limiter.take("k", spec);
  t.false(refused.allowed);
  t.true(refused.retryAfter >= 1);
  clock = 1000;
  t.true(limiter.take("k", spec).allowed);
});

test("a static path cannot escape the client bundle", (t) => {
  t.is(resolveWithinRoot("/srv/app", "/assets/index.js"), "/srv/app/assets/index.js");
  // Traversal is normalized back inside the root rather than followed out.
  t.is(resolveWithinRoot("/srv/app", "/../../etc/passwd"), "/srv/app/etc/passwd");
  t.is(resolveWithinRoot("/srv/app", "/%2e%2e%2f%2e%2e%2fetc/passwd"), "/srv/app/etc/passwd");
  t.is(resolveWithinRoot("/srv/app", "/a%00b"), null);
  t.is(resolveWithinRoot("/srv/app", "/%zz"), null);
});

test("without a built client an unknown path is a 404", async (t) => {
  const harness = createHarness(t);
  const response = await harness.request("/r/does-not-exist");
  t.is(response.status, 404);
});

test("the mutation budget is per account", async (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("budget");
  const caller = harness.caller(user);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await caller.workspaces.ensureDefault();
  }
  await t.throwsAsync(caller.workspaces.ensureDefault(), { message: /too many changes/ });
  // A second account is unaffected.
  await t.notThrowsAsync(harness.caller(harness.addUser("budget2")).workspaces.ensureDefault());
});

test("an opaque origin is not our origin", async (t) => {
  const harness = createHarness(t);
  const response = await harness.app.request("/api/trpc/workspaces.ensureDefault", {
    method: "POST",
    headers: { Origin: "null", "X-Requested-With": "session", "Content-Type": "application/json" },
    body: "{}",
  });
  t.is(response.status, 403);
  // A same-origin GET navigation carries no `Origin` at all and is unaffected.
  t.is((await harness.app.request("/healthz")).status, 200);
});

test("expired state is swept rather than kept until it is read again", (t) => {
  const harness = createHarness(t);
  const user = harness.addUser("sweeper");
  const session = auth.createSession(harness.db, user.id);
  auth.createOAuthState(harness.db, { state: "s", codeVerifier: "v" });
  harness.db.$client.prepare("UPDATE sessions SET expires_at = 1 WHERE id = ?").run(session.id);
  harness.db.$client.prepare("UPDATE oauth_states SET created_at = 0").run();
  harness.limiter.take("auth:ip:1.2.3.4", RATE_LIMITS.auth);

  sweepExpired(harness.deps, harness.limiter, createLogger({ write: () => undefined }));
  t.is(auth.readSession(harness.db, session.token), null);
  t.is(
    (harness.db.$client.prepare("SELECT count(*) AS n FROM oauth_states").get() as { n: number }).n,
    0,
  );
});

test("the workspace .env is found from a package directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-dotenv-"));
  t.teardown(() => {
    rmSync(root, { recursive: true, force: true });
  });
  // The layout `npm run dev --workspace` produces: the file sits beside the
  // workspace root, the process starts two directories below it.
  writeFileSync(join(root, ".env"), "SESSION_PROBE=found\n");
  const packageDirectory = join(root, "packages", "server");
  mkdirSync(packageDirectory, { recursive: true });

  t.is(findDotenvFile(packageDirectory), join(root, ".env"));
  t.is(findDotenvFile(root), join(root, ".env"));
  t.is(findDotenvFile(tmpdir()), null);
});
