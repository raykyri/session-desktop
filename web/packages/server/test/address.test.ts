// The client's network address (review round 2 of phase 2, reviewer A's
// findings 1 and 6; the experiment e01-client-ip as tests): by default the
// socket's, since off Fly a client sets `Fly-Client-IP` itself; a production
// server that names a header without FLY_APP_NAME does not start; a
// signed-out caller's budget is keyed by its IPv4 address or IPv6 /64; and
// an app polling `devices.token` spends its sign-in's budget, not its
// address's.

import test from "ava";

import { ConfigError } from "../src/config.js";

import { createHarness, testConfig } from "./helpers.js";
import { HttpClient } from "./sync.helpers.js";

const VICTIM = "203.0.113.7";
const ATTACKER = "198.51.100.9";

const status = (r: { status: number; body: { ok?: boolean } }) => (r.body.ok ? 200 : r.status);

test("SESSION_CLIENT_IP_HEADER is empty by default; in production a header needs FLY_APP_NAME", (t) => {
  t.is(
    testConfig("/tmp/session-config", { SESSION_CLIENT_IP_HEADER: "" }).sync.clientIpHeader,
    null,
  );
  const production = {
    NODE_ENV: "production",
    SESSION_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
    SESSION_API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  };
  const error = t.throws(() =>
    testConfig("/tmp/session-config", { ...production, SESSION_CLIENT_IP_HEADER: "fly-client-ip" }),
  );
  t.true(error instanceof ConfigError);
  t.true((error as ConfigError).issues.some((i) => i.startsWith("SESSION_CLIENT_IP_HEADER")));
  t.is(
    testConfig("/tmp/session-config", {
      ...production,
      SESSION_CLIENT_IP_HEADER: "fly-client-ip",
      FLY_APP_NAME: "session-dev",
    }).sync.clientIpHeader,
    "fly-client-ip",
  );
  t.is(
    testConfig("/tmp/session-config", { ...production, SESSION_CLIENT_IP_HEADER: "" }).sync
      .clientIpHeader,
    null,
  );
});

test.serial(
  "E1a: with the default, a sign-in asked from another socket naming the victim's address in Fly-Client-IP needs the code",
  async (t) => {
    const h = createHarness(t, { env: { SESSION_CLIENT_IP_HEADER: "" } });
    const victim = h.addUser("vera");
    const browser = new HttpClient(h, { cookie: h.signIn(victim) });
    browser.socket = VICTIM;
    const app = new HttpClient(h, null);
    app.socket = ATTACKER;
    const a = await app.call(
      "devices.authorize",
      { name: "Vera’s Mac", kind: "mac" },
      { "Fly-Client-IP": VICTIM },
    );
    const { request, code } = a.body.result as { request: string; code: string };
    const view = await h.app.request(
      `/api/devices/requests/${request}`,
      { headers: { Cookie: `session=${h.signIn(victim)}`, Origin: "http://localhost:8787" } },
      { incoming: { socket: { remoteAddress: VICTIM } } },
    );
    t.like(await view.json(), { request, sameComputer: false });
    t.like((await browser.call("devices.approve", { request })).body, {
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
    t.like((await app.call("devices.token", { request })).body, {
      ok: false,
      error: { code: "PRECONDITION_FAILED" },
    });
    // the code still approves it, as from any other computer
    t.like((await browser.call("devices.approve", { request, code })).body, { ok: true });
    // asked from the browser's own socket: one click
    const mac = new HttpClient(h, null);
    mac.socket = VICTIM;
    const b = await mac.call("devices.authorize", { name: "Vera’s Mac", kind: "mac" });
    const r2 = (b.body.result as { request: string }).request;
    t.like((await browser.call("devices.approve", { request: r2 })).body, { ok: true });
  },
);

test.serial(
  "E1b: with the default, a signed-out caller's budget is its socket's, whatever Fly-Client-IP it sends",
  async (t) => {
    const h = createHarness(t, {
      env: {
        SESSION_CLIENT_IP_HEADER: "",
        SESSION_WRITE_BURST: "3",
        SESSION_WRITES_PER_MINUTE: "1",
      },
    });
    const anon = new HttpClient(h, null);
    anon.socket = ATTACKER;
    const statuses = [];
    for (let k = 0; k < 6; k++)
      statuses.push(
        status(
          await anon.call("devices.authorize", { name: "m" }, { "Fly-Client-IP": `10.0.0.${k}` }),
        ),
      );
    t.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    const rows = (
      h.db.$client.prepare("SELECT count(*) AS n FROM sync_signins").get() as { n: number }
    ).n;
    t.is(rows, 3);
    // another socket has its own budget
    const other = new HttpClient(h, null);
    other.socket = VICTIM;
    t.is(status(await other.call("devices.authorize", { name: "m" })), 200);
  },
);

test.serial(
  "E1c: behind Fly, the addresses of one IPv6 /64 share a budget, and an IPv4-mapped address is its IPv4 address",
  async (t) => {
    const h = createHarness(t, {
      env: { SESSION_WRITE_BURST: "3", SESSION_WRITES_PER_MINUTE: "1" },
    });
    const anon = new HttpClient(h, null);
    anon.socket = "fdaa::1"; // Fly's proxy
    const call = async (ip: string) =>
      status(await anon.call("devices.authorize", { name: "m" }, { "Fly-Client-IP": ip }));
    const statuses = [];
    for (let k = 0; k < 6; k++) statuses.push(await call(`2001:db8:1:2::${(k + 1).toString(16)}`));
    t.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    t.is(await call("2001:db8:1:3::1"), 200, "another /64");
    t.deepEqual(
      [await call("203.0.113.5"), await call("::ffff:203.0.113.5"), await call("::ffff:cb00:7105")],
      [200, 200, 200],
    );
    t.is(await call("203.0.113.5"), 429);
  },
);

test.serial(
  "an app polling devices.token spends its sign-in's budget, not its address's",
  async (t) => {
    const h = createHarness(t, {
      env: { SESSION_WRITE_BURST: "3", SESSION_WRITES_PER_MINUTE: "1" },
    });
    const here = { "Fly-Client-IP": "203.0.113.5" };
    const anon = new HttpClient(h, null);
    const a = await anon.call("devices.authorize", { name: "Mac" }, here);
    const { request } = a.body.result as { request: string };
    const polls = [];
    for (let k = 0; k < 5; k++)
      polls.push(status(await anon.call("devices.token", { request }, here)));
    // waiting for its approval, then its own budget is spent
    t.deepEqual(polls, [412, 412, 412, 429, 429]);
    // the address still has two of its three
    t.is(status(await anon.call("devices.authorize", { name: "Mac" }, here)), 200);
    // a request the server does not hold is counted by address
    t.is(status(await anon.call("devices.token", { request: "nope" }, here)), 404);
    t.is(status(await anon.call("devices.authorize", { name: "Mac" }, here)), 429);
  },
);
