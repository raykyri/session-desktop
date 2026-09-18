// End-to-end configuration (`12-testing-linting-ci.md` §3.6).
//
// One real server — fixture providers, a temp data directory, the test-only
// sign-in route — serving the built client through its own static middleware,
// which is the deployment's arrangement rather than Vite's. Building the
// client is part of the server command so `npm run test:e2e` is a single step.
//
// Visual regression screenshots run on Chromium only to avoid baseline churn from cross-engine font rasterization differences.

import { defineConfig, devices } from "@playwright/test";

import { APP_ORIGIN, ARTIFACT_ORIGIN, E2E_DATA_DIR, E2E_PORT } from "./e2e/constants.js";

const CI = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // `{platform}` is kept: a baseline rendered by macOS's rasterizer does not
  // match Linux's, so the two sets live side by side and a platform without
  // one skips the visual test rather than failing it (`visual.spec.ts`).
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
    reuseExistingServer: !CI,
    timeout: 180_000,
    // Request logging is disabled in e2e test mode to avoid obscuring test runner output.
    stdout: "ignore",
    stderr: "pipe",
    env: {
      // `::` rather than the config's default loopback: the suite reaches the
      // same process as both `127.0.0.1` and `localhost`, and a v4-only bind
      // would miss whichever of the two the browser resolves to `::1`.
      HOST: "::",
      PORT: String(E2E_PORT),
      NODE_ENV: "development",
      SESSION_PUBLIC_ORIGIN: APP_ORIGIN,
      SESSION_ARTIFACT_ORIGIN: ARTIFACT_ORIGIN,
      SESSION_DATA_DIR: E2E_DATA_DIR,
      SESSION_FIXTURE_PROVIDERS: "1",
      SESSION_TEST_AUTH: "1",
      // Every provider reports a credential so no model is hidden as
      // unavailable; the fixture provider answers instead of any of them.
      GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
      GOOGLE_VERTEX_PROJECT: "session-e2e",
      OPENROUTER_API_KEY: "openrouter-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      // No search key on purpose: `web_search` is then not registered at all,
      // so a fixture that calls it fails the call locally instead of reaching
      // a vendor from CI (`04-agent-runtime.md` §11).
      SESSION_ENFORCE_LIMITS: "0",
    },
  },
});
