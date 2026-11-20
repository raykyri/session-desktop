// The sync protocol over HTTP (phase 2a): register and write (seqs, replays,
// refusals, the protocol minimum), snapshot and pull with access filtering,
// SSE pokes, device sign-in and bearer auth, CORS, the account reads and the
// operator's time reset.

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient, signInDevice } from "./sync.helpers.js";

const people = (h: ReturnType<typeof createHarness>, ...logins: string[]) =>
  logins.map((l) => new HttpClient(h, { cookie: h.signIn(h.addUser(l)) }));

test("register and write: seqs, a replay, a refusal recorded, OUT_OF_ORDER and UNAUTHORIZED unrecorded", async (t) => {
  const h = createHarness(t);
  const [olga] = people(h, "olga");
  if (!olga) return t.fail();
  const reg = await olga.register();
  t.is(reg.status, 200);
  t.true(typeof reg.body["clientId"] === "string");
  t.is(reg.res.headers.get("x-session-server-time"), String(reg.body.serverTime));
  const space = olga.id();
  const e = olga.envelope("spaces.create", { id: space, name: "lounge" });
  const first = await olga.send(e);
  t.like(first.body, { ok: true, seq: 1 });
  // the same envelope again: its recorded answer, no seq used
  const again = await olga.post("/api/sync/write", e);
  t.like(again.body, { ok: true, replayed: true });
  // a refusal is recorded and uses the seq (409 CONFLICT: the name is taken)
  const taken = await olga.send(olga.envelope("spaces.create", { id: olga.id(), name: "lounge" }));
  t.is(taken.status, 409);
  t.like(taken.body, { ok: false, error: { code: "CONFLICT" }, seq: 2 });
  // a seq ahead of the client's: OUT_OF_ORDER, with the expected seq
  const ahead = await olga.post("/api/sync/write", { ...olga.envelope("likes.set", {}), seq: 9 });
  t.like(ahead.body, { ok: false, error: { code: "OUT_OF_ORDER", expectedSeq: 3 } });
  // signed out: UNAUTHORIZED
  const anon = new HttpClient(h, null);
  const out = await anon.post("/api/sync/write", e);
  t.is(out.status, 401);
  t.like(out.body, { ok: false, error: { code: "UNAUTHORIZED" } });
  t.like((await anon.register()).body, { ok: false, error: { code: "UNAUTHORIZED" } });
  // a body that is not JSON
  const bad = await h.app.request("/api/sync/write", {
    method: "POST",
    body: "{",
    headers: { Origin: "http://localhost:8787", "X-Requested-With": "session" },
  });
  t.is(bad.status, 400);
});

test("a request below the configured protocol minimum answers UPDATE_REQUIRED (426)", async (t) => {
  const h = createHarness(t, { env: { SESSION_MIN_PROTOCOL: "5" } });
  const [olga] = people(h, "olga");
  if (!olga) return t.fail();
  const r = await olga.post("/api/sync/register", {});
  t.is(r.status, 426);
  t.like(r.body, { ok: false, error: { code: "UPDATE_REQUIRED" } });
  // an envelope's own version counts too, with no header
  const w = await olga.post(
    "/api/sync/write",
    { ...olga.envelope("likes.set", {}), protocolVersion: 4 },
    { "X-Session-Protocol": "5" },
  );
  t.like(w.body, { ok: false, error: { code: "UPDATE_REQUIRED" } });
  t.is((await olga.post("/api/rpc/devices.authorize", { name: "x" })).status, 426);
});

