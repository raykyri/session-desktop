// The transport rules of the sync routes after the M3 and M4 reviews (`01`
// A3, S1, Y3, Y4, Y7; `04` Z1, Z2): bodies read with a byte count, the
// caller checked before the body, non-object bodies refused, every limit
// taken after the route matched and answered in the protocol shape, the
// CSRF guard on the decoded path, the configured protocol minimum, the
// stream's log count, and what a refused or drained request leaves behind.

import { PROTOCOL_VERSION } from "@session/sync/server";
import test from "ava";

import { createHarness, PUBLIC_ORIGIN, type Harness } from "./helpers.js";
import { Person, channels, newId } from "./syncHttp.js";

/** A pinned limiter clock, so no bucket refills while a test spends it. */
const pinned = (t: Parameters<typeof createHarness>[0], env: Record<string, string> = {}) => {
  const at = Date.now();
  return createHarness(t, { limiterNow: () => at, env });
};

/** A body of `mb` chunks of 1 MiB with no declared length; counts the
 * chunks the server pulled. */
function chunked(mb: number) {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulled >= mb) return c.close();
      state.pulled += 1;
      c.enqueue(chunk);
    },
  });
  return { body, state };
}

const post = (h: Harness, path: string, body: ReadableStream<Uint8Array>, cookie?: string) =>
  h.app.request(path, {
    method: "POST",
    body,
    duplex: "half",
    headers: {
      Origin: PUBLIC_ORIGIN,
      "X-Requested-With": "session",
      "Session-Protocol": String(PROTOCOL_VERSION),
      ...(cookie ? { Cookie: `session=${cookie}` } : {}),
    },
  });

/** The rows a refused write must not leave. */
function rows(h: Harness) {
  const n = (sql: string) => (h.db.$client.prepare(sql).get() as { n: number }).n;
  return {
    records: n("SELECT count(*) AS n FROM records"),
    answers: n("SELECT count(*) AS n FROM sync_answers"),
    seqAnswers: n("SELECT count(*) AS n FROM sync_seq_answers"),
    seqs: n("SELECT coalesce(sum(last_seq), 0) AS n FROM sync_clients"),
    head: n("SELECT version AS n FROM server_head"),
  };
}

test("a chunked body past the limit is cut off at the limit, and a signed-out /apply reads no body at all", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("big"));
  const a = chunked(64);
  const res = await post(h, "/api/sync/register", a.body, p.cookie);
  t.is(res.status, 413);
  t.like(await res.json(), { code: "TOO_LARGE" });
  t.true(a.state.pulled <= 3, `pulled ${a.state.pulled} MiB of a 64 KiB limit`);
  const b = chunked(64);
  const anon = await post(h, "/api/sync/apply", b.body);
  t.is(anon.status, 401);
  t.like(await anon.json(), { code: "UNAUTHORIZED" });
  t.true(b.state.pulled <= 1, `pulled ${b.state.pulled} MiB before the caller was checked`);
  const c = chunked(64);
  const big = await post(h, "/api/sync/apply", c.body, p.cookie);
  t.is(big.status, 413);
  t.true(c.state.pulled <= 6, `pulled ${c.state.pulled} MiB of a 4 MiB limit`);
});

test("a body of null, or any body that is not a JSON object, answers 400 on every POST route", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("nulls"));
  for (const path of [
    "/api/sync/apply",
    "/api/sync/snapshot",
    "/api/sync/register",
    "/api/sync/read",
  ])
    for (const body of ["null", "[1]", "3", '"x"', "true"]) {
      const res = await h.request(path, {
        method: "POST",
        cookie: p.cookie,
        headers: { "Content-Type": "application/json" },
        body,
      });
      t.is(res.status, 400, `${path} ${body}`);
      t.like(await res.json(), { code: "BAD_REQUEST" });
    }
  t.false(
    h.logs.some((l) => l.includes("sync route failed")),
    "nothing failed",
  );
  // a read whose cursor is not a string
  for (const cursor of [5, null, {}, ["x"]]) {
    const res = await p.post("/api/sync/read", { reads: [{ log: "user:nulls", cursor }] });
    t.is(res.status, 400, JSON.stringify(cursor));
  }
});

