// The artifact origin's isolation from the app (`11-artifacts-and-browser.md`
// §2). Widget previews are the only routes left on this host; their own
// behavior is covered in `widgets.test.ts`.

import test from "ava";

import { ConfigError } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import { logWidgetScriptPolicy } from "../src/main.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness, testConfig } from "./helpers.js";

const ARTIFACT_HOST = new URL(ARTIFACT_ORIGIN).host;

test("the artifact origin must be another host, and a same-site one is logged at boot", (t) => {
  const error = t.throws(() =>
    testConfig("unused-data-dir", {
      SESSION_PUBLIC_ORIGIN: "https://session.dev",
      SESSION_ARTIFACT_ORIGIN: "https://session.dev",
    }),
  );
  t.true(error instanceof ConfigError);
  t.regex(
    (error as ConfigError).issues.join("\n"),
    /SESSION_ARTIFACT_ORIGIN: must be a different host/u,
  );

  const lines: { level: string; message: string }[] = [];
  const logger = {
    info: (_: unknown, message: string) => lines.push({ level: "info", message }),
    error: (_: unknown, message: string) => lines.push({ level: "error", message }),
  } as unknown as Logger;
  logWidgetScriptPolicy(
    testConfig("unused-data-dir", {
      SESSION_PUBLIC_ORIGIN: "https://session.dev",
      SESSION_ARTIFACT_ORIGIN: "https://artifacts.session.dev",
    }),
    logger,
  );
  logWidgetScriptPolicy(testConfig("unused-data-dir"), logger);
  t.is(lines[0]!.level, "error");
  t.regex(lines[0]!.message, /same site \(session\.dev\).*Widget scripts are off/u);
  t.is(lines[1]!.level, "info");
});

test("the artifact host never sets a cookie", async (t) => {
  const harness = createHarness(t);
  for (const path of [`/w/${"f".repeat(64)}`, "/auth/test-login", "/"]) {
    const response = await harness.app.request(path, {
      method: path === "/auth/test-login" ? "POST" : "GET",
      headers: { Host: ARTIFACT_HOST, "Sec-Fetch-Dest": "iframe", Cookie: "session=forged" },
    });
    t.is(response.headers.get("set-cookie"), null, path);
  }
});

test("the artifact host serves artifacts and rejects requests for the rest of the app", async (t) => {
  const harness = createHarness(t);

  // The widget route belongs to this host and still answers on it: an unknown
  // token is 410, not the 404 every other path gets.
  const widget = await harness.app.request(`/w/${"f".repeat(64)}`, {
    headers: { Host: ARTIFACT_HOST, "Sec-Fetch-Dest": "iframe" },
  });
  t.is(widget.status, 410);

  // Everything else is the app. An auth route answering here is what would let
  // a session cookie be set on the origin the preview iframe is same-origin
  // with, which is the property the whole split exists to hold.
  for (const path of ["/", "/healthz", "/auth/github", "/api/trpc/auth.me"]) {
    const onArtifactHost = await harness.app.request(path, { headers: { Host: ARTIFACT_HOST } });
    t.is(onArtifactHost.status, 404, `${path} must not answer on the artifact host`);
  }

  // The same paths are unaffected on the app host.
  const health = await harness.app.request("/healthz", {
    headers: { Host: new URL(PUBLIC_ORIGIN).host },
  });
  t.is(health.status, 200);
});
