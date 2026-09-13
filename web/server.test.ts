import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createSessionWebServer } from "./server";

test("the public server serves the Session landing page", async (t) => {
  const server = createSessionWebServer({ publicOrigin: "https://qmux.app" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /<title>Session — Agent research workspace<\/title>/);
  assert.match(body, /Research that keeps its context\./);
  assert.match(body, /Branch any answer/);
  assert.match(body, /Keep durable research/);
  assert.match(body, /property="og:image" content="https:\/\/qmux\.app\/logo\.png"/);
  assert.match(body, /rel="canonical" href="https:\/\/qmux\.app\/"/);
  assert.doesNotMatch(body, /publish/i);
  assert.doesNotMatch(body, /<script/);

  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /img-src 'self'/);
});

test("the public server exposes health and no publication routes", async (t) => {
  const server = createSessionWebServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");

  const formerPublication = await fetch(`${origin}/p/example123`);
  assert.equal(formerPublication.status, 404);
  assert.doesNotMatch(await formerPublication.text(), /GitHub|Gist|publication/i);

  const formerAuth = await fetch(`${origin}/auth/github`);
  assert.equal(formerAuth.status, 404);
});
