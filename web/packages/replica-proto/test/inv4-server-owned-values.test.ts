// Invariant 4: the server owns uniqueness, stored times and the values it
// makes (invite codes). A client ULID is accepted only from 3 days in the past
// to 1 minute in the future; an existing id is CONFLICT, byte-identical
// whether or not the caller may read the record that has it; space ids are
// ULIDs and space names are unique.

import test from "ava";

import { deriveId, ulid, type InviteRec, type ThreadRec } from "../src/index.js";

import { DAY, MINUTE, World, cast, ok, refused, thread } from "./harness.js";

test("a duplicate id is the same CONFLICT for a readable and an unreadable record", async (t) => {
  const { w, open, closed } = await cast(t);
  const visible = await thread(t, w, "mel", open, "post");
  const hidden = await thread(t, w, "mel", closed, "post");
  const a = await refused(
    t,
    w.as("otto", "threads.create", { id: visible, space: open, kind: "post", q: "x" }),
    "CONFLICT",
  );
  const b = await refused(
    t,
    w.as("otto", "threads.create", { id: hidden, space: open, kind: "post", q: "x" }),
    "CONFLICT",
  );
  t.is(a, b);
  // ids are unique across kinds: a follow-up, a report or a space cannot take a thread's id
  const c = await refused(
    t,
    w.as("otto", "research.createPostFollowUp", { id: hidden, thread: visible, t: "x" }),
    "CONFLICT",
  );
  const d = await refused(
    t,
    w.as("otto", "reports.create", { id: hidden, item: `p:${visible}`, why: "x" }),
    "CONFLICT",
  );
  const e = await refused(
    t,
    w.as("otto", "spaces.create", { id: hidden, name: "fresh" }),
    "CONFLICT",
  );
  t.deepEqual([c, d, e], [a, a, a]);
  t.is((w.get(`thread:${hidden}`) as ThreadRec).q, "What changed?");
});

test("an id is never reused, even after its record was deleted", async (t) => {
  const { w, open } = await cast(t);
  const th = await thread(t, w, "mel", open, "post");
  await ok(t, w.as("mel", "threads.delete", { id: th }));
  await refused(
    t,
    w.as("mel", "threads.create", { id: th, space: open, kind: "post", q: "again" }),
    "CONFLICT",
  );
});

test("a missing target and one the caller may not read answer the same", async (t) => {
  const { w, closed } = await cast(t);
  const hidden = await thread(t, w, "mel", closed, "ask");
  const missing = w.id();
  for (const [name, input] of [
    ["likes.set", (id: string) => ({ thread: id, on: true })],
    ["saved.toggle", (id: string) => ({ kind: "thread", id })],
    ["followups.ask", (id: string) => ({ id: w.id(), thread: id, q: "x" })],
    ["reports.create", (id: string) => ({ id: w.id(), item: `a:${id}`, why: "x" })],
    ["threads.update", (id: string) => ({ id, q: "x" })],
    ["threads.delete", (id: string) => ({ id })],
  ] as const) {
    const a = await refused(t, w.as("eve", name, input(hidden)), "NOT_FOUND");
    const b = await refused(t, w.as("eve", name, input(missing)), "NOT_FOUND");
    t.is(a, b, name);
  }
  // taking back a like you never gave answers ok whether or not the thread exists
  await ok(t, w.as("eve", "likes.set", { thread: hidden, on: false }));
  await ok(t, w.as("eve", "likes.set", { thread: missing, on: false }));
});

test("a client ULID older than 3 days or more than 1 minute ahead is refused", async (t) => {
  const { w, open } = await cast(t);
  const at = (offset: number) => w.id(offset);
  const create = (id: string) =>
    w.as("mel", "threads.create", { id, space: open, kind: "post", q: "x" });
  await refused(t, create(at(-3 * DAY - 1)), "BAD_REQUEST");
  await refused(t, create(at(MINUTE + 1)), "BAD_REQUEST");
  await refused(t, create(ulid(0, w.random)), "BAD_REQUEST");
  await ok(t, create(at(-3 * DAY)));
  await ok(t, create(at(MINUTE)));
  // the same window applies to the mutation id
  await refused(t, w.as("mel", "spaces.join", { space: open }, at(-3 * DAY - 1)), "BAD_REQUEST");
  await refused(t, w.as("mel", "spaces.join", { space: open }, at(MINUTE + 1)), "BAD_REQUEST");
});

test("a malformed ULID is refused", async (t) => {
  const { w, open } = await cast(t);
  const good = w.id();
  for (const id of [
    "",
    good.slice(1),
    `${good}0`,
    good.toLowerCase(),
    `${good.slice(0, 25)}U`,
    `${good.slice(0, 25)}I`,
    `8${good.slice(1)}`,
    "sp-lounge",
    `${good.slice(0, 25)} `,
  ]) {
    await refused(
      t,
      w.as("mel", "threads.create", { id, space: open, kind: "post", q: "x" }),
      "BAD_REQUEST",
    );
    await refused(t, w.as("mel", "spaces.join", { space: open }, id), "BAD_REQUEST");
  }
});