test("snapshot and pull are filtered by the reader's scope", async (t) => {
  const h = createHarness(t);
  const [olga, mel, otto] = people(h, "olga", "mel", "otto");
  if (!olga || !mel || !otto) return t.fail();
  const lab = olga.id();
  t.true(
    (await olga.write("spaces.create", { id: lab, name: "lab", vis: "listed", policy: "request" }))
      .body.ok,
  );
  const th = olga.id();
  t.true(
    (await olga.write("threads.create", { id: th, space: lab, kind: "post", q: "MK-CLOSED" })).body
      .ok,
  );
  const keys = async (c: HttpClient) =>
    ((await c.snapshot(`space:${lab}`)).body["records"] as { key: string }[]).map((r) => r.key);
  t.true((await keys(olga)).includes(`thread:${th}`));
  t.false((await keys(otto)).includes(`thread:${th}`), "an outsider reads no thread");
  t.deepEqual(
    (await keys(new HttpClient(h, null))).filter((k) => k.startsWith("thread:")),
    [],
  );
  // a user log is its user's: another person's reads nothing
  const theirs = await otto.snapshot("user:olga");
  t.deepEqual(theirs.body["records"], []);
  // signed out: a user log is UNAUTHORIZED
  t.is((await new HttpClient(h, null).snapshot("user:olga")).status, 401);
  // mel joins by request and is approved: a pull with the old cursor resyncs
  // or brings the thread
  const s = await mel.snapshot(`space:${lab}`);
  const cursor = s.body["cursor"] as string;
  t.true((await mel.write("joinRequests.create", { space: lab, rulesAccepted: true })).body.ok);
  const req = h.deps.sync.records().get(`request:${lab}:mel`);
  t.true(
    (
      await olga.write("joinRequests.decide", {
        space: lab,
        users: ["mel"],
        decision: "approve",
        base: { mel: req?.rev ?? 0 },
      })
    ).body.ok,
  );
  const p = await mel.pull(`space:${lab}`, cursor);
  t.true(
    p.body["resync"] === true ||
      (p.body["changes"] as { key: string }[]).some((c) => c.key === `thread:${th}`),
  );
  t.true((await keys(mel)).includes(`thread:${th}`));
  // a cursor of another reader resyncs
  const o = await otto.pull(`space:${lab}`, cursor);
  t.true(o.body["resync"] === true);
  // the read carries lastSeq for the reader's own client only: none before
  // mel registered, olga's three writes after hers
  t.is(s.body["lastSeq"], null);
  t.is((await olga.snapshot(`space:${lab}`)).body["lastSeq"], 3);
});

