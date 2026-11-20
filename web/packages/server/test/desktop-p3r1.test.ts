// Review round 1 of phase 3 (reviewer A), the server's side of the Desktop
// app: a sign-in asked from the app's origin without a token or a cookie
// is counted against its address's budget, as any signed-out call is (the
// reviewer's 300 calls in a row came with no address, which `app.request`
// gives none); and a registration names the person its client id is for,
// so a client takes no client id for anyone else (finding 1).

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient, signInDevice } from "./sync.helpers.js";

const APP = { Origin: "tauri://localhost" };

test("devices.authorize from the app's origin, signed out, takes from its address's budget", async (t) => {
  const h = createHarness(t, {
    env: { SESSION_WRITE_BURST: "3", SESSION_WRITES_PER_MINUTE: "1" },
  });
  const statuses: number[] = [];
  for (let k = 0; k < 5; k++) {
    const r = await h.app.request(
      "/api/rpc/devices.authorize",
      {
        method: "POST",
        headers: { ...APP, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Mac", kind: "mac" }),
      },
      { incoming: { socket: { remoteAddress: "198.51.100.9" } } },
    );
    statuses.push(r.status);
    if (k === 0) t.is(r.headers.get("Access-Control-Allow-Origin"), "tauri://localhost");
  }
  t.deepEqual(statuses, [200, 200, 200, 429, 429]);
  // another address has its own
  const other = await h.app.request(
    "/api/rpc/devices.authorize",
    {
      method: "POST",
      headers: { ...APP, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mac", kind: "mac" }),
    },
    { incoming: { socket: { remoteAddress: "203.0.113.7" } } },
  );
  t.is(other.status, 200);
});

test("a registration names the person its client id is for", async (t) => {
  const h = createHarness(t);
  const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
  t.like((await mel.register()).body, { ok: true, u: "mel" });
  const d = await signInDevice(h, mel);
  const device = new HttpClient(h, { bearer: d.token });
  t.like((await device.register()).body, { ok: true, u: "mel" });
});
