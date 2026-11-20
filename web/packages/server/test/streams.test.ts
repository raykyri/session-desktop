// The limit on open sync event streams (review round 2 of phase 2, reviewer
// A's finding 9): a browser session, a device and a signed-out address
// (an IPv6 address by its /64) each hold at most SESSION_STREAMS_PER_READER
// open; past it `GET /api/sync/events` answers TOO_MANY_REQUESTS (429)
// until one closes.

import test from "ava";

import { createHarness } from "./helpers.js";
import { HttpClient, signInDevice } from "./sync.helpers.js";

type Stream = Awaited<ReturnType<HttpClient["events"]>>;

async function openMany(c: HttpClient, n: number, cursors = {}, extra = {}) {
  const out: Stream[] = [];
  for (let k = 0; k < n; k++) out.push(await c.events(cursors, extra));
  return out;
}

const closeAll = async (streams: Stream[]) => {
  for (const s of streams) await s.close();
};

test.serial(
  "a session, a device and a signed-out address each hold at most SESSION_STREAMS_PER_READER streams",
  async (t) => {
    const h = createHarness(t, { env: { SESSION_STREAMS_PER_READER: "3" } });
    t.is(h.deps.streams.perReader, 3);
    const olga = new HttpClient(h, { cookie: h.signIn(h.addUser("olga")) });
    const mel = new HttpClient(h, { cookie: h.signIn(h.addUser("mel")) });
    const sp = olga.id();
    await olga.write("spaces.create", { id: sp, name: "lounge" });
    const cursor = (await mel.snapshot(`space:${sp}`)).body["cursor"] as string;
    const cursors = { [`space:${sp}`]: cursor };

    // a browser session
    const mine = await openMany(mel, 3, cursors);
    t.deepEqual(
      mine.map((s) => s.status),
      [200, 200, 200],
    );
    const fourth = await mel.events(cursors);
    t.is(fourth.status, 429);
    t.like(JSON.parse(await fourth.read()), { ok: false, error: { code: "TOO_MANY_REQUESTS" } });
    // another session of another person is not counted with it
    const theirs = await olga.events(cursors);
    t.is(theirs.status, 200);
    // one closes: another opens
    await mine[0]?.close();
    const again = await mel.events(cursors);
    t.is(again.status, 200);
    // the open ones still hear a commit
    await olga.write("threads.create", { id: olga.id(), space: sp, kind: "post", q: "hello" });
    t.regex(await again.until(/event: poke/), /event: poke/);

    // a device
    const d = await signInDevice(h, mel);
    const dev = new HttpClient(h, { bearer: d.token });
    const devs = await openMany(dev, 3);
    t.deepEqual(
      devs.map((s) => s.status),
      [200, 200, 200],
    );
    t.is((await dev.events({})).status, 429);

    // signed out, by address: the addresses of one IPv6 /64 together
    const anon = new HttpClient(h, null);
    const a64 = await openMany(anon, 3, cursors, { "Fly-Client-IP": "2001:db8:1:2::1" });
    t.deepEqual(
      a64.map((s) => s.status),
      [200, 200, 200],
    );
    t.is((await anon.events(cursors, { "Fly-Client-IP": "2001:db8:1:2::99" })).status, 429);
    const other = await anon.events(cursors, { "Fly-Client-IP": "2001:db8:1:3::1" });
    t.is(other.status, 200);

    // mel's two and her new one, olga's, the device's three, the /64's three
    // and the other /64's: the refused ones were never tracked
    t.is(h.deps.streams.size, 11);
    await closeAll([...mine, theirs, again, ...devs, ...a64, other]);
    t.is(h.deps.streams.size, 0);
    t.is(h.deps.streams.of(`ip:2001:db8:1:2::/64`), 0);
  },
);
