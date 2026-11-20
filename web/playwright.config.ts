// End-to-end configuration (`12-testing-linting-ci.md` §3.6).
//
// One real server — `@session/server/test-server`: fixture providers, a temp
// database, the test-only sign-in and scenario routes — serving the built
// client through its own static middleware, which is the deployment's
// arrangement rather than Vite's. Building the client is part of the server
// command so `npm run test:e2e` is a single step.
//

import { defineConfig, devices } from "@playwright/test";

import { APP_ORIGIN, E2E_REUSE_SERVER, E2E_RUN_ID_VARIABLE } from "./e2e/constants.js";

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
  // `{platform}`: a baseline rendered by macOS's rasterizer does not match
  // Linux's. The visual baselines were removed with the tree-shaped specs
  // (phase 2a) and are re-recorded with the spaces client.
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
      testIgnore: "**/e2e/desktop/**",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    // Phase 3: the Desktop app's frontend in Chromium, with its Tauri bridge
    // replaced by the test's (`e2e/desktop/bridge.ts`), against the same
    // server (`npm run test:e2e:desktop`).
    {
      name: "desktop",
      testDir: "./e2e/desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1320, height: 900 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 900 } },
      // Best-effort: WebKit is excluded from the default local run so a
      // machine without the browser still gets a green suite.
      testIgnore: "**/e2e/desktop/**",
      grepInvert: /@visual/,
    },
  ],

  webServer: {
    // The client bundle and the Desktop app's, then
    // `@session/server/test-server` on the suite's port (`e2e/server.ts`,
    // which also serves the Desktop app's frontend on `DESKTOP_ORIGIN`): a temp database, test sign-in and the test
    // routes (`/api/test/records`, `clock`, `fail`, `config`, `device`),
    // the fixture providers and the job runner.
    command: [
      "npm run build --workspace @session/client",
      "npm run build --workspace @session/desktop",
      "npx tsx e2e/server.ts",
    ].join(" && "),
    url: `${APP_ORIGIN}/healthz`,
    // A server already on the port is used only when asked for
    // (`SESSION_E2E_REUSE_SERVER=1`); otherwise Playwright refuses to start
    // rather than run against another suite's server and data.
    reuseExistingServer: E2E_REUSE_SERVER,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