test("apply and tRPC mutations take from one writes bucket", async (t) => {
  const h = pinned(t, { SESSION_LIMIT_WRITES_PER_MINUTE: "5" });
  const p = new Person(h, h.addUser("both"));
  await p.register();
  const first = await p.send(
    [1, 2, 3, 4, 5].map((k) => p.envelope("prefs.set", { layout: k % 2 ? "wide" : "centred" })),
  );
  t.true(first.answers.every((a) => a.ok));
  await t.throwsAsync(h.caller(p.user).settings.update({}), {
    code: "TOO_MANY_REQUESTS",
  } as never);
  // and the other way round
  const q = new Person(h, h.addUser("trpcfirst"));
  await q.register();
  for (let k = 0; k < 5; k += 1) await h.caller(q.user).settings.update({});
  const refused = await q.post("/api/sync/apply", {
    envelopes: [q.envelope("prefs.set", { layout: "wide" })],
  });
  t.is(refused.status, 429);
  t.like(await refused.json(), { code: "TOO_MANY_REQUESTS" });
});

test("signed-out pulls and snapshots share the per-IP snapshots bucket, answered in the protocol shape", async (t) => {
  const h = pinned(t, { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "3" });
  const { open } = await channels(h);
  const pull = () =>
    h.request(`/api/sync/pull?log=space:${open}&cursor=x`, {
      headers: { "Fly-Client-IP": "2.2.2.2" },
    });
  for (let k = 0; k < 2; k += 1) t.is((await pull()).status, 200);
  const snap = await h.request("/api/sync/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Fly-Client-IP": "2.2.2.2" },
    body: JSON.stringify({ log: `space:${open}` }),
  });
  t.is(snap.status, 200);
  for (const res of [
    await pull(),
    await h.request("/api/sync/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Fly-Client-IP": "2.2.2.2" },
      body: JSON.stringify({ log: `space:${open}` }),
    }),
  ]) {
    t.is(res.status, 429);
    const body = (await res.json()) as { code: string; message: string; serverTime: number };
    t.is(body.code, "TOO_MANY_REQUESTS");
    t.is(typeof body.message, "string");
    t.is(typeof body.serverTime, "number");
    t.true(Number(res.headers.get("retry-after")) >= 1);
  }
  // another address has its own bucket
  const other = await h.request(`/api/sync/pull?log=space:${open}&cursor=x`, {
    headers: { "Fly-Client-IP": "9.9.9.9" },
  });
  t.is(other.status, 200);
});

test("opening a stream takes from a per-person bucket", async (t) => {
  const h = pinned(t, { SESSION_LIMIT_STREAM_OPENS_PER_MINUTE: "3" });
  const p = new Person(h, h.addUser("opener"));
  await p.register();
  const cursor = (await p.snapshot("user:opener")).cursor;
  const statuses: number[] = [];
  for (let k = 0; k < 4; k += 1) {
    const s = await p.events({ "user:opener": cursor });
    statuses.push(s.status);
    await s.close();
  }
  t.deepEqual(statuses, [200, 200, 200, 429]);
});

test("spaces.directory and spaces.byName are limited per caller, each call of a tRPC batch counted", async (t) => {
  const h = pinned(t, {
    SESSION_LIMIT_DIRECTORY_PER_MINUTE: "2",
    SESSION_LIMIT_BY_NAME_PER_MINUTE: "3",
  });
  const anon = h.caller(null);
  await anon.spaces.directory();
  await anon.spaces.directory();
  await t.throwsAsync(anon.spaces.directory(), { code: "TOO_MANY_REQUESTS" } as never);
  // byName takes from the directory's bucket too; its own bucket is the
  // smaller one here, from another address
  const own = pinned(t, {
    SESSION_LIMIT_DIRECTORY_PER_MINUTE: "100",
    SESSION_LIMIT_BY_NAME_PER_MINUTE: "3",
  });
  const names = ["a", "b", "c", "d"];
  const input = Object.fromEntries(names.map((name, i) => [i, { name }]));
  const res = await own.request(
    `/api/trpc/${names.map(() => "spaces.byName").join(",")}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`,
    { headers: { "Fly-Client-IP": "3.3.3.3" } },
  );
  const answers = (await res.json()) as {
    result?: unknown;
    error?: { data?: { code?: string } };
  }[];
  t.is(answers.length, 4);
  t.truthy(answers[2]?.result);
  t.is(answers[3]?.error?.data?.code, "TOO_MANY_REQUESTS");
});

test("the CSRF guard and the Authorization refusal read the decoded path", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("pct"));
  const base = { "Session-Protocol": String(PROTOCOL_VERSION), Cookie: `session=${p.cookie}` };
  const evil = { ...base, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  for (const path of [
    "/api/%73ync/pull?log=space:x",
    "/api/sync/%70ull?log=space:x",
    "/api/%73ync/events?clientId=x",
    "/api/%74rpc/spaces.directory",
  ]) {
    t.is((await h.app.request(path, { headers: evil })).status, 403, path);
    t.is(
      (await h.app.request(path, { headers: { ...base, Authorization: "Bearer x" } })).status,
      400,
      path,
    );
  }
});

