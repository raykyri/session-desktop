// End-to-end configuration (`12-testing-linting-ci.md` §3.6).
//
// One real server — fixture providers, a temp data directory, the test-only
// sign-in route — serving the built client through its own static middleware,
// which is the deployment's arrangement rather than Vite's. Building the
// client is part of the server command so `npm run test:e2e` is a single step.
//
// Visual regression screenshots run on Chromium only to avoid baseline churn from cross-engine font rasterization differences.

import { defineConfig, devices } from "@playwright/test";

import {
  APP_ORIGIN,
  ARTIFACT_ORIGIN,
  E2E_DATA_DIR,
  E2E_HOST,
  E2E_PORT,
  E2E_REUSE_SERVER,
  E2E_RUN_ID_VARIABLE,
} from "./e2e/constants.js";

const CI = Boolean(process.env["CI"]);

// One id per run, set in the runner before the workers start (they inherit
// it, and keep it when they load this file again). Logins carry it, with the
// attempt's retry number (`e2e/helpers.ts:e2eLogin`), so a retry or a second
// run against a reused server signs in as fresh accounts instead of finding
// the folders and threads an earlier attempt made.
process.env[E2E_RUN_ID_VARIABLE] ??= Date.now().toString(36);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // `{platform}` is kept: a baseline rendered by macOS's rasterizer does not
  // match Linux's, so the two sets live side by side. Outside CI a missing
  // baseline is written; in CI it fails unless `e2e/visual.pending` exists
  // (`visual.spec.ts`). The Linux set is rendered by CI's e2e job
  // (`.github/workflows/web.yml`, `12-testing-linting-ci.md` §4).
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // Concurrency is restricted to a single worker because shared test user accounts and queue admission limits would cause resource contention and timeouts.
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: APP_ORIGIN,
    trace: "retain-on-failure",
    video: CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } },
      // Best-effort: the visual specs are skipped here (see `visual.spec.ts`),
      // and WebKit is excluded from the default local run so a machine without
      // the browser still gets a green suite.
      grepInvert: /@visual/,
    },
  ],

  webServer: {
    command: [
      `rm -rf ${JSON.stringify(E2E_DATA_DIR)}`,
      "npm run build --workspace @session/client",
      "npx tsx packages/server/src/index.ts",
    ].join(" && "),
    url: `${APP_ORIGIN}/healthz`,
    // A server already on the port is used only when asked for
    // (`SESSION_E2E_REUSE_SERVER=1`); otherwise Playwright refuses to start
    // rather than run against another suite's server and data.
    reuseExistingServer: E2E_REUSE_SERVER,
    timeout: 180_000,
    // Request logging is disabled in e2e test mode to avoid obscuring test runner output.
    stdout: "ignore",
    stderr: "pipe",
    env: {
      // `::` (`E2E_HOST`) rather than the config's default loopback: the suite
      // reaches the same process as both `127.0.0.1` and `localhost`, and a
      // v4-only bind would miss `localhost` if the browser tried only `::1`.
      HOST: E2E_HOST,
      PORT: String(E2E_PORT),
      NODE_ENV: "development",
      SESSION_PUBLIC_ORIGIN: APP_ORIGIN,
      SESSION_ARTIFACT_ORIGIN: ARTIFACT_ORIGIN,
      SESSION_DATA_DIR: E2E_DATA_DIR,
      SESSION_FIXTURE_PROVIDERS: "1",
      SESSION_TEST_AUTH: "1",
      // The auth dialog's sign-in runs the real OAuth handshake against this
      // server's fixture provider endpoints (`auth/fixtureOAuth.ts`).
      SESSION_FIXTURE_OAUTH: "1",
      // Every provider reports a credential so no model is hidden as
      // unavailable; the fixture provider answers instead of any of them.
      GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
      GOOGLE_VERTEX_PROJECT: "session-e2e",
      OPENROUTER_API_KEY: "openrouter-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      // No search key on purpose: `web_search` is then not registered at all,
      // so a fixture that calls it fails the call locally instead of reaching
      // a vendor from CI (`04-agent-runtime.md` §11).
      // A member's overdraft past the weekly allowance (`03` K9): small, so
      // the billing spec's run reaches it in seconds. Only that spec's
      // member, who starts near the allowance, comes near it.
      SESSION_OVERDRAFT_TOKENS: "1000",
      // The specs write their channels and threads through the sync routes,
      // many in a few seconds, and sign in several people from one address
      // (`e2e/world.ts`): the abuse limits of `04` Z1 are raised.
      SESSION_LIMIT_WRITES_PER_MINUTE: "100000",
      SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "100000",
      SESSION_LIMIT_REGISTER_PER_MINUTE: "1000",
      SESSION_LIMIT_AUTH_PER_MINUTE: "1000",
      SESSION_LIMIT_STREAMS_PER_USER: "50",
      SESSION_LIMIT_SPACES_PER_DAY: "100000",
      SESSION_LIMIT_CHANNEL_INVITES_PER_DAY: "100000",
      SESSION_LIMIT_JOINS_PER_HOUR: "100000",
      SESSION_LIMIT_DIRECTORY_PER_MINUTE: "100000",
      SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: "100000",
      SESSION_LIMIT_THREAD_READS_PER_MINUTE: "100000",
      SESSION_LIMIT_THREAD_READS_PER_IP_PER_MINUTE: "100000",
      SESSION_LIMIT_BY_NAME_PER_MINUTE: "100000",
      // A channel past 100 threads keeps its oldest out of the window, for
      // the thread address of a thread outside it (`spaces-feed`, 01 R1).
      SESSION_WEB_WINDOW_CAP: "100",
    },
  },
});
