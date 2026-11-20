// The server half's own tests, over both stores: the envelope rules phase 1b
// adds (TOO_LARGE, queuedAt, replaces, serverTime, STALE's current and
// changes), cursor key rotation, replication tiers, the SSE stream, the
// effect worker, the online calls, and the stores themselves.

import test from "ava";
import BetterSqlite from "better-sqlite3";

import {
  MAX_ENVELOPE_BYTES,
  SqliteServerStore,
  TOMBSTONE_TTL,
  migrate,
  newCursorKey,
  openStream,
  parseCursorMap,
  type Answer,
  type Envelope,
  type LogId,
} from "../src/server/index.js";

import { DAY, HOUR, MINUTE, STORES, World, cast, makeStore, ok, refused } from "./helpers.js";

const thread = (w: World, u: string, space: string, q = "What changed?", kind = "ask") => {
  const id = w.id();
  const a = w.as(u, "threads.create", { id, space, kind, q });
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  return id;
};

for (const kind of STORES) {
  test(`${kind}: every answer carries the server's time, recorded, unrecorded or replayed`, (t) => {
    const { w, open } = cast(t, kind);
    const e = w.envelope("mel", "likes.set", { thread: thread(w, "otto", open), on: true });
    const first = w.server.apply({ u: "mel" }, e);
    const again = w.server.apply({ u: "mel" }, e);
    const skew = w.server.apply(
      { u: "mel" },
      { ...w.envelope("mel", "likes.set", {}), clientTime: w.clock.now() + HOUR },
    );
    const signedOut = w.server.apply(null, w.envelope("mel", "likes.set", {}));
    for (const a of [first, again, skew, signedOut]) t.is(a.serverTime, w.clock.now());
    t.true(first.ok);
    t.like(again, { ok: true, replayed: true });
    t.is(first.seq, e.seq);
    t.is(again.seq, undefined, "a replay uses no seq");
    t.is(skew.ok ? null : skew.error.code, "CLOCK_SKEW");
  });

  test(`${kind}: an oversized envelope is TOO_LARGE before anything else, unrecorded; a deep one BAD_REQUEST`, (t) => {
    const { w, open } = cast(t, kind);
    const e = w.envelope("mel", "threads.create", {
      id: w.id(),
      space: open,
      kind: "post",
      q: "x".repeat(MAX_ENVELOPE_BYTES),
    });
    refused(t, w.server.apply({ u: "mel" }, e), "TOO_LARGE");
    // too large and nested too deep: the size decides
    let deep: unknown = "x".repeat(MAX_ENVELOPE_BYTES);
    for (let k = 0; k < 40; k++) deep = [deep];
    refused(t, w.server.apply({ u: "mel" }, { ...e, input: deep }), "TOO_LARGE");
    // the size the HTTP layer reports counts too
    refused(
      t,
      w.server.apply({ u: "mel" }, w.envelope("mel", "likes.set", {}), MAX_ENVELOPE_BYTES + 1),
      "TOO_LARGE",
    );
    let nested: unknown = 1;
    for (let k = 0; k < 40; k++) nested = [nested];
    refused(t, w.server.apply({ u: "mel" }, { ...e, input: nested }), "BAD_REQUEST");
    t.is(w.nextSeq("mel"), e.seq, "nothing used the seq");
  });

  test(`${kind}: queuedAt is checked like an id's age: EXPIRED, recorded`, (t) => {
    const { w, open } = cast(t, kind);
    const th = thread(w, "otto", open);
    const e = w.envelope(
      "mel",
      "likes.set",
      { thread: th, on: true },
      { queuedAt: w.clock.now() - 5 * DAY },
    );
    const a = w.server.apply({ u: "mel" }, e);
    refused(t, a, "EXPIRED");
    t.deepEqual(a.ok ? null : a.error.issues, [
      "queuedAt: expected a time from the 4 days before clientTime to 1 minute after",
    ]);
    t.like(w.server.apply({ u: "mel" }, e), { ok: false, replayed: true });
    t.is(w.get(`like:mel:${th}`), undefined);
    refused(
      t,
      w.as("mel", "likes.set", { thread: th, on: true }, { queuedAt: w.clock.now() + 2 * MINUTE }),
      "EXPIRED",
    );
    ok(
      t,
      w.as("mel", "likes.set", { thread: th, on: true }, { queuedAt: w.clock.now() - 3 * DAY }),
    );
  });

  // The design finding of review round 2's fixes (r2fix/remint-dup.mts): a
  // write refused with CLOCK_SKEW is reminted; a delayed copy of the first
  // envelope and the reminted one must not both apply.
  test(`${kind}: a reminted write and a delayed copy of its old envelope apply once, in either order`, (t) => {
    const { w, open } = cast(t, kind);
    const count = (q: string) =>
      [...w.server.records().values()].filter((r) => r.kind === "thread" && r.q === q).length;
    // the delayed copy arrives first
    const id = w.id();
    const old = w.envelope(
      "mel",
      "threads.create",
      { id, space: open, kind: "post", q: "once" },
      {
        clientTime: w.clock.now() + 2 * MINUTE,
      },
    );
    refused(t, w.server.apply({ u: "mel" }, old), "CLOCK_SKEW");
    const fresh: Envelope = {
      ...old,
      mutationId: w.id(),
      clientTime: w.clock.now(),
      replaces: [old.mutationId],
    };
    w.clock.advance(2 * MINUTE);
    ok(t, w.server.apply({ u: "mel" }, { ...old, clientTime: w.clock.now() }));
    const r = w.server.apply(
      { u: "mel" },
      { ...fresh, seq: w.nextSeq("mel"), clientTime: w.clock.now() },
    );
    t.like(r, { ok: true, replayed: true });
    t.is(count("once"), 1);
    // the reminted one arrives first; its input ids were reminted too
    const old2 = w.envelope(
      "mel",
      "threads.create",
      { id: w.id(), space: open, kind: "post", q: "twice?" },
      {
        clientTime: w.clock.now() + 2 * MINUTE,
      },
    );
    refused(t, w.server.apply({ u: "mel" }, old2), "CLOCK_SKEW");
    const fresh2: Envelope = {
      ...old2,
      mutationId: w.id(),
      input: { ...(old2.input as object), id: w.id() },
      clientTime: w.clock.now(),
      replaces: [old2.mutationId],
    };
    ok(t, w.server.apply({ u: "mel" }, fresh2));
    w.clock.advance(2 * MINUTE);
    const late = w.server.apply(
      { u: "mel" },
      { ...old2, seq: w.nextSeq("mel"), clientTime: w.clock.now() },
    );
    t.like(late, { ok: true, replayed: true });
    t.is(count("twice?"), 1);
  });

  test(`${kind}: STALE carries current and changes as the caller reads them now; the stored answer keeps keys, no text`, (t) => {
    const { w, open } = cast(t, kind);
    const th = thread(w, "mel", open, "First SECRET-A");
    const base = { rev: w.rev(`thread:${th}`) };
    ok(t, w.as("mel", "threads.update", { id: th, q: "Second SECRET-B", base }));
    const e = w.envelope("mel", "threads.update", { id: th, q: "Third", base });
    const a = w.server.apply({ u: "mel" }, e);
    refused(t, a, "STALE");
    if (a.ok) return;
    t.like(a.error.current ?? {}, { kind: "thread", q: "Second SECRET-B" });
    t.deepEqual(
      a.error.changes?.map((c) => [c.key, c.op]),
      [[`thread:${th}`, "put"]],
    );
    const stored = JSON.stringify(w.server.store.dump().answers);
    t.false(stored.includes("SECRET"));
    // the thread is removed: the replay reads it again, erased
    ok(t, w.as("mona", "moderation.decide", { item: `a:${th}`, decision: "removed" }));
    const again = w.server.apply({ u: "mel" }, e) as Answer & { ok: false };
    t.like(again, { replayed: true });
    t.false(JSON.stringify(again).includes("SECRET"));
    t.like(again.error.current ?? {}, { q: "", mod: "removed" });
  });

  test(`${kind}: cursor tokens: the previous key works for 30 days after a rotation`, (t) => {
    const keys = { current: newCursorKey() };
    const { w, open } = cast(t, kind, 1, { cursorKeys: keys });
    const s = w.server.snapshot({ u: "mel" }, `space:${open}`);
    // a server with the rotated keys, over the same store
    const rotated = {
      current: newCursorKey(),
      previous: { key: keys.current, rotatedAt: w.clock.now() },
    };
    const w2 = new World(kind, 1, { cursorKeys: rotated, store: w.server.store });
    w2.clock.ms = w.clock.ms;
    t.false("resync" in w2.server.pull({ u: "mel" }, `space:${open}`, s.cursor));
    w2.clock.advance(TOMBSTONE_TTL + 1);
    t.deepEqual(w2.server.pull({ u: "mel" }, `space:${open}`, s.cursor), {
      resync: true,
      serverTime: w2.clock.now(),
    });
    // a key never configured opens nothing
    const w3 = new World(kind, 1, {
      cursorKeys: { current: newCursorKey() },
      store: w.server.store,
    });
    w3.clock.ms = w.clock.ms;
    t.true("resync" in w3.server.pull({ u: "mel" }, `space:${open}`, s.cursor));
  });

  test(`${kind}: tiers: the desktop and Phone windows, pinned threads, summaries and hydration`, (t) => {
    const { w, open } = cast(t, kind);
    const old = thread(w, "otto", open, "old");
    const f = w.id();
    ok(t, w.as("mel", "followups.ask", { id: f, thread: old, q: "and?" }));
    const mine = thread(w, "mel", open, "mine, old");
    w.clock.advance(40 * DAY);
    const recent = thread(w, "otto", open, "recent");
    const log: LogId = `space:${open}`;
    const keys = (o: object) => w.server.snapshot({ u: "mel" }, log, o).records.map((r) => r.key);
    // desktop: 90 days or the newest 500: everything
    t.true(keys({ tier: { window: "desktop" } }).includes(`followup:${f}`));
    // phone: 30 days or 200 threads: still everything (3 threads)
    t.true(keys({ tier: { window: "phone" } }).includes(`followup:${f}`));
    // summary: threads and counts only, nothing under them
    const sum = keys({ tier: { window: "summary" } });
    t.true(sum.includes(`thread:${old}`) && sum.includes(`counts:${old}`));
    t.false(sum.some((k) => k.startsWith("followup:") || k.startsWith("run:")));
    // hydration: one thread in full, nothing else of the space
    const h = keys({ threads: [old] });
    t.true(h.includes(`followup:${f}`));
    t.false(h.includes(`thread:${recent}`));
    t.false(h.includes(`space:${open}`));
    void mine;
  });

  test(`${kind}: tiers past the window: old threads are summaries unless pinned`, (t) => {
    const { w, open } = cast(t, kind);
    const ids: string[] = [];
    for (let k = 0; k < 205; k++) {
      ids.push(thread(w, "otto", open, `t${k}`));
      w.clock.advance(MINUTE);
    }
    const mel = thread(w, "mel", open, "mel's");
    w.clock.advance(31 * DAY);
    const f = w.id();
    ok(t, w.as("mel", "followups.ask", { id: f, thread: ids[0] ?? "", q: "f" }));
    const runs = (o: object) =>
      new Set(
        w.server
          .snapshot({ u: "mel" }, `space:${open}`, o)
          .records.filter((r) => r.record.kind === "run")
          .map((r) => (r.record as { th: string }).th),
      );
    const phone = runs({ tier: { window: "phone" } });
    t.true(phone.has(mel), "pinned: mel wrote it");
    t.false(phone.has(ids[0] ?? ""), "outside the newest 200 and the past 30 days");
    t.true(phone.has(ids[204] ?? ""));
    t.true(
      runs({ tier: { window: "phone", opened: [ids[0] ?? ""] } }).has(ids[0] ?? ""),
      "pinned: opened",
    );
    t.true(runs({ tier: { window: "desktop" } }).has(ids[0] ?? ""), "desktop: 90 days");
  });

  test(`${kind}: the SSE stream pokes for changes the reader may read, with its cursors as the event id`, async (t) => {
    const { w, open, closed } = cast(t, kind);
    const otto = w.server.snapshot({ u: "otto" }, `space:${open}`);
    const lab = w.server.snapshot({ u: "otto" }, `space:${closed}`);
    const ctl = new AbortController();
    const stream = openStream(
      w.server,
      { u: "otto" },
      { [`space:${open}`]: otto.cursor, [`space:${closed}`]: lab.cursor },
      ctl.signal,
      { setInterval: () => 0, clearInterval: () => {} },
    );
    const reader = stream.getReader();
    const chunks: string[] = [];
    const dec = new TextDecoder();
    const read = async () => {
      const r = await reader.read();
      if (r.value) chunks.push(dec.decode(r.value));
    };
    await read();
    t.is(chunks[0], ": open\n\n");
    // a write in the closed space otto may not read: no poke
    thread(w, "mel", closed, "secret");
    thread(w, "mel", open, "public");
    await read();
    const poke = chunks[1] ?? "";
    t.regex(poke, /^event: poke\nid: .+\ndata: .+\n\n$/);
    const data = JSON.parse(poke.split("\n")[2]?.slice(6) ?? "{}") as { logs: string[] };
    t.deepEqual(data.logs, [`space:${open}`]);
    const id = parseCursorMap(poke.split("\n")[1]?.slice(4));
    t.deepEqual(Object.keys(id).sort(), [`space:${closed}`, `space:${open}`]);
    ctl.abort();
    t.true((await reader.read()).done);
  });

  test(`${kind}: the effect worker backs off, ends in the dead letters after 10 failures, and commits each effect with its writes`, (t) => {
    let failing = true;
    const { w, open } = cast(t, kind, 1, { failEffect: () => failing });
    const th = thread(w, "otto", open);
    ok(t, w.as("mel", "reports.create", { id: w.id(), item: `a:${th}`, why: "spam" }));
    const queued = () => w.server.store.dump().effects;
    t.true(queued().length >= 1);
    for (let k = 0; k < 10; k++) {
      w.server.work();
      w.clock.advance(20 * MINUTE);
    }
    t.true(w.server.store.dump().deadLetters.some((d) => d.effect.type === "notifyStaff"));
    failing = false;
    ok(t, w.as("mel", "reports.create", { id: w.id(), item: `a:${th}`, why: "again" }));
    w.server.work();
    const notifs = [...w.server.records().values()].filter(
      (r) => r.kind === "notif" && r.type === "report",
    );
    t.deepEqual(notifs.map((n) => (n as { to: string }).to).sort(), ["mona", "olga"]);
  });

  test(`${kind}: devices: sign-in, a token, a device record in the user log, revocation ends its clients`, (t) => {
    const { w } = cast(t, kind);
    const s = w.server.call(null, "devices.authorize", { name: "Mel's Mac" });
    if (!s.ok) return t.fail(JSON.stringify(s.error));
    const { request, code } = s.result as { request: string; code: string };
    t.like(w.server.call(null, "devices.token", { request }), {
      ok: false,
      error: { code: "PRECONDITION_FAILED" },
    });
    t.like(w.server.call({ u: "mel" }, "devices.approve", { request, code: "ZZZ-ZZZ" }), {
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
    const ap = w.server.call({ u: "mel" }, "devices.approve", { request, code });
    const device = ap.ok ? (ap.result as { device: string }).device : "";
    t.truthy(device);
    const tok = w.server.call(null, "devices.token", { request });
    const token = tok.ok ? (tok.result as { token: string }).token : "";
    t.like(w.server.call(null, "devices.token", { request }), {
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    const actor = w.server.online.authenticate(token);
    t.deepEqual(actor, { u: "mel", device });
    const d = w.get(`device:${device}`);
    t.like(d ?? {}, { kind: "device", u: "mel", name: "Mel's Mac", type: "mac" });
    t.false(JSON.stringify(w.server.records()).includes(token), "the token is not in a record");
    t.false(
      JSON.stringify(w.server.store.dump().tokens).includes(token),
      "only its hash is stored",
    );
    const snap = w.server.snapshot({ u: "mel" }, "user:mel").records.map((r) => r.key);
    t.true(snap.includes(`device:${device}`));
    t.false(w.server.snapshot({ u: "otto" }, "user:mel").records.length > 0);
    // a client registered by the device; revoking the device ends it
    const reg = w.server.register(actor);
    const clientId = reg.ok ? reg.clientId : "";
    const e: Envelope = {
      ...w.envelope("mel", "profile.update", { name: "Mel", bio: "" }),
      clientId,
      seq: 1,
    };
    ok(t, w.server.apply(actor, e));
    ok(t, w.server.call({ u: "mel" }, "devices.revoke", { id: device }));
    refused(t, w.server.apply(actor, { ...e, mutationId: w.id(), seq: 2 }), "WRONG_CLIENT");
    t.is(w.server.online.authenticate(token), null);
    t.is(w.get(`device:${device}`), undefined);
    t.like(w.server.call({ u: "otto" }, "devices.revoke", { id: device }), {
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  test(`${kind}: device runs: claim, heartbeat apart from progress, attempts, interrupted and too_large ends`, (t) => {
    const { w, open } = cast(t, kind);
    const s = w.server.call(null, "devices.authorize", { name: "Mac" });
    const request = s.ok ? (s.result as { request: string }).request : "";
    const ap = w.server.call({ u: "mel" }, "devices.approve", {
      request,
      code: s.ok ? (s.result as { code: string }).code : "",
    });
    const device = ap.ok ? (ap.result as { device: string }).device : "";
    ok(t, w.server.call(null, "devices.token", { request }));
    const mac = { kind: "device", cli: "claude", device };
    const ask = (q: string) => {
      const id = w.id();
      const a = w.as("mel", "threads.create", { id, space: open, kind: "ask", q, executor: mac });
      return (ok(t, a) as { run: string }).run;
    };
    const run = ask("Q1");
    t.like(w.get(`run:${run}`) ?? {}, { status: "queued", executor: { device } });
    w.server.work();
    t.false(
      w.jobs.some((j) => j.id === run),
      "a device run is no server job",
    );
    const as = { u: "mel", device };
    t.like(w.server.call({ u: "otto" }, "runs.claim", { run, device }), {
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const c = w.server.call(as, "runs.claim", { run, device });
    t.like(c, { ok: true, result: { attempt: 1, turns: [{ q: "Q1", a: "" }] } });
    t.like(w.server.call(as, "runs.claim", { run, device }), {
      ok: false,
      error: { code: "PRECONDITION_FAILED" },
    });
    // progress does not extend the lease; the heartbeat does
    w.clock.advance(80_000);
    ok(t, w.server.call(as, "runs.turn", { run, device, attempt: 1, turn: "step" }));
    ok(t, w.server.call(as, "runs.heartbeat", { run, device, attempt: 1 }));
    w.clock.advance(80_000);
    t.like(w.server.call(as, "runs.heartbeat", { run, device, attempt: 2 }), {
      ok: false,
      error: { code: "PRECONDITION_FAILED" },
    });
    t.like(w.server.call(as, "runs.finish", { run, device, attempt: 1, answer: "The answer." }), {
      ok: true,
      result: { status: "complete" },
    });
    t.like(w.get(`run:${run}`) ?? {}, { status: "complete" });
    t.false("lease" in (w.get(`run:${run}`) ?? {}), "a run record holds no lease");
    // a lease that ends: interrupted
    const r2 = ask("Q2");
    ok(t, w.server.call(as, "runs.claim", { run: r2, device }));
    w.clock.advance(91_000);
    w.server.housekeepAll();
    t.like(w.get(`run:${r2}`) ?? {}, { status: "failed", end: "interrupted" });
    t.like(w.server.call(as, "runs.finish", { run: r2, device, attempt: 1, answer: "late" }), {
      ok: false,
      error: { code: "PRECONDITION_FAILED" },
    });
    // an answer over 200 KB: too_large, not saved
    const r3 = ask("Q3");
    ok(t, w.server.call(as, "runs.claim", { run: r3, device }));
    t.like(
      w.server.call(as, "runs.finish", {
        run: r3,
        device,
        attempt: 1,
        answer: "x".repeat(200 * 1024 + 1),
      }),
      {
        ok: true,
        result: { status: "too_large" },
      },
    );
    t.like(w.get(`run:${r3}`) ?? {}, { status: "failed", end: "too_large" });
    // phase 2a: API keys are served (a raw key of one character is none);
    // account state (settings, usage) is the HTTP server's, and the package
    // answers METHOD_NOT_SUPPORTED for it
    t.like(w.server.call({ u: "mel" }, "apiKeys.create", { raw: "k", label: "l" }), {
      ok: false,
      error: { code: "BAD_REQUEST" },
    });
    t.like(w.server.call({ u: "mel" }, "settings.update", { emailOn: true }), {
      ok: false,
      error: { code: "METHOD_NOT_SUPPORTED" },
    });
  });

  test(`${kind}: a transaction that throws leaves nothing behind`, (t) => {
    const store = makeStore(kind);
    t.throws(() =>
      store.transaction((tx) => {
        tx.setHead(5);
        tx.put("space:X", { kind: "space" } as never, 1);
        tx.logPut("space:X", { key: "space:X", op: "put", version: 1 });
        tx.effectAdd({ type: "job", kind: "run", id: "R" }, 1);
        throw new Error("fault");
      }),
    );
    const d = store.dump();
    t.deepEqual([d.records, d.logRows, d.effects], [[], [], []]);
    t.is(
      store.transaction((tx) => tx.head()),
      0,
    );
  });

  test(`${kind}: housekeeping expires each table by time, in bounded batches`, (t) => {
    const { w, open } = cast(t, kind);
    const th = thread(w, "mel", open);
    ok(t, w.as("mel", "threads.delete", { id: th }));
    t.true(w.server.store.dump().tombstones.length > 0);
    w.clock.advance(TOMBSTONE_TTL + DAY);
    w.server.housekeepAll();
    const d = w.server.store.dump();
    t.deepEqual(d.tombstones, []);
    t.deepEqual(d.answers, []);
    t.false(d.logRows.some((r) => r.op === "del"));
  });
}

test("sqlite: the migrations apply once, and the schema is the package's", (t) => {
  const db = new BetterSqlite(":memory:");
  t.deepEqual(migrate(db), [
    "0001_sync.sql",
    "0002_review_r1.sql",
    "0003_space_vis.sql",
    "0004_review_r1_phase2.sql",
  ]);
  t.deepEqual(migrate(db), []);
  const store = new SqliteServerStore(db);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  t.true(
    tables.includes("sync_log") &&
      tables.includes("sync_answers") &&
      tables.includes("sync_effects"),
  );
  t.is(
    store.transaction((tx) => tx.head()),
    0,
  );
});
