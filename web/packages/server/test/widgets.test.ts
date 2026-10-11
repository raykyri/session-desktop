import test from "ava";

import { mintWidgetPreview, renderStaticWidget } from "../src/artifacts/widgets.js";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness } from "./helpers.js";

const host = new URL(ARTIFACT_ORIGIN).host;
test("widget previews require authentication, use expiring capabilities and deny authored scripts", async (t) => {
  const harness = createHarness(t);
  await t.throwsAsync(harness.caller(null).artifacts.prepareWidget({ html: "<p>x</p>" }), {
    code: "UNAUTHORIZED",
  });
  const caller = harness.caller(harness.addUser("widget-owner"));
  const minted = await caller.artifacts.prepareWidget({
    html: '<p id="result">Static figure</p><script>fetch("https://bad.invalid")</script><meta HTTP-EQUIV="refresh" content="0;url=https://bad.invalid"><a href="https://bad.invalid">link</a>',
  });
  t.is(new URL(minted.url).origin, ARTIFACT_ORIGIN);
  const path = new URL(minted.url).pathname;
  const response = await harness.app.request(path, { headers: { Host: host } });
  t.is(response.status, 200);
  t.is(response.headers.get("cache-control"), "no-store");
  t.is(response.headers.get("set-cookie"), null);
  const policy = response.headers.get("content-security-policy") ?? "";
  t.true(policy.includes("script-src 'none'"));
  t.true(policy.endsWith("; sandbox"));
  t.true(policy.includes(`frame-ancestors ${PUBLIC_ORIGIN}`));
  t.false(policy.includes("allow-scripts"));
  const html = await response.text();
  t.true(html.includes("Static figure"));
  t.false(/<script|<meta|href=/iu.test(html));
  t.is(
    (await harness.app.request(path, { headers: { Host: new URL(PUBLIC_ORIGIN).host } })).status,
    404,
  );
  t.is(
    (await harness.app.request("/w/" + "f".repeat(64), { headers: { Host: host } })).status,
    410,
  );
  const expired = mintWidgetPreview(harness.db, "u", "<p>old</p>", 0);
  t.is((await harness.app.request(`/w/${expired.token}`, { headers: { Host: host } })).status, 410);
  await t.throwsAsync(caller.artifacts.prepareWidget({ html: "é".repeat(33_000) }), {
    code: "BAD_REQUEST",
  });
});

test("static sanitization removes forms' actions, focus grabs and embedded navigation", (t) => {
  const html = renderStaticWidget(
    '<form action="https://bad.invalid"><input autofocus><button formaction="https://bad.invalid">Go</button></form><svg><a xlink:href="https://bad.invalid"><text>x</text></a></svg><iframe srcdoc="evil"></iframe><img src="data:image/png;base64,x" onerror="alert(1)"><style>p{color:red}</style>',
  );
  t.false(/\s(?:action|formaction|autofocus|onerror|href|xlink:href)=|<iframe/iu.test(html));
  t.true(html.includes("p{color:red}"));
});

test("local SVG symbols survive but animated navigation and template payloads do not", (t) => {
  const html = renderStaticWidget(
    '<svg><defs><symbol id="dot"><circle r="4"/></symbol></defs><use href="#dot"/><a><set attributeName="href" to="https://bad.invalid"/></a></svg><template><meta http-equiv="refresh" content="0;url=https://bad.invalid"></template>',
  );
  t.true(html.includes('href="#dot"'));
  t.false(/<set|<template|bad.invalid/iu.test(html));
});
