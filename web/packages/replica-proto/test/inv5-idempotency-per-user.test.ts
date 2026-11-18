// Invariant 5: idempotency is keyed by (user, mutation id) and kept 7 days.
// Another user's mutation id neither blocks nor replays your write.

import test from "ava";

import type { SpaceRec, ThreadRec } from "../src/index.js";

import { DAY, HOUR, actor, cast, ok, refused, thread } from "./harness.js";

test("a replay of the same mutation id is applied once and answers the first result", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const like = w.envelope("likes.set", { thread: th, on: true });
  const create = w.envelope("threads.create", { id: w.id(), space: open, kind: "post", q: "once" });
  const reply = w.envelope("research.createPostFollowUp", { id: w.id(), thread: th, t: "once" });
  const send = async () => {
    const out: string[] = [];
    for (const e of [like, create, reply])
      out.push(JSON.stringify(await w.server.apply(actor("otto"), e)));
    return out;
  };
  const first = await send();
  const before = JSON.stringify([...w.server.dump()]);
  for (let k = 0; k < 3; k++) {
    w.clock.advance(HOUR);
    t.deepEqual(await send(), first);
  }
  t.is(JSON.stringify([...w.server.dump()]), before);
  const p = w.get(`thread:${th}`) as ThreadRec;
  t.is(p.likes, 1);
  t.is(p.r, 1);
  t.is((w.get(`space:${open}`) as SpaceRec).posts, 2);
});

test("a replay answers the stored result even when the input differs", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const e = w.envelope("likes.set", { thread: th, on: true });
  await ok(t, w.server.apply(actor("otto"), e));
  const forged = {
    ...e,
    name: "members.setRole",
    input: { space: open, user: "otto", role: "owner" },
  };
  t.deepEqual(await w.server.apply(actor("otto"), forged), { ok: true, result: { on: true } });
  t.is((w.get(`member:${open}:otto`) as { role: string }).role, "member");
});

test("a refusal is stored too: the same mutation id is refused again", async (t) => {
  const { w, closed } = await cast(t);
  const e = w.envelope("threads.create", { id: w.id(), space: closed, kind: "post", q: "x" });
  await refused(t, w.server.apply(actor("otto"), e), "FORBIDDEN");
  await ok(t, w.as("otto", "joinRequests.create", { space: closed, rulesAccepted: true }));
  await ok(
    t,
    w.as("olga", "joinRequests.decide", { space: closed, users: ["otto"], decision: "approve" }),
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
  t.deepEqual(
    await w.as("mel", "threads.create", { id: w.id(), space: open, kind: "ask", q: "x" }, mid),
    {
      ok: true,
      result: a,
    },
  );
  // eve replaying mel's exact envelope gets her own attempt: mel's id is taken
  await refused(
    t,
    w.as("eve", "threads.create", { id: a.id, space: open, kind: "ask", q: "mel's" }, mid),
    "CONFLICT",
  );
});

test("each user's last mutation id comes back with their pulls only", async (t) => {
  const { w, open } = await cast(t);
  const mel = w.client("mel");
  const otto = w.client("otto");
  await mel.sync(`space:${open}`);
  await otto.sync(`space:${open}`);
  const before = otto.lastMutationId;
  const e = mel.queue("threads.create", { id: mel.newId(), space: open, kind: "post", q: "x" });
  await mel.flush();
  await mel.sync(`space:${open}`);
  await otto.sync(`space:${open}`);
  t.is(mel.lastMutationId, e.mutationId);
  t.is(otto.lastMutationId, before);
  // a refused write is processed too
  const r = mel.queue("members.remove", { space: open, user: "otto" });
  await mel.flush();
  await mel.sync(`space:${open}`);
  t.is(mel.lastMutationId, r.mutationId);
});

test("a replay within 7 days answers the stored result; after 7 days it is refused, never applied again", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  const e = w.envelope("saved.toggle", { kind: "thread", id: th });
  t.deepEqual(await w.server.apply(actor("otto"), e), { ok: true, result: { on: true } });
  w.clock.advance(6 * DAY);
  t.deepEqual(await w.server.apply(actor("otto"), e), { ok: true, result: { on: true } });
  t.truthy(w.get(`save:otto:${th}`));
  w.clock.advance(DAY + HOUR);
  // the stored result is gone; a toggle applied again would unsave the thread
  await refused(t, w.server.apply(actor("otto"), e), "BAD_REQUEST");
  t.truthy(w.get(`save:otto:${th}`));
});

// DESIGN (phase 0 finding, not fixed here): the last mutation id is kept per
// user, as AGENTS.md says. With two devices, one device's write overwrites the
// other's, so a device cannot tell from it whether its own outbox entry was
// applied. This test states what a device needs and fails under the decided
// design; it is expected to fail until the last mutation id is kept per
// (user, device) or the server reports the processed ids of the caller's
// outbox.
test.failing(
  "a device can tell from a pull whether its own queued write was applied",
  async (t) => {
    const { w, open } = await cast(t);
    const laptop = w.client("mel");
    const phone = w.client("mel");
    await laptop.sync(`space:${open}`);
    const mine = laptop.queue("threads.create", {
      id: laptop.newId(),
      space: open,
      kind: "post",
      q: "laptop",
    });
    await laptop.flush();
    phone.queue("threads.create", { id: phone.newId(), space: open, kind: "post", q: "phone" });
    await phone.flush();
    await laptop.sync(`space:${open}`);
    t.is(laptop.lastMutationId, mine.mutationId);
  },
);
