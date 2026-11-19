// Invariant 5: idempotency is keyed by (user, mutation id) and kept 7 days.
// Another user's mutation id neither blocks nor replays your write. A
// client's writes are applied in their order: each carries the client's next
// `seq`, and the last processed `seq` comes back with every read.

import test from "ava";

import type { Envelope, StatsRec, CountsRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, actor, cast, ok, refused, thread } from "./harness.js";

test("a replay of the same mutation id is applied once and answers the first result", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const sent: Envelope[] = [];
  const first: string[] = [];
  for (const [name, input] of [
    ["likes.set", { thread: th, on: true }],
    ["threads.create", { id: w.id(), space: open, kind: "post", q: "once" }],
    ["research.createPostFollowUp", { id: w.id(), thread: th, t: "once" }],
  ] as const) {
    const e = await w.envelope("otto", name, input);
    sent.push(e);
    first.push(JSON.stringify(await w.server.apply(actor("otto"), e)));
  }
  const before = JSON.stringify([...w.server.dump()]);
  for (let k = 0; k < 3; k++) {
    w.clock.advance(HOUR);
    const again: string[] = [];
    for (const e of sent) again.push(JSON.stringify(await w.server.apply(actor("otto"), e)));
    t.deepEqual(again, first);
    // a replay under a later seq is answered the same: the mutation id decides
    const late = await w.resend("otto", sent[0] as Envelope, true);
    t.is(JSON.stringify(late), first[0] ?? "");
  }
  t.is(JSON.stringify([...w.server.dump()]), before);
  const pCounts = w.get(`counts:${th}`) as CountsRec;
  t.is(pCounts.likes, 1);
  t.is(pCounts.r, 1);
  t.is((w.get(`stats:${open}`) as StatsRec).posts, 2);
});

test("a replay with a different name or input is refused, and the stored result stays", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const e = await w.envelope("otto", "likes.set", { thread: th, on: true });
  await ok(t, w.server.apply(actor("otto"), e));
  for (const forged of [
    { name: "members.setRole", input: { space: open, user: "otto", role: "owner" } },
    { name: "likes.set", input: { thread: th, on: false } },
  ]) {
    const r = await w.resend("otto", { ...e, ...forged }, true);
    t.is(r.ok ? null : r.error.code, "BAD_REQUEST");
    t.deepEqual(r.ok ? null : r.error.issues, ["mutationId: already used for a different change"]);
  }
  t.is((w.get(`member:${open}:otto`) as { role: string }).role, "member");
  t.truthy(w.get(`like:otto:${th}`));
  // the same payload with its keys in another order is the same payload
  t.deepEqual(await w.server.apply(actor("otto"), { ...e, input: { on: true, thread: th } }), {
    ok: true,
    result: { on: true },
  });
});

test("a refusal is stored too: the same mutation id is refused again", async (t) => {
  const { w, closed } = await cast(t);
  const e = await w.envelope("otto", "threads.create", {
    id: w.id(),
    space: closed,
    kind: "post",
    q: "x",
  });
  await refused(t, w.server.apply(actor("otto"), e), "FORBIDDEN");
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", {
      space: closed,
      users: ["otto"],
      decision: "approve",
      base: w.requests(closed, ["otto"]),
    }),
  );
  await refused(t, w.server.apply(actor("otto"), e), "FORBIDDEN");
});

test("another user's mutation id neither blocks nor replays your write", async (t) => {
  const { w, open } = await cast(t);
  const mid = w.id();
  const a = (await ok(
    t,
    w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "mel's" }, mid),
  )) as {
    id: string;
    run: string;
  };
  // otto sends the same mutation id with his own write: it is applied, and its
  // derived run id does not collide with mel's
  const b = (await ok(
    t,
    w.as("otto", "threads.create", { id: w.id(), space: open, kind: "ask", q: "otto's" }, mid),
  )) as {
    id: string;
    run: string;
  };
  t.not(a.id, b.id);
  t.not(a.run, b.run);
  t.is((w.get(`thread:${b.id}`) as ThreadRec).u, "otto");
  t.truthy(w.get(`run:${a.run}`));
  t.truthy(w.get(`run:${b.run}`));
  // and mel's replay still answers mel's result
  const melsInput = { id: a.id, space: open, kind: "ask", q: "mel's" };
  t.deepEqual(await w.as("mel", "threads.create", melsInput, mid), { ok: true, result: a });
  // eve sending mel's exact envelope, mel's client id included, is refused
  const melsEnvelope = { ...(await w.envelope("mel", "threads.create", melsInput, mid)), seq: 1 };
  await refused(t, w.server.apply(actor("eve"), melsEnvelope), "WRONG_CLIENT");
  // eve sending mel's write from her own client gets her own attempt: mel's id is taken
  await refused(t, w.as("eve", "threads.create", melsInput, mid), "CONFLICT");
});

test("each client's last processed seq comes back with its own reads only", async (t) => {
  const { w, open } = await cast(t);
  const mel = w.client("mel");
  const otto = w.client("otto");
  await mel.register();
  await otto.register();
  await mel.sync(`space:${open}`);
  await otto.sync(`space:${open}`);
  t.is(mel.lastSeq, 0);
  t.is(otto.lastSeq, 0);
  mel.queue("threads.create", { id: mel.newId(), space: open, kind: "post", q: "x" });
  await mel.flush();
  await mel.sync(`space:${open}`);
  await otto.sync(`space:${open}`);
  t.is(mel.lastSeq, 1);
  t.is(otto.lastSeq, 0);
  // a refused write is processed too
  mel.queue("members.remove", {
    space: open,
    user: "otto",
    base: w.admission(open, "otto"),
  });
  await mel.flush();
  await mel.sync(`space:${open}`);
  t.is(mel.lastSeq, 2);
  // another person's client id gives nothing, nor does a made-up one
  for (const clientId of [mel.clientId ?? "", "made-up"]) {
    t.is((await w.server.snapshot(actor("otto"), `space:${open}`, { clientId })).lastSeq, null);
    const p = await w.server.pull(actor("otto"), `space:${open}`, otto.cursor(`space:${open}`)!, {
      clientId,
    });
    t.is("resync" in p ? undefined : p.lastSeq, null);
  }
  t.is(
    (await w.server.snapshot(null, `space:${open}`, { clientId: mel.clientId ?? "" })).lastSeq,
    null,
  );
});

