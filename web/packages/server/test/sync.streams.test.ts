// Client registration (`01` Y3), a write's notifications in its own commit
// (U1, D2), the event stream (Y7) and the drain (S5), over HTTP against the
// SQLite store.

import { MUTATORS, type AnyMutator } from "@session/mutators";
import test from "ava";

import { createApp } from "../src/app.js";
import { SyncService } from "../src/sync/service.js";

import { createHarness } from "./helpers.js";
import { channels, keysOf, MODEL, newId, Person, recordsOf } from "./syncHttp.js";

// ---- Y3 ----

test("Y3: a re-attach returns the stored lastSeq and is not counted; the 51st new id in a day is refused", async (t) => {
  const h = createHarness(t, { env: { SESSION_LIMIT_REGISTER_PER_MINUTE: "1000" } });
  const p = new Person(h, h.addUser("tabs"));
  const first = await p.register();
  t.like(first.body, { ok: true, lastSeq: 0, reattached: false });
  const id = p.clientId;
  await p.ok("prefs.set", { layout: "wide" });
  await p.ok("prefs.set", { layout: "centred" });
  // 100 reloads of the tab re-attach its id
  for (let k = 0; k < 100; k++) {
    const again = await p.register(id);
    t.deepEqual(again.body, { ok: true, clientId: id, lastSeq: 2, reattached: true });
  }
  // 49 more new ids make 50 today; the 51st is refused, a re-attach is not
  for (let k = 0; k < 49; k++) t.true((await p.register()).body.ok);
  const refused = await p.register();
  t.is(refused.status, 429);
  t.like(refused.body, { code: "TOO_MANY_REQUESTS" });
  t.like((await p.register(id)).body, { ok: true, reattached: true, lastSeq: 2 });
});

test("Y3: another person's client id, or an unknown one, answers WRONG_CLIENT", async (t) => {
  const h = createHarness(t);
  const ada = new Person(h, h.addUser("ada"));
  const eve = new Person(h, h.addUser("eve"));
  await ada.register();
  const theirs = await eve.register(ada.clientId);
  t.is(theirs.status, 409);
  t.like(theirs.body, { ok: false, error: { code: "WRONG_CLIENT" } });
  t.like((await eve.register(newId())).body, { ok: false, error: { code: "WRONG_CLIENT" } });
  // nor may eve write with it
  eve.clientId = ada.clientId;
  const a = (await eve.send([eve.envelope("prefs.set", { layout: "wide" })])).answers[0];
  t.like(a, { ok: false, error: { code: "WRONG_CLIENT" } });
});

// ---- U1, D2: notifications commit with their write ----

test("a write's notifications are in its own commit: the reply, its counts and the notifications share one version", async (t) => {
  const h = createHarness(t);
  const { mona, mel, open } = await channels(h);
  const post = newId();
  await mona.ok("threads.create", { id: post, space: open, kind: "post", q: "A post" });
  const reply = newId();
  const told = (await mel.ok("research.createPostFollowUp", {
    id: reply,
    thread: post,
    t: "Agreed, @olga",
  })) as { notified: string[] };
  t.deepEqual(told.notified, ["olga"]);
  const version = (log: string, key: string) =>
    (
      h.db.$client
        .prepare("SELECT version FROM change_log WHERE log = ? AND key = ?")
        .get(log, key) as { version: number } | undefined
    )?.version;
  const v = version(`space:${open}`, `reply:${reply}`);
  t.truthy(v);
  t.is(version(`space:${open}`, `counts:${post}`), v);
  const notifs = h.db.$client
    .prepare("SELECT key, u FROM records WHERE kind = 'notif' ORDER BY u")
    .all() as { key: string; u: string }[];
  t.deepEqual(
    notifs.map((n) => n.u),
    ["mona", "olga"],
  );
  for (const n of notifs) t.is(version(`user:${n.u}`, n.key), v);
  // and the recorded answer is in the same transaction: a replay answers it
  const answers = h.db.$client.prepare("SELECT count(*) AS n FROM sync_answers").get() as {
    n: number;
  };
  t.true(answers.n > 0);
});