test("the event stream pokes a reader for a change it may read, and closes on sign-out", async (t) => {
  const h = createHarness(t);
  const [olga, mel] = people(h, "olga", "mel");
  if (!olga || !mel) return t.fail();
  const sp = olga.id();
  await olga.write("spaces.create", { id: sp, name: "lounge" });
  const s = await mel.snapshot(`space:${sp}`);
  const stream = await mel.events({ [`space:${sp}`]: s.body["cursor"] as string });
  t.is(stream.status, 200);
  t.true((await stream.until(/: open/)).includes(": open"));
  await olga.write("threads.create", { id: olga.id(), space: sp, kind: "post", q: "hello" });
  const text = await stream.until(/event: poke/);
  t.regex(
    text,
    new RegExp(`event: poke\\nid: .*\\ndata: \\{"type":"poke","logs":\\["space:${sp}"\\]\\}`),
  );
  // signing out ends this session's streams
  const logout = await h.request("/auth/logout", {
    method: "POST",
    cookie: (mel.auth as { cookie: string }).cookie,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  t.is(logout.status, 204);
  await stream.until(null);
  t.true(stream.ended());
  await stream.close();
});

test("device sign-in: approved from the browser with one click; the bearer token signs in without cookie or CSRF; revoked, it signs in nobody", async (t) => {
  const h = createHarness(t);
  const [mel] = people(h, "mel");
  if (!mel) return t.fail();
  const d = await signInDevice(h, mel);
  t.like(d.approve.body, { ok: true });
  t.true(typeof d.token === "string" && d.token.length > 20);
  // the token is stored hashed only
  const rows = h.db.$client.prepare("SELECT * FROM sync_device_tokens").all();
  t.false(JSON.stringify(rows).includes(d.token));
  const dev = new HttpClient(h, { bearer: d.token });
  const reg = await dev.register();
  t.like(reg.body, { ok: true });
  // no X-Requested-With, an Origin other than the app's: still taken
  t.like((await dev.write("profile.update", { name: "Mel", bio: "" })).body, { ok: true });
  // /api/me/devices lists it, for the browser
  const list = (await (
    await h.request("/api/me/devices", { cookie: (mel.auth as { cookie: string }).cookie })
  ).json()) as { id: string; kind: string }[];
  t.deepEqual(
    list.map((x) => [x.id, x.kind]),
    [[d.device, "mac"]],
  );
  // a device cannot approve another sign-in
  const a2 = await new HttpClient(h, null).call("devices.authorize", { name: "x" });
  const ap2 = await dev.call("devices.approve", {
    request: (a2.body.result as { request: string }).request,
  });
  t.like(ap2.body, { ok: false, error: { code: "FORBIDDEN" } });
  // a stream of the device closes when it is revoked
  const stream = await dev.events({ "user:mel": "x" });
  t.like((await mel.call("devices.revoke", { id: d.device })).body, { ok: true });
  await stream.until(null);
  t.true(stream.ended());
  await stream.close();
  const after = await dev.post("/api/sync/register", {});
  t.like(after.body, { ok: false, error: { code: "UNAUTHORIZED" } });
  t.is((await dev.events({})).status, 401);
  // a made-up token: no actor, and no cookie fallback
  const fake = new HttpClient(h, { bearer: "not-a-token" });
  t.is((await fake.post("/api/sync/register", {})).status, 401);
});

test("CORS admits the desktop origin for bearer requests only", async (t) => {
  const h = createHarness(t);
  const pre = await h.app.request("/api/sync/write", {
    method: "OPTIONS",
    headers: {
      Origin: "tauri://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type, x-session-protocol",
    },
  });
  t.is(pre.status, 204);
  t.is(pre.headers.get("access-control-allow-origin"), "tauri://localhost");
  t.regex(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  t.is(pre.headers.get("access-control-allow-credentials"), null);
  const other = await h.app.request("/api/sync/write", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  t.is(other.headers.get("access-control-allow-origin"), null);
  const bearer = await h.app.request("/api/sync/register", {
    method: "POST",
    headers: { Origin: "tauri://localhost", Authorization: "Bearer nothing" },
  });
  t.is(bearer.headers.get("access-control-allow-origin"), "tauri://localhost");
  // a cookie request from the desktop origin: no CORS header, and the CSRF
  // guard refuses the write
  const [mel] = people(h, "mel");
  const cookie = await h.app.request("/api/sync/register", {
    method: "POST",
    headers: {
      Origin: "tauri://localhost",
      Cookie: `session=${(mel?.auth as { cookie: string }).cookie}`,
      "X-Requested-With": "session",
    },
  });
  t.is(cookie.status, 403);
  t.is(cookie.headers.get("access-control-allow-origin"), null);
});

test("the account reads: /api/me, settings, usage, API keys; settings.update and usage.setDefaultKey", async (t) => {
  const h = createHarness(t);
  const [mel] = people(h, "Mel");
  if (!mel) return t.fail();
  const cookie = (mel.auth as { cookie: string }).cookie;
  const get = async (path: string) =>
    (await h.request(path, { cookie })).json() as Promise<Record<string, unknown>>;
  t.like(await get("/api/me"), { u: "mel", name: "Mel", bio: "" });
  t.like(await get("/api/me/settings"), { emailOn: true, emailNew: null, types: {} });
  t.like((await mel.call("settings.update", { emailOn: false, types: { invite: false } })).body, {
    ok: true,
  });
  t.like(await get("/api/me/settings"), { emailOn: false, types: { invite: false } });
  t.like((await mel.call("settings.update", { emailNew: "not an address" })).body, {
    ok: false,
    error: { code: "BAD_REQUEST" },
  });
  const usage = await get("/api/me/usage");
  t.like(usage, { cap: 1_000_000, def: null, movedSeen: false, by: {} });
  const k = await mel.call("apiKeys.create", { raw: "sk-ant-MK-RAW-0001", label: "Work" });
  const id = (k.body.result as { id: string }).id;
  const keys = (await (await h.request("/api/me/api-keys", { cookie })).json()) as Record<
    string,
    unknown
  >[];
  t.like(keys[0], {
    id,
    kind: "key",
    label: "Work",
    provider: "Anthropic",
    valid: true,
    mask: "sk-ant-…0001",
    cap: 0,
  });
  t.false(JSON.stringify(keys).includes("MK-RAW"));
  t.false(
    JSON.stringify(h.db.$client.prepare("SELECT * FROM api_keys").all()).includes("MK-RAW"),
    "the raw key is encrypted at rest",
  );
  t.like((await mel.call("usage.setDefaultKey", { id })).body, { ok: true });
  t.like(await get("/api/me/usage"), { def: id });
  t.like((await mel.call("usage.markMovedSeen", {})).body, { ok: true });
  t.like(await get("/api/me/usage"), { movedSeen: true });
  t.is((await h.request("/api/me")).status, 401);
});

test("an admin resets the sync server's time; nobody else does", async (t) => {
  const h = createHarness(t);
  const admin = h.addUser("root", { isAdmin: true });
  const [mel] = people(h, "mel");
  const reset = (cookie: string) => h.request("/api/admin/reset-time", { method: "POST", cookie });
  t.is((await reset((mel?.auth as { cookie: string }).cookie)).status, 403);
  const r = await reset(h.signIn(admin));
  t.is(r.status, 200);
  t.like(await r.json(), { ok: true });
});
