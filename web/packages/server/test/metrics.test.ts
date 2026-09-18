// `/healthz` readiness and the `/metrics` exposition
// (`13-deployment-fly.md` §5, §7).

import test from "ava";

import { createApp } from "../src/app.js";
import { createReadiness } from "../src/health.js";
import { MetricsRegistry, routeLabel, statusClass } from "../src/metrics.js";

import { createHarness } from "./helpers.js";

const TOKEN = "metrics-token";

test("/healthz fails while the server is starting and again while it drains", async (t) => {
  const harness = createHarness(t);
  const readiness = createReadiness("starting");
  const app = createApp({ ...harness.deps, readiness, clientDistDirectory: "/nonexistent" });

  const starting = await app.request("/healthz");
  t.is(starting.status, 503);
  t.is(await starting.text(), "starting\n");

  readiness.ready();
  const ready = await app.request("/healthz");
  t.is(ready.status, 200);
  t.is(await ready.text(), "ok\n");

  readiness.drain();
  const draining = await app.request("/healthz");
  t.is(draining.status, 503);
  t.is(await draining.text(), "draining\n");

  // A late boot step must not undo a drain that has already started.
  readiness.ready();
  t.is(readiness.state(), "draining");
});

test("/metrics is absent without a token and closed to the wrong one", async (t) => {
  const open = createHarness(t);
  t.is((await open.request("/metrics")).status, 404);

  const harness = createHarness(t, { env: { SESSION_METRICS_TOKEN: TOKEN } });
  t.is((await harness.request("/metrics")).status, 401);
  const wrong = await harness.request("/metrics", {
    headers: { Authorization: "Bearer metrics-tokeN" },
  });
  t.is(wrong.status, 401);
});

test("/metrics reports the process and the database", async (t) => {
  const harness = createHarness(t, { env: { SESSION_METRICS_TOKEN: TOKEN } });
  // One request of each class, so the histogram has something to say.
  await harness.request("/healthz");
  await harness.request("/api/trpc/nope");

  const response = await harness.request("/metrics", {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  t.is(response.status, 200);
  t.is(response.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  t.is(response.headers.get("cache-control"), "no-store");
  const body = await response.text();

  t.true(body.includes("# TYPE session_http_request_duration_seconds histogram"));
  t.regex(
    body,
    /session_http_request_duration_seconds_bucket\{method="GET",route="\/healthz",status="2xx",le="\+Inf"\} 1/,
  );
  t.regex(
    body,
    /session_http_request_duration_seconds_count\{method="GET",route="\/healthz",status="2xx"\} 1/,
  );
  t.true(body.includes("session_ready 1"));
  t.true(body.includes("session_queue_depth 0"));
  t.true(body.includes("session_sse_clients 0"));
  t.regex(body, /session_db_size_bytes\{file="db"\} [1-9][0-9]*/);
  t.true(body.includes("# TYPE session_daily_tokens gauge"));
  t.true(body.endsWith("\n"));
});

test("active runs, queue depth, and daily usage come out of the database", async (t) => {
  const harness = createHarness(t, { env: { SESSION_METRICS_TOKEN: TOKEN } });
  const user = harness.addUser("metrics");
  const client = harness.db.$client;
  client
    .prepare(
      "INSERT INTO usage_events (id, user_id, node_id, kind, provider, model, input_tokens, output_tokens, reasoning_tokens, cached_tokens, cost_estimate_micros, created_at) VALUES (?, ?, NULL, 'research', 'vertex', 'gemini-flash', 100, 40, 0, 0, 2500, ?)",
    )
    .run("usage-metrics", user.id, Date.now());

  const caller = harness.caller(user);
  const workspace = await caller.workspaces.ensureDefault();
  const detail = await caller.research.createTree({
    prompt: "What is in the queue?",
    model: "gemini-flash",
    workspaceId: workspace.id,
  });
  const nodeId = detail.nodes[0]?.id ?? "";

  const scrape = async (): Promise<string> =>
    (await harness.request("/metrics", { headers: { Authorization: `Bearer ${TOKEN}` } })).text();

  // Admitted but unclaimed: queue depth, not an active run.
  const waiting = await scrape();
  t.true(waiting.includes("session_queue_depth 1"));
  t.false(waiting.includes("session_active_runs{"));

  client.prepare("UPDATE run_queue SET claimed_at = ? WHERE node_id = ?").run(Date.now(), nodeId);
  const running = await scrape();
  t.true(running.includes("session_queue_depth 0"));
  t.regex(running, /session_active_runs\{provider="[a-z]+"\} 1/);
  t.true(running.includes('session_daily_tokens{provider="vertex",direction="input"} 100'));
  t.true(running.includes('session_daily_tokens{provider="vertex",direction="output"} 40'));
  t.true(running.includes('session_daily_cost_usd{provider="vertex"} 0.002500'));
});

test("the histogram labels stay bounded", (t) => {
  t.is(routeLabel("/a/9f3c1d"), "/a");
  t.is(routeLabel("/api/trpc/research.ask"), "/api/trpc");
  t.is(routeLabel("/__session/fonts/DMSans-Variable-Latin.woff2"), "/__session/fonts");
  t.is(routeLabel("/healthz"), "/healthz");
  t.is(routeLabel("/assets/index-abc123.js"), "static");
  t.is(statusClass(204), "2xx");
  t.is(statusClass(503), "5xx");

  const registry = new MetricsRegistry();
  registry.observeRequest("BREW", "/teapot", 418, 0.002);
  const rendered = registry.render().join("\n");
  t.true(rendered.includes('method="other"'));
  t.true(rendered.includes('route="static"'));
  t.true(rendered.includes('status="4xx"'));
  // Cumulative buckets: the first bucket already holds the observation.
  t.true(rendered.includes('le="0.005"} 1'));
  t.true(rendered.includes('le="+Inf"} 1'));
});
