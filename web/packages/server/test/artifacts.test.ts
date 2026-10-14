// The artifact origin's isolation from the app (`11-artifacts-and-browser.md`
// §2). Widget previews are the only routes left on this host; their own
// behavior is covered in `widgets.test.ts`.

import test from "ava";

import { ARTIFACT_ORIGIN, PUBLIC_ORIGIN, createHarness } from "./helpers.js";

const ARTIFACT_HOST = new URL(ARTIFACT_ORIGIN).host;

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
