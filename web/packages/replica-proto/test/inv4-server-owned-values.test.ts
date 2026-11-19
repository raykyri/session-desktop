// Invariant 4: the server owns uniqueness, stored times and the values it
// makes (invite codes). A client ULID is accepted only from 4 days before to
// 1 minute after the device's time, and the device's time only within a
// minute of the server's; an existing id is CONFLICT, byte-identical whether
// or not the caller may read the record that has it; space ids are ULIDs and
// space names are unique.

import test from "ava";

import {
  ReplicaClient,
  deriveId,
  ulid,
  ulidTime,
  type ApplyResult,
  type CountsRec,
  type InviteRec,
  type ThreadRec,
} from "../src/index.js";

import { DAY, MINUTE, World, actor, cast, ok, refused, thread } from "./harness.js";

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
  const { w, open, closed } = await cast(t);
  const hidden = await thread(t, w, "mel", closed, "ask");
  const post = await thread(t, w, "mel", closed, "post");
  const fu = w.id();
  const top = w.id();
  await ok(t, w.as("ada", "followups.ask", { id: fu, thread: hidden, q: "x" }));
  await ok(t, w.as("ada", "research.createPostFollowUp", { id: top, thread: post, t: "x" }));
  const openPost = await thread(t, w, "otto", open, "post");
  const missing = w.id();
  for (const [name, input] of [
    ["likes.set", (id: string) => ({ thread: id, on: true })],
    ["saved.set", (id: string) => ({ kind: "thread", id, on: true })],
    ["followups.ask", (id: string) => ({ id: w.id(), thread: id, q: "x" })],
    ["reports.create", (id: string) => ({ id: w.id(), item: `a:${id}`, why: "x" })],
    ["threads.update", (id: string) => ({ id, q: "x", base: { rev: 1 } })],
    ["threads.delete", (id: string) => ({ id })],
    [
      "moderation.decide",
      (id: string) => ({ item: `a:${id}`, decision: "hidden", base: { rev: 1 } }),
    ],
  ] as const) {
    const a = await refused(t, w.as("eve", name, input(hidden)), "NOT_FOUND");
    const b = await refused(t, w.as("eve", name, input(missing)), "NOT_FOUND");
    t.is(a, b, name);
  }
  // follow-up and reply keys, for a report and a moderation decision: mona
  // moderates the open space, not the closed one
  for (const [name, who, input] of [
    ["reports.create", "eve", (key: string) => ({ id: w.id(), item: key, why: "x" })],
    [
      "moderation.decide",
      "eve",
      (key: string) => ({ item: key, decision: "hidden", base: { rev: 1 } }),
    ],
    [
      "moderation.decide",
      "otto",
      (key: string) => ({ item: key, decision: "removed", base: { rev: 1 } }),
    ],
  ] as const) {
    const answers = new Set<string>();
    for (const key of [
      `f:${hidden}:${fu}`,
      `f:${hidden}:${missing}`,
      `f:${missing}:${fu}`,
      `r:${post}:${top}`,
      `r:${post}:${missing}`,
      `r:${openPost}:${top}`,
      `p:${hidden}`,
      `a:${post}`,
    ])
      answers.add(await refused(t, w.as(who, name, input(key)), "NOT_FOUND"));
    t.is(answers.size, 1, name);
  }
  // a reply's parent: one in a space the caller may not read, a missing one,
  // and one under another thread answer the same
  const parents = new Set<string>();
  for (const parent of [top, missing])
    parents.add(
      await refused(
        t,
        w.as("eve", "research.createPostFollowUp", {
          id: w.id(),
          thread: openPost,
          t: "x",
          parent,
        }),
        "NOT_FOUND",
      ),
    );
  t.is(parents.size, 1);
  // taking back a like you never gave answers ok whether or not the thread exists
  await ok(t, w.as("eve", "likes.set", { thread: hidden, on: false }));
  await ok(t, w.as("eve", "likes.set", { thread: missing, on: false }));
});

test("a client ULID more than 4 days old or more than 1 minute ahead on the device's clock is EXPIRED, and the answer is recorded", async (t) => {
  const { w, open, closed } = await cast(t);
  const at = (offset: number) => w.id(offset);
  const create = (id: string) =>
    w.as("mel", "threads.create", { id, space: open, kind: "post", q: "x" });
  const skew = async (res: Promise<ApplyResult>) => {
    const r = await res;
    t.is(r.ok ? null : r.error.code, "EXPIRED");
  };
  await skew(create(at(-4 * DAY - 1)));
  await skew(create(at(MINUTE + 1)));
  await skew(create(ulid(0, w.random)));
  await ok(t, create(at(-4 * DAY)));
  await ok(t, create(at(MINUTE)));
  // the same window applies to the mutation id, and to every id the input brings
  await skew(w.as("mel", "spaces.join", { space: open }, at(-4 * DAY - 1)));
  await skew(w.as("mel", "spaces.join", { space: open }, at(MINUTE + 1)));
  // recorded: the same envelope again gets the same answer, and the seq is used
  const e = await w.envelope("mel", "spaces.join", { space: open }, at(-5 * DAY));
  await skew(Promise.resolve(w.server.apply(actor("mel"), e)));
  await skew(w.resend("mel", e, true));
  t.is(await w.nextSeq("mel", e.clientId), e.seq + 1);
  t.is(w.get(`member:${open}:mel`)?.kind, "member");
  const th = await thread(t, w, "mel", closed, "ask");
  const post = await thread(t, w, "mel", closed, "post");
  for (const [name, input] of [
    ["followups.ask", { id: at(2 * MINUTE), thread: th, q: "x" }],
    ["research.createPostFollowUp", { id: at(2 * MINUTE), thread: post, t: "x" }],
    ["reports.create", { id: at(2 * MINUTE), item: `a:${th}`, why: "x" }],
    ["invites.create", { id: at(2 * MINUTE), space: closed }],
  ] as const)
    await skew(w.as("mel", name, input));
  // moderation.decide brings no new id; its mutation id is checked
  await skew(
    w.as(
      "mona",
      "moderation.decide",
      { item: `a:${th}`, decision: "hidden", base: w.item(`a:${th}`) },
      at(2 * MINUTE),
    ),
  );
  t.is((w.get(`thread:${th}`) as ThreadRec).mod, null);
});