// ---- Y7: the event stream ----

test("Y7: two readers with different scopes get different batches for the same commit", async (t) => {
  const h = createHarness(t);
  const { olga, mona, mel, open } = await channels(h);
  const post = newId();
  await mona.ok("threads.create", { id: post, space: open, kind: "post", q: "Mona's question" });
  const log = `space:${open}`;
  const olgaStream = await olga.events({ [log]: (await olga.snapshot(log)).cursor });
  const melStream = await mel.events({ [log]: (await mel.snapshot(log)).cursor });
  for (const s of [olgaStream, melStream]) t.is((await s.until("ready"))?.event, "ready");
  await olga.ok("moderation.decide", { item: `p:${post}`, decision: "hidden" });
  const forOlga = recordsOf(await olgaStream.until("changes"), log).get(`thread:${post}`);
  const forMel = recordsOf(await melStream.until("changes"), log).get(`thread:${post}`);
  t.like(forOlga, { mod: "hidden", q: "Mona's question" });
  t.like(forMel, { mod: "hidden", q: "" });
  for (const s of [olgaStream, melStream]) await s.close();
});

test("Y7: a reconnect with the last event id loses no change", async (t) => {
  const h = createHarness(t);
  const { mona, mel, open } = await channels(h);
  const log = `space:${open}`;
  const s1 = await mel.events({ [log]: (await mel.snapshot(log)).cursor });
  const a = newId();
  await mona.ok("threads.create", { id: a, space: open, kind: "post", q: "first" });
  const e1 = await s1.until("changes");
  t.true(keysOf(e1, log).includes(`thread:${a}`));
  t.truthy(e1?.id);
  await s1.close();
  // writes while the stream is closed
  const b = newId();
  const c = newId();
  await mona.ok("threads.create", { id: b, space: open, kind: "post", q: "second" });
  await mona.ok("threads.create", { id: c, space: open, kind: "post", q: "third" });
  const s2 = await mel.events({}, e1?.id);
  t.is(s2.status, 200);
  const e2 = await s2.until("changes");
  const keys = keysOf(e2, log);
  t.true(keys.includes(`thread:${b}`) && keys.includes(`thread:${c}`));
  t.false(keys.includes(`thread:${a}`));
  await s2.close();
  // an id this server did not seal names no log
  const s3 = await mel.events({}, "not-an-event-id");
  t.is(s3.status, 400);
});

test("Y7: a member removed while connected gets resync for the space log and no record written after", async (t) => {
  const h = createHarness(t);
  const { olga, mel, closed } = await channels(h);
  const log = `space:${closed}`;
  const stream = await mel.events({
    [log]: (await mel.snapshot(log)).cursor,
    "user:mel": (await mel.snapshot("user:mel")).cursor,
  });
  t.is((await stream.until("ready"))?.event, "ready");
  const member = h.sync.store.byKey(`member:${closed}:mel`) as { adm: string };
  await olga.ok("members.remove", { space: closed, user: "mel", base: { adm: member.adm } });
  const resync = await stream.until("resync");
  t.deepEqual(JSON.parse(resync?.data ?? "{}"), { log });
  const after = newId();
  await olga.ok("threads.create", {
    id: after,
    space: closed,
    kind: "post",
    q: "after the removal",
  });
  // nothing more of the space log reaches mel's stream
  for (let e = await stream.next(500); e; e = await stream.next(500)) {
    t.false(e.data.includes("after the removal"));
    t.deepEqual(keysOf(e, log), []);
  }
  await stream.close();
});

test("Y7: sign-out ends the person's streams of that session", async (t) => {
  const h = createHarness(t);
  const p = new Person(h, h.addUser("leaver"));
  await p.register();
  const s = await p.events({ "user:leaver": (await p.snapshot("user:leaver")).cursor });
  t.is((await s.until("ready"))?.event, "ready");
  const out = await h.request("/api/trpc/auth.logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cookie: p.cookie,
    body: "{}",
  });
  t.true(out.ok);
  t.is(await s.until("never", 1000), null);
  t.true(s.ended);
});