test("a replay within 7 days answers the stored result; after 7 days it is refused, never applied again", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const e = await w.envelope("otto", "saved.set", { kind: "thread", id: th, on: true });
  t.deepEqual(await w.server.apply(actor("otto"), e), { ok: true, result: { on: true } });
  await ok(t, w.as("otto", "saved.set", { kind: "thread", id: th, on: false }));
  w.clock.advance(6 * DAY);
  t.deepEqual(await w.server.apply(actor("otto"), e), { ok: true, result: { on: true } });
  t.is(w.get(`save:otto:${th}`), undefined);
  w.clock.advance(DAY + HOUR);
  // the stored result is gone; the seq was used up, and the mutation id is
  // more than 4 days old on the device's clock, so it is refused under its
  // own seq and any later one (and that refusal is recorded)
  await refused(t, w.server.apply(actor("otto"), e), "OUT_OF_ORDER");
  await refused(t, w.resend("otto", e, true), "EXPIRED");
  await refused(t, w.resend("otto", e, true), "EXPIRED");
  t.is(w.get(`save:otto:${th}`), undefined);
});

test("a client's writes are applied in order: a gap or an earlier seq is refused and records nothing", async (t) => {
  // attack F of the phase 0 review: a write that arrived after a later one
  // from the same client was applied, and the last mutation id went back
  const { w, open } = await cast(t);
  const clientId = await w.clientId("mel");
  const seq = await w.nextSeq("mel", clientId);
  const make = async (n: number, q: string): Promise<Envelope> => ({
    ...(await w.envelope("mel", "threads.create", { id: w.id(), space: open, kind: "post", q })),
    seq: n,
  });
  const m1 = await make(seq, "1");
  const m2 = await make(seq + 1, "2");
  const m3 = await make(seq + 2, "3");
  const gap = await w.server.apply(actor("mel"), m2);
  t.is(gap.ok ? null : gap.error.code, "OUT_OF_ORDER");
  t.deepEqual(gap.ok ? null : gap.error.issues, [`seq: expected ${seq}`]);
  t.is(await w.nextSeq("mel", clientId), seq);
  await ok(t, w.server.apply(actor("mel"), m1));
  await refused(t, w.server.apply(actor("mel"), m3), "OUT_OF_ORDER");
  await ok(t, w.server.apply(actor("mel"), m2));
  // a new write under an earlier seq is refused, not applied
  const old = await make(seq, "again");
  await refused(t, w.server.apply(actor("mel"), old), "OUT_OF_ORDER");
  await ok(t, w.server.apply(actor("mel"), m3));
  const qs = [...w.server.dump().values()].flatMap((r) =>
    r.kind === "thread" && r.u === "mel" ? [r.q] : [],
  );
  t.deepEqual(qs.sort(), ["1", "2", "3"]);
  t.is(await w.nextSeq("mel", clientId), seq + 3);
});

test("a malformed mutation id is refused before the replay check, and recorded under its seq only", async (t) => {
  // round 1, R7b: the refusal used up the seq and recorded nothing, so the
  // same envelope sent again after a lost response was OUT_OF_ORDER
  const { w, open } = await cast(t);
  const clientId = await w.clientId("mel");
  for (const mutationId of ["G".repeat(100_000), "", "not-a-ulid", `${w.id()}0`]) {
    const seq = await w.nextSeq("mel", clientId);
    const e = await w.envelope("mel", "spaces.join", { space: open }, mutationId);
    const first = await refused(t, w.server.apply(actor("mel"), e), "BAD_REQUEST");
    t.is(await w.nextSeq("mel", clientId), seq + 1);
    // the same envelope again: the recorded answer, and no seq is used
    t.is(await refused(t, w.server.apply(actor("mel"), e), "BAD_REQUEST"), first);
    t.is(await w.nextSeq("mel", clientId), seq + 1);
    // the id is in no (user, mutation id) entry: under the next seq it is
    // refused afresh, which uses the next seq
    await refused(t, w.resend("mel", e, true), "BAD_REQUEST");
    t.is(await w.nextSeq("mel", clientId), seq + 2);
  }
});

test("two devices of one person each learn whether their own write was applied", async (t) => {
  // the expected failure of phase 0: one device's write overwrote the other's
  // last mutation id; the last seq is kept per client
  const { w, open } = await cast(t);
  const laptop = w.client("mel");
  const phone = w.client("mel");
  await laptop.sync(`space:${open}`);
  laptop.queue("threads.create", {
    id: laptop.newId(),
    space: open,
    kind: "post",
    q: "laptop",
  });
  await laptop.flush();
  phone.queue("threads.create", { id: phone.newId(), space: open, kind: "post", q: "phone" });
  phone.queue("threads.create", { id: phone.newId(), space: open, kind: "post", q: "phone 2" });
  await phone.flush();
  await laptop.sync(`space:${open}`);
  await phone.sync(`space:${open}`);
  t.not(laptop.clientId, phone.clientId);
  t.is(laptop.lastSeq, 1);
  t.is(phone.lastSeq, 2);
});