test("a device clock more than a minute from the server's is CLOCK_SKEW with the server's time, and nothing is recorded", async (t) => {
  const { w, open } = await cast(t);
  for (const off of [MINUTE + 1, -MINUTE - 1, -10 * DAY, 400 * DAY]) {
    const e = await w.envelope("otto", "likes.set", { thread: w.id(), on: false });
    const r = await w.server.apply(actor("otto"), { ...e, clientTime: e.clientTime + off });
    t.is(r.ok ? null : r.error.code, "CLOCK_SKEW");
    t.is(r.ok ? null : r.error.serverTime, w.clock.now());
    t.is(await w.nextSeq("otto", e.clientId), e.seq);
  }
  for (const off of [MINUTE, -MINUTE]) {
    const e = await w.envelope("otto", "spaces.join", { space: open });
    await ok(t, w.server.apply(actor("otto"), { ...e, clientTime: e.clientTime + off }));
  }
});

test("a fast clock is corrected from the server's time, and the write sent again succeeds", async (t) => {
  // attack E of the phase 0 review: a refusal for an id 2 minutes ahead was
  // stored, so the client could not send the write again
  const { w, open } = await cast(t);
  const fast = { now: () => w.clock.now() + 2 * MINUTE };
  const mel = new ReplicaClient(w.server, actor("mel"), { clock: fast, random: w.random });
  const id = mel.newId();
  mel.queue("threads.create", { id, space: open, kind: "ask", q: "from a fast clock" });
  mel.queue("followups.ask", { id: mel.newId(), thread: id, q: "and a follow-up" });
  const results = await mel.flush();
  t.deepEqual(
    results.map((r) => (r.ok ? "ok" : r.error.code)),
    ["ok", "ok"],
  );
  // the thread got a new id inside the window, and the follow-up names it
  const made = [...w.server.dump().values()].filter(
    (r): r is ThreadRec => r.kind === "thread" && r.q === "from a fast clock",
  );
  t.is(made.length, 1);
  t.not(made[0]?.id, id);
  t.true(Math.abs(ulidTime(made[0]?.id ?? "") - w.clock.now()) < MINUTE);
  t.is((w.get(`counts:${made[0]?.id ?? ""}`) as CountsRec).r, 1);
  t.true(Math.abs(mel.now() - w.clock.now()) < 1000);
  // the refusal was not recorded: the same envelope, sent unchanged once the
  // server's clock has caught up with the device's, is applied
  const e = await w.envelope(
    "otto",
    "threads.create",
    {
      id: w.id(2 * MINUTE),
      space: open,
      kind: "post",
      q: "x",
    },
    w.id(2 * MINUTE),
  );
  const ahead = { ...e, clientTime: e.clientTime + 2 * MINUTE };
  await refused(t, w.server.apply(actor("otto"), ahead), "CLOCK_SKEW");
  w.clock.advance(2 * MINUTE);
  await ok(t, w.server.apply(actor("otto"), ahead));
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
  t.is(w.get(`member:${open}:mel`)?.kind, "member");
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

test("the server refuses an online-only write that waited in an outbox with EXPIRED, and records it", async (t) => {
  const w = new World();
  // a client that queues it anyway: on the device's clock, its mutation id
  // is more than a minute old when it is sent. A slow device clock is a
  // CLOCK_SKEW of `clientTime` instead, which the client corrects (R6).
  const e = await w.envelope("eve", "spaces.create", { id: w.id(), name: "late" });
  w.clock.advance(MINUTE + 1);
  for (let k = 0; k < 2; k++) await refused(t, w.resend("eve", e), "EXPIRED");
  t.is(w.server.dump().size, 0);
  // recorded: the seq is used, and a fresh write is applied under the next one
  t.is(await w.nextSeq("eve", e.clientId), e.seq + 1);
  await ok(t, w.as("eve", "spaces.create", { id: w.id(), name: "late" }));
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
  await w.work();
  t.deepEqual(w.server.jobs().at(-1), { kind: "run", id: res.run });
});