test("space ids are ULIDs and names are unique, after normalization", async (t) => {
  const { w } = await cast(t);
  await refused(t, w.as("eve", "spaces.create", { id: "sp-new", name: "new" }), "BAD_REQUEST");
  await refused(t, w.as("eve", "spaces.create", { id: w.id(), name: "lounge" }), "CONFLICT");
  await refused(t, w.as("eve", "spaces.create", { id: w.id(), name: "#Lounge" }), "CONFLICT");
  // a closed space's name is taken too, and the answer names only the name sent
  const a = await refused(
    t,
    w.as("eve", "spaces.create", { id: w.id(), name: "vault" }),
    "CONFLICT",
  );
  t.is((JSON.parse(a) as { message: string }).message, "#vault already exists.");
  const mine = w.id();
  await ok(t, w.as("eve", "spaces.create", { id: mine, name: "Eve's Space" }));
  await refused(t, w.as("eve", "spaces.update", { id: mine, set: { name: "lab" } }), "CONFLICT");
  t.is(
    w.get(`space:${mine}`)?.kind === "space"
      ? (w.get(`space:${mine}`) as { name: string }).name
      : null,
    "eve-s-space",
  );
});

test("spaces.create is online only: the client never queues it", async (t) => {
  const w = new World();
  const c = w.client("eve");
  t.throws(() => c.queue("spaces.create", { id: c.newId(), name: "x" }));
  t.is(c.pending().length, 0);
  await ok(t, c.send("spaces.create", { id: c.newId(), name: "x" }));
});

test("invite codes are made by the server: a client can neither choose nor predict one", async (t) => {
  const { w, closed } = await cast(t);
  const id = w.id();
  await refused(
    t,
    w.as("mona", "invites.create", { id, space: closed, code: "letmein" }),
    "BAD_REQUEST",
  );
  const res = (await ok(t, w.as("mona", "invites.create", { id, space: closed }))) as {
    code: string;
  };
  t.is((w.get(`invite:${id}`) as InviteRec).code, res.code);
  // the mock took the code from the id; here it does not depend on it
  t.not(res.code, id.slice(-5).toLowerCase());
  t.false(id.toLowerCase().includes(res.code));
  // the same input on two servers with different random sources gets different codes
  const codes = new Set<string>();
  for (const seed of [11, 12, 13]) {
    const c = await cast(t, seed);
    const r = (await ok(t, c.w.as("olga", "invites.create", { id, space: c.closed }))) as {
      code: string;
    };
    codes.add(r.code);
  }
  t.is(codes.size, 3);
  t.regex(res.code, /^[0-9a-hjkmnp-tv-z]{10}$/);
});

test("joining by invite needs the server's code for that space, once", async (t) => {
  const { w, closed, vault } = await cast(t);
  const res = (await ok(t, w.as("olga", "invites.create", { id: w.id(), space: vault }))) as {
    code: string;
  };
  const wrong = await refused(
    t,
    w.as("eve", "spaces.join", { space: vault, invite: "0000000000" }),
    "FORBIDDEN",
  );
  const other = await refused(
    t,
    w.as("eve", "spaces.join", { space: closed, invite: res.code }),
    "FORBIDDEN",
  );
  t.is(wrong, other);
  await ok(t, w.as("eve", "spaces.join", { space: vault, invite: res.code }));
  const used = await refused(
    t,
    w.as("otto", "spaces.join", { space: vault, invite: res.code }),
    "FORBIDDEN",
  );
  t.is(used, wrong);
});

test("stored times are the server's, not the time in a client's ULID", async (t) => {
  const { w, open } = await cast(t);
  const id = w.id(-2 * DAY);
  await ok(t, w.as("mel", "threads.create", { id, space: open, kind: "ask", q: "x" }));
  const p = w.get(`thread:${id}`) as ThreadRec;
  t.is(Date.parse(p.createdAt), Math.floor(w.clock.now() / 1000) * 1000);
});

test("later ids of a mutation derive from the user, the mutation id and an ordinal", async (t) => {
  const { w, open } = await cast(t);
  const mid = w.id();
  const th = w.id();
  const res = (await ok(
    t,
    w.as("mel", "threads.create", { id: th, space: open, kind: "ask", q: "x" }, mid),
  )) as {
    run: string;
  };
  t.is(res.run, deriveId("mel", mid, 1));
  t.truthy(w.get(`run:${res.run}`));
  t.not(deriveId("otto", mid, 1), res.run);
  t.not(deriveId("mel", mid, 2), res.run);
  t.deepEqual(w.server.jobs().at(-1), { kind: "run", id: res.run });
});