// ---- S5: the drain ----

test("S5: envelopes after SIGTERM's drain answer SERVICE_UNAVAILABLE; after a restart each mutation id is applied exactly once", async (t) => {
  // the third write of the batch starts the drain, as a signal arriving
  // while the batch is answered would
  let calls = 0;
  let service: SyncService | null = null;
  const create = MUTATORS["threads.create"] as AnyMutator;
  const mutators = {
    ...MUTATORS,
    "threads.create": {
      ...create,
      run: (...a: Parameters<AnyMutator["run"]>) => {
        if (++calls === 3) service?.drain();
        return create.run(...a);
      },
    },
  };
  const h = createHarness(t, { sync: { mutators } });
  service = h.sync;
  const { mona, open } = await channels(h);
  const ids = [1, 2, 3, 4, 5].map(() => newId());
  const batch = ids.map((id, k) =>
    mona.envelope("threads.create", { id, space: open, kind: "post", q: `post ${k}` }),
  );
  const first = await mona.send(batch);
  t.is(first.status, 200);
  t.deepEqual(
    first.answers.map((a) => (a.ok ? "ok" : a.error.code)),
    ["ok", "ok", "ok", "SERVICE_UNAVAILABLE", "SERVICE_UNAVAILABLE"],
  );
  t.is((await mona.send(batch)).status, 503);
  // the restart: a new process over the same database
  const restarted = new SyncService({ db: h.db, config: h.config, mutators: MUTATORS });
  t.teardown(() => restarted.drain());
  const app = createApp({ ...h.deps, sync: restarted });
  const again = await app.request("/api/sync/apply", {
    method: "POST",
    headers: {
      Origin: h.config.publicOrigin,
      "X-Requested-With": "session",
      "Session-Protocol": "4",
      "Content-Type": "application/json",
      Cookie: `session=${mona.cookie}`,
    },
    body: JSON.stringify({ envelopes: batch }),
  });
  const answers = ((await again.json()) as { answers: { ok: boolean; result?: unknown }[] })
    .answers;
  t.deepEqual(
    answers.map((a) => a.ok),
    [true, true, true, true, true],
  );
  // the first three are the recorded answers; nothing was applied twice
  t.deepEqual(
    answers.slice(0, 3).map((a) => a.result),
    first.answers.slice(0, 3).map((a) => (a.ok ? a.result : null)),
  );
  for (const id of ids) t.is((restarted.store.byKey(`thread:${id}`) as { rev: number }).rev, 1);
  const stats = restarted.store.byKey(`stats:${open}`) as { posts: number };
  t.is(stats.posts, 5);
});

test("boot marks runs still running as interrupted, through the change log", async (t) => {
  const h = createHarness(t);
  const { mona, open } = await channels(h);
  const ask = newId();
  const r = (await mona.ok("threads.create", {
    id: ask,
    space: open,
    kind: "ask",
    q: "Why?",
    ...MODEL,
  })) as {
    run: string;
  };
  // the dispatcher claimed it, then the process died
  h.sync.server.serverApply({ me: "", mutationId: "" }, (tx) => {
    const run = tx.byKey(`run:${r.run}`);
    if (run?.kind === "run") tx.put({ ...run, status: "running" });
  });
  const cursor = (await mona.snapshot(`space:${open}`)).cursor;
  t.is(h.sync.interruptRunning(), 1);
  t.like(h.sync.store.byKey(`run:${r.run}`), {
    status: "interrupted",
    fail: { why: "interrupted", at: null, cls: null },
  });
  const p = h.sync.server.pull({ u: "mona" }, `space:${open}`, cursor);
  t.true("changes" in p && p.changes.some((c) => c.key === `run:${r.run}`));
  t.is(h.sync.interruptRunning(), 0);
});
