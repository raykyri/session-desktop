import test from "ava";

import { app } from "../src/app.js";

test("GET /healthz reports readiness", async (t) => {
  const response = await app.request("/healthz");
  t.is(response.status, 200);
  t.is(await response.text(), "ok\n");
});

test("unknown routes are 404", async (t) => {
  const response = await app.request("/nope");
  t.is(response.status, 404);
});
