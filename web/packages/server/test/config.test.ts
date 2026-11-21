// The sync settings' validation after the M3 review (`01` S3, Y6, A1, R1):
// the cursor keys and their rotation time, the production refusals, the
// upper bounds of the size settings, and the test routes, which only a test
// server on a loopback origin mounts.

import test from "ava";

import type { ConfigError } from "../src/config.js";
import { isLoopbackOrigin, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { warnOnDevelopmentCursorKey } from "../src/main.js";

import { createHarness, testConfig } from "./helpers.js";

const key = (b: number) => Buffer.alloc(32, b).toString("base64");
const production = {
  NODE_ENV: "production",
  SESSION_PUBLIC_ORIGIN: "https://session.example",
  SESSION_DATA_DIR: "/tmp/session-config",
  SESSION_SECRET_KEY: key(1),
  SESSION_CURSOR_KEY: key(2),
};
const issues = (env: Record<string, string>): string => {
  try {
    loadConfig(env);
    return "";
  } catch (e) {
    return (e as ConfigError).issues.join("\n");
  }
};

test("SESSION_CURSOR_KEY_ROTATED_AT is a strict ISO time, not in the future", (t) => {
  const withPrevious = (at: string) => ({
    ...production,
    SESSION_CURSOR_KEY_PREVIOUS: key(3),
    SESSION_CURSOR_KEY_ROTATED_AT: at,
  });
  for (const at of ["1", "2026-11-01", "Nov 1 2026", "2026-11-01T00:00", "2026-13-45T00:00:00Z"])
    t.regex(issues(withPrevious(at)), /SESSION_CURSOR_KEY_ROTATED_AT: required/, at);
  t.regex(issues(withPrevious("2099-01-01T00:00:00Z")), /is in the future/);
  for (const at of ["2026-11-01T00:00:00Z", "2026-11-01T00:00:00.000+01:00", "2026-11-01T00:00Z"])
    t.is(issues(withPrevious(at)), "", at);
});

test("production refuses the development cursor key, the secret key as the cursor key, and a previous key equal to the current one", (t) => {
  t.regex(
    issues({ ...production, SESSION_CURSOR_KEY: Buffer.alloc(32, 0xc5).toString("base64") }),
    /the public development key is not allowed in production/,
  );
  t.regex(
    issues({ ...production, SESSION_CURSOR_KEY: key(1) }),
    /must differ from SESSION_SECRET_KEY/,
  );
  t.regex(
    issues({
      ...production,
      SESSION_CURSOR_KEY_PREVIOUS: key(2),
      SESSION_CURSOR_KEY_ROTATED_AT: "2026-11-01T00:00:00Z",
    }),
    /SESSION_CURSOR_KEY_PREVIOUS: must differ from SESSION_CURSOR_KEY/,
  );
  // the same keys outside production are a developer's choice
  t.notThrows(() => testConfig("/tmp/session-config", { SESSION_CURSOR_KEY: key(2) }));
});

test("a cursor key is strict base64 of 32 bytes", (t) => {
  for (const bad of [
    `!!${key(7)}`,
    `${key(7)}\n##`,
    key(7).replace("=", ""),
    Buffer.alloc(32, 7).toString("base64url"),
    ` ${key(7).slice(1)}`,
  ])
    t.regex(issues({ ...production, SESSION_CURSOR_KEY: bad }), /expected 32 bytes of base64/, bad);
});

test("the window and size settings have upper bounds", (t) => {
  for (const [name, value] of [
    ["SESSION_WEB_WINDOW_CAP", "1000000000000"],
    ["SESSION_WEB_WINDOW_THREADS", "10001"],
    ["SESSION_WEB_WINDOW_DAYS", "3651"],
    ["SESSION_WEB_SUMMARY_DAYS", "3651"],
    ["SESSION_LIMIT_APPLY_BYTES", "1000000000000"],
    ["SESSION_LIMIT_APPLY_BATCH", "1001"],
  ] as const)
    t.regex(
      issues({ ...production, [name]: value }),
      new RegExp(`${name}: expected an integer from`),
    );
  t.is(
    testConfig("/tmp/session-config", { SESSION_WEB_SUMMARY_DAYS: "0" }).sync.window.summaryDays,
    0,
  );
});

test("boot warns when the development cursor key is in use", (t) => {
  const lines: string[] = [];
  const logger = createLogger({ level: "warn", write: (line) => lines.push(line) });
  t.true(warnOnDevelopmentCursorKey(testConfig("/tmp/session-config"), logger));
  t.regex(lines.join("\n"), /SESSION_CURSOR_KEY is unset/);
  lines.length = 0;
  t.false(warnOnDevelopmentCursorKey(loadConfig(production), logger));
  t.deepEqual(lines, []);
});

test("SESSION_TEST_ROUTES needs NODE_ENV=test and a loopback origin", (t) => {
  t.regex(
    issues({ ...production, SESSION_TEST_ROUTES: "1" }),
    /SESSION_TEST_ROUTES: allowed only with NODE_ENV=test/,
  );
  t.regex(
    issues({
      NODE_ENV: "development",
      SESSION_PUBLIC_ORIGIN: "http://localhost:8787",
      SESSION_TEST_ROUTES: "1",
    }),
    /SESSION_TEST_ROUTES/,
  );
  t.regex(
    issues({
      NODE_ENV: "test",
      SESSION_PUBLIC_ORIGIN: "https://staging.example",
      SESSION_TEST_ROUTES: "1",
    }),
    /SESSION_TEST_ROUTES/,
  );
  for (const origin of ["http://localhost:8787", "http://127.0.0.1:9000", "http://[::1]:8787"]) {
    t.true(isLoopbackOrigin(origin), origin);
    t.true(
      testConfig("/tmp/session-config", { SESSION_PUBLIC_ORIGIN: origin, SESSION_TEST_ROUTES: "1" })
        .testRoutes,
    );
  }
  t.false(isLoopbackOrigin("http://localhost.example"));
  t.false(testConfig("/tmp/session-config").testRoutes);
});

test("the test routes are absent unless SESSION_TEST_ROUTES is set: in production, development and a plain test server", async (t) => {
  const development = createHarness(t, { env: { NODE_ENV: "development" } });
  const test_ = createHarness(t);
  const prod = createHarness(t, {
    env: {
      NODE_ENV: "production",
      SESSION_SECRET_KEY: key(1),
      SESSION_CURSOR_KEY: key(2),
      SESSION_TEST_AUTH: "0",
    },
  });
  for (const h of [development, test_, prod]) {
    for (const path of ["/api/sync/test/scan", "/api/sync/test/log-rows?log=user:x"])
      t.is((await h.request(path)).status, 404, `${h.config.env} ${path}`);
    t.is(
      (
        await h.request("/api/sync/test/replace-history", {
          method: "POST",
          body: '{"log":"user:x"}',
        })
      ).status,
      404,
    );
  }
  const on = createHarness(t, { env: { SESSION_TEST_ROUTES: "1" } });
  t.is((await on.request("/api/sync/test/scan")).status, 200);
});