test("an envelope's protocolVersion is checked against SESSION_MIN_PROTOCOL", async (t) => {
  const h = createHarness(t, { env: { SESSION_MIN_PROTOCOL: String(PROTOCOL_VERSION - 1) } });
  const p = new Person(h, h.addUser("older"));
  await p.register();
  const e = {
    ...p.envelope("prefs.set", { layout: "wide" }),
    protocolVersion: PROTOCOL_VERSION - 1,
  };
  t.like((await p.send([e])).answers[0], { ok: true });
  const old = {
    ...p.envelope("prefs.set", { layout: "centred" }),
    protocolVersion: PROTOCOL_VERSION - 2,
  };
  t.like((await p.send([old])).answers[0], { ok: false, error: { code: "UPGRADE_REQUIRED" } });
});

test("a stream reads at most 64 logs, Last-Event-ID and Session-Cursors together", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_SNAPSHOTS_PER_MINUTE: "100000" } });
  const p = new Person(h, h.addUser("many"));
  await p.register();
  const cursors = async (prefix: string, n: number) => {
    const m: Record<string, string> = {};
    for (let i = 0; i < n; i += 1)
      m[`space:${prefix}${i}`] = (await p.snapshot(`space:${prefix}${i}`)).cursor;
    return m;
  };
  // an id naming 63 logs and one that resyncs at once, so the stream sends one
  const first = await p.events({ ...(await cursors("a", 63)), "space:gone": "x" });
  const id = (await first.until("resync"))?.id;
  await first.close();
  t.truthy(id);
  const two = await cursors("b", 2);
  const refused = await p.events(two, id);
  t.is(refused.status, 400);
  // one more fits
  const one = await p.events({ "space:b0": two["space:b0"] ?? "" }, id);
  t.is(one.status, 200);
  await one.close();
});

test("refused envelopes leave no record, no answer row and no seq: signed out, waiting, malformed batch, over the limit", async (t) => {
  const h = pinned(t, { SESSION_LIMIT_WRITES_PER_MINUTE: "1" });
  const p = new Person(h, h.addUser("writer"));
  await p.register();
  const before = rows(h);
  const e = p.envelope("prefs.set", { layout: "wide" });
  await h.request("/api/sync/apply", { method: "POST", body: JSON.stringify({ envelopes: [e] }) });
  const waiting = new Person(h, h.addWaitingUser("waits"));
  await waiting.post("/api/sync/apply", { envelopes: [e] });
  await p.post("/api/sync/apply", { envelopes: "x" });
  await p.post("/api/sync/apply", { envelopes: [] });
  t.deepEqual(rows(h), before);
  // one admitted, the second over the limit: only the first is recorded
  const second = p.envelope("prefs.set", { layout: "centred" });
  const r = await p.send([e, second]);
  t.deepEqual(
    r.answers.map((a) => (a.ok ? "ok" : a.error.code)),
    ["ok", "TOO_MANY_REQUESTS"],
  );
  const after = rows(h);
  t.is(after.answers, before.answers + 1);
  t.is(after.seqs, before.seqs + 1);
  t.is(after.seqAnswers, before.seqAnswers);
});

test("during the drain: register, apply and stream opens answer 503 and record nothing; open streams end", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  const log = `space:${open}`;
  const stream = await mona.events({ [log]: (await mona.snapshot(log)).cursor });
  t.is((await stream.until("ready"))?.event, "ready");
  const before = rows(h);
  h.sync.drain();
  t.is(await stream.until("never", 1000), null);
  t.true(stream.ended);
  t.is(h.sync.hub.size(), 0);
  const reg = await mona.post("/api/sync/register", {});
  t.is(reg.status, 503);
  t.like(await reg.json(), { code: "SERVICE_UNAVAILABLE" });
  const r = await mona.send([
    mona.envelope("threads.create", { id: newId(), space: open, kind: "post", q: "x" }),
  ]);
  t.is(r.status, 503);
  t.like(r.answers[0], { ok: false, error: { code: "SERVICE_UNAVAILABLE" } });
  const ev = await mona.events({ [log]: "x" });
  t.is(ev.status, 503);
  t.deepEqual(rows(h), before);
  // reads go on during the drain
  t.is((await mona.post("/api/sync/snapshot", { log })).status, 200);
});
