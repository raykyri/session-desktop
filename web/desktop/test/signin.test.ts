// Device sign-in from the app (phase 3): devices.authorize with what the
// app is, the browser's address (the request, never the code), and the wait
// for the token.

import test from "ava";

import { SIGNIN_TTL_MS, SignInError, approvalUrl, authorize, waitForToken } from "../src/signin.js";

const ORIGIN = "https://session.test";
const about = { name: "MacBook Air", device: "MacBook Air · macOS 15.1", app: "Session 0.1.0" };

type Reply = { status: number; body: unknown } | "offline";

/** A fetch that answers `replies` in order and records each call. */
function stub(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    const r = replies.shift() ?? "offline";
    if (r === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  };
  return { f: f, calls };
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result, serverTime: 0 } });
const err = (status: number, code: string) => ({
  status,
  body: { ok: false, error: { code, message: code }, serverTime: 0 },
});

test("authorize sends the device and the app, without a cookie, and answers the request and code", async (t) => {
  const { f, calls } = stub([ok({ request: "r1", code: "ABC-DEF", url: "session.app/device" })]);
  t.deepEqual(await authorize(ORIGIN, about, f), { request: "r1", code: "ABC-DEF" });
  t.is(calls[0]?.url, `${ORIGIN}/api/rpc/devices.authorize`);
  t.is(calls[0]?.init.credentials, "omit");
  t.deepEqual(JSON.parse(calls[0]?.init.body as string), {
    name: "MacBook Air",
    kind: "mac",
    device: "MacBook Air · macOS 15.1",
    app: "Session 0.1.0",
  });
  const refused = stub([err(400, "BAD_REQUEST")]);
  const e = await t.throwsAsync(authorize(ORIGIN, about, refused.f), { instanceOf: SignInError });
  t.is(e?.code, "BAD_REQUEST");
  const down = stub(["offline"]);
  const offline = await t.throwsAsync(authorize(ORIGIN, about, down.f), {
    instanceOf: SignInError,
  });
  t.is(offline?.code, "OFFLINE");
});

test("the browser's address names the request, never the code", (t) => {
  t.is(approvalUrl(ORIGIN, "01J/X"), `${ORIGIN}/device?request=01J%2FX`);
});

const fast = { sleep: () => Promise.resolve() };

test("the app asks for its token until the browser approves; no answer is asked again", async (t) => {
  const { f, calls } = stub([
    err(412, "PRECONDITION_FAILED"),
    "offline",
    err(503, "SERVICE_UNAVAILABLE"),
    ok({ token: "tok", device: "d1", u: "ines.v" }),
  ]);
  const r = await waitForToken(ORIGIN, "r1", {
    signal: new AbortController().signal,
    fetch: f,
    ...fast,
  });
  t.deepEqual(r, { token: "tok", device: "d1", u: "ines.v" });
  t.is(calls.length, 4);
  t.true(calls.every((c) => c.url === `${ORIGIN}/api/rpc/devices.token`));
  t.deepEqual(JSON.parse(calls[0]?.init.body as string), { request: "r1" });
});

test("a denied sign-in, an expired one, and a cancelled wait", async (t) => {
  const signal = new AbortController().signal;
  t.is(
    await waitForToken(ORIGIN, "r1", { signal, fetch: stub([err(403, "FORBIDDEN")]).f, ...fast }),
    "denied",
  );
  t.is(
    await waitForToken(ORIGIN, "r1", { signal, fetch: stub([err(404, "NOT_FOUND")]).f, ...fast }),
    "expired",
  );
  // the request's 10 minutes pass without an answer from the server
  let now = 0;
  const waiting = stub(Array.from({ length: 5 }, () => "offline" as const));
  t.is(
    await waitForToken(ORIGIN, "r1", {
      signal,
      fetch: waiting.f,
      now: () => now,
      sleep: () => Promise.resolve(void (now += SIGNIN_TTL_MS / 2)),
    }),
    "expired",
  );
  t.is(waiting.calls.length, 3);
  const ac = new AbortController();
  const cancelled = waitForToken(ORIGIN, "r1", {
    signal: ac.signal,
    fetch: stub([err(412, "PRECONDITION_FAILED")]).f,
    pollMs: 60_000,
  });
  ac.abort();
  t.is(await cancelled, "cancelled");
});

test("an answer without a token is an error", async (t) => {
  const { f } = stub([ok({ token: 1 })]);
  await t.throwsAsync(
    waitForToken(ORIGIN, "r1", { signal: new AbortController().signal, fetch: f, ...fast }),
    { instanceOf: SignInError },
  );
});
